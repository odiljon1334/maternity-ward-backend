import { HikPersonQueueService } from './hik-person-queue.service';

describe('Person delivery scheduler', () => {
  afterEach(() => jest.useRealTimers());
  it('summary does not fetch employee delivery rows or terminal names', async () => {
    const prisma = {
      hikPersonDelivery: {
        findMany: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([
          { state: 'WAITING', _count: 4 },
          { state: 'DELIVERED', _count: 6 },
        ]),
      },
      hikTerminal: { findMany: jest.fn() },
      employee: { count: jest.fn().mockResolvedValue(2) },
    };
    const result = await new HikPersonQueueService(prisma as any).status(
      'h',
      undefined,
      1,
      true,
    );
    expect(result).toMatchObject({
      items: [],
      total: 10,
      withoutPhoto: 2,
      counts: { WAITING: 4, DELIVERED: 6 },
    });
    expect(prisma.hikPersonDelivery.findMany).not.toHaveBeenCalled();
    expect(prisma.hikTerminal.findMany).not.toHaveBeenCalled();
  });
  it('starts immediately, caps parallel work at three and drains without idle gaps', async () => {
    jest.useFakeTimers();
    const queue = new HikPersonQueueService({} as any);
    let running = 0,
      max = 0,
      calls = 0;
    jest.spyOn(queue, 'runNext').mockImplementation(async () => {
      calls++;
      if (calls > 6) return false;
      running++;
      max = Math.max(max, running);
      await new Promise((resolve) => setTimeout(resolve, 100));
      running--;
      return true;
    });
    queue.start(async () => undefined);
    expect(calls).toBe(3);
    await jest.advanceTimersByTimeAsync(250);
    expect(calls).toBeGreaterThanOrEqual(6);
    expect(max).toBe(3);
    expect(running).toBe(0);
    await queue.onModuleDestroy();
    const stopped = calls;
    await jest.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(stopped);
  });
});
