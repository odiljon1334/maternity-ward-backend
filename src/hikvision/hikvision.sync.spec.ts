import axios from 'axios';
import * as fs from 'fs';
import { HikvisionService, setSyncRetryBaseMs } from './hikvision.service';

jest.mock('axios');
const mockedRequest = (axios as any).request as jest.Mock;

function makeService(prisma: any = {}) {
  const config: any = {
    get: jest.fn((k: string, d?: any) =>
      k === 'HIK_GATEWAY_URL' ? 'http://gw.local:8080' : d,
    ),
  };
  return new HikvisionService(config, prisma);
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

describe('HikvisionService — fon sync', () => {
  beforeAll(() => setSyncRetryBaseMs(1));
  afterEach(() => jest.restoreAllMocks());

  const employees = [
    { employeeNo: '1', fullName: 'Ali', photoUrl: '/uploads/p1.jpg' },
    { employeeNo: '2', fullName: 'Vali', photoUrl: '/uploads/p2.jpg' },
    { employeeNo: '3', fullName: 'Soli', photoUrl: '/uploads/p3.jpg' },
    { employeeNo: '4', fullName: 'Rasmsiz', photoUrl: null },
  ];

  function setup(terminals: any[]) {
    const prisma: any = {
      hikTerminal: { findMany: jest.fn(async () => terminals) },
      employee: { findMany: jest.fn(async () => employees) },
    };
    const svc: any = makeService(prisma);
    jest
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(async () => Buffer.from('img') as any);
    jest.spyOn(svc, 'compressFace').mockImplementation(async (b: any) => b);
    return svc;
  }

  it("POST darhol qaytadi (RUNNING), qayta bosish — o'sha ish; tugagach natija va progress", async () => {
    const svc = setup([
      { id: 't1', name: 'Kirish', devIndex: 'D1' },
      { id: 't2', name: 'Chiqish', devIndex: 'D2' },
    ]);
    jest
      .spyOn(svc, 'getExistingPersons')
      .mockImplementation(async (dev: any) =>
        dev === 'D1' ? new Map([['1', true]]) : new Map(),
      );
    const addPerson = jest.spyOn(svc, 'addPerson').mockResolvedValue({});
    const addFace = jest.spyOn(svc, 'addFacePicture').mockResolvedValue({});

    const first = svc.startSync('h1');
    expect(first.state).toBe('RUNNING');
    expect(svc.startSync('h1').id).toBe(first.id);

    const res = await svc.syncHospital('h1');
    expect(res).toMatchObject({
      state: 'DONE',
      total: 3,
      withoutPhoto: 1,
      units: 6,
      done: 6,
      created: 5,
      skipped: 1,
      failed: 0,
    });
    expect(addPerson).toHaveBeenCalledTimes(5);
    expect(addFace).toHaveBeenCalledTimes(5);
    // Rasm terminal soniga qarab emas — har xodimga bir marta o'qiladi
    expect((fs.promises.readFile as any).mock.calls.length).toBe(3);
    expect(addFace.mock.calls[0][3]).toEqual({ compressed: true });
    expect(svc.getSyncStatus('h1').state).toBe('DONE');
  });

  it("terminal ro'yxati olinmasa — o'sha terminal to'xtatiladi, bitta aniq xato, boshqasi ishlayveradi", async () => {
    const svc = setup([
      { id: 't1', name: 'Kirish', devIndex: 'D1' },
      { id: 't2', name: 'Ombor', devIndex: 'D2' },
    ]);
    jest
      .spyOn(svc, 'getExistingPersons')
      .mockImplementation(async (dev: any) => {
        if (dev === 'D2')
          throw Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED',
          });
        return new Map();
      });
    jest.spyOn(svc, 'addPerson').mockResolvedValue({});
    jest.spyOn(svc, 'addFacePicture').mockResolvedValue({});

    const res = await svc.syncHospital('h1');
    expect(res.created).toBe(3);
    expect(res.failed).toBe(3);
    expect(res.done).toBe(6);
    const ombor = res.perTerminal.find((t: any) => t.terminalName === 'Ombor');
    expect(ombor).toMatchObject({ aborted: true, failed: 3 });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].reason).toMatch(/Ombor: terminal javob bermadi/);
  });

  it('ketma-ket 3 marta tarmoq xatosi — qolgan xodimlar kutilmaydi', async () => {
    const svc = setup([{ id: 't1', name: 'Kirish', devIndex: 'D1' }]);
    const many = Array.from({ length: 6 }, (_, i) => ({
      employeeNo: String(i + 1),
      fullName: `X${i}`,
      photoUrl: `/uploads/p${i}.jpg`,
    }));
    (svc as any).prisma.employee.findMany = jest.fn(async () => many);
    jest.spyOn(svc, 'getExistingPersons').mockResolvedValue(new Map());
    const addPerson = jest.spyOn(svc, 'addPerson').mockRejectedValue(
      Object.assign(new Error('timeout of 15000ms exceeded'), {
        code: 'ECONNABORTED',
      }),
    );
    jest.spyOn(svc, 'addFacePicture').mockResolvedValue({});

    const res = await svc.syncHospital('h1');
    expect(res.failed).toBe(6);
    expect(res.done).toBe(6);
    expect(res.perTerminal[0].aborted).toBe(true);
    // 3 xodim × 3 urinish (2 qayta) — qolgan 3 tasiga so'rov ketmaydi
    expect(addPerson).toHaveBeenCalledTimes(9);
    expect(res.errors.at(-1).reason).toMatch(/qolgan 3 xodim/);
  });

  it("'allaqachon mavjud' xatosi muvaffaqiyat hisoblanadi, boshqa xato — xato ro'yxatida", async () => {
    const svc = setup([{ id: 't1', name: 'Kirish', devIndex: 'D1' }]);
    jest.spyOn(svc, 'getExistingPersons').mockResolvedValue(new Map());
    jest
      .spyOn(svc, 'addPerson')
      .mockRejectedValueOnce(new Error('employeeNoAlreadyExist'))
      .mockResolvedValue({});
    jest
      .spyOn(svc, 'addFacePicture')
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error('faceQualityBad'), {
          friendlyMessage: 'Yuz rasmi sifatsiz',
        }),
      )
      .mockResolvedValue({});
    const res = await svc.syncHospital('h1');
    expect(res.created).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.errors[0].reason).toBe('Kirish: Yuz rasmi sifatsiz');
  });

  it('faol terminal yo‘q — darhol tugaydi', async () => {
    const svc = setup([]);
    const res = await svc.syncHospital('h1');
    expect(res.state).toBe('DONE');
    expect(res.errors[0].reason).toMatch(/terminal topilmadi/i);
  });
});
