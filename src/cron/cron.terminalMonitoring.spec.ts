import { CronService } from './cron.service';

function makeService(options: {
  terminal?: Record<string, any>;
  gatewayStatus?: string;
  gatewayError?: Error;
  updateManyCounts?: number[];
}) {
  const terminal = {
    id: 'terminal-1',
    name: 'Kirish terminali',
    devIndex: 'device-1',
    hospitalId: 'hospital-1',
    isActive: true,
    lastSeenAt: null,
    offlineSince: null,
    lastOfflineAlertAt: null,
    hospital: { name: 'Test muassasa' },
    ...options.terminal,
  };
  const updateMany = jest.fn();
  for (const count of options.updateManyCounts ?? [1]) {
    updateMany.mockResolvedValueOnce({ count });
  }

  const prisma: any = {
    hikTerminal: {
      findMany: jest.fn().mockResolvedValue([terminal]),
      updateMany,
      update: jest.fn().mockResolvedValue(terminal),
    },
  };
  const push = {
    notifyTerminalConnectivity: jest.fn().mockResolvedValue(undefined),
  };
  const telegram = {
    notifyTerminalConnectivity: jest.fn().mockResolvedValue(undefined),
  };
  const hikvision = {
    getTerminalStatusSnapshot: options.gatewayError
      ? jest.fn().mockRejectedValue(options.gatewayError)
      : jest
          .fn()
          .mockResolvedValue({ 'device-1': options.gatewayStatus ?? 'online' }),
  };

  const service = new CronService(
    {} as any,
    telegram as any,
    {} as any,
    prisma,
    {} as any,
    push as any,
    {} as any,
    hikvision as any,
  );

  return { service, prisma, push, telegram, hikvision };
}

describe('CronService.monitorTerminalConnectivity', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-21T05:00:00.000Z'));
    process.env.TERMINAL_OFFLINE_THRESHOLD_MINUTES = '5';
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.TERMINAL_OFFLINE_THRESHOLD_MINUTES;
  });

  it("gateway ishlamasa terminalni offline deb o'zgartirmaydi", async () => {
    const { service, prisma } = makeService({
      gatewayError: new Error('gateway unavailable'),
    });

    await service.monitorTerminalConnectivity();

    expect(prisma.hikTerminal.findMany).not.toHaveBeenCalled();
    expect(prisma.hikTerminal.updateMany).not.toHaveBeenCalled();
  });

  it('birinchi offline kuzatuvida faqat offlineSince vaqtini belgilaydi', async () => {
    const { service, prisma, push, telegram } = makeService({
      gatewayStatus: 'offline',
    });

    await service.monitorTerminalConnectivity();

    expect(prisma.hikTerminal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'terminal-1', offlineSince: null },
      }),
    );
    expect(push.notifyTerminalConnectivity).not.toHaveBeenCalled();
    expect(telegram.notifyTerminalConnectivity).not.toHaveBeenCalled();
  });

  it('5 daqiqadan ortiq offline terminal uchun bir marta ogohlantiradi', async () => {
    const { service, prisma, push, telegram } = makeService({
      gatewayStatus: 'offline',
      terminal: {
        offlineSince: new Date('2026-09-21T04:54:00.000Z'),
      },
    });

    await service.monitorTerminalConnectivity();

    expect(prisma.hikTerminal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lastOfflineAlertAt: null }),
      }),
    );
    expect(push.notifyTerminalConnectivity).toHaveBeenCalledWith(
      'hospital-1',
      'terminal-1',
      'Kirish terminali',
      false,
    );
    expect(telegram.notifyTerminalConnectivity).toHaveBeenCalledWith(
      'hospital-1',
      'Test muassasa',
      'Kirish terminali',
      false,
    );
  });

  it("ogohlantirilgan terminal qayta online bo'lsa tiklanish xabarini yuboradi", async () => {
    const { service, push, telegram } = makeService({
      gatewayStatus: 'online',
      terminal: {
        offlineSince: new Date('2026-09-21T04:50:00.000Z'),
        lastOfflineAlertAt: new Date('2026-09-21T04:55:00.000Z'),
      },
    });

    await service.monitorTerminalConnectivity();

    expect(push.notifyTerminalConnectivity).toHaveBeenCalledWith(
      'hospital-1',
      'terminal-1',
      'Kirish terminali',
      true,
    );
    expect(telegram.notifyTerminalConnectivity).toHaveBeenCalledWith(
      'hospital-1',
      'Test muassasa',
      'Kirish terminali',
      true,
    );
  });
});
