import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { QueryEmployeeDto } from './dto/query-employee.dto';
import * as bcrypt from 'bcrypt';
import * as ExcelJS from 'exceljs';
import csv from 'csv-parser';
import { Readable } from 'stream';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver = require('archiver');
import * as fs from 'fs';
import * as path from 'path';
import { processAndSavePhoto } from '../common/utils/image.util';

// ─── Kirill → Lotin transliteratsiya ────────────────────────────────────────
const CYR_TO_LAT: Record<string, string> = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'j','з':'z',
  'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
  'с':'s','т':'t','у':'u','ф':'f','х':'x','ц':'c','ч':'ch','ш':'sh',
  'ъ':"'",'ь':"'",'э':'e','ю':'yu','я':'ya',
  'ғ':'g','қ':'q','ҳ':'h','ў':'o',
};
function cyrToLat(str: string): string {
  return str.toLowerCase().split('').map(c => CYR_TO_LAT[c] ?? c).join('');
}
function hasCyrillic(str: string): boolean {
  return /[а-яёА-ЯЁҒғҚқҲҳЎў]/.test(str);
}

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryEmployeeDto, hospitalId: string) {
    const { search, departmentId, positionId, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    // hospitalId bo'sh string bo'lsa (SUPER_ADMIN kasalxona tanlamagan) — barcha xodimlar
    const where: any = {
      ...(hospitalId ? { hospitalId } : {}),
      firedAt: null,
      ...(departmentId && { departmentId }),
      ...(positionId && { positionId }),
      ...(search && (() => {
        // Kirill kiritilsa → Lotin ekvivalentini ham qidiramiz (va aksincha)
        const alt = hasCyrillic(search) ? cyrToLat(search) : null;
        const nameFilters: any[] = [
          { fullName: { startsWith: search, mode: 'insensitive' } },
          { fullName: { contains: ` ${search}`, mode: 'insensitive' } },
          ...(alt ? [
            { fullName: { startsWith: alt, mode: 'insensitive' } },
            { fullName: { contains: ` ${alt}`, mode: 'insensitive' } },
          ] : []),
        ];
        return {
          OR: [
            ...nameFilters,
            { employeeNo: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search, mode: 'insensitive' } },
          ],
        };
      })()),
    };

    const [data, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        skip,
        take: limit,
        include: { department: true, position: true, user: { select: { username: true, status: true } } },
        orderBy: { fullName: 'asc' },
      }),
      this.prisma.employee.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, hospitalId?: string) {
    const where: any = { id };
    if (hospitalId) where.hospitalId = hospitalId;

    const emp = await this.prisma.employee.findFirst({
      where,
      include: {
        department: true,
        position: true,
        user: { select: { id: true, username: true, role: true, status: true } },
      },
    });
    if (!emp) throw new NotFoundException('Hodim topilmadi');
    return emp;
  }

  async findByEmployeeNo(employeeNo: string) {
    return this.prisma.employee.findUnique({
      where: { employeeNo },
      include: { department: true, position: true, hospital: true },
    });
  }

  async create(dto: CreateEmployeeDto, hospitalId: string, username?: string, password?: string) {
    // employeeNo is optional — only check duplicate if provided
    if (dto.employeeNo) {
      const existing = await this.prisma.employee.findUnique({
        where: { employeeNo: dto.employeeNo },
      });
      if (existing) throw new ConflictException('Bu Employee ID allaqachon mavjud');
    }

    // Verify department & position belong to same hospital
    const [dept, pos] = await Promise.all([
      this.prisma.department.findFirst({ where: { id: dto.departmentId, hospitalId } }),
      this.prisma.position.findFirst({ where: { id: dto.positionId, hospitalId } }),
    ]);
    if (!dept) throw new NotFoundException('Bo\'lim topilmadi');
    if (!pos) throw new NotFoundException('Lavozim topilmadi');

    return this.prisma.$transaction(async (tx) => {
      let userId: string | undefined;

      if (username && password) {
        const hash = await bcrypt.hash(password, 12);
        const user = await tx.user.create({
          data: { username, passwordHash: hash, role: 'EMPLOYEE', hospitalId },
        });
        userId = user.id;
      }

      return tx.employee.create({
        data: {
          employeeNo: dto.employeeNo || undefined,
          fullName: dto.fullName,
          gender: dto.gender,
          phone: dto.phone,
          email: dto.email,
          departmentId: dto.departmentId,
          positionId: dto.positionId,
          baseSalary: dto.baseSalary ?? 0,
          telegramChatId: dto.telegramChatId,
          hiredAt: dto.hiredAt ? new Date(dto.hiredAt) : undefined,
          hospitalId,
          userId,
        },
        include: { department: true, position: true },
      });
    });
  }

  async update(id: string, dto: UpdateEmployeeDto, hospitalId: string) {
    await this.findOne(id, hospitalId);
    const { username, password, ...rest } = dto as any;

    return this.prisma.$transaction(async (tx) => {
      if (username || password) {
        const emp = await tx.employee.findUnique({ where: { id }, select: { userId: true } });
        if (emp?.userId) {
          const updateData: any = {};
          if (username) updateData.username = username;
          if (password) updateData.passwordHash = await bcrypt.hash(password, 12);
          await tx.user.update({ where: { id: emp.userId }, data: updateData });
        }
      }

      return tx.employee.update({
        where: { id },
        data: {
          ...(rest.fullName                   && { fullName:       rest.fullName }),
          ...(rest.gender                     && { gender:         rest.gender }),
          ...(rest.phone       !== undefined   && { phone:          rest.phone }),
          ...(rest.email       !== undefined   && { email:          rest.email }),
          ...(rest.departmentId               && { departmentId:   rest.departmentId }),
          ...(rest.positionId                 && { positionId:      rest.positionId }),
          ...(rest.baseSalary  !== undefined   && { baseSalary:     rest.baseSalary }),
          ...(rest.employeeNo  !== undefined   && rest.employeeNo !== '' && { employeeNo: rest.employeeNo }),
          ...(rest.telegramChatId !== undefined && { telegramChatId: rest.telegramChatId }),
        },
        include: { department: true, position: true },
      });
    });
  }

  async updatePhoto(id: string, imageBuffer: Buffer, hospitalId: string) {
    await this.findOne(id, hospitalId);
    const emp = await this.prisma.employee.findUnique({ where: { id } });

    // Rasmni qayta ishlash: EXIF rotate + resize 800x800 + JPEG 85% siqish
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const filenameBase = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const { filename } = await processAndSavePhoto(imageBuffer, uploadDir, filenameBase);
    const photoUrl = `/uploads/${filename}`;

    // Eski rasmni o'chirish
    if (emp?.photoUrl) {
      const oldFile = path.join(uploadDir, emp.photoUrl.replace(/^\/uploads\//, ''));
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
    }

    const updateData: any = { photoUrl };

    // Auto-generate numeric employeeNo for Hikvision terminal (only if not set yet)
    if (!emp?.employeeNo) {
      const count = await this.prisma.employee.count({ where: { hospitalId } });
      // Format: {YY}{sequential 5-digit} — e.g. 2600001
      const yy = new Date().getFullYear().toString().slice(-2);
      const seq = String(count + 1).padStart(5, '0');
      updateData.employeeNo = `${yy}${seq}`;
    }

    return this.prisma.employee.update({ where: { id }, data: updateData });
  }

  /** EMP-XXXXXX formatli eski employee numberlarni raqamli formatga o'tkazish */
  async fixLegacyEmployeeNumbers(hospitalId: string): Promise<{ fixed: number; skipped: number }> {
    const employees = await this.prisma.employee.findMany({
      where: { hospitalId },
      select: { id: true, employeeNo: true },
      orderBy: { hiredAt: 'asc' },
    });

    const yy = new Date().getFullYear().toString().slice(-2);
    let fixed = 0;
    let skipped = 0;
    let counter = 1;

    // Find highest existing numeric employeeNo to continue from there
    const maxNumeric = employees
      .filter((e) => e.employeeNo && /^\d+$/.test(e.employeeNo))
      .map((e) => parseInt(e.employeeNo!))
      .sort((a, b) => b - a)[0] || 0;
    counter = maxNumeric + 1;

    for (const emp of employees) {
      // Only fix non-numeric (EMP-XXXXX style) numbers
      if (emp.employeeNo && /^\d+$/.test(emp.employeeNo)) {
        skipped++;
        continue;
      }
      const seq = String(counter).padStart(5, '0');
      await this.prisma.employee.update({
        where: { id: emp.id },
        data: { employeeNo: `${yy}${seq}` },
      });
      counter++;
      fixed++;
    }

    return { fixed, skipped };
  }

  async fire(id: string, hospitalId: string, firedAt?: string) {
    const emp = await this.findOne(id, hospitalId);
    const result = await this.prisma.employee.update({
      where: { id },
      data: { firedAt: firedAt ? new Date(firedAt) : new Date() },
    });
    // Agar DIRECTOR bo'lsa — Telegram obunasini o'chirish
    if (emp.user?.role === 'DIRECTOR' && emp.hospitalId) {
      await this.prisma.telegramSubscription.updateMany({
        where: { hospitalId: emp.hospitalId, isActive: true },
        data: { isActive: false },
      });
    }
    return result;
  }

  async remove(id: string, hospitalId: string) {
    const emp = await this.findOne(id, hospitalId);
    const isDirector = emp.user?.role === 'DIRECTOR';

    // Bog'liq yozuvlarni avval o'chirish (cascade yo'q jadvallar)
    await this.prisma.$transaction([
      this.prisma.payrollRecord.deleteMany({ where: { employeeId: id } }),
      this.prisma.weeklyAttendanceStat.deleteMany({ where: { employeeId: id } }),
      this.prisma.attendanceRecord.deleteMany({ where: { employeeId: id } }),
      this.prisma.schedule.deleteMany({ where: { employeeId: id } }),
      this.prisma.employee.delete({ where: { id } }),
    ]);

    // DIRECTOR o'chirilsa — Telegram obunasini ham o'chirish
    if (isDirector && emp.hospitalId) {
      await this.prisma.telegramSubscription.updateMany({
        where: { hospitalId: emp.hospitalId, isActive: true },
        data: { isActive: false },
      });
    }

    return { success: true, message: 'Hodim o\'chirildi' };
  }

  // ──────────────────────────────────────────
  // BULK OPERATIONS
  // ──────────────────────────────────────────
  async bulkDelete(ids: string[], hospitalId: string) {
    const where = { employeeId: { in: ids } };
    await this.prisma.$transaction([
      this.prisma.payrollRecord.deleteMany({ where }),
      this.prisma.weeklyAttendanceStat.deleteMany({ where }),
      this.prisma.attendanceRecord.deleteMany({ where }),
      this.prisma.schedule.deleteMany({ where }),
      this.prisma.employee.deleteMany({
        where: { id: { in: ids }, ...(hospitalId ? { hospitalId } : {}) },
      }),
    ]);
    return { success: true, deleted: ids.length };
  }

  async bulkUpdateDepartment(ids: string[], departmentId: string, hospitalId: string) {
    const result = await this.prisma.employee.updateMany({
      where: { id: { in: ids }, ...(hospitalId ? { hospitalId } : {}) },
      data: { departmentId },
    });
    return { success: true, updated: result.count };
  }

  // ──────────────────────────────────────────
  // CSV IMPORT
  // ──────────────────────────────────────────
  async importCsv(
    buffer: Buffer,
    hospitalId: string,
  ): Promise<{ imported: number; created: { departments: string[]; positions: string[] }; errors: string[] }> {
    const rows: any[] = await new Promise((resolve, reject) => {
      const results: any[] = [];
      const stream = Readable.from(buffer.toString().replace(/^\uFEFF/, '')); // strip BOM
      stream
        .pipe(csv())
        .on('data', (row) => results.push(row))
        .on('end', () => resolve(results))
        .on('error', reject);
    });

    let imported = 0;
    const errors: string[] = [];
    const autoCreatedDepts = new Set<string>();
    const autoCreatedPositions = new Set<string>();

    // Cache to avoid redundant DB calls within one import
    const deptCache = new Map<string, string>(); // code → id
    const posCache = new Map<string, string>();  // name → id

    const getOrCreateDept = async (code: string): Promise<string> => {
      const cacheKey = code.toUpperCase();
      if (deptCache.has(cacheKey)) return deptCache.get(cacheKey)!;

      let dept = await this.prisma.department.findFirst({
        where: { hospitalId, code: cacheKey },
      });
      if (!dept) {
        dept = await this.prisma.department.create({
          data: { hospitalId, code: cacheKey, name: cacheKey },
        });
        autoCreatedDepts.add(cacheKey);
      }
      deptCache.set(cacheKey, dept.id);
      return dept.id;
    };

    const getOrCreatePos = async (name: string): Promise<string> => {
      if (posCache.has(name)) return posCache.get(name)!;

      let pos = await this.prisma.position.findFirst({
        where: { hospitalId, name },
      });
      if (!pos) {
        pos = await this.prisma.position.create({
          data: { hospitalId, name },
        });
        autoCreatedPositions.add(name);
      }
      posCache.set(name, pos.id);
      return pos.id;
    };

    for (const row of rows) {
      // Support both Uzbek headers and legacy English headers
      const fullName = (row.ism_familiya || row.full_name || '').trim();
      const gender = (row.jinsi || row.gender || '').trim();
      const departmentCode = (row.bolim_kodi || row.department_code || '').trim();
      const positionName = (row.lavozim || row.position || '').trim();
      const phone = (row.telefon || row.phone || '').trim();

      if (!fullName) { errors.push(`Qator o'tkazib yuborildi: ism-familiya bo'sh`); continue; }

      try {
        const deptId = departmentCode
          ? await getOrCreateDept(departmentCode)
          : await getOrCreateDept('BOSHQA');

        const posId = positionName
          ? await getOrCreatePos(positionName)
          : await getOrCreatePos('Belgilanmagan');

        await this.prisma.employee.create({
          data: {
            fullName,
            gender: gender.toUpperCase() === 'AYOL' || gender.toUpperCase() === 'FEMALE' ? 'FEMALE' : 'MALE',
            phone: phone || null,
            departmentId: deptId,
            positionId: posId,
            baseSalary: 0,
            hiredAt: new Date(),
            hospitalId,
          },
        });
        imported++;
      } catch (e) {
        errors.push(`${fullName}: ${e.message}`);
      }
    }

    return {
      imported,
      created: {
        departments: [...autoCreatedDepts],
        positions: [...autoCreatedPositions],
      },
      errors,
    };
  }

  // ──────────────────────────────────────────
  // EXCEL EXPORT
  // ──────────────────────────────────────────
  async exportExcel(hospitalId: string): Promise<Buffer> {
    const employees = await this.prisma.employee.findMany({
      where: { hospitalId, firedAt: null },
      include: { department: true, position: true },
      orderBy: { fullName: 'asc' },
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Maternity Ward System';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Hodimlar', {
      pageSetup: { paperSize: 9, orientation: 'landscape' },
    });

    const headerStyle: Partial<ExcelJS.Style> = {
      font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E6DA4' } },
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' },
      },
    };

    sheet.columns = [
      { header: '№', key: 'no', width: 5 },
      { header: 'Employee ID', key: 'employeeNo', width: 15 },
      { header: 'F.I.O', key: 'fullName', width: 30 },
      { header: 'Jinsi', key: 'gender', width: 10 },
      { header: 'Bo\'lim', key: 'department', width: 25 },
      { header: 'Lavozim', key: 'position', width: 25 },
      { header: 'Telefon', key: 'phone', width: 15 },
      { header: 'Email', key: 'email', width: 25 },
      { header: 'Oylik maosh', key: 'baseSalary', width: 15 },
      { header: 'Ishga kirgan sana', key: 'hiredAt', width: 20 },
    ];

    sheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });
    sheet.getRow(1).height = 30;

    employees.forEach((emp, i) => {
      const row = sheet.addRow({
        no: i + 1,
        employeeNo: emp.employeeNo || '—',
        fullName: emp.fullName,
        gender: emp.gender === 'MALE' ? 'Erkak' : 'Ayol',
        department: emp.department.name,
        position: emp.position.name,
        phone: emp.phone || '',
        email: emp.email || '',
        baseSalary: Number(emp.baseSalary),
        hiredAt: emp.hiredAt.toLocaleDateString('uz-UZ'),
      });

      if (i % 2 === 1) {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4F8' } };
        });
      }
      row.getCell('baseSalary').numFmt = '#,##0.00 "so\'m"';
    });

    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
    return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  }

  // ──────────────────────────────────────────
  // ENROLL PIC ZIP (Hikvision)
  // ──────────────────────────────────────────
  async enrollPicZip(hospitalId: string): Promise<Buffer> {
    const employees = await this.prisma.employee.findMany({
      where: { hospitalId, firedAt: null, photoUrl: { not: null }, employeeNo: { not: null } },
      select: { employeeNo: true, photoUrl: true, fullName: true },
    });

    const uploadDir = process.env.UPLOAD_DIR || './uploads';

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const archive = archiver('zip', { zlib: { level: 9 } });

      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);

      let added = 0;
      for (const emp of employees) {
        if (!emp.photoUrl || !emp.employeeNo) continue;
        // photoUrl = /uploads/filename.jpg  →  filename.jpg
        const filename = emp.photoUrl.replace(/^\/uploads\//, '');
        const filePath = path.join(uploadDir, filename);
        if (fs.existsSync(filePath)) {
          const pin = emp.employeeNo;
          // Hikvision format: enroll_pic/{PIN}_2_0_{PIN}_0.jpg
          const zipName = `enroll_pic/${pin}_2_0_${pin}_0.jpg`;
          archive.file(filePath, { name: zipName });
          added++;
        }
      }

      if (added === 0) {
        // Return empty zip with README inside folder
        archive.append('Hech qanday rasm topilmadi. Avval hodimlar rasmini yuklang.', { name: 'enroll_pic/README.txt' });
      }

      archive.finalize();
    });
  }

  getCsvTemplate(): Buffer {
    // UTF-8 BOM for Excel compatibility
    const BOM = '\uFEFF';
    // Minimal Uzbek CSV shablon — faqat zaruriy ustunlar
    // jinsi: ERKAK yoki AYOL
    // bolim_kodi — bo'lim kodi (masalan AKUSHERLIK), lavozim — lavozim nomi
    const rows = [
      'ism_familiya,jinsi,bolim_kodi,lavozim,telefon',
      'Aziza Karimova,AYOL,AKUSHERLIK,Akusher-ginekolog,+998901234567',
      'Bobur Rahimov,ERKAK,OPERATSIYA,Hirurg,+998901111111',
      'Malika Yusupova,AYOL,REANIMATSIYA,Hamshira,+998909999999',
    ];
    return Buffer.from(BOM + rows.join('\r\n'), 'utf8');
  }
}
