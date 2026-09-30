import { ConflictException } from '@nestjs/common';
import {
  MonthlySchedulePlanStatus,
  ScheduleChangeStatus,
  SchedulePlanEntryType,
  SchedulePlanningMode,
  ScheduleStatus,
} from '@prisma/client';
import { SchedulePlanningService } from './schedule-planning.service';

/**
 * Production xavfsizligi: ta'til ustidan yozmaslik, takroriy/parallel
 * tasdiqlash, qayta ochish va bir vaqtda tahrirlash.
 */
describe('SchedulePlanningService — production xavfsizligi', () => {
  const OCT_1 = new Date('2026-09-30T19:00:00Z'); // 1-oktabr, Toshkent
  const OCT_2 = new Date('2026-10-01T19:00:00Z');

  function setup() {
    const prisma: any = {
      hospital: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'hospital-1',
          schedulePlanningMode: SchedulePlanningMode.POST_COVERAGE,
        }),
      },
      monthlySchedulePlan: {
        findFirst: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ id: 'plan-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      monthlyScheduleEntry: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      employee: {
        findMany: jest.fn().mockResolvedValue([{ id: 'employee-1' }]),
      },
      shiftTemplate: {
        findMany: jest.fn().mockResolvedValue([{ id: 'shift-1' }]),
      },
      scheduleChangeRequest: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ id: 'change-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
      schedule: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      attendanceRecord: { count: jest.fn().mockResolvedValue(0) },
      $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    const service = new SchedulePlanningService(prisma);
    return { prisma, service };
  }

  const working = (id: string, workDate: Date) => ({
    id,
    employeeId: 'employee-1',
    shiftId: 'shift-1',
    entryType: SchedulePlanEntryType.WORKING,
    workDate,
    note: null,
  });

  function submittedPlan(service: SchedulePlanningService, entries: any[]) {
    jest.spyOn(service as any, 'getPlanForWorkflow').mockResolvedValue({
      id: 'plan-1',
      year: 2026,
      month: 10,
      status: MonthlySchedulePlanStatus.SUBMITTED,
      entries,
    });
    jest
      .spyOn(service as any, 'buildPlanSummary')
      .mockReturnValue({ remainingMinutes: 0, excessMinutes: 0 });
  }

  describe('postdan tashqari grafik', () => {
    const dayShift = (employeeId: string, day: number, counts: boolean) => ({
      id: `${employeeId}-${day}`,
      employeeId,
      shiftId: 'shift-1',
      entryType: SchedulePlanEntryType.WORKING,
      countsTowardPostCoverage: counts,
      workDate: new Date(Date.UTC(2026, 9, day - 1, 19)),
      startsAt: new Date(
        `2026-10-${String(day).padStart(2, '0')}T08:00:00+05:00`,
      ),
      endsAt: new Date(
        `2026-10-${String(day).padStart(2, '0')}T16:00:00+05:00`,
      ),
      note: null,
    });
    const draftWith = (entries: any[]) => ({
      id: 'plan-1',
      year: 2026,
      month: 10,
      status: MonthlySchedulePlanStatus.DRAFT,
      coverageMode: 'CONTINUOUS_24_7',
      dailyCoverageMinutes: 1440,
      coverageMinutesByWeekday: null,
      post: { coverageMode: 'CONTINUOUS_24_7', dailyCoverageMinutes: 1440 },
      entries,
    });

    it('faqat postdan tashqari xodimlar grafigi 744 soat talab qilmasdan yuboriladi', async () => {
      const { prisma, service } = setup();
      jest
        .spyOn(service as any, 'getPlanForWorkflow')
        .mockResolvedValue(
          draftWith([
            dayShift('employee-1', 1, false),
            dayShift('employee-1', 2, false),
          ]),
        );

      await service.submitPlan('hospital-1', 'plan-1');

      expect(prisma.monthlySchedulePlan.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: MonthlySchedulePlanStatus.SUBMITTED,
          }),
        }),
      );
    });

    it('post xodimi bor grafikda norma hali ham talab qilinadi', async () => {
      const { service } = setup();
      jest
        .spyOn(service as any, 'getPlanForWorkflow')
        .mockResolvedValue(
          draftWith([
            dayShift('employee-1', 1, true),
            dayShift('employee-2', 1, false),
          ]),
        );

      await expect(service.submitPlan('hospital-1', 'plan-1')).rejects.toThrow(
        /normasi to‘liq taqsimlanmagan: 8\/744/,
      );
    });

    it("oldingi oydan o'tgan post smenasi (carry-in) normani majburiy qilmaydi", async () => {
      const { service } = setup();
      jest
        .spyOn(service as any, 'getPlanForWorkflow')
        .mockResolvedValue(
          draftWith([
            { ...dayShift('employee-9', 1, true), isCarryIn: true },
            dayShift('employee-1', 2, false),
          ]),
        );

      await expect(
        service.submitPlan('hospital-1', 'plan-1'),
      ).resolves.toBeDefined();
    });

    it('bo‘sh grafik yuborilmaydi', async () => {
      const { service } = setup();
      jest
        .spyOn(service as any, 'getPlanForWorkflow')
        .mockResolvedValue(draftWith([]));

      await expect(service.submitPlan('hospital-1', 'plan-1')).rejects.toThrow(
        /birorta ham katak yo‘q/,
      );
    });

    it('xulosada postCoverageRequired belgisi qaytadi', () => {
      const { service } = setup();
      const outsideOnly = (service as any).buildPlanSummary(
        draftWith([dayShift('employee-1', 1, false)]),
      );
      const withPost = (service as any).buildPlanSummary(
        draftWith([dayShift('employee-1', 1, true)]),
      );
      expect(outsideOnly.postCoverageRequired).toBe(false);
      expect(withPost.postCoverageRequired).toBe(true);
    });
  });

  describe('approvePlan', () => {
    it("tasdiqlangan ta'til kunini ish kuniga aylantirmaydi", async () => {
      const { prisma, service } = setup();
      submittedPlan(service, [working('e-1', OCT_1), working('e-2', OCT_2)]);
      prisma.schedule.findMany.mockResolvedValue([
        {
          employeeId: 'employee-1',
          date: OCT_1,
          status: ScheduleStatus.VACATION,
          note: "Ta'til: Yillik ta'til",
        },
      ]);

      const result: any = await service.approvePlan(
        'hospital-1',
        'plan-1',
        'director-1',
      );

      // Ta'til kuni: holat va izoh o'zgarmaydi, reja preLeaveStatus'ga yoziladi
      expect(prisma.schedule.update).toHaveBeenCalledWith({
        where: { employeeId_date: { employeeId: 'employee-1', date: OCT_1 } },
        data: expect.objectContaining({
          preLeaveStatus: ScheduleStatus.WORKING,
          shiftId: 'shift-1',
          sourcePlanId: 'plan-1',
        }),
      });
      expect(prisma.schedule.update.mock.calls[0][0].data).not.toHaveProperty(
        'status',
      );
      // Oddiy kun odatdagidek nashr qilinadi
      expect(prisma.schedule.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.schedule.upsert.mock.calls[0][0].where).toEqual({
        employeeId_date: { employeeId: 'employee-1', date: OCT_2 },
      });
      expect(result.leaveConflicts).toEqual([
        {
          employeeId: 'employee-1',
          date: OCT_1,
          leaveStatus: ScheduleStatus.VACATION,
        },
      ]);
    });

    it("qo'lda qo'yilgan (ta'tilsiz) kasallik belgisi odatdagidek almashadi", async () => {
      const { prisma, service } = setup();
      submittedPlan(service, [working('e-1', OCT_1)]);
      prisma.schedule.findMany.mockResolvedValue([
        {
          employeeId: 'employee-1',
          date: OCT_1,
          status: ScheduleStatus.SICK,
          note: null,
        },
      ]);

      await service.approvePlan('hospital-1', 'plan-1', 'director-1');

      expect(prisma.schedule.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.schedule.update).not.toHaveBeenCalled();
    });

    it('ikkinchi (parallel) tasdiqlash grafikka tegmaydi', async () => {
      const { prisma, service } = setup();
      submittedPlan(service, [working('e-1', OCT_1)]);
      prisma.monthlySchedulePlan.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approvePlan('hospital-1', 'plan-1', 'director-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.schedule.upsert).not.toHaveBeenCalled();
      expect(prisma.monthlySchedulePlan.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'plan-1',
          hospitalId: 'hospital-1',
          status: MonthlySchedulePlanStatus.SUBMITTED,
        },
        data: expect.objectContaining({
          status: MonthlySchedulePlanStatus.APPROVED,
        }),
      });
    });
  });

  describe('approveChangeRequest', () => {
    it('ikkinchi tasdiqlash almashishni qayta qo‘llamaydi', async () => {
      const { prisma, service } = setup();
      const inTwoDays = new Date(Date.now() + 2 * 86_400_000);
      prisma.scheduleChangeRequest.findFirst.mockResolvedValue({
        id: 'change-1',
        planId: 'plan-1',
        type: 'SWAP',
        status: ScheduleChangeStatus.ACCEPTED,
        requestedById: 'user-1',
        primaryEntry: {
          id: 'e-1',
          employeeId: 'employee-1',
          shiftId: 'a',
          workDate: inTwoDays,
        },
        counterpartEntry: {
          id: 'e-2',
          planId: 'plan-1',
          employeeId: 'employee-2',
          shiftId: 'b',
          workDate: inTwoDays,
          employee: { userId: 'user-2' },
        },
        replacementEmployee: null,
        requestedBy: { role: 'EMPLOYEE' },
      });
      prisma.scheduleChangeRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approveChangeRequest('hospital-1', 'change-1', 'director-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.schedule.update).not.toHaveBeenCalled();
      expect(prisma.scheduleChangeRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            plan: { status: MonthlySchedulePlanStatus.APPROVED },
          }),
        }),
      );
    });

    it('ikkinchi rad etish 409 qaytaradi', async () => {
      const { prisma, service } = setup();
      prisma.scheduleChangeRequest.findFirst.mockResolvedValue({
        id: 'change-1',
        status: ScheduleChangeStatus.REQUESTED,
        requestedById: 'user-1',
      });
      prisma.scheduleChangeRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.rejectChangeRequest(
          'hospital-1',
          'change-1',
          'director-1',
          'yo‘q',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('reopenApprovedPlan', () => {
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-30T10:00:00+05:00'));
    });
    afterEach(() => jest.useRealTimers());

    const approvedOctober = {
      id: 'plan-1',
      year: 2026,
      month: 10,
      status: MonthlySchedulePlanStatus.APPROVED,
    };

    it('tasdiqlangan smena o‘zgarishi bo‘lsa qayta ochilmaydi', async () => {
      const { prisma, service } = setup();
      prisma.monthlySchedulePlan.findFirst.mockResolvedValue(approvedOctober);
      prisma.scheduleChangeRequest.count.mockResolvedValue(1);

      await expect(
        service.reopenApprovedPlan('hospital-1', 'plan-1', 'xato'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.schedule.deleteMany).not.toHaveBeenCalled();
      expect(prisma.monthlySchedulePlan.updateMany).not.toHaveBeenCalled();
    });

    it("kutilayotgan so'rovlarni bekor qiladi va ta'til kunlarini o'chirmaydi", async () => {
      const { prisma, service } = setup();
      prisma.monthlySchedulePlan.findFirst.mockResolvedValue(approvedOctober);

      await service.reopenApprovedPlan('hospital-1', 'plan-1', 'xato');

      expect(prisma.scheduleChangeRequest.updateMany).toHaveBeenCalledWith({
        where: {
          planId: 'plan-1',
          status: {
            in: [ScheduleChangeStatus.REQUESTED, ScheduleChangeStatus.ACCEPTED],
          },
        },
        data: expect.objectContaining({
          status: ScheduleChangeStatus.CANCELLED,
        }),
      });
      // Ta'til kunlari faqat rejadan uziladi
      expect(prisma.schedule.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            sourcePlanId: 'plan-1',
            note: { startsWith: "Ta'til: " },
          }),
          data: expect.objectContaining({ sourcePlanId: null }),
        }),
      );
      // Qolganlari o'chiriladi — ta'til kunlaridan tashqari
      expect(prisma.schedule.deleteMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          sourcePlanId: 'plan-1',
          NOT: expect.objectContaining({ note: { startsWith: "Ta'til: " } }),
        }),
      });
    });
  });

  describe('saveEntries', () => {
    const draft = {
      id: 'plan-1',
      hospitalId: 'hospital-1',
      postId: 'post-1',
      year: 2026,
      month: 10,
      status: MonthlySchedulePlanStatus.DRAFT,
      post: { id: 'post-1', departmentId: 'department-1' },
    };
    const input = {
      employeeId: 'employee-1',
      shiftId: 'shift-1',
      entryType: SchedulePlanEntryType.WORKING,
      workDate: '2026-10-01',
      startsAt: '2026-10-01T08:00:00+05:00',
      endsAt: '2026-10-01T20:00:00+05:00',
    };

    /** Faqat shu rejaning o'z kataklari (boshqa postlar bo'sh) */
    function ownEntries(prisma: any, rows: any[]) {
      prisma.monthlyScheduleEntry.findMany.mockImplementation(
        async ({ where }: any) => (where.planId === 'plan-1' ? rows : []),
      );
    }

    function prepare() {
      const ctx = setup();
      ctx.prisma.monthlySchedulePlan.findFirst.mockResolvedValue(draft);
      jest
        .spyOn(ctx.service as any, 'withCanonicalCarryIn')
        .mockImplementation(async (...args: any[]) => args[4]);
      jest.spyOn(ctx.service, 'getPlanDetails').mockResolvedValue({} as never);
      return ctx;
    }

    it('orada boshqa foydalanuvchi saqlagan bo‘lsa yozmaydi (409)', async () => {
      const { prisma, service } = prepare();
      prisma.monthlySchedulePlan.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.saveEntries('hospital-1', 'plan-1', {
          expectedUpdatedAt: '2026-09-29T10:00:00.000Z',
          entries: [input],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.monthlySchedulePlan.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'plan-1',
          hospitalId: 'hospital-1',
          status: MonthlySchedulePlanStatus.DRAFT,
          updatedAt: new Date('2026-09-29T10:00:00.000Z'),
        },
        data: { updatedAt: expect.any(Date) },
      });
      expect(prisma.monthlyScheduleEntry.createMany).not.toHaveBeenCalled();
      expect(prisma.monthlyScheduleEntry.deleteMany).not.toHaveBeenCalled();
    });

    it('mavjud katakni o‘chirib-qayta yaratmaydi, joyida yangilaydi', async () => {
      const { prisma, service } = prepare();
      ownEntries(prisma, [
        {
          id: 'kept-entry',
          employeeId: 'employee-1',
          workDate: OCT_1,
          shiftId: 'old-shift',
          entryType: SchedulePlanEntryType.WORKING,
          countsTowardPostCoverage: true,
          startsAt: new Date('2026-10-01T08:00:00+05:00'),
          endsAt: new Date('2026-10-01T16:00:00+05:00'),
          note: null,
        },
      ]);

      await service.saveEntries('hospital-1', 'plan-1', { entries: [input] });

      expect(prisma.monthlyScheduleEntry.update).toHaveBeenCalledWith({
        where: { id: 'kept-entry' },
        data: expect.objectContaining({ shiftId: 'shift-1' }),
      });
      expect(prisma.monthlyScheduleEntry.deleteMany).not.toHaveBeenCalled();
      expect(prisma.monthlyScheduleEntry.createMany).not.toHaveBeenCalled();
    });

    it("smena so'rovi bog'langan katakni o'chirishni tushunarli 409 bilan rad etadi", async () => {
      const { prisma, service } = prepare();
      ownEntries(prisma, [
        {
          id: 'referenced-entry',
          employeeId: 'employee-1',
          workDate: OCT_2,
          shiftId: 'shift-1',
          entryType: SchedulePlanEntryType.WORKING,
          countsTowardPostCoverage: true,
          startsAt: null,
          endsAt: null,
          note: null,
        },
      ]);
      prisma.scheduleChangeRequest.findMany.mockResolvedValue([
        {
          primaryEntry: {
            workDate: OCT_2,
            employee: { fullName: 'Aliyeva N.' },
          },
        },
      ]);

      await expect(
        service.saveEntries('hospital-1', 'plan-1', { entries: [input] }),
      ).rejects.toThrow(/Aliyeva N\. — 02\.10/);
      expect(prisma.monthlyScheduleEntry.deleteMany).not.toHaveBeenCalled();
    });
  });
});
