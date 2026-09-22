import { ReportsController } from './reports.controller';

describe('ReportsController tenant scope', () => {
  it('Director queryda boshqa targetHospitalId yuborsa ham JWT muassasasidan hisobot oladi', async () => {
    const reportsService = {
      generateAttendanceExcel: jest.fn().mockResolvedValue(Buffer.from('xlsx')),
    };
    const response = {
      set: jest.fn(),
      send: jest.fn(),
    };
    const controller = new ReportsController(reportsService as any);

    await controller.attendanceExcel(
      'jwt-hospital',
      '9',
      '2026',
      '',
      'other-hospital',
      response as any,
    );

    expect(reportsService.generateAttendanceExcel).toHaveBeenCalledWith(
      expect.objectContaining({ hospitalId: 'jwt-hospital' }),
    );
  });
});
