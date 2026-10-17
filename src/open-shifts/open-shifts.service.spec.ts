import { BadRequestException, ConflictException } from '@nestjs/common';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { OpenShiftsService } from './open-shifts.service';

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'Asia/Tashkent';

const day = (offset: number) =>
  dayjs().tz(TZ).startOf('day').add(offset, 'day').toDate();
const DAY_SHIFT = { startTime: '08:00', endTime: '20:00', isOvernight: false };
const NIGHT_SHIFT = { startTime: '20:00', endTime: '08:00', isOvernight: true };

function employee(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    fullName: `Xodim ${id}`,
    positionId: 'doya',
    telegramChatId: null,
    position: { name: 'Doya' },
    schedules: [],
    leaveRequests: [],
    ...patch,
  };
}

function setup(employees: any[] = [], mode = 'STANDARD') {
  const prisma: any = {
    hospital: {
      findUnique: jest.fn(async () => ({
        id: 'h1',
        schedulePlanningMode: mode,
      })),
    },
    department: {
      findFirst: jest.fn(async () => ({ id: 'dep', name: 'Tug‘ruq bloki' })),
    },
    scheduleChangeRequest: { findFirst: jest.fn(async () => null) },
    shiftTemplate: {
      findFirst: jest.fn(async ({ where }: any) => ({
        id: where.id,
        name: 'Smena',
        ...DAY_SHIFT,
      })),
    },
    employee: {
      findMany: jest.fn(async () => employees),
      findFirst: jest.fn(async () => ({
        positionId: 'doya',
        id: 'absent',
        departmentId: 'dep',
      })),
    },
    openShift: {
      findFirst: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    openShiftOffer: {
      findUnique: jest.fn(),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    schedule: { upsert: jest.fn(async () => ({})) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const telegram: any = {
    sendDecisionRequest: jest.fn(async () => undefined),
    sendPersonal: jest.fn(async () => true),
  };
  const planning: any = {
    findApprovedWorkingEntry: jest.fn(async () => ({
      id: 'entry-1',
      shiftId: 'plan-shift',
    })),
    substituteFromOpenShift: jest.fn(async () => ({ id: 'change-1' })),
  };
  return {
    prisma,
    telegram,
    planning,
    service: new OpenShiftsService(prisma, telegram, planning),
  };
}

describe('Bo‘sh smena birjasi', () => {
  describe('kim taklif ola oladi', () => {
    it('ta’til, o‘z smenasi va kesishuv bloklanadi; qisqa dam ogohlantiriladi', async () => {
      const tomorrow = day(1);
      const { service } = setup([
        employee('free'),
        employee('dayoff', {
          schedules: [{ date: tomorrow, status: 'DAY_OFF', shift: null }],
        }),
        employee('leave', { leaveRequests: [{ id: 'l1' }] }),
        employee('busy', {
          schedules: [{ date: tomorrow, status: 'WORKING', shift: DAY_SHIFT }],
        }),
        employee('sick', {
          schedules: [{ date: tomorrow, status: 'SICK', shift: null }],
        }),
        // Kecha 20:00 — bugun 08:00 tungi smena; ertaga 08:00 smena bilan
        // kesishmaydi, lekin dam 24 soat — ogohlantirish yo'q.
        employee('night-before', {
          schedules: [{ date: day(0), status: 'WORKING', shift: NIGHT_SHIFT }],
        }),
      ]);

      const result = await service.evaluateCandidates(
        'h1',
        'dep',
        tomorrow,
        DAY_SHIFT,
        'absent',
      );
      const byId = Object.fromEntries(result.map((c) => [c.employeeId, c]));

      expect(byId.free.eligible).toBe(true);
      expect(byId.dayoff.eligible).toBe(true);
      expect(byId.leave.blockers).toContain('Tasdiqlangan ta’tilda');
      expect(byId.busy.blockers).toContain('Bu kuni o‘z smenasi bor');
      expect(byId.sick.blockers).toContain('Bu kuni kasallik varaqasida');
      expect(byId['night-before'].eligible).toBe(true);
      // Mos keladiganlar ro'yxat boshida
      expect(result.slice(0, 3).every((c) => c.eligible)).toBe(true);
    });

    it('kechagi tungi smena tugamasdan boshlanadigan smena bloklanadi', async () => {
      const tomorrow = day(1);
      const early = {
        startTime: '07:00',
        endTime: '15:00',
        isOvernight: false,
      };
      const { service } = setup([
        employee('tired', {
          schedules: [{ date: day(0), status: 'WORKING', shift: NIGHT_SHIFT }],
        }),
      ]);
      const [c] = await service.evaluateCandidates(
        'h1',
        'dep',
        tomorrow,
        early,
      );
      expect(c.eligible).toBe(false);
      expect(c.blockers).toContain('Kechagi smenasi hali tugamagan');
    });

    it('smenalar orasidagi dam 12 soatdan kam bo‘lsa ogohlantiradi', async () => {
      const tomorrow = day(1);
      const { service } = setup([
        employee('short-rest', {
          // Ertaga 08:00–20:00 dan keyin indinga 06:00 smena — 10 soat dam
          schedules: [
            {
              date: day(2),
              status: 'WORKING',
              shift: {
                startTime: '06:00',
                endTime: '14:00',
                isOvernight: false,
              },
            },
          ],
        }),
      ]);
      const [c] = await service.evaluateCandidates(
        'h1',
        'dep',
        tomorrow,
        DAY_SHIFT,
      );
      expect(c.eligible).toBe(true);
      expect(c.warnings).toEqual(['Keyingi smenagacha 10 soat dam']);
    });
  });

  describe('"Olaman"', () => {
    const openShift = (status = 'OPEN') => ({
      id: 'os1',
      hospitalId: 'h1',
      departmentId: 'dep',
      date: day(1),
      shiftId: 's1',
      shift: DAY_SHIFT,
      status,
      claimedById: null,
      absentEmployeeId: null,
      department: { name: 'Tug‘ruq bloki' },
      absentEmployee: null,
    });

    it('ikki xodim bir vaqtda bossa — faqat birinchisi oladi', async () => {
      const { prisma, service, telegram } = setup([employee('e2')]);
      prisma.openShiftOffer.findUnique.mockResolvedValue({
        id: 'offer-2',
        response: null,
        openShift: openShift(),
        employee: { fullName: 'Xodim e2' },
      });
      // Boshqa xodim bir lahza oldin oldi — atomik yangilash 0 qator
      prisma.openShift.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.claim('e2', 'os1')).rejects.toThrow(
        new ConflictException('Bu smenani boshqa hamkasb oldi'),
      );
      expect(prisma.openShiftOffer.update).not.toHaveBeenCalled();
      expect(telegram.sendDecisionRequest).not.toHaveBeenCalled();
    });

    it('birinchi bo‘lib olgan xodim — mudirga tasdiq so‘rovi boradi', async () => {
      const { prisma, service, telegram } = setup([employee('e1')]);
      prisma.openShiftOffer.findUnique.mockResolvedValue({
        id: 'offer-1',
        response: null,
        openShift: openShift(),
        employee: { fullName: 'Xodim e1' },
      });

      await expect(service.claim('e1', 'os1')).resolves.toEqual({
        id: 'os1',
        status: 'CLAIMED',
      });
      expect(prisma.openShift.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'os1', status: 'OPEN' } }),
      );
      expect(telegram.sendDecisionRequest).toHaveBeenCalledWith(
        'h1',
        expect.stringContaining('Xodim e1'),
        'openshift',
        'os1',
      );
    });

    it('taklif yuborilmagan xodim ola olmaydi', async () => {
      const { prisma, service } = setup();
      prisma.openShiftOffer.findUnique.mockResolvedValue(null);
      await expect(service.claim('stranger', 'os1')).rejects.toThrow(
        'Bu taklif sizga yuborilmagan',
      );
    });

    it('shu orada band bo‘lib qolgan xodim ola olmaydi', async () => {
      const { prisma, service } = setup([
        employee('e1', {
          schedules: [{ date: day(1), status: 'WORKING', shift: DAY_SHIFT }],
        }),
      ]);
      prisma.openShiftOffer.findUnique.mockResolvedValue({
        id: 'offer-1',
        response: null,
        openShift: openShift(),
        employee: { fullName: 'Xodim e1' },
      });
      await expect(service.claim('e1', 'os1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.openShift.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('mudir tasdig‘i', () => {
    const claimed = {
      id: 'os1',
      hospitalId: 'h1',
      departmentId: 'dep',
      date: day(1),
      shiftId: 's1',
      shift: DAY_SHIFT,
      status: 'CLAIMED',
      absentEmployeeId: 'absent',
      department: { name: 'Tug‘ruq bloki' },
      absentEmployee: { fullName: 'Karimova N.' },
      claimedBy: { id: 'e1', fullName: 'Aliyeva D.', telegramChatId: '42' },
    };

    it('tasdiqlansa smena xodimning grafigiga yoziladi', async () => {
      const { prisma, service, telegram } = setup([employee('e1')]);
      prisma.openShift.findFirst.mockResolvedValue(claimed);

      await expect(
        service.review('os1', 'APPROVED', { userId: 'u1', hospitalId: 'h1' }),
      ).resolves.toEqual({ id: 'os1', status: 'FILLED' });
      expect(prisma.schedule.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { employeeId_date: { employeeId: 'e1', date: claimed.date } },
          update: expect.objectContaining({
            status: 'WORKING',
            shiftId: 's1',
            note: "Bo'sh smena: Karimova N. o'rniga",
          }),
        }),
      );
      expect(telegram.sendPersonal).toHaveBeenCalledWith(
        '42',
        expect.stringContaining('grafigingizga yozildi'),
      );
    });

    it('rad etilsa smena yana ochiq, grafik o‘zgarmaydi', async () => {
      const { prisma, service } = setup([employee('e1')]);
      prisma.openShift.findFirst.mockResolvedValue(claimed);

      await expect(
        service.review('os1', 'REJECTED', { userId: 'u1', hospitalId: 'h1' }),
      ).resolves.toEqual({ id: 'os1', status: 'OPEN' });
      expect(prisma.schedule.upsert).not.toHaveBeenCalled();
      expect(prisma.openShift.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'OPEN', claimedById: null }),
        }),
      );
      // Rad etilgan xodim qayta ololmaydi
      expect(prisma.openShiftOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { openShiftId: 'os1', employeeId: 'e1' },
          data: expect.objectContaining({ response: 'DECLINED' }),
        }),
      );
    });

    it('xodim shu orada band bo‘lib qolsa tasdiqlanmaydi', async () => {
      const { prisma, service } = setup([
        employee('e1', { leaveRequests: [{ id: 'l1' }] }),
      ]);
      prisma.openShift.findFirst.mockResolvedValue(claimed);
      await expect(
        service.review('os1', 'APPROVED', { userId: 'u1', hospitalId: 'h1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.schedule.upsert).not.toHaveBeenCalled();
    });
  });

  describe('post rejali muassasa (tug‘ruqxona)', () => {
    it('kim o‘rniga tanlanmasa e’lon qilinmaydi', async () => {
      const { service } = setup([employee('e1')], 'POST_COVERAGE');
      await expect(
        service.preview('h1', {
          departmentId: 'dep',
          date: dayjs(day(1)).tz(TZ).format('YYYY-MM-DD'),
          shiftId: 'any',
        }),
      ).rejects.toThrow('kimning o‘rniga');
    });

    it('smena kelmagan xodimning post rejadagi smenasidan olinadi', async () => {
      const { service, prisma } = setup([employee('e1')], 'POST_COVERAGE');
      const result = await service.preview('h1', {
        departmentId: 'dep',
        date: dayjs(day(1)).tz(TZ).format('YYYY-MM-DD'),
        shiftId: 'user-picked-shift',
        absentEmployeeId: 'absent',
      });
      expect(result.postCoverage).toBe(true);
      expect(result.shift.id).toBe('plan-shift');
      expect(prisma.shiftTemplate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'plan-shift' }),
        }),
      );
    });

    it('rejada smenasi bo‘lmasa rad etiladi', async () => {
      const { service, planning } = setup([employee('e1')], 'POST_COVERAGE');
      planning.findApprovedWorkingEntry.mockResolvedValue(null);
      await expect(
        service.preview('h1', {
          departmentId: 'dep',
          date: dayjs(day(1)).tz(TZ).format('YYYY-MM-DD'),
          shiftId: 'x',
          absentEmployeeId: 'absent',
        }),
      ).rejects.toThrow('tasdiqlangan post rejada ish smenasi yo‘q');
    });

    it('tasdiqlash "o‘rnini bosish" orqali yoziladi, grafik to‘g‘ridan-to‘g‘ri yozilmaydi', async () => {
      const { service, prisma, planning } = setup(
        [employee('e1')],
        'POST_COVERAGE',
      );
      prisma.openShift.findFirst.mockResolvedValue({
        id: 'os1',
        hospitalId: 'h1',
        departmentId: 'dep',
        date: day(1),
        shiftId: 'plan-shift',
        shift: DAY_SHIFT,
        status: 'CLAIMED',
        absentEmployeeId: 'absent',
        createdById: 'manager-user',
        department: { name: 'Tug‘ruq bloki' },
        absentEmployee: { fullName: 'Karimova N.' },
        claimedBy: { id: 'e1', fullName: 'Aliyeva D.', telegramChatId: null },
      });

      await expect(
        service.review('os1', 'APPROVED', { userId: null, hospitalId: 'h1' }),
      ).resolves.toEqual({ id: 'os1', status: 'FILLED' });
      expect(planning.substituteFromOpenShift).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          hospitalId: 'h1',
          entryId: 'entry-1',
          replacementEmployeeId: 'e1',
          requestedById: 'manager-user',
          approvedById: null,
        }),
      );
      expect(prisma.schedule.upsert).not.toHaveBeenCalled();
    });
  });
});
