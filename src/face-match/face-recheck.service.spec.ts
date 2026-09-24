import { FaceRecheckService } from './face-recheck.service';

jest.mock('fs', () => ({
  existsSync: jest.fn((p: string) => !p.includes('missing')),
  readFileSync: jest.fn((p: string) => Buffer.from(`file:${p}`)),
}));
jest.mock('../common/utils/image.util', () => ({
  prepareFaceImage: jest.fn(async (b: Buffer) => b),
}));

describe('FaceRecheckService — kechiktirilgan yuz tekshiruvi', () => {
  const row = (over: any = {}) => ({
    id: 'att-1',
    selfieUrl: '/uploads/selfies/a.jpg',
    workDate: new Date(),
    checkIn: new Date(),
    faceCheckReason: 'SERVICE_ERROR',
    employee: {
      id: 'emp-1',
      fullName: 'Aziza',
      hospitalId: 'h1',
      photoUrl: '/uploads/emp1.jpg',
    },
    ...over,
  });

  function setup(rows: any[], results: any[]) {
    const prisma: any = {
      attendanceRecord: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn().mockResolvedValue({}),
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

  it('mos kelsa faceVerified=true va kutish yopiladi', async () => {
    const { svc, prisma } = setup(
      [row()],
      [{ mismatch: false, skipped: false, similarity: 0.7 }],
    );
    const res = await svc.run();
    expect(res.verified).toBe(1);
    expect(prisma.attendanceRecord.update).toHaveBeenCalledWith({
      where: { id: 'att-1' },
      data: {
        faceVerified: true,
        faceCheckPending: false,
        faceCheckReason: null,
      },
    });
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
    expect(prisma.attendanceRecord.update).toHaveBeenCalledWith({
      where: { id: 'att-1' },
      data: {
        faceVerified: false,
        faceCheckPending: false,
        faceCheckReason: 'FACE_MISMATCH',
      },
    });
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
    expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
  });

  it("profil rasmi yo'q — kutishda qoladi, sababi yangilanadi", async () => {
    const { svc, prisma, faceMatch } = setup(
      [
        row({
          employee: {
            id: 'e',
            fullName: 'X',
            hospitalId: 'h1',
            photoUrl: null,
          },
        }),
      ],
      [],
    );
    const res = await svc.run();
    expect(res.waitingPhoto).toBe(1);
    expect(faceMatch.verify).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.update).toHaveBeenCalledWith({
      where: { id: 'att-1' },
      data: { faceCheckReason: 'NO_REFERENCE_PHOTO' },
    });
  });

  it("3 kundan eski kutishlar EXPIRED bo'ladi", async () => {
    const { svc, prisma } = setup([], []);
    prisma.attendanceRecord.updateMany.mockResolvedValue({ count: 4 });
    const res = await svc.run();
    expect(res.expired).toBe(4);
    expect(prisma.attendanceRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ faceCheckPending: true }),
        data: { faceCheckPending: false, faceCheckReason: 'EXPIRED' },
      }),
    );
  });

  it("selfi fayli yo'qolgan bo'lsa kutish yopiladi (NO_SELFIE)", async () => {
    const { svc, prisma } = setup(
      [row({ selfieUrl: '/uploads/selfies/missing.jpg' })],
      [],
    );
    await svc.run();
    expect(prisma.attendanceRecord.update).toHaveBeenCalledWith({
      where: { id: 'att-1' },
      data: {
        faceVerified: false,
        faceCheckPending: false,
        faceCheckReason: 'NO_SELFIE',
      },
    });
  });
});
