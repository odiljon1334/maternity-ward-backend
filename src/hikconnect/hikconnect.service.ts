import {
  Injectable,
  Logger,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Video kuzatuv — ikki rejim qo'llab-quvvatlanadi:
 *
 * 1. MediaMTX:
 *    - Har bir poliklinikada FFmpeg agent ishlaydi
 *    - FFmpeg RTSP → VPS MediaMTX ga push qiladi
 *    - Camera.streamPath = "hospital1/cam1"
 *    - HLS URL: https://{MEDIAMTX_HLS_HOST}/{streamPath}/index.m3u8
 *
 * 2. Hik-Connect for Teams (HikCentral Connect) OpenAPI:
 *    - Bu — Artemis/on-premise API EMAS. Autentifikatsiya token-asosida:
 *        POST {HIKCONNECT_HOST}/api/hccgw/platform/v1/token/get
 *        body: { appKey, secretKey } → { accessToken, areaDomain, expireTime }
 *      Keyingi barcha so'rovlar accessToken'ni "Token" header sifatida,
 *      va bazaviy URL sifatida areaDomain'ni ishlatadi (HIKCONNECT_HOST emas!).
 *    - Camera.cameraIndexCode = HCC camera "id" (resourceId sifatida ishlatiladi)
 *    - Camera.deviceSerial    = HCC device serialNo
 *
 * .env:
 *   MEDIAMTX_HLS_HOST     = https://vps-ip:8888
 *   HIKCONNECT_HOST       = https://ieu.hikcentralconnect.com   (region serveri —
 *                           Getting Started jadvalidan: Rossiya/Singapur-Hindiston/
 *                           Yevropa/Janubiy Amerika/Shimoliy Amerika)
 *   HIKCONNECT_APP_KEY    = ...
 *   HIKCONNECT_APP_SECRET = ...
 *
 * DIQQAT: India/Rossiya regionlarida RTMP/HLS protokoli QO'LLAB-QUVVATLANMAYDI —
 * shu regionlarda protocol:2 (HLS) o'rniga EZOPEN (protocol:1) + JS SDK
 * (WASM/JSDecoder) kerak bo'ladi.
 */

export interface LiveUrlResult {
  url: string;
  protocol: 'hls' | 'rtsp' | 'rtmp';
  expireTime: number;
  source: 'mediamtx' | 'hikconnect';
}

interface HccTokenCache {
  accessToken: string;
  areaDomain: string;
  expireAt: number; // ms, Date.now() asosida — token/get javobidagi expireTime emas
}

@Injectable()
export class HikConnectService {
  private readonly logger = new Logger(HikConnectService.name);

  // HikConnect (Hik-Connect for Teams / HikCentral Connect OpenAPI)
  private readonly hikHost: string;
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly hikConfigured: boolean;
  private tokenCache: HccTokenCache | null = null;
  private tokenFetchInFlight: Promise<HccTokenCache> | null = null;

  // MediaMTX
  private readonly mediamtxHost: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.hikHost = this.config.get('HIKCONNECT_HOST', '');
    this.appKey = this.config.get('HIKCONNECT_APP_KEY', '');
    this.appSecret = this.config.get('HIKCONNECT_APP_SECRET', '');
    this.hikConfigured = !!(this.hikHost && this.appKey && this.appSecret);

    this.mediamtxHost = this.config.get('MEDIAMTX_HLS_HOST', '');

    if (!this.hikConfigured) {
      this.logger.log(
        'HikConnect sozlanmagan (HIKCONNECT_HOST/APP_KEY/APP_SECRET) — faqat MediaMTX rejimida ishlaydi.',
      );
    }
    if (!this.mediamtxHost) {
      this.logger.warn(
        'MEDIAMTX_HLS_HOST sozlanmagan. MediaMTX orqali kamera URL lar ishlamaydi.',
      );
    }
  }

  // ─── Camera CRUD ───────────────────────────────────────────────────────────

  async getCamerasForHospital(hospitalId: string) {
    return this.prisma.camera.findMany({
      where: { hospitalId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async getAllCameras(hospitalId?: string) {
    return this.prisma.camera.findMany({
      where: hospitalId ? { hospitalId } : {},
      include: { hospital: { select: { id: true, name: true, code: true } } },
      orderBy: [{ hospital: { name: 'asc' } }, { name: 'asc' }],
    });
  }

  async createCamera(data: {
    hospitalId: string;
    name: string;
    streamPath?: string;
    cameraIndexCode?: string;
    channelNo?: number;
    deviceSerial?: string;
  }) {
    return this.prisma.camera.create({ data });
  }

  async updateCamera(
    id: string,
    data: {
      name?: string;
      streamPath?: string;
      cameraIndexCode?: string;
      channelNo?: number;
      deviceSerial?: string;
      isActive?: boolean;
    },
  ) {
    return this.prisma.camera.update({ where: { id }, data });
  }

  async deleteCamera(id: string) {
    return this.prisma.camera.delete({ where: { id } });
  }

  // ─── Live URL — asosiy metod ───────────────────────────────────────────────

  /**
   * Kamera ID si bo'yicha HLS stream URL qaytaradi.
   *
   * Prioritet:
   *   1. HikConnect (configured bo'lsa va cameraIndexCode + deviceSerial bor bo'lsa)
   *   2. MediaMTX   (streamPath bor bo'lsa)
   */
  async getLiveUrlById(cameraId: string): Promise<LiveUrlResult> {
    const camera = await this.prisma.camera.findUnique({
      where: { id: cameraId },
    });
    if (!camera) throw new NotFoundException('Kamera topilmadi');

    if (this.hikConfigured && camera.cameraIndexCode && camera.deviceSerial) {
      return this.getLiveUrlFromHikConnect(
        camera.cameraIndexCode,
        camera.deviceSerial,
      );
    }

    if (camera.streamPath) {
      return this.getLiveUrlFromMediaMTX(camera.streamPath);
    }

    throw new InternalServerErrorException(
      'Kamera uchun stream sozlanmagan. streamPath yoki (cameraIndexCode + deviceSerial) kerak.',
    );
  }

  /** Barcha sozlamalar holati */
  getStatus() {
    return {
      hikconnect: {
        configured: this.hikConfigured,
        host: this.hikHost || null,
        areaDomain: this.tokenCache?.areaDomain ?? null,
      },
      mediamtx: {
        configured: !!this.mediamtxHost,
        host: this.mediamtxHost || null,
      },
    };
  }

  isConfigured(): boolean {
    return this.hikConfigured || !!this.mediamtxHost;
  }

  // ─── HikConnect dan kameralar ro'yxatini olish (import qilish uchun) ───────

  async fetchCamerasFromHikConnect(params?: {
    pageIndex?: number;
    pageSize?: number;
  }) {
    if (!this.hikConfigured) {
      throw new InternalServerErrorException('HikConnect sozlanmagan.');
    }

    const body = {
      pageIndex: params?.pageIndex ?? 1,
      pageSize: params?.pageSize ?? 100,
      filter: {
        areaID: '-1',
        includeSubArea: '-1',
      },
    };

    const response = await this.hccPost<{
      totalCount: number;
      pageIndex: number;
      pageSize: number;
      camera: any[];
    }>('/api/hccgw/resource/v1/areas/cameras/get', body);

    return {
      list: (response.camera ?? []).map((c: any) => ({
        // 'id' — keyingi live/address/get so'rovida resourceId sifatida ishlatiladi
        cameraIndexCode: c.id ?? '',
        cameraName: c.name ?? '',
        deviceSerial: c.device?.devInfo?.serialNo ?? '',
        channelNo: Number(c.device?.channelInfo?.no ?? 1),
        online: c.online === '1',
      })),
      total: response.totalCount ?? 0,
    };
  }

  // ─── PRIVATE: MediaMTX HLS URL ────────────────────────────────────────────

  private getLiveUrlFromMediaMTX(streamPath: string): LiveUrlResult {
    if (!this.mediamtxHost) {
      throw new InternalServerErrorException(
        "MEDIAMTX_HLS_HOST sozlanmagan. VPS da MediaMTX o'rnatilganmi?",
      );
    }

    const host = this.mediamtxHost.replace(/\/$/, '');
    return {
      url: `${host}/${streamPath}/index.m3u8`,
      protocol: 'hls',
      expireTime: 0, // MediaMTX da expiry yo'q — FFmpeg agent ishlayotganida doimiy
      source: 'mediamtx',
    };
  }

  // ─── PRIVATE: Hik-Connect for Teams (HCC) OpenAPI ─────────────────────────

  private async getLiveUrlFromHikConnect(
    resourceId: string,
    deviceSerial: string,
  ): Promise<LiveUrlResult> {
    const response = await this.hccPost<{
      id: string;
      url: string;
      expireTime?: number;
    }>('/api/hccgw/video/v1/live/address/get', {
      resourceId,
      deviceSerial,
      type: '1', // 1 = live view
      protocol: 2, // 2 = HLS (brauzerda hls.js bilan to'g'ridan-to'g'ri ochiladi)
      quality: 1,
      expireTime: 3600,
    });

    return {
      url: response.url,
      protocol: 'hls',
      expireTime: response.expireTime ?? 3600,
      source: 'hikconnect',
    };
  }

  /**
   * Token olish/keshdan qaytarish. Muddati tugashiga 60 soniya qolganda
   * avtomatik yangilaydi. Bir vaqtda bir nechta so'rov token so'ramasligi
   * uchun tokenFetchInFlight bilan birlashtiriladi.
   */
  private async getToken(): Promise<HccTokenCache> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expireAt > now + 60_000) {
      return this.tokenCache;
    }

    if (this.tokenFetchInFlight) {
      return this.tokenFetchInFlight;
    }

    this.tokenFetchInFlight = this.fetchNewToken().finally(() => {
      this.tokenFetchInFlight = null;
    });

    return this.tokenFetchInFlight;
  }

  private async fetchNewToken(): Promise<HccTokenCache> {
    try {
      const res = await axios.post<{
        errorCode: string;
        msg?: string;
        data?: {
          accessToken: string;
          expireTime: number;
          userId: string;
          areaDomain: string;
        };
      }>(
        `${this.hikHost}/api/hccgw/platform/v1/token/get`,
        { appKey: this.appKey, secretKey: this.appSecret },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10_000,
        },
      );

      if (res.data.errorCode !== '0' || !res.data.data) {
        throw new InternalServerErrorException(
          `HikConnect token xatosi: ${res.data.errorCode} — ${res.data.msg ?? ''}`,
        );
      }

      const { accessToken, areaDomain, expireTime } = res.data.data;
      const cache: HccTokenCache = {
        accessToken,
        areaDomain,
        // expireTime — unix soniya. 60s marja bilan keshlaymiz (getToken ichida tekshiriladi)
        expireAt: expireTime * 1000,
      };
      this.tokenCache = cache;
      this.logger.log(`HikConnect token yangilandi. areaDomain=${areaDomain}`);
      return cache;
    } catch (err: any) {
      if (err instanceof InternalServerErrorException) throw err;
      this.logger.error(`HikConnect token olishda xato: ${err.message}`);
      throw new InternalServerErrorException(
        `HikConnect token olishda xato: ${err.message}`,
      );
    }
  }

  /**
   * areaDomain asosida hccgw endpointiga Token header bilan POST so'rov.
   */
  private async hccPost<T>(path: string, body: object): Promise<T> {
    const { accessToken, areaDomain } = await this.getToken();

    try {
      const res = await axios.post<{
        errorCode: string;
        msg?: string;
        data: T;
      }>(`${areaDomain}${path}`, body, {
        headers: {
          'Content-Type': 'application/json',
          Token: accessToken,
        },
        timeout: 10_000,
      });

      if (res.data.errorCode !== '0') {
        throw new InternalServerErrorException(
          `HikConnect API xatosi: ${res.data.errorCode} — ${res.data.msg ?? ''}`,
        );
      }
      return res.data.data;
    } catch (err: any) {
      if (err instanceof InternalServerErrorException) throw err;
      this.logger.error(`HikConnect so'rov xatosi (${path}): ${err.message}`);
      throw new InternalServerErrorException(
        `HikConnect bilan ulanishda xato: ${err.message}`,
      );
    }
  }
}
