import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { QueryEmployeeDto } from './dto/query-employee.dto';
import * as bcrypt from 'bcrypt';
import * as ExcelJS from 'exceljs';
import * as csv from 'csv-parser';
import { Readable } from 'stream';

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryEmployeeDto) {
    const { search, departmentId, positionId, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: any = {
      firedAt: null,
      ...(departmentId && { departmentId }),
      ...(positionId && { positionId }),
      ...(search && {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { employeeNo: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
        ],
      }),
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

  async findOne(id: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id },
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
      include: { department: true, position: true },
    });
  }

  async create(dto: CreateEmployeeDto, username?: string, password?: string) {
    // Check duplicate
    const existing = await this.prisma.employee.findUnique({
      where: { employeeNo: dto.employeeNo },
    });
    if (existing) throw new ConflictException('Bu Employee ID allaqachon mavjud');

    // Verify department & position exist
    const [dept, pos] = await Promise.all([
      this.prisma.department.findUnique({ where: { id: dto.departmentId } }),
      this.prisma.position.findUnique({ where: { id: dto.positionId } }),
    ]);
    if (!dept) throw new NotFoundException('Bo\'lim topilmadi');
    if (!pos) throw new NotFoundException('Lavozim topilmadi');

    return this.prisma.$transaction(async (tx) => {
      let userId: string | undefined;

      if (username && password) {
        const hash = await bcrypt.hash(password, 10);
        const user = await tx.user.create({
          data: { username, passwordHash: hash, role: 'EMPLOYEE' },
        });
        userId = user.id;
      }

      return tx.employee.create({
        data: {
          employeeNo: dto.employeeNo,
          fullName: dto.fullName,
          gender: dto.gender,
          phone: dto.phone,
          email: dto.email,
          departmentId: dto.departmentId,
          positionId: dto.positionId,
          baseSalary: dto.baseSalary,
          telegramChatId: dto.telegramChatId,
          hiredAt: dto.hiredAt ? new Date(dto.hiredAt) : undefined,
          userId,
        },
        include: { department: true, position: true },
      });
    });
  }

  async update(id: string, dto: UpdateEmployeeDto) {
    await this.findOne(id);
    const { username, password, ...rest } = dto as any;

    return this.prisma.$transaction(async (tx) => {
      if (username || password) {
        const emp = await tx.employee.findUnique({ where: { id }, select: { userId: true } });
        if (emp?.userId) {
          const updateData: any = {};
          if (username) updateData.username = username;
          if (password) updateData.passwordHash = await bcrypt.hash(password, 10);
          await tx.user.update({ where: { id: emp.userId }, data: updateData });
        }
      }

      return tx.employee.update({
        where: { id },
        data: {
          ...(rest.fullName && { fullName: rest.fullName }),
          ...(rest.gender && { gender: rest.gender }),
          ...(rest.phone !== undefined && { phone: rest.phone }),
          ...(rest.email !== undefined && { email: rest.email }),
          ...(rest.departmentId && { departmentId: rest.departmentId }),
          ...(rest.positionId && { positionId: rest.positionId }),
          ...(rest.baseSalary && { baseSalary: rest.baseSalary }),
          ...(rest.telegramChatId !== undefined && { telegramChatId: rest.telegramChatId }),
        },
        include: { department: true, position: true },
      });
    });
  }

  async updatePhoto(id: string, photoUrl: string) {
    await this.findOne(id);
    return this.prisma.employee.update({ where: { id }, data: { photoUrl } });
  }

  async fire(id: string, firedAt?: string) {
    await this.findOne(id);
    return this.prisma.employee.update({
      where: { id },
      data: { firedAt: firedAt ? new Date(firedAt) : new Date() },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.employee.delete({ where: { id } });
  }

  // ──────────────────────────────────────────
  // CSV IMPORT
  // ──────────────────────────────────────────
  async importCsv(buffer: Buffer): Promise<{ imported: number; errors: string[] }> {
    const rows: any[] = await new Promise((resolve, reject) => {
      const results: any[] = [];
      const stream = Readable.from(buffer.toString());
      stream
        .pipe(csv())
        .on('data', (row) => results.push(row))
        .on('end', () => resolve(results))
        .on('error', reject);
    });

    let imported = 0;
    const errors: string[] = [];

    for (const row of rows) {
      try {
        const dept = await this.prisma.department.findUnique({ where: { code: row.department_code } });
        const pos = await this.prisma.position.findUnique({ where: { name: row.position } });

        if (!dept) { errors.push(`${row.full_name}: Bo'lim topilmadi (${row.department_code})`); continue; }
        if (!pos) { errors.push(`${row.full_name}: Lavozim topilmadi (${row.position})`); continue; }

        const existing = await this.prisma.employee.findUnique({ where: { employeeNo: row.employee_no } });
        if (existing) { errors.push(`${row.full_name}: Employee No allaqachon mavjud (${row.employee_no})`); continue; }

        await this.prisma.employee.create({
          data: {
            employeeNo: row.employee_no,
            fullName: row.full_name,
            gender: row.gender?.toUpperCase() === 'FEMALE' ? 'FEMALE' : 'MALE',
            phone: row.phone,
            email: row.email,
            departmentId: dept.id,
            positionId: pos.id,
            baseSalary: parseFloat(row.base_salary) || 0,
            hiredAt: row.hired_at ? new Date(row.hired_at) : new Date(),
          },
        });
        imported++;
      } catch (e) {
        errors.push(`${row.full_name || row.employee_no}: ${e.message}`);
      }
    }

    return { imported, errors };
  }

  // ──────────────────────────────────────────
  // EXCEL EXPORT
  // ──────────────────────────────────────────
  async exportExcel(): Promise<Buffer> {
    const employees = await this.prisma.employee.findMany({
      where: { firedAt: null },
      include: { department: true, position: true },
      orderBy: { fullName: 'asc' },
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Maternity Ward System';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Hodimlar', {
      pageSetup: { paperSize: 9, orientation: 'landscape' },
    });

    // Header style
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

    // Apply header style
    sheet.getRow(1).eachCell((cell) => {
      Object.assign(cell, headerStyle);
    });
    sheet.getRow(1).height = 30;

    employees.forEach((emp, i) => {
      const row = sheet.addRow({
        no: i + 1,
        employeeNo: emp.employeeNo,
        fullName: emp.fullName,
        gender: emp.gender === 'MALE' ? 'Erkak' : 'Ayol',
        department: emp.department.name,
        position: emp.position.name,
        phone: emp.phone || '',
        email: emp.email || '',
        baseSalary: Number(emp.baseSalary),
        hiredAt: emp.hiredAt.toLocaleDateString('uz-UZ'),
      });

      // Alternating row colors
      if (i % 2 === 1) {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4F8' } };
        });
      }

      // Format salary
      row.getCell('baseSalary').numFmt = '#,##0.00 "so\'m"';
    });

    // Freeze header row
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];

    return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  }

  // ──────────────────────────────────────────
  // CSV TEMPLATE DOWNLOAD
  // ──────────────────────────────────────────
  getCsvTemplate(): string {
    const headers = 'employee_no,full_name,gender,department_code,position,phone,email,base_salary,hired_at';
    const example = '001,Aziza Karimova,FEMALE,MATERNITY,Hamshira,+998901234567,aziza@example.com,3000000,2024-01-01';
    return `${headers}\n${example}`;
  }
}
