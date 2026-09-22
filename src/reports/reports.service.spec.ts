import * as ExcelJS from 'exceljs';
import { ReportsService } from './reports.service';

/**
 * ReportsService.generateT13Excel uchun unit test — StaffPulse rejasi,
 * "T-13 tabelini bir tugma bilan 1C'ga uzatish" (2026-09-20).
 *
 * Bu test HAQIQIY faylni generatsiya qilib, ExcelJS bilan qayta o'qiydi va
 * kod (Я/Н/В/ОТ/Б) va soat ustunlari to'g'ri joyga to'g'ri qiymat bilan
 * yozilganini tekshiradi — chunki bu yerdagi eng xato-moyil qism aynan
 * status→kod moslashtirish va ustun indekslash mantig'i.
 */

function makeFakePrisma(employees: any[], hospital: any = null) {
  return {
    employee: {
      findMany: jest.fn(async () => employees),
    },
    hospital: {
      findUnique: jest.fn(async () => hospital),
    },
  };
}

function makeFakeAttendanceService(byEmployeeId: Record<string, any[]>) {
  return {
    getEmployeeAttendance: jest.fn(async (employeeId: string) => ({
      records: byEmployeeId[employeeId] ?? [],
      stats: {},
    })),
  };
}

describe('ReportsService.generateT13Excel', () => {
  const YEAR = 2026;
  const MONTH = 9; // 30 kunlik oy

  it("holat kodlarini (Я/Н/В/ОТ/Б) to'g'ri ustunlarga yozadi va jami ustunlarni hisoblaydi", async () => {
    const emp = {
      id: 'emp-1',
      fullName: 'Alisher Odilov',
      department: { name: 'Kardiologiya' },
      position: { name: 'Hamshira' },
    };

    // 1-kun: ishladi (180 daqiqa = 3 soat), 2-kun: kelmadi, 3-kun: dam olish,
    // 4-kun: ta'til, 5-kun: kasallik — qolgan kunlar uchun yozuv yo'q (bo'sh).
    const records = [
      {
        workDate: new Date(YEAR, MONTH - 1, 1),
        status: 'PRESENT',
        netWorkMin: 180,
      },
      {
        workDate: new Date(YEAR, MONTH - 1, 2),
        status: 'ABSENT',
        netWorkMin: 0,
      },
      {
        workDate: new Date(YEAR, MONTH - 1, 3),
        status: 'DAY_OFF',
        netWorkMin: 0,
      },
      {
        workDate: new Date(YEAR, MONTH - 1, 4),
        status: 'VACATION',
        netWorkMin: 0,
      },
      { workDate: new Date(YEAR, MONTH - 1, 5), status: 'SICK', netWorkMin: 0 },
    ];

    const prisma = makeFakePrisma([emp], { name: 'Test Poliklinika' });
    const attendance = makeFakeAttendanceService({ 'emp-1': records });
    const svc = new ReportsService(prisma as any, attendance as any);

    const buffer = await svc.generateT13Excel({
      month: MONTH,
      year: YEAR,
      hospitalId: 'hosp-1',
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.worksheets[0];

    // Kod qatori — 6-qator (4-header, 5-kod sarlavhasi, 6-birinchi xodim kodi)
    const codeRow = sheet.getRow(6);
    const hoursRow = sheet.getRow(7);

    // 1-kun ustuni = 4 (F.I.O/Bo'lim/Lavozim) + 1 = 5-ustun
    expect(codeRow.getCell(5).value).toBe('Я'); // 1-kun: PRESENT
    expect(hoursRow.getCell(5).value).toBe(3); // 180 daqiqa = 3 soat
    expect(codeRow.getCell(6).value).toBe('Н'); // 2-kun: ABSENT
    expect(hoursRow.getCell(6).value).toBe(''); // ishlamagan kun uchun soat yo'q
    expect(codeRow.getCell(7).value).toBe('В'); // 3-kun: DAY_OFF
    expect(codeRow.getCell(8).value).toBe('ОТ'); // 4-kun: VACATION
    expect(codeRow.getCell(9).value).toBe('Б'); // 5-kun: SICK
    expect(codeRow.getCell(10).value).toBe(''); // 6-kun: yozuv yo'q — bo'sh

    // Jami ustunlar (Я, ОТ, Б, Н) — daysInMonth (30) dan keyin, 4+30=34-ustundan boshlab
    const totalsStart = 4 + 30;
    expect(sheet.getCell(6, totalsStart + 1).value).toBe(1); // Я soni
    expect(sheet.getCell(6, totalsStart + 2).value).toBe(1); // ОТ soni
    expect(sheet.getCell(6, totalsStart + 3).value).toBe(1); // Б soni
    expect(sheet.getCell(6, totalsStart + 4).value).toBe(1); // Н soni
  });

  it("xodim yo'q bo'lsa — xatosiz bo'sh jadval generatsiya qiladi", async () => {
    const prisma = makeFakePrisma([]);
    const attendance = makeFakeAttendanceService({});
    const svc = new ReportsService(prisma as any, attendance as any);

    const buffer = await svc.generateT13Excel({ month: MONTH, year: YEAR });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    expect(workbook.worksheets[0]).toBeDefined();
  });

  it('LATE/EARLY_LEAVE/LATE_EARLY — barchasi "Я" (ishladi) sifatida hisoblanadi', async () => {
    const emp = {
      id: 'emp-2',
      fullName: 'Malika Yusupova',
      department: { name: 'Pediatriya' },
      position: { name: 'Shifokor' },
    };
    const records = [
      {
        workDate: new Date(YEAR, MONTH - 1, 1),
        status: 'LATE',
        netWorkMin: 120,
      },
      {
        workDate: new Date(YEAR, MONTH - 1, 2),
        status: 'EARLY_LEAVE',
        netWorkMin: 90,
      },
      {
        workDate: new Date(YEAR, MONTH - 1, 3),
        status: 'LATE_EARLY',
        netWorkMin: 60,
      },
    ];

    const prisma = makeFakePrisma([emp]);
    const attendance = makeFakeAttendanceService({ 'emp-2': records });
    const svc = new ReportsService(prisma as any, attendance as any);

    const buffer = await svc.generateT13Excel({ month: MONTH, year: YEAR });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.worksheets[0];
    const codeRow = sheet.getRow(6);

    expect(codeRow.getCell(5).value).toBe('Я');
    expect(codeRow.getCell(6).value).toBe('Я');
    expect(codeRow.getCell(7).value).toBe('Я');

    const totalsStart = 4 + 30;
    expect(sheet.getCell(6, totalsStart + 1).value).toBe(3); // 3 kun ham "ishladi" deb hisoblanadi
  });
});

describe('ReportsService.generateAttendanceExcel', () => {
  it('ish kunlari kelgan va kelmagan kunlar yig‘indisiga teng bo‘ladi', async () => {
    const attendances = [
      ...Array.from({ length: 13 }, (_, index) => ({
        workDate: new Date(2026, 8, index + 1),
        status: 'PRESENT',
      })),
      { workDate: new Date(2026, 8, 14), status: 'ABSENT' },
    ];
    const employee = {
      id: 'emp-1',
      fullName: 'Test Xodim',
      department: { name: 'Test bo‘lim' },
      position: { name: 'Test lavozim' },
      attendances,
    };
    const svc = new ReportsService(
      makeFakePrisma([employee]) as any,
      makeFakeAttendanceService({}) as any,
    );

    const buffer = await svc.generateAttendanceExcel({
      month: 9,
      year: 2026,
      hospitalId: 'hospital-1',
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const row = workbook.worksheets[0].getRow(3);

    expect(row.getCell(5).value).toBe(14); // jami ish kuni
    expect(row.getCell(6).value).toBe(13); // keldi
    expect(row.getCell(7).value).toBe(1); // kelmadi
  });
});

describe('ReportsService.generateWeeklyExcel', () => {
  it('grafik bo‘lmagan ish kunlarini kelmadi deb hisoblamaydi', async () => {
    const prisma = {
      employee: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'emp-1',
            fullName: 'Test Xodim',
            department: { name: 'Test bo‘lim' },
            position: { name: 'Test lavozim' },
          },
        ]),
      },
      attendanceRecord: { findMany: jest.fn().mockResolvedValue([]) },
      schedule: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const svc = new ReportsService(prisma as any, {} as any);

    const buffer = await svc.generateWeeklyExcel({
      weekStart: '2026-09-21',
      hospitalId: 'hospital-1',
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const row = workbook.worksheets[0].getRow(2);

    expect(row.getCell(12).value).toBe(0); // keldi
    expect(row.getCell(13).value).toBe(0); // kelmadi
  });
});
