import { AttendanceController } from './attendance.controller';

describe('AttendanceController — tenant scope', () => {
  it('SUPER/ASSISTANT admin GPS resetida tanlangan muassasani servicega uzatadi', async () => {
    const service = {
      resetEmployeeGps: jest.fn(async () => ({ reset: true })),
    } as any;
    const controller = new AttendanceController(service);

    await controller.resetEmployeeGps('employee-1', null, 'hospital-1');

    expect(service.resetEmployeeGps).toHaveBeenCalledWith(
      'employee-1',
      'hospital-1',
    );
  });

  it('DIRECTOR/ADMIN uchun JWT muassasasi query qiymatidan ustun', async () => {
    const service = {
      resetEmployeeGps: jest.fn(async () => ({ reset: true })),
    } as any;
    const controller = new AttendanceController(service);

    await controller.resetEmployeeGps(
      'employee-1',
      'own-hospital',
      'other-hospital',
    );

    expect(service.resetEmployeeGps).toHaveBeenCalledWith(
      'employee-1',
      'own-hospital',
    );
  });
});
