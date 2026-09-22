import { SchedulesService } from './schedules.service';
import { BadRequestException } from '@nestjs/common';

describe('SchedulesService monthly pagination filters', () => {
  function setup() {
    const prisma = {
      employee: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      schedule: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    return {
      prisma,
      service: new SchedulesService(prisma as never),
    };
  }

  it('preserves hospital scope when department and search filters are used', async () => {
    const { prisma, service } = setup();

    await service.getMonthlySchedulesPaginated(9, 2026, 1, 30, 'hospital-1', {
      departmentId: 'department-1',
      search: 'Qodirova',
    });

    const where = prisma.employee.findMany.mock.calls[0][0].where;
    expect(where.hospitalId).toBe('hospital-1');
    expect(where.departmentId).toBe('department-1');
    expect(where.OR).toEqual(
      expect.arrayContaining([
        {
          fullName: {
            contains: 'қодирова',
            mode: 'insensitive',
          },
        },
      ]),
    );
    expect(prisma.employee.count).toHaveBeenCalledWith({ where });
  });

  it('filters grafikli employees inside the requested month', async () => {
    const { prisma, service } = setup();

    await service.getMonthlySchedulesPaginated(9, 2026, 1, 30, 'hospital-1', {
      scheduleFilter: 'with',
    });

    const where = prisma.employee.findMany.mock.calls[0][0].where;
    expect(where.schedules.some.date.gte).toBeInstanceOf(Date);
    expect(where.schedules.some.date.lte).toBeInstanceOf(Date);
    expect(where.schedules.some.date.gte.getTime()).toBeLessThan(
      where.schedules.some.date.lte.getTime(),
    );
  });

  it('keeps the legacy unfiltered query when no optional filters are sent', async () => {
    const { prisma, service } = setup();

    await service.getMonthlySchedulesPaginated(9, 2026, 1, 30, 'hospital-1');

    expect(prisma.employee.findMany.mock.calls[0][0].where).toEqual({
      firedAt: null,
      hospitalId: 'hospital-1',
    });
  });

  it('blocks direct edits for schedules published from a post plan', async () => {
    const prisma = {
      schedule: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'schedule-1',
          sourcePlanId: 'plan-1',
        }),
        update: jest.fn(),
      },
    };
    const service = new SchedulesService(prisma as never);

    await expect(
      service.updateEntry('schedule-1', { status: 'DAY_OFF' }, 'hospital-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.schedule.update).not.toHaveBeenCalled();
  });

  it('blocks bulk changes that would overwrite a post-plan schedule', async () => {
    const prisma = {
      employee: {
        findMany: jest.fn().mockResolvedValue([{ id: 'employee-1' }]),
      },
      schedule: {
        findMany: jest.fn().mockImplementation(({ where }) =>
          Promise.resolve([
            {
              id: 'schedule-1',
              date: where.date.in[0],
              shiftId: 'shift-1',
              status: 'WORKING',
              note: null,
              sourcePlanId: 'plan-1',
            },
          ]),
        ),
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const service = new SchedulesService(prisma as never);

    await expect(
      service.bulkManual(
        {
          employeeId: 'employee-1',
          entries: [
            {
              date: '2026-09-01',
              shiftId: 'shift-2',
              status: 'WORKING',
            },
          ],
        },
        'hospital-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.schedule.updateMany).not.toHaveBeenCalled();
  });
});
