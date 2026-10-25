import { HikvisionService } from './hikvision.service';

function setup() {
  const prisma = {
    hikTerminal: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 't1', devIndex: 'd1', hospitalId: 'h1' }]),
    },
  };
  const config = { get: (_key: string, fallback: unknown) => fallback };
  const service = new HikvisionService(config as any, prisma as any, {} as any);
  const request = jest.spyOn(service as any, 'digestRequest');
  return { service, request };
}

describe('Gateway status accuracy', () => {
  it('gateway uzilsa terminalni offline deb taxmin qilmaydi', async () => {
    const { service, request } = setup();
    request.mockRejectedValue(new Error('gateway unreachable'));
    const [terminal] = await service.getTerminalsWithStatus('h1');
    expect(terminal.onlineStatus).toBe('unknown');
    expect((terminal as any).gatewayReachable).toBe(false);
  });

  it('gateway ro‘yxatida bo‘lmagan terminal holati noma’lum', async () => {
    const { service, request } = setup();
    request.mockResolvedValue({ data: { SearchResult: { MatchList: [] } } });
    const [terminal] = await service.getAllTerminalsWithStatus();
    expect(terminal.onlineStatus).toBe('unknown');
    expect((terminal as any).gatewayReachable).toBe(true);
  });

  it('faqat gateway aniq offline desa offline ko‘rsatadi', async () => {
    const { service, request } = setup();
    request.mockResolvedValue({
      data: {
        SearchResult: {
          MatchList: [{ Device: { devIndex: 'd1', devStatus: 'offline' } }],
        },
      },
    });
    expect((await service.getTerminalStatusSnapshot()).d1).toBe('offline');
  });
});

describe('Gateway inventory reliability', () => {
  const device = (n: number) => ({
    Device: { devIndex: `d${n}`, devStatus: 'online' },
  });

  it('100 dan ko‘p terminalni sahifalab oladi', async () => {
    const { service, request } = setup();
    request
      .mockResolvedValueOnce({
        data: {
          SearchResult: {
            MatchList: Array.from({ length: 100 }, (_, i) => device(i)),
            totalMatches: 101,
          },
        },
      })
      .mockResolvedValueOnce({
        data: { SearchResult: { MatchList: [device(100)], totalMatches: 101 } },
      });
    const statuses = await service.getTerminalStatusSnapshot();
    expect(Object.keys(statuses)).toHaveLength(101);
    expect(
      (request.mock.calls[1][2] as any).data.SearchDescription.position,
    ).toBe(100);
  });

  it('gateway noto‘g‘ri javobi bo‘sh ro‘yxat deb qabul qilinmaydi', async () => {
    const { service, request } = setup();
    request.mockResolvedValue({ data: { statusCode: 1 } });
    await expect(service.getTerminalStatusSnapshot()).rejects.toThrow(
      'SearchResult.MatchList',
    );
  });

  it('parallel holat tekshiruvlari bitta so‘rovni ishlatadi', async () => {
    const { service, request } = setup();
    request.mockResolvedValue({
      data: { SearchResult: { MatchList: [device(1)] } },
    });
    await Promise.all([
      service.getTerminalStatusSnapshot(),
      service.getTerminalStatusSnapshot(),
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('takroriy to‘liq sahifani aniq xato bilan to‘xtatadi', async () => {
    const { service, request } = setup();
    request.mockResolvedValue({
      data: {
        SearchResult: {
          MatchList: Array.from({ length: 100 }, (_, i) => device(i)),
          totalMatches: 200,
        },
      },
    });
    await expect(service.getTerminalStatusSnapshot()).rejects.toThrow(
      'bir xil sahifani',
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('Terminal user search pagination', () => {
  it('barcha sahifalar bir searchID dan foydalanadi', async () => {
    const { service, request } = setup();
    request
      .mockResolvedValueOnce({
        data: {
          UserInfoSearch: {
            UserInfo: [{ employeeNo: '1', numOfFace: 1 }],
            responseStatusStrg: 'MORE',
            numOfMatches: 1,
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          UserInfoSearch: {
            UserInfo: [{ employeeNo: '2', numOfFace: 0 }],
            responseStatusStrg: 'OK',
            numOfMatches: 1,
          },
        },
      });
    const users = await (service as any).getExistingPersons('d1');
    expect(users.size).toBe(2);
    const first = (request.mock.calls[0][2] as any).data.UserInfoSearchCond;
    const second = (request.mock.calls[1][2] as any).data.UserInfoSearchCond;
    expect(second.searchID).toBe(first.searchID);
    expect(second.searchResultPosition).toBe(1);
  });
  it('noto‘g‘ri javob bo‘sh terminal deb qabul qilinmaydi', async () => {
    const { service, request } = setup();
    request.mockResolvedValue({ data: {} });
    await expect((service as any).getExistingPersons('d1')).rejects.toThrow(
      'UserInfoSearch',
    );
  });
});
