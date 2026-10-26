import axios from 'axios';
import { HikvisionService } from './hikvision.service';

jest.mock('axios');
const mockedRequest = (axios as any).request as jest.Mock;

function makeService(prisma: any = {}) {
  const config: any = {
    get: jest.fn((k: string, d?: any) =>
      k === 'HIK_GATEWAY_URL' ? 'http://gw.local:8080' : d,
    ),
  };
  return new HikvisionService(config, prisma, {} as any);
}

const CHALLENGE =
  'Digest realm="IP Camera", qop="auth", nonce="abc123", algorithm=MD5';

describe('HikvisionService — digest (nonce qayta ishlatiladi)', () => {
  beforeEach(() => mockedRequest.mockReset());

  it("birinchi so'rov 401 → challenge bilan qayta; keyingisi darhol Authorization bilan (1 ta so'rov)", async () => {
    mockedRequest
      .mockResolvedValueOnce({
        status: 401,
        headers: { 'www-authenticate': CHALLENGE },
        data: '',
      })
      .mockResolvedValue({ status: 200, headers: {}, data: { ok: 1 } });
    const svc: any = makeService();

    await svc.digestRequest('GET', 'http://gw.local:8080/ISAPI/a');
    expect(mockedRequest).toHaveBeenCalledTimes(2);
    expect(mockedRequest.mock.calls[1][0].headers.Authorization).toMatch(
      /nc=00000001/,
    );

    await svc.digestRequest('GET', 'http://gw.local:8080/ISAPI/b');
    expect(mockedRequest).toHaveBeenCalledTimes(3);
    const auth = mockedRequest.mock.calls[2][0].headers.Authorization;
    expect(auth).toMatch(/nonce="abc123"/);
    expect(auth).toMatch(/nc=00000002/);
    expect(auth).toMatch(/uri="\/ISAPI\/b"/);
  });

  it('lease yo‘qolgach hech qanday terminal HTTP so‘rovi ketmaydi', async () => {
    const svc: any = makeService();
    await expect(
      svc.syncLeaseContext.run(
        () => {
          throw new Error('SYNC_LEASE_LOST');
        },
        () => svc.digestRequest('POST', 'http://gw.local:8080/write'),
      ),
    ).rejects.toThrow('SYNC_LEASE_LOST');
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('nonce eskirsa (401) — yangi challenge bilan bir marta qayta yuboriladi', async () => {
    const svc: any = makeService();
    mockedRequest
      .mockResolvedValueOnce({
        status: 401,
        headers: { 'www-authenticate': CHALLENGE },
        data: '',
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: {} })
      .mockResolvedValueOnce({
        status: 401,
        headers: {
          'www-authenticate':
            CHALLENGE.replace('abc123', 'fresh99') + ', stale=TRUE',
        },
        data: '',
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: 2 } });
    await svc.digestRequest('GET', 'http://gw.local:8080/ISAPI/a');
    const res = await svc.digestRequest('GET', 'http://gw.local:8080/ISAPI/a');
    expect(res.data).toEqual({ ok: 2 });
    expect(mockedRequest.mock.calls[3][0].headers.Authorization).toMatch(
      /nonce="fresh99".*nc=00000001/,
    );
  });

  it('multipart: FormData har yuborishda yangidan yaratiladi', async () => {
    const svc: any = makeService();
    mockedRequest
      .mockResolvedValueOnce({
        status: 401,
        headers: { 'www-authenticate': CHALLENGE },
        data: '',
      })
      .mockResolvedValue({ status: 200, headers: {}, data: {} });
    const createForm = jest.fn(() => {
      const FormData = jest.requireActual('form-data');
      const f = new FormData();
      f.append('a', 'b');
      return f;
    });
    await svc.digestMultipartRequest(
      'POST',
      'http://gw.local:8080/x',
      createForm,
    );
    expect(createForm).toHaveBeenCalledTimes(2);
    await svc.digestMultipartRequest(
      'POST',
      'http://gw.local:8080/x',
      createForm,
    );
    expect(createForm).toHaveBeenCalledTimes(3); // rasm endi bir marta yuboriladi
  });
});
