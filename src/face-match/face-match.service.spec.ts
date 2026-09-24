import axios from 'axios';
import { FaceMatchService } from './face-match.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * FaceMatchService har chaqiruvda process.env'ni o'qiydi (module-load
 * vaqtida emas), shuning uchun testlarda ENV'ni chaqiruvdan oldin
 * o'rnatish kifoya — modulni qayta yuklash shart emas. Haqiqiy Postgres
 * yoki Python face-match mikroservisi kerak emas — axios to'liq soxta.
 */
describe('FaceMatchService.verify — Qaror 4 (yuz tekshiruvi)', () => {
  const ref = Buffer.from('reference-photo');
  const live = Buffer.from('live-selfie');
  let svc: FaceMatchService;
  const ENV_KEYS = [
    'FACE_MATCH_ENABLED',
    'FACE_MATCH_MODE',
    'FACE_MATCH_SERVICE_URL',
    'FACE_MATCH_THRESHOLD',
    'FACE_MATCH_TIMEOUT_MS',
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new FaceMatchService();
    ENV_KEYS.forEach((k) => delete process.env[k]);
  });

  it("FACE_MATCH_ENABLED=false bo'lsa — hech qanday tekshiruv o'tkazmasdan skip qiladi", async () => {
    process.env.FACE_MATCH_ENABLED = 'false';
    const res = await svc.verify(ref, live);
    expect(res).toEqual({ skipped: true, mismatch: false, reason: 'DISABLED' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("xodimning profil rasmi yo'q bo'lsa — LENIENT rejimda skip qiladi", async () => {
    process.env.FACE_MATCH_MODE = 'lenient';
    const res = await svc.verify(null, live);
    expect(res).toEqual({
      skipped: true,
      mismatch: false,
      reason: 'NO_REFERENCE_PHOTO',
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("xodimning profil rasmi yo'q bo'lsa — STRICT (standart) rejimda bloklaydi", async () => {
    const res = await svc.verify(null, live);
    expect(res).toEqual({
      skipped: false,
      mismatch: true,
      reason: 'NO_REFERENCE_PHOTO',
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("FACE_MATCH_MODE ENV berilmasa — standart rejim STRICT bo'ladi", async () => {
    mockedAxios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await svc.verify(ref, live);
    expect(res.skipped).toBe(false);
    expect(res.mismatch).toBe(true);
    expect(res.reason).toBe('SERVICE_ERROR');
  });

  it('yuzlar mos kelsa — mismatch:false qaytaradi', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        match: true,
        similarity: 0.61,
        referenceFaceFound: true,
        liveFaceFound: true,
      },
    });
    const res = await svc.verify(ref, live);
    expect(res.mismatch).toBe(false);
    expect(res.skipped).toBe(false);
    expect(res.similarity).toBe(0.61);
  });

  it('timeout berilmasa CPU inference uchun 15 soniyalik zaxira ishlatadi', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        match: true,
        similarity: 0.61,
        referenceFaceFound: true,
        liveFaceFound: true,
      },
    });
    await svc.verify(ref, live);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ timeout: 15000 }),
    );
  });

  it('eski 6 soniyalik konfiguratsiyani ham xavfsiz 15 soniyaga ko‘taradi', async () => {
    process.env.FACE_MATCH_TIMEOUT_MS = '6000';
    mockedAxios.post.mockResolvedValue({
      data: {
        match: true,
        similarity: 0.61,
        referenceFaceFound: true,
        liveFaceFound: true,
      },
    });
    await svc.verify(ref, live);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ timeout: 15000 }),
    );
  });

  it('ANIQ MOS KELMASLIK — lenient rejimda ham bloklaydi (fail-open bunga tegishli emas)', async () => {
    process.env.FACE_MATCH_MODE = 'lenient';
    mockedAxios.post.mockResolvedValue({
      data: {
        match: false,
        similarity: 0.1,
        referenceFaceFound: true,
        liveFaceFound: true,
      },
    });
    const res = await svc.verify(ref, live);
    expect(res.mismatch).toBe(true);
    expect(res.reason).toBe('FACE_MISMATCH');
  });

  it('live rasmda yuz aniqlanmasa — LENIENT rejimda skip qiladi (bloklamaydi)', async () => {
    process.env.FACE_MATCH_MODE = 'lenient';
    mockedAxios.post.mockResolvedValue({
      data: {
        match: false,
        similarity: 0,
        referenceFaceFound: true,
        liveFaceFound: false,
      },
    });
    const res = await svc.verify(ref, live);
    expect(res.skipped).toBe(true);
    expect(res.mismatch).toBe(false);
    expect(res.reason).toBe('LIVE_FACE_NOT_FOUND');
  });

  it('live rasmda yuz aniqlanmasa — STRICT rejimda bloklaydi', async () => {
    process.env.FACE_MATCH_MODE = 'strict';
    mockedAxios.post.mockResolvedValue({
      data: {
        match: false,
        similarity: 0,
        referenceFaceFound: true,
        liveFaceFound: false,
      },
    });
    const res = await svc.verify(ref, live);
    expect(res.skipped).toBe(false);
    expect(res.mismatch).toBe(true);
    expect(res.reason).toBe('LIVE_FACE_NOT_FOUND');
  });

  it('mikroservis ishlamasa (tarmoq xatosi) — LENIENT rejimda skip qiladi (check-in davom etadi)', async () => {
    process.env.FACE_MATCH_MODE = 'lenient';
    mockedAxios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await svc.verify(ref, live);
    expect(res.skipped).toBe(true);
    expect(res.mismatch).toBe(false);
    expect(res.reason).toBe('SERVICE_ERROR');
  });

  it('mikroservis ishlamasa (tarmoq xatosi) — STRICT rejimda bloklaydi', async () => {
    process.env.FACE_MATCH_MODE = 'strict';
    mockedAxios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await svc.verify(ref, live);
    expect(res.skipped).toBe(false);
    expect(res.mismatch).toBe(true);
    expect(res.reason).toBe('SERVICE_ERROR');
  });

  it("xizmat 400 qaytarsa (rasm o'qilmadi) — SERVICE_ERROR emas, LIVE_FACE_NOT_FOUND (kechiktirilmaydi)", async () => {
    process.env.FACE_MATCH_MODE = 'strict';
    mockedAxios.post.mockRejectedValue(
      Object.assign(new Error('Bad Request'), {
        response: { status: 400, data: { detail: 'bad image' } },
      }),
    );
    const res = await svc.verify(ref, live);
    expect(res.mismatch).toBe(true);
    expect(res.reason).toBe('LIVE_FACE_NOT_FOUND');
  });

  it('xizmat 500 qaytarsa — SERVICE_ERROR', async () => {
    process.env.FACE_MATCH_MODE = 'strict';
    mockedAxios.post.mockRejectedValue(
      Object.assign(new Error('boom'), { response: { status: 500 } }),
    );
    const res = await svc.verify(ref, live);
    expect(res.reason).toBe('SERVICE_ERROR');
  });
});
