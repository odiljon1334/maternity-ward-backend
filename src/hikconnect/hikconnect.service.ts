import {
  Injectable,
  Logger,
  InternalServerErrorException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Video kuzatuv — ikki rejim qo'llab-quvvatlanadi:
 *
 * 1. MediaMTX (hozir ishlatilmoqda):
 *    - Har bir poliklinikada FFmpeg agent ishlaydi
 *    - FFmpeg RTSP → VPS MediaMTX ga push qiladi
 *    - Camera.streamPath = "hospital1/cam1"
 *    - HLS URL: https://{MEDIAMTX_HOST}/{streamPath}/index.m3u8
 *
 * 2. Hik-Connect for Teams OpenAPI V2.15.0 (konfiguratsiya bo'lsa):
 *    - PDF §3.2: POST /api/hccgw/platform/v1/token/get → accessToken + areaDomain
 *    - PDF §5.1.4: GET  /api/hccgw/platform/v1/streamtoken/get → appToken (SDK uchun)
 *    - PDF §5.11.6: POST /api/hccgw/video/v1/live/address/get → HLS/RTMP URL
 *    - Camera.cameraIndexCode = HikConnect camera resource ID
 *    - Camera.deviceSerial    = qurilma seriyasi (live URL uchun zarur)
 *
 * .env:
 *   MEDIAMTX_HLS_HOST         = https://vps-ip:8888
 *   HIKCONNECT_APP_KEY        = 9xAJIZEOr5enH580IGk2A3ooJQgyWX26
 *   HIKCONNECT_APP_SECRET     = mAqGVnNxmQZkO56sXTZgPnNHhLnzcQgR
 *   HIKCONNECT_BASE_URL       = https://iotservice.hik-connect.com
 */

export interface LiveUrlResult {
  url: string;
  protocol: 'hls' | 'rtsp' | 'rtmp' | 'ezopen';
  expireTime: number;
  source: 'mediamtx' | 'hikconnect';
}

// ─── Token cache (modul ichida) ───────────────────────────────────────────────
interface TokenCache {
  accessToken: string;
  areaDomain: string;
  expiresAt: number; // ms
}

@Injectable()
export class HikConnectService implements OnModuleInit {
  private readonly logger = new Logger(HikConnectService.name);

  // Hik-Connect for Teams
  private readonly hikBaseUrl: string; // token/get uchun (iotservice.hik-connect.com)
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly hikConfigured: boolean;

  // MediaMTX
  private readonly mediamtxHost: string;

  // Token cache
  private tokenCache: TokenCache | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.hikBaseUrl = this.config.get(
      'HIKCONNECT_BASE_URL',
      'https://iotservice.hik-connect.com',
    );
    this.appKey = this.config.get('HIKCONNECT_APP_KEY', '');
    this.appSecret = this.config.get('HIKCONNECT_APP_SECRET', '');
    this.hikConfigured = !!(this.appKey && this.appSecret);

    this.mediamtxHost = this.config.get('MEDIAMTX_HLS_HOST', '');

    if (!this.hikConfigured) {
      this.logger.log('HikConnect sozlanmagan — MediaMTX rejimida ishlaydi.');
    }
    if (!this.mediamtxHost) {
      this.logger.warn(
        'MEDIAMTX_HLS_HOST sozlanmagan. Kamera URL lar ishlamaydi.',
      );
    }
  }

  async onModuleInit() {
    if (this.hikConfigured) {
      try {
        await this.ensureToken();
        this.logger.log('HikConnect token muvaffaqiyatli olindi');
      } catch (err: any) {
        this.logger.error(`HikConnect token xatosi: ${err.message}`);
      }
    }
  }

  // ─── Camera CRUD ─────────────────────────────────────────────────────────────

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

  async getDeviceDetail(deviceSerial: string) {
    if (!this.hikConfigured) {
      throw new InternalServerErrorException('HikConnect sozlanmagan.');
    }

    const res = await this.hccPost<{
      device: {
        baseInfo: {
          id: string;
          name: string;
          category: string;
          serialNo: string;
          version: string;
          streamEncryptEnable: string;
          availableCameraChannelNum: string;
          areaId: string;
        };

        onlineStatus: number;

        cameraChannel: Array<{
          id: string;
          name: string;
          no: string;
          online: string;
        }>;

        doorChannel?: Array<{
          id: string;
          name: string;
          no: string;
          online: string;
        }>;
      };
    }>('/api/hccgw/resource/v1/devicedetail/get', {
      deviceSerialNo: deviceSerial,
    });

    const device = res.device;

    return {
      device: {
        id: device.baseInfo.id,
        name: device.baseInfo.name,
        serialNo: device.baseInfo.serialNo,
        type: device.baseInfo.category,
        version: device.baseInfo.version,
        areaId: device.baseInfo.areaId,
        online: device.onlineStatus === 1,
      },

      cameras: (device.cameraChannel ?? []).map((camera) => ({
        cameraIndexCode: camera.id,
        name: camera.name,
        channelNo: Number(camera.no),
        online: camera.online === '1',
      })),
    };
  }

  // ─── Live URL — asosiy metod ──────────────────────────────────────────────────

  /**
   * Prioritet:
   *   1. Hik-Connect for Teams (hikConfigured && cameraIndexCode && deviceSerial)
   *   2. MediaMTX (streamPath)
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

  /** Eski interfeys — to'g'ridan-to'g'ri cameraIndexCode + deviceSerial bilan */
  async getLiveUrl(
    cameraIndexCode: string,
    deviceSerial?: string,
  ): Promise<LiveUrlResult> {
    if (!this.hikConfigured) {
      throw new InternalServerErrorException(
        'HikConnect sozlanmagan. getLiveUrlById ishlatilsin.',
      );
    }
    if (!deviceSerial) {
      throw new InternalServerErrorException(
        'deviceSerial kerak (HikConnect live URL uchun).',
      );
    }
    return this.getLiveUrlFromHikConnect(cameraIndexCode, deviceSerial);
  }

  /** Sozlamalar holati */
  getStatus() {
    return {
      hikconnect: {
        configured: this.hikConfigured,
        baseUrl: this.hikBaseUrl,
        tokenCached: !!this.tokenCache,
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

  // ─── PRIVATE: MediaMTX HLS URL ───────────────────────────────────────────────

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
      expireTime: 0,
      source: 'mediamtx',
    };
  }

  // ─── PRIVATE: Hik-Connect for Teams live URL ─────────────────────────────────

  /**
   * POST /api/hccgw/video/v1/live/address/get
   * PDF §5.11.6
   *
   * protocol: 2 = HLS, 3 = RTMP, 1 = EZOPEN (JS SDK)
   * HLS tanlangan: H264 kerak, stream encryption o'chirilgan bo'lishi kerak.
   */
  private async getLiveUrlFromHikConnect(
    cameraIndexCode: string,
    deviceSerial: string,
  ): Promise<LiveUrlResult> {
    const res = await this.hccPost<{
      id: string;
      url: string;
      expireTime: number;
    }>('/api/hccgw/video/v1/live/address/get', {
      resourceId: cameraIndexCode,
      deviceSerial: deviceSerial,
      type: '1', // 1 = live view
      protocol: 2, // 2 = HLS
      quality: 2, // 2 = Fluent (sub-bitrate) — mobil uchun yaxshi
      expireTime: 3600, // 1 soat
    });

    return {
      url: res.url,
      protocol: 'hls',
      expireTime: res.expireTime ?? 0,
      source: 'hikconnect',
    };
  }

  // ─── PRIVATE: Token boshqaruvi ────────────────────────────────────────────────

  /**
   * Token 1 soat zaxira qoldirib yangilanadi.
   * POST /api/hccgw/platform/v1/token/get
   * PDF §5.1.1 — appKey + secretKey, Artemis imzosi YO'Q.
   */
  private async ensureToken(): Promise<{
    accessToken: string;
    areaDomain: string;
  }> {
    const bufferMs = 60 * 60 * 1000; // 1 soat oldin yangilash
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - bufferMs) {
      return this.tokenCache;
    }

    const url = `${this.hikBaseUrl}/api/hccgw/platform/v1/token/get`;
    const res = await axios.post<{
      errorCode: string;
      message?: string;
      data?: {
        accessToken: string;
        expireTime: number; // Unix seconds
        userId: string;
        areaDomain: string;
      };
    }>(
      url,
      { appKey: this.appKey, secretKey: this.appSecret },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10_000 },
    );

    if (res.data.errorCode !== '0' || !res.data.data) {
      throw new InternalServerErrorException(
        `HikConnect token xatosi [${res.data.errorCode}]: ${res.data.message}`,
      );
    }

    const { accessToken, areaDomain, expireTime } = res.data.data;
    this.tokenCache = {
      accessToken,
      areaDomain,
      expiresAt: expireTime * 1000, // seconds → ms
    };

    this.logger.log(`Token yangilandi. areaDomain: ${areaDomain}`);
    return this.tokenCache;
  }

  // ─── PRIVATE: Umumiy Hik-Connect for Teams POST yordamchisi ─────────────────

  /**
   * areaDomain + path birlashtiradi, Token header qo'shadi.
   * Hamma API so'rovlari (token/get dan tashqari) shu orqali o'tadi.
   */
  private async hccPost<T>(path: string, body: object): Promise<T> {
    const { accessToken, areaDomain } = await this.ensureToken();
    const url = `${areaDomain}${path}`;

    try {
      const res = await axios.post<{
        errorCode: string;
        message?: string;
        data: T;
      }>(url, body, {
        headers: {
          'Content-Type': 'application/json',
          Token: accessToken,
        },
        timeout: 10_000,
      });

      if (res.data.errorCode !== '0') {
        // Token muddati o'tgan bo'lsa — bir marta tozalab qayta urinish
        if (res.data.errorCode === '10002' || res.data.errorCode === '401') {
          this.tokenCache = null;
          const retry = await this.ensureToken();
          const res2 = await axios.post<{
            errorCode: string;
            message?: string;
            data: T;
          }>(`${retry.areaDomain}${path}`, body, {
            headers: {
              'Content-Type': 'application/json',
              Token: retry.accessToken,
            },
            timeout: 10_000,
          });
          if (res2.data.errorCode !== '0') {
            throw new InternalServerErrorException(
              `HikConnect API xatosi [${res2.data.errorCode}]: ${res2.data.message}`,
            );
          }
          return res2.data.data;
        }

        throw new InternalServerErrorException(
          `HikConnect API xatosi [${res.data.errorCode}]: ${res.data.message}`,
        );
      }

      return res.data.data;
    } catch (err: any) {
      if (err instanceof InternalServerErrorException) throw err;
      this.logger.error(`HikConnect so'rov xatosi: ${err.message}`);
      throw new InternalServerErrorException(
        `HikConnect bilan ulanishda xato: ${err.message}`,
      );
    }
  }
}
