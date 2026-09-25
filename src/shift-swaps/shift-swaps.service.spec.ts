import { BadRequestException, ConflictException } from '@nestjs/common';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { ShiftSwapsService } from './shift-swaps.service';

dayjs.extend(utc);
dayjs.extend(timezone);

// Kelajakdagi sanalar — test har qachon ishlaydi
const key = (plusDays: number) =>
  dayjs().tz('Asia/Tashkent').add(plusDays, 'day').format('YYYY-MM-DD');
const D = (plusDays: number) => ShiftSwapsService.dateOf(key(plusDays));

const DAY = {
  id: 'sh-day',
  name: 'Kunduzgi',
  startTime: '08:00',
  endTime: '17:00',
};
const NIGHT = {
  id: 'sh-night',
  name: 'Tungi',
  startTime: '20:00',
  endTime: '08:00',
};

const emp = (id: string, name: string) => ({
  id,
  fullName: name,
  photoUrl: null,
  userId: `u-${id}`,
  departmentId: 'dep1',
  telegramChatId: null,
  telegramReminders: true,
  position: null,
  department: { name: 'Tug‘ruq bo‘limi' },
});
const A = emp('A', 'Karimova Dilnoza');
const B = emp('B', 'Aliyeva Nodira');

function setup(
  schedules: { employeeId: string; date: Date; shift: any; status?: string }[],
  swap?: any,
) {
  const rows = schedules.map((s, i) => ({
    id: `s${i}`,
    employeeId: s.employeeId,
    date: s.date,
    status: s.status ?? 'WORKING',
    shiftId: s.shift?.id ?? null,
    shift: s.shift,
  }));
  const upserts: any[] = [];
  const prisma: any = {
    employee: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.userId === 'u-A'
          ? {
              ...A,
              hospitalId: 'h1',
              firedAt: null,
              hospital: { schedulePlanningMode: 'STANDARD' },
            }
          : { id: 'B', userId: 'u-B' },
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 'B' ? { id: 'B' } : null,
      ),
      findMany: jest.fn(async () => [
        { id: 'B', fullName: B.fullName, photoUrl: null, position: null },
      ]),
    },
    schedule: {
      findUnique: jest.fn(
        async ({ where: { employeeId_date: k } }: any) =>
          rows.find(
            (r) =>
              r.employeeId === k.employeeId &&
              r.date.getTime() === k.date.getTime(),
          ) ?? null,
      ),
      findMany: jest.fn(async () => rows),
      upsert: jest.fn(async (a: any) => upserts.push(a)),
    },
    shiftSwapRequest: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.status?.in ? null : swap,
      ),
      create: jest.fn(async (a: any) => ({
        ...a.data,
        id: 'sw1',
        requester: A,
        target: B,
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => ({
        ...swap,
        requester: A,
        target: B,
      })),
      findMany: jest.fn(async () => []),
    },
    shiftTemplate: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const telegram: any = {
    registerDecisionHandler: jest.fn(),
    sendPersonal: jest.fn(),
    sendDecisionRequest: jest.fn(),
  };
  const svc = new ShiftSwapsService(prisma, telegram);
  return { svc, prisma, upserts, telegram };
}

describe('ShiftSwapsService', () => {
  it('nomzodlar: COVER — o‘sha kuni bo‘sh hamkasb; SWAP — hamkasbning kuni (men bo‘shman)', async () => {
    const { svc } = setup([
      { employeeId: 'A', date: D(2), shift: DAY },
      { employeeId: 'B', date: D(4), shift: DAY },
    ]);
    const r = await svc.candidates('u-A', key(2));
    expect(r.cover.map((c) => c.id)).toEqual(['B']);
    expect(r.swap[0].options.map((o) => o.date)).toEqual([key(4)]);
  });

  it('o‘z smenasi bo‘lmagan kun uchun so‘rov — rad etiladi', async () => {
    const { svc } = setup([]);
    await expect(svc.candidates('u-A', key(2))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('COVER: hamkasb o‘sha kuni ishlasa — yaratilmaydi', async () => {
    const { svc } = setup([
      { employeeId: 'A', date: D(2), shift: DAY },
      { employeeId: 'B', date: D(2), shift: NIGHT },
    ]);
    await expect(
      svc.create('u-A', {
        type: 'COVER',
        requesterDate: key(2),
        targetId: 'B',
      }),
    ).rejects.toThrow('o‘zi ishlaydi');
  });

  it('ta’tildagi hamkasb o‘rniga chiqa olmaydi (nomzodlarda ham yo‘q)', async () => {
    const { svc } = setup([
      { employeeId: 'A', date: D(2), shift: DAY },
      { employeeId: 'B', date: D(2), shift: null, status: 'VACATION' },
    ]);
    const r = await svc.candidates('u-A', key(2));
    expect(r.cover).toEqual([]);
    await expect(
      svc.create('u-A', {
        type: 'COVER',
        requesterDate: key(2),
        targetId: 'B',
      }),
    ).rejects.toThrow('ta’tilda');
  });

  it('SWAP turli kunlar: tasdiqlanganda 4 ta grafik yozuvi almashadi', async () => {
    const swap = {
      id: 'sw1',
      hospitalId: 'h1',
      type: 'SWAP',
      status: 'ACCEPTED',
      requesterId: 'A',
      targetId: 'B',
      requesterDate: D(2),
      requesterShiftId: DAY.id,
      targetDate: D(4),
      targetShiftId: NIGHT.id,
      requester: A,
      target: B,
    };
    const { svc, upserts } = setup(
      [
        { employeeId: 'A', date: D(2), shift: DAY },
        { employeeId: 'B', date: D(4), shift: NIGHT },
      ],
      swap,
    );
    await svc.review('sw1', 'APPROVED', { userId: 'd1', hospitalId: 'h1' });
    const summary = upserts.map((u) => [
      u.where.employeeId_date.employeeId,
      u.where.employeeId_date.date.getTime(),
      u.update.shiftId ?? null,
    ]);
    expect(summary).toEqual([
      ['B', D(2).getTime(), DAY.id], // B mening kunimda ishlaydi
      ['A', D(2).getTime(), null], // men dam olaman
      ['A', D(4).getTime(), NIGHT.id], // men B ning kunida
      ['B', D(4).getTime(), null],
    ]);
  });

  it('COVER tasdiqlandi: men dam olaman, hamkasb mening smenamda', async () => {
    const swap = {
      id: 'sw1',
      hospitalId: 'h1',
      type: 'COVER',
      status: 'ACCEPTED',
      requesterId: 'A',
      targetId: 'B',
      requesterDate: D(3),
      requesterShiftId: DAY.id,
      targetDate: null,
      targetShiftId: null,
      requester: A,
      target: B,
    };
    const { svc, upserts } = setup(
      [{ employeeId: 'A', date: D(3), shift: DAY }],
      swap,
    );
    await svc.review('sw1', 'APPROVED', { userId: 'd1', hospitalId: 'h1' });
    expect(
      upserts.map((u) => [u.where.employeeId_date.employeeId, u.update.status]),
    ).toEqual([
      ['A', 'DAY_OFF'],
      ['B', 'WORKING'],
    ]);
  });

  it('hamkasb hali rozi bo‘lmagan — rahbar tasdiqlay olmaydi', async () => {
    const { svc } = setup([], {
      id: 'sw1',
      status: 'REQUESTED',
      requester: A,
      target: B,
    });
    await expect(
      svc.review('sw1', 'APPROVED', { userId: 'd1', hospitalId: 'h1' }),
    ).rejects.toThrow(ConflictException);
  });

  it('so‘rovdan keyin grafik o‘zgargan — tasdiqlanmaydi', async () => {
    const swap = {
      id: 'sw1',
      hospitalId: 'h1',
      type: 'COVER',
      status: 'ACCEPTED',
      requesterId: 'A',
      targetId: 'B',
      requesterDate: D(3),
      requesterShiftId: NIGHT.id, // so'rov paytida tungi edi
      targetDate: null,
      targetShiftId: null,
      requester: A,
      target: B,
    };
    const { svc, upserts } = setup(
      [{ employeeId: 'A', date: D(3), shift: DAY }],
      swap,
    );
    await expect(
      svc.review('sw1', 'APPROVED', { userId: 'd1', hospitalId: 'h1' }),
    ).rejects.toThrow('grafik o');
    expect(upserts).toHaveLength(0);
  });

  it('o‘tgan kun — almashtirib bo‘lmaydi', async () => {
    const { svc } = setup([{ employeeId: 'A', date: D(-1), shift: DAY }]);
    await expect(
      svc.create('u-A', {
        type: 'COVER',
        requesterDate: key(-1),
        targetId: 'B',
      }),
    ).rejects.toThrow("O'tgan kun");
  });
});
