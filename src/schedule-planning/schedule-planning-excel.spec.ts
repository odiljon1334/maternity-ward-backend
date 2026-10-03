import * as ExcelJS from 'exceljs';
import {
  MonthlySchedulePlanStatus,
  ScheduleChangeStatus,
  ScheduleChangeType,
  SchedulePlanEntryType,
} from '@prisma/client';
import { SchedulePlanningService } from './schedule-planning.service';

describe('post schedule Excel export', () => {
  it('keeps each employee hours on the correct Excel row', async () => {
    const service = new SchedulePlanningService({} as never);
    const employees = {
      gulbaxor: {
        fullName: 'Gulbaxor Yuldasheva',
        position: { name: 'Hamshira' },
      },
      oydin: {
        fullName: 'Oydin Yuldasheva',
        position: { name: 'Hamshira' },
      },
    };
    const working = (
      id: string,
      employeeId: keyof typeof employees,
      day: number,
    ) => ({
      id,
      employeeId,
      entryType: SchedulePlanEntryType.WORKING,
      workDate: new Date(
        `2026-10-${String(day).padStart(2, '0')}T00:00:00+05:00`,
      ),
      employee: employees[employeeId],
      countsTowardPostCoverage: true,
      calendarMinutes: {
        [`2026-10-${String(day).padStart(2, '0')}`]: 720,
      },
    });

    // Yozuvlar ataylab xodimlar bo'yicha aralashtirilgan. Eksport satrlarni
    // massiv indeksiga yoki familiyaga qarab emas, employeeId bo'yicha yig'ishi
    // kerak.
    const entries = [
      working('g-1', 'gulbaxor', 1),
      working('o-1', 'oydin', 2),
      working('g-2', 'gulbaxor', 3),
      working('o-2', 'oydin', 4),
      working('g-3', 'gulbaxor', 5),
      working('o-3', 'oydin', 6),
      working('g-4', 'gulbaxor', 7),
      working('g-5', 'gulbaxor', 8),
      working('g-6', 'gulbaxor', 9),
    ];
    jest.spyOn(service, 'getPlanDetails').mockResolvedValue({
      id: 'plan-72-36',
      year: 2026,
      month: 10,
      version: 1,
      status: MonthlySchedulePlanStatus.APPROVED,
      hospital: { id: 'h1', name: '2-son tug‘ruq kompleksi' },
      post: {
        name: 'Ona va bola posti',
        department: { name: 'Ona va bola bo‘limi' },
      },
      approvedBy: { username: 'director' },
      approvedAt: new Date('2026-09-30T10:00:00+05:00'),
      entries,
      changeRequests: [],
      summary: {
        targetMinutes: 744 * 60,
        plannedMinutes: 108 * 60,
        byEmployee: {
          gulbaxor: 72 * 60,
          oydin: 36 * 60,
        },
        byDate: Object.fromEntries(
          entries.map((entry) => [
            Object.keys(entry.calendarMinutes)[0],
            720,
          ]),
        ),
      },
    } as never);

    const buffer = await service.exportPlanExcel('h1', 'plan-72-36');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet('Ish jadvali');
    const totalColumn = 35; // A-C + October's 31 days + Jami
    const rowsByEmployee = new Map<string, ExcelJS.Row>();

    for (let rowNumber = 6; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const fullName = row.getCell(2).value;
      if (typeof fullName === 'string') rowsByEmployee.set(fullName, row);
    }

    const gulbaxorRow = rowsByEmployee.get('Gulbaxor Yuldasheva');
    const oydinRow = rowsByEmployee.get('Oydin Yuldasheva');
    expect(gulbaxorRow).toBeDefined();
    expect(oydinRow).toBeDefined();
    expect(gulbaxorRow?.number).not.toBe(oydinRow?.number);
    expect(gulbaxorRow?.getCell(totalColumn).value).toBe(72);
    expect(oydinRow?.getCell(totalColumn).value).toBe(36);

    const sumDayCells = (row: ExcelJS.Row) => {
      let total = 0;
      for (let column = 4; column < totalColumn; column += 1) {
        const value = row.getCell(column).value;
        if (typeof value === 'number') total += value;
      }
      return total;
    };
    expect(sumDayCells(gulbaxorRow!)).toBe(72);
    expect(sumDayCells(oydinRow!)).toBe(36);
  });

  it('renders overnight hours into separate calendar day cells', async () => {
    const service = new SchedulePlanningService({} as never);
    jest.spyOn(service, 'getPlanDetails').mockResolvedValue({
      id: 'plan-1',
      year: 2026,
      month: 9,
      version: 1,
      status: MonthlySchedulePlanStatus.APPROVED,
      hospital: { id: 'h1', name: '2-son tug‘ruq kompleksi' },
      post: {
        name: 'Akusherlik posti',
        department: { name: 'Ona va bola bo‘limi' },
      },
      approvedBy: { username: 'director' },
      approvedAt: new Date('2026-08-28T10:00:00+05:00'),
      entries: [
        {
          id: 'entry-1',
          employeeId: 'e1',
          entryType: SchedulePlanEntryType.WORKING,
          workDate: new Date('2026-09-01T00:00:00+05:00'),
          employee: {
            fullName: 'Odiljon Akramov',
            position: { name: 'Hamshira' },
          },
          calendarMinutes: {
            '2026-09-01': 240,
            '2026-09-02': 480,
          },
        },
      ],
      summary: {
        targetMinutes: 720 * 60,
        plannedMinutes: 12 * 60,
        byDate: {
          '2026-09-01': 240,
          '2026-09-02': 480,
        },
      },
    } as never);

    const buffer = await service.exportPlanExcel('h1', 'plan-1');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet('Ish jadvali');

    expect(sheet.getCell('B6').value).toBe('Odiljon Akramov');
    expect(sheet.getCell('D6').value).toBe(4);
    expect(sheet.getCell('E6').value).toBe(8);
    expect(sheet.getCell('AH6').value).toBe(12);
  });

  it('marks approved changes with dates and lists them on a second sheet', async () => {
    const service = new SchedulePlanningService({} as never);
    const employee = (fullName: string) => ({
      fullName,
      position: { name: 'Hamshira' },
    });
    const working = (id: string, employeeId: string, day: string) => ({
      id,
      employeeId,
      entryType: SchedulePlanEntryType.WORKING,
      workDate: new Date(`2026-09-${day}T00:00:00+05:00`),
      employee: employee(
        employeeId === 'e1' ? 'Aziza Karimova' : 'Bobur Aliyev',
      ),
      calendarMinutes: { [`2026-09-${day}`]: 720 },
    });
    jest.spyOn(service, 'getPlanDetails').mockResolvedValue({
      id: 'plan-1',
      year: 2026,
      month: 9,
      version: 1,
      status: MonthlySchedulePlanStatus.APPROVED,
      hospital: { id: 'h1', name: 'Klinika' },
      post: { name: 'Post 1', department: { name: 'Bo‘lim' } },
      approvedBy: { username: 'director' },
      approvedAt: new Date('2026-08-28T10:00:00+05:00'),
      entries: [working('a5', 'e1', '05'), working('b7', 'e2', '07')],
      changeRequests: [
        {
          status: ScheduleChangeStatus.REJECTED,
          type: ScheduleChangeType.ABSENCE,
          primaryEntry: { ...working('a5', 'e1', '05') },
          createdAt: new Date('2026-09-02T09:00:00+05:00'),
        },
        {
          status: ScheduleChangeStatus.APPROVED,
          type: ScheduleChangeType.SWAP,
          reason: 'Oilaviy sabab',
          primaryEntry: working('a5', 'e1', '05'),
          counterpartEntry: working('b7', 'e2', '07'),
          requestedBy: { username: 'aziza' },
          approvedBy: { username: 'director' },
          createdAt: new Date('2026-09-01T09:00:00+05:00'),
          approvedAt: new Date('2026-09-03T14:30:00+05:00'),
        },
      ],
      summary: {
        targetMinutes: 720 * 60,
        plannedMinutes: 24 * 60,
        byDate: { '2026-09-05': 720, '2026-09-07': 720 },
      },
    } as never);

    const buffer = await service.exportPlanExcel('h1', 'plan-1');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet('Ish jadvali');

    // Asl tasdiqlangan qiymat saqlanadi, katak belgilanadi.
    expect(sheet.getCell('H6').value).toBe(12);
    expect((sheet.getCell('H6').fill as any).fgColor.argb).toBe('FFFFE699');
    expect(String(sheet.getCell('H6').note)).toContain('03.09.2026 14:30');
    expect((sheet.getCell('J7').fill as any).fgColor.argb).toBe('FFFFE699');
    expect(sheet.getCell('A6').value).toBe(1);
    expect(String(sheet.getCell('A4').value)).toContain('Yuklab olingan:');

    const changes = workbook.getWorksheet('O‘zgarishlar');
    expect(changes.getCell('B3').value).toBe('05.09.2026 ↔ 07.09.2026');
    expect(changes.getCell('C3').value).toBe('Smena almashish');
    expect(changes.getCell('D3').value).toBe('Aziza Karimova');
    expect(changes.getCell('E3').value).toBe('Bobur Aliyev');
    expect(changes.getCell('K3').value).toBe('03.09.2026 14:30');
    // Rad etilgan so'rov ro'yxatga kirmaydi.
    expect(changes.getCell('A4').value).toBeNull();
  });
});
