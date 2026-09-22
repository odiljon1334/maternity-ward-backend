import { SchedulesService } from './schedules.service';

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
});
