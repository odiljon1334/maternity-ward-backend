import axios from 'axios';
import { FaceMatchMonitorService } from './face-match-monitor.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

type State = {
  serviceKey: string;
  status: string;
  consecutiveFailures: number;
  outageStartedAt: Date | null;
  alertedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
};

function makeService(initial: State | null = null) {
  let state = initial;
  const model: any = {
    findUnique: jest.fn(async () => state),
    create: jest.fn(async ({ data }) => {
      state = {
        alertedAt: null,
        lastSuccessAt: null,
        ...data,
      } as State;
      return state;
    }),
    update: jest.fn(async ({ data }) => {
      state = { ...state!, ...data };
      return state;
    }),
    upsert: jest.fn(async ({ create, update }) => {
      state = state
        ? ({ ...state, ...update } as State)
        : ({
            lastFailureAt: null,
            outageStartedAt: null,
            alertedAt: null,
            ...create,
          } as State);
      return state;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      const matches =
        state &&
        (!where.status || state.status === where.status) &&
        (!where.alertedAt ||
          state.alertedAt?.getTime() === where.alertedAt.getTime());
      if (matches) state = { ...state!, ...data };
      return { count: matches ? 1 : 0 };
    }),
  };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
    operationalServiceMonitor: model,
  };
  const prisma: any = {
    $transaction: jest.fn((callback) => callback(tx)),
    operationalServiceMonitor: model,
  };
  const supportBot = {
    notifyOperationalAlert: jest.fn().mockResolvedValue(true),
  };
  return {
    service: new FaceMatchMonitorService(prisma, supportBot as any),
    supportBot,
    getState: () => state,
  };
}

describe('FaceMatchMonitorService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-22T04:00:00.000Z'));
    process.env.FACE_MATCH_ALERT_FAILURES = '3';
    process.env.FACE_MATCH_ENABLED = 'true';
    mockedAxios.get.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.FACE_MATCH_ALERT_FAILURES;
    delete process.env.FACE_MATCH_ENABLED;
  });

  it('birinchi ikki xatoda operatorni bezovta qilmaydi', async () => {
    mockedAxios.get.mockRejectedValue(new Error('timeout'));
    const { service, supportBot, getState } = makeService();

    await service.check();
    await service.check();

    expect(getState()?.consecutiveFailures).toBe(2);
    expect(supportBot.notifyOperationalAlert).not.toHaveBeenCalled();
  });

  it('uchinchi ketma-ket xatoda faqat bitta outage xabari yuboradi', async () => {
    mockedAxios.get.mockRejectedValue(new Error('timeout'));
    const { service, supportBot, getState } = makeService();

    await service.check();
    await service.check();
    await service.check();
    await service.check();

    expect(getState()?.status).toBe('ALERTED');
    expect(supportBot.notifyOperationalAlert).toHaveBeenCalledTimes(1);
    expect(supportBot.notifyOperationalAlert).toHaveBeenCalledWith(
      expect.stringContaining('ketma-ket 3 marta'),
    );
  });

  it('xizmat tiklanganda bitta recovery xabari yuboradi', async () => {
    mockedAxios.get.mockResolvedValue({ data: { status: 'ready' } } as any);
    const { service, supportBot, getState } = makeService({
      serviceKey: 'face-match',
      status: 'ALERTED',
      consecutiveFailures: 3,
      outageStartedAt: new Date('2026-09-22T03:55:00.000Z'),
      alertedAt: new Date('2026-09-22T03:57:00.000Z'),
      lastSuccessAt: null,
      lastFailureAt: new Date('2026-09-22T03:57:00.000Z'),
    });

    await service.check();
    await service.check();

    expect(getState()?.status).toBe('HEALTHY');
    expect(supportBot.notifyOperationalAlert).toHaveBeenCalledTimes(1);
    expect(supportBot.notifyOperationalAlert).toHaveBeenCalledWith(
      expect.stringContaining('xizmati tiklandi'),
    );
  });

  it('recovery xabari yuborilmasa keyingi tekshiruvda qayta urinadi', async () => {
    mockedAxios.get.mockResolvedValue({ data: { status: 'ready' } } as any);
    const { service, supportBot } = makeService({
      serviceKey: 'face-match',
      status: 'ALERTED',
      consecutiveFailures: 3,
      outageStartedAt: new Date('2026-09-22T03:55:00.000Z'),
      alertedAt: new Date('2026-09-22T03:57:00.000Z'),
      lastSuccessAt: null,
      lastFailureAt: new Date('2026-09-22T03:57:00.000Z'),
    });
    supportBot.notifyOperationalAlert
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await service.check();
    await service.check();

    expect(supportBot.notifyOperationalAlert).toHaveBeenCalledTimes(2);
  });

  it("advisory lock olinmasa boshqa replica holatni o'zgartirmaydi", async () => {
    mockedAxios.get.mockRejectedValue(new Error('timeout'));
    const { service, supportBot, getState } = makeService();
    const prisma = (service as any).prisma;
    prisma.$transaction = jest.fn(async (callback) =>
      callback({
        $queryRaw: jest.fn().mockResolvedValue([{ locked: false }]),
        operationalServiceMonitor: {},
      }),
    );

    await service.check();

    expect(getState()).toBeNull();
    expect(supportBot.notifyOperationalAlert).not.toHaveBeenCalled();
  });
});
