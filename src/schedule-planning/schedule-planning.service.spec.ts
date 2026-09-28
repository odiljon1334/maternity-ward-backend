import { BadRequestException } from '@nestjs/common';
import { SchedulePlanningMode } from '@prisma/client';
import {
  calculateMonthlyCoverageMinutes,
  SchedulePlanningService,
} from './schedule-planning.service';
import dayjs from 'dayjs';

describe('SchedulePlanningService', () => {
  function setup(mode: SchedulePlanningMode) {
    const prisma = {
      hospital: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'hospital-1',
          name: 'Muassasa',
          schedulePlanningMode: mode,
        }),
      },
      department: {
        findFirst: jest.fn().mockResolvedValue({ id: 'department-1' }),
      },
      schedulePost: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'post-1',
          dailyCoverageMinutes: 1440,
        }),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => data),
        update: jest.fn().mockImplementation(({ data }) => data),
        delete: jest.fn().mockResolvedValue({ id: 'post-1' }),
      },
      monthlySchedulePlan: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'plan-1',
          ...data,
        })),
      },
      monthlyScheduleEntry: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      employee: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      scheduleChangeRequest: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockImplementation(({ data }) => ({
          id: 'change-1',
          ...data,
        })),
      },
      schedule: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };

    return {
      prisma,
      service: new SchedulePlanningService(prisma as never),
    };
  }

  it('calculates 720 and 744 hours for a 24/7 post', () => {
    expect(calculateMonthlyCoverageMinutes(2026, 9, 1440) / 60).toBe(720);
    expect(calculateMonthlyCoverageMinutes(2026, 10, 1440) / 60).toBe(744);
  });

  it('blocks post writes for STANDARD hospitals', async () => {
    const { prisma, service } = setup(SchedulePlanningMode.STANDARD);

    await expect(
      service.createPost('hospital-1', {
        name: 'Akusherlik posti',
        code: 'POST-1',
        departmentId: 'department-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.department.findFirst).not.toHaveBeenCalled();
    expect(prisma.schedulePost.create).not.toHaveBeenCalled();
  });

  it('creates a post only inside the selected hospital', async () => {
    const { prisma, service } = setup(SchedulePlanningMode.POST_COVERAGE);

    await service.createPost('hospital-1', {
      name: ' Akusherlik posti ',
      code: ' post-1 ',
      departmentId: 'department-1',
    });

    expect(prisma.department.findFirst).toHaveBeenCalledWith({
      where: { id: 'department-1', hospitalId: 'hospital-1' },
      select: { id: true },
    });
    expect(prisma.schedulePost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hospitalId: 'hospital-1',
          departmentId: 'department-1',
          name: 'Akusherlik posti',
          code: 'POST-1',
          dailyCoverageMinutes: 1440,
        }),
      }),
    );
  });

  it('returns the monthly coverage target when a draft is created', async () => {
    const { service } = setup(SchedulePlanningMode.POST_COVERAGE);

    const result = await service.createDraftPlan('hospital-1', 'user-1', {
      postId: 'post-1',
      year: 2026,
      month: 9,
    });

    expect(result.version).toBe(1);
    expect(result.targetCoverageHours).toBe(720);
  });

  it('archives a post without deleting its schedule history', async () => {
    const { prisma, service } = setup(SchedulePlanningMode.POST_COVERAGE);
    prisma.schedulePost.findFirst.mockResolvedValue({ id: 'post-1' });

    await service.setPostStatus('hospital-1', 'post-1', false);

    expect(prisma.schedulePost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'post-1' },
        data: { isActive: false },
      }),
    );
  });

  it('does not delete a post that already has plans', async () => {
    const { prisma, service } = setup(SchedulePlanningMode.POST_COVERAGE);
    prisma.schedulePost.findFirst.mockResolvedValue({
      id: 'post-1',
      _count: { plans: 1 },
    });

    await expect(
      service.removePost('hospital-1', 'post-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.schedulePost.delete).not.toHaveBeenCalled();
  });

  it('does not expose another employee shift-change options', async () => {
    const { prisma, service } = setup(SchedulePlanningMode.POST_COVERAGE);
    prisma.monthlyScheduleEntry.findFirst.mockResolvedValue({
      id: 'entry-1',
      employeeId: 'employee-2',
      entryType: 'WORKING',
      plan: { status: 'APPROVED' },
      employee: {
        id: 'employee-2',
        userId: 'user-2',
        departmentId: 'department-1',
        fullName: 'Boshqa xodim',
      },
      shift: { id: 'shift-1' },
    });

    await expect(
      service.getMyChangeOptions('hospital-1', 'user-1', 'entry-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
  });

  it('POST_COVERAGE create API 31 kundan uzoq o‘zgarishni rad etadi', async () => {
    const { prisma, service } = setup(SchedulePlanningMode.POST_COVERAGE);
    prisma.monthlyScheduleEntry.findFirst.mockResolvedValue({
      id: 'entry-1',
      employeeId: 'employee-1',
      shiftId: 'shift-1',
      entryType: 'WORKING',
      startsAt: new Date(),
      endsAt: new Date(),
      workDate: dayjs().add(32, 'day').toDate(),
      planId: 'plan-1',
      plan: { id: 'plan-1', status: 'APPROVED' },
      employee: {
        id: 'employee-1',
        userId: 'user-1',
        departmentId: 'department-1',
      },
    });

    await expect(
      service.createChangeRequest('hospital-1', 'user-1', 'EMPLOYEE', {
        type: 'ABSENCE',
        primaryEntryId: 'entry-1',
        absenceEntryType: 'SICK',
        reason: 'Davolanish kerak',
      } as never),
    ).rejects.toThrow('31 kun');
  });

  it('POST_COVERAGE o‘rinbosarlikni tasdiqlaganda ish soatini o‘rinbosarga yozadi', async () => {
    const { prisma, service } = setup(SchedulePlanningMode.POST_COVERAGE);
    const workDate = dayjs().add(2, 'day').startOf('day').toDate();
    prisma.scheduleChangeRequest.findFirst.mockResolvedValue({
      id: 'change-1',
      hospitalId: 'hospital-1',
      planId: 'plan-1',
      type: 'SUBSTITUTION',
      status: 'ACCEPTED',
      requestedById: 'user-1',
      replacementEmployeeId: 'employee-2',
      absenceEntryType: 'SICK',
      primaryEntry: {
        id: 'entry-1',
        employeeId: 'employee-1',
        shiftId: 'shift-12h',
        workDate,
      },
      counterpartEntry: null,
      replacementEmployee: { userId: 'user-2' },
      requestedBy: { role: 'EMPLOYEE' },
    });

    await service.approveChangeRequest('hospital-1', 'change-1', 'director-1');

    expect(prisma.schedule.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        update: expect.objectContaining({ status: 'SICK', shiftId: null }),
      }),
    );
    expect(prisma.schedule.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        create: expect.objectContaining({
          employeeId: 'employee-2',
          shiftId: 'shift-12h',
          status: 'WORKING',
          scheduleChangeRequestId: 'change-1',
        }),
      }),
    );
  });

  it('POST_COVERAGE ikki kunlik SWAPni audit izi bilan qo‘llaydi', async () => {
    const { prisma, service } = setup(SchedulePlanningMode.POST_COVERAGE);
    const firstDate = dayjs().add(2, 'day').startOf('day').toDate();
    const secondDate = dayjs().add(4, 'day').startOf('day').toDate();
    prisma.scheduleChangeRequest.findFirst.mockResolvedValue({
      id: 'change-swap',
      hospitalId: 'hospital-1',
      planId: 'plan-1',
      type: 'SWAP',
      status: 'ACCEPTED',
      requestedById: 'user-1',
      replacementEmployeeId: 'employee-2',
      absenceEntryType: null,
      primaryEntry: {
        id: 'entry-1',
        employeeId: 'employee-1',
        shiftId: 'shift-day',
        workDate: firstDate,
      },
      counterpartEntry: {
        id: 'entry-2',
        planId: 'plan-1',
        employeeId: 'employee-2',
        shiftId: 'shift-night',
        workDate: secondDate,
        employee: { userId: 'user-2' },
      },
      replacementEmployee: { userId: 'user-2' },
      requestedBy: { role: 'EMPLOYEE' },
    });

    await service.approveChangeRequest(
      'hospital-1',
      'change-swap',
      'director-1',
    );

    expect(prisma.schedule.update).toHaveBeenCalledTimes(2);
    expect(prisma.schedule.upsert).toHaveBeenCalledTimes(2);
    for (const call of prisma.schedule.upsert.mock.calls) {
      expect(call[0].create.scheduleChangeRequestId).toBe('change-swap');
    }
  });
});
