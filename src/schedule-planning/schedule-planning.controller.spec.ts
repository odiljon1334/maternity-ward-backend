import { StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { SchedulePlanningController } from './schedule-planning.controller';
import { SchedulePlanningService } from './schedule-planning.service';

describe('SchedulePlanningController export', () => {
  it('returns the generated workbook with download-safe XLSX headers', async () => {
    const workbook = Buffer.from('xlsx-regression-fixture');
    const service = {
      exportPlanExcel: jest.fn().mockResolvedValue(workbook),
    } as unknown as SchedulePlanningService;
    const controller = new SchedulePlanningController(service);
    const setHeader = jest.fn();
    const response = { setHeader } as unknown as Response;

    const result = await controller.exportPlan(
      'plan-72-36',
      'hospital-1',
      undefined,
      response,
    );

    expect(service.exportPlanExcel).toHaveBeenCalledWith(
      'hospital-1',
      'plan-72-36',
    );
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="post-grafik-plan-72-36.xlsx"',
    );
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Length',
      String(workbook.length),
    );
    expect(result).toBeInstanceOf(StreamableFile);
  });

  it('uses targetHospitalId when a super admin has no fixed hospital', async () => {
    const service = {
      exportPlanExcel: jest.fn().mockResolvedValue(Buffer.from('xlsx')),
    } as unknown as SchedulePlanningService;
    const controller = new SchedulePlanningController(service);
    const response = { setHeader: jest.fn() } as unknown as Response;

    await controller.exportPlan('plan-1', null, 'selected-hospital', response);

    expect(service.exportPlanExcel).toHaveBeenCalledWith(
      'selected-hospital',
      'plan-1',
    );
  });
});
