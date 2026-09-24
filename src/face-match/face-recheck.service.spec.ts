import { FaceRecheckService } from './face-recheck.service';

jest.mock('fs', () => ({
  existsSync: jest.fn((p: string) => !p.includes('missing')),
  readFileSync: jest.fn((p: string) => Buffer.from(`file:${p}`)),
}));
jest.mock('../common/utils/image.util', () => ({
  prepareFaceImage: jest.fn(async (b: Buffer) => b),
}));

describe('FaceRecheckService — kechiktirilgan yuz tekshiruvi', () => {
  const T0 = new Date('2026-09-24T05:00:00Z');
  const row = (over: any = {}) => ({
    id: 'att-1',
    selfieUrl: '/uploads/selfies/a.jpg',
    workDate: new Date(),
    checkIn: new Date(),
    updatedAt: T0,
    faceCheckReason: 'SERVICE_ERROR',
    ...over,
    employee: {
      id: 'emp-1',
      fullName: 'Aziza',
      hospitalId: 'h1',
      photoUrl: '/uploads/emp1.jpg',
      updatedAt: T0,
      ...(over.employee ?? {}),
    },
  });

  function setup(rows: any[], results: any[], stale: any[] = []) {
    const prisma: any = {
      attendanceRecord: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn(async (args: any) =>
          args?.where?.workDate?.lt ? stale : rows,
        ),
      },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'dir-1' }, { id: 'adm-1' }]),
      },
    };
    const faceMatch: any = { verify: jest.fn() };
    results.forEach((r) => faceMatch.verify.mockResolvedValueOnce(r));
    const auditLog: any = { log: jest.fn() };
    const notifications: any = {
      createForUsers: jest.fn().mockResolvedValue({ count: 2 }),
    };
    const svc = new FaceRecheckService(
      prisma,
      faceMatch,
      auditLog,
      notifications,
    );
    return { svc, prisma, faceMatch, auditLog, notifications };
  }

  const finishCall = (
    id: string,
    verified: boolean,
    reason: string | null,
  ) => ({
    where: { id, faceCheckPending: true },
    data: {
      faceVerified: verified,
      faceCheckPending: false,
      faceCheckReason: reason,
    },
  });

  it('mos kelsa faceVerified=true va kutish yopiladi', async () => {
    const { svc, prisma } = setup(
      [row()],
      [{ mismatch: false, skipped: false, similarity: 0.7 }],
    );
    const res = await svc.run();
    expect(res.verified).toBe(1);
    expect(prisma.attendanceRecord.updateMany).toHaveBeenCalledWith(
      finishCall('att-1', true, null),
    );
  });

  it("navbat updatedAt bo'yicha aylanadi (eski kutayotganlar yangilarini to'smaydi)", async () => {
    const { svc, prisma } = setup([], []);
    await svc.run();
    const rowsQuery = prisma.attendanceRecord.findMany.mock.calls.find(
      (c: any[]) => c[0].where.workDate.gte,
    );
    expect(rowsQuery[0].orderBy).toEqual({ updatedAt: 'asc' });
  });

  it("mos kelmasa rahbarlarga bildirishnoma, davomat o'chirilmaydi", async () => {
    const { svc, prisma, notifications } = setup(
      [row()],
      [
        {
          mismatch: true,
          skipped: false,
          reason: 'FACE_MISMATCH',
          similarity: 0.1,
        },
      ],
    );
    const res = await svc.run();
    expect(res.rejected).toBe(1);
    expect(prisma.attendanceRecord.updateMany).toHaveBeenCalledWith(
      finishCall('att-1', false, 'FACE_MISMATCH'),
    );
    expect(notifications.createForUsers).toHaveBeenCalledWith(
      ['dir-1', 'adm-1'],
      expect.objectContaining({
        type: 'ALERT',
        metadata: expect.objectContaining({ attendanceId: 'att-1' }),
      }),
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ hospitalId: 'h1' }),
      }),
    );
  });

  it("xizmat hali ishlamasa aylanish to'xtaydi, yozuvlar kutishda qoladi", async () => {
    const { svc, prisma, faceMatch } = setup(
      [row(), row({ id: 'att-2' })],
      [{ mismatch: true, skipped: false, reason: 'SERVICE_ERROR' }],
    );
    const res = await svc.run();
    expect(res.serviceDown).toBe(true);
    expect(faceMatch.verify).toHaveBeenCalledTimes(1);
    expect(prisma.attendanceRecord.updateMany).not.toHaveBeenCalled();
  });

  it("profil rasmi yo'q — kutishda qoladi, sababi yangilanadi", async () => {
    const { svc, prisma, faceMatch } = setup(
      [row({ employee: { photoUrl: null } })],
      [],
    );
    const res = await svc.run();
    expect(res.waitingPhoto).toBe(1);
    expect(faceMatch.verify).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'att-1', faceCheckPending: true },
      data: { faceCheckReason: 'NO_REFERENCE_PHOTO' },
    });
  });

  it("profil rasmida yuz yo'q va profil o'zgarmagan — xizmat qayta chaqirilmaydi", async () => {
    const { svc, faceMatch } = setup(
      [row({ faceCheckReason: 'REFERENCE_FACE_NOT_FOUND' })],
      [],
    );
    const res = await svc.run();
    expect(faceMatch.verify).not.toHaveBeenCalled();
    expect(res.waitingPhoto).toBe(1);
  });

  it('profil rasmi yangilangandan keyin qayta tekshiriladi', async () => {
    const { svc, faceMatch } = setup(
      [
        row({
          faceCheckReason: 'REFERENCE_FACE_NOT_FOUND',
          employee: { updatedAt: new Date(T0.getTime() + 60_000) },
        }),
      ],
      [{ mismatch: false, skipped: false, similarity: 0.8 }],
    );
    const res = await svc.run();
    expect(faceMatch.verify).toHaveBeenCalledTimes(1);
    expect(res.verified).toBe(1);
  });

  it('bitta yozuvdagi xato qolganlarini to‘xtatmaydi', async () => {
    const { svc, prisma } = setup(
      [row(), row({ id: 'att-2' })],
      [
        { mismatch: false, skipped: false },
        { mismatch: false, skipped: false },
      ],
    );
    prisma.attendanceRecord.updateMany
      .mockRejectedValueOnce(new Error('P2025'))
      .mockResolvedValue({ count: 1 });
    const res = await svc.run();
    expect(res.checked).toBe(2);
    expect(prisma.attendanceRecord.updateMany).toHaveBeenLastCalledWith(
      finishCall('att-2', true, null),
    );
  });

  it("3 kundan eski kutishlar EXPIRED bo'ladi va rahbarlarga bitta ogohlantirish ketadi", async () => {
    const stale = [
      {
        id: 'old-1',
        faceCheckReason: 'NO_REFERENCE_PHOTO',
        employee: { fullName: 'Ali', hospitalId: 'h1' },
      },
      {
        id: 'old-2',
        faceCheckReason: 'SERVICE_ERROR',
        employee: { fullName: 'Vali', hospitalId: 'h1' },
      },
    ];
    const { svc, prisma, notifications, auditLog } = setup([], [], stale);
    const res = await svc.run();
    expect(res.expired).toBe(2);
    expect(prisma.attendanceRecord.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-1', 'old-2'] }, faceCheckPending: true },
      data: { faceCheckPending: false, faceCheckReason: 'EXPIRED' },
    });
    expect(notifications.createForUsers).toHaveBeenCalledTimes(1);
    const payload = notifications.createForUsers.mock.calls[0][1];
    expect(payload.message).toMatch(/2 ta check-in/);
    expect(payload.message).toMatch(/profil rasmi/);
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FACE_MATCH_EXPIRED' }),
    );
  });

  it("selfi fayli yo'qolgan bo'lsa kutish yopiladi (NO_SELFIE)", async () => {
    const { svc, prisma } = setup(
      [row({ selfieUrl: '/uploads/selfies/missing.jpg' })],
      [],
    );
    await svc.run();
    expect(prisma.attendanceRecord.updateMany).toHaveBeenCalledWith(
      finishCall('att-1', false, 'NO_SELFIE'),
    );
  });
});
