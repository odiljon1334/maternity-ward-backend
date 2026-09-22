import * as ExcelJS from 'exceljs';
import {
  MonthlySchedulePlanStatus,
  SchedulePlanEntryType,
} from '@prisma/client';
import { SchedulePlanningService } from './schedule-planning.service';

describe('post schedule Excel export', () => {
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
});
