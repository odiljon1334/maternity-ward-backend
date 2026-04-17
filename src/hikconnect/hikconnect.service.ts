import {
  Injectable,
  Logger,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
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
 * 2. HikConnect OpenAPI (keyinroq, AppKey olinganda):
 *    - Camera.cameraIndexCode = HikConnect ID
 *    - HIKCONNECT_APP_KEY + HIKCONNECT_APP_SECRET .env ga qo'shiladi
 *    - Avtomatik HikConnect ga switch bo'ladi
 *
 * .env:
 *   MEDIAMTX_HLS_HOST     = https://vps-ip:8888        (MediaMTX HLS port)
 *   HIKCONNECT_HOST       = https://open.hikvision.com  (keyinroq)
 *   HIKCONNECT_APP_KEY    = ...                         (keyinroq)
 *   HIKCONNECT_APP_SECRET = ...                         (keyinroq)
 */

export interface LiveUrlResult {
  url:        string;
  protocol:   'hls' | 'rtsp' | 'rtmp';
  expireTime: number;
  source:     'mediamtx' | 'hikconnect';
}

@Injectable()
export class HikConnectService {
  private readonly logger = new Logger(HikConnectService.name);

  // HikConnect
  private readonly hikHost:    string;
  private readonly appKey:     string;
  private readonly appSecret:  string;
  private readonly hikConfigured: boolean;

  // MediaMTX
  private readonly mediamtxHost: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.hikHost      = this.config.get('HIKCONNECT_HOST', 'https://open.hikvision.com');
    this.appKey       = this.config.get('HIKCONNECT_APP_KEY', '');
    this.appSecret    = this.config.get('HIKCONNECT_APP_SECRET', '');
    this.hikConfigured = !!(this.appKey && this.appSecret);

    this.mediamtxHost = this.config.get('MEDIAMTX_HLS_HOST', '');

    if (!this.hikConfigured) {
      this.logger.log('HikConnect sozlanmagan — MediaMTX rejimida ishlaydi.');
    }
    if (!this.mediamtxHost) {
      this.logger.warn('MEDIAMTX_HLS_HOST sozlanmagan. Kamera URL lar ishlamaydi.');
    }
  }

  // ─── Camera CRUD ───────────────────────────────────────────────────────────

  async getCamerasForHospital(hospitalId: string) {
    return this.prisma.camera.findMany({
      where:   { hospitalId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async getAllCameras(hospitalId?: string) {
    return this.prisma.camera.findMany({
      where:   hospitalId ? { hospitalId } : {},
      include: { hospital: { select: { id: true, name: true, code: true } } },
      orderBy: [{ hospital: { name: 'asc' } }, { name: 'asc' }],
    });
  }

  async createCamera(data: {
    hospitalId:      string;
    name:            string;
    streamPath?:     string;
    cameraIndexCode?: string;
    channelNo?:      number;
    deviceSerial?:   string;
  }) {
    return this.prisma.camera.create({ data });
  }

  async updateCamera(id: string, data: {
    name?:            string;
    streamPath?:      string;
    cameraIndexCode?: string;
    channelNo?:       number;
    deviceSerial?:    string;
    isActive?:        boolean;
  }) {
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
   *   1. HikConnect (configured bo'lsa va cameraIndexCode bor bo'lsa)
   *   2. MediaMTX   (streamPath bor bo'lsa)
   */
  async getLiveUrlById(cameraId: string): Promise<LiveUrlResult> {
    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId } });
    if (!camera) throw new NotFoundException('Kamera topilmadi');

    // HikConnect — birinchi prioritet
    if (this.hikConfigured && camera.cameraIndexCode) {
      return this.getLiveUrlFromHikConnect(camera.cameraIndexCode);
    }

    // MediaMTX — ikkinchi prioritet
    if (camera.streamPath) {
      return this.getLiveUrlFromMediaMTX(camera.streamPath);
    }

    throw new InternalServerErrorException(
      'Kamera uchun stream sozlanmagan. streamPath yoki cameraIndexCode kerak.',
    );
  }

  /**
   * cameraIndexCode bo'yicha (eski interfeys — HikConnect uchun saqlanadi)
   */
  async getLiveUrl(cameraIndexCode: string): Promise<LiveUrlResult> {
    if (!this.hikConfigured) {
      throw new InternalServerErrorException(
        'HikConnect sozlanmagan. MEDIAMTX orqali getLiveUrlById ishlatilsin.',
      );
    }
    return this.getLiveUrlFromHikConnect(cameraIndexCode);
  }

  /** Barcha sozlamalar holati */
  getStatus() {
    return {
      hikconnect: {
        configured: this.hikConfigured,
        host:       this.hikHost,
      },
      mediamtx: {
        configured: !!this.mediamtxHost,
        host:       this.mediamtxHost || null,
      },
    };
  }

  isConfigured(): boolean {
    return this.hikConfigured || !!this.mediamtxHost;
  }

  // ─── HikConnect dan kameralar import qilish ────────────────────────────────

  async fetchCamerasFromHikConnect(params?: {
    pageNo?:   number;
    pageSize?: number;
  }) {
    if (!this.hikConfigured) {
      throw new InternalServerErrorException('HikConnect sozlanmagan.');
    }

    const path = '/artemis/api/resource/v1/cameras/indexCode/cameraList';
    const body = {
      pageNo:   params?.pageNo   ?? 1,
      pageSize: params?.pageSize ?? 50,
    };

    const response = await this.artemisPost<{ list: any[]; total: number }>(path, body);

    return {
      list: (response.list ?? []).map((c: any) => ({
        cameraIndexCode: c.cameraIndexCode ?? c.indexCode ?? '',
        cameraName:      c.cameraName ?? c.name ?? '',
        deviceSerial:    c.deviceSerial ?? '',
        channelNo:       Number(c.channelNo ?? 1),
        status:          c.status ?? 'unknown',
      })),
      total: response.total ?? 0,
    };
  }

  // ─── PRIVATE: MediaMTX HLS URL ────────────────────────────────────────────

  private getLiveUrlFromMediaMTX(streamPath: string): LiveUrlResult {
    if (!this.mediamtxHost) {
      throw new InternalServerErrorException(
        'MEDIAMTX_HLS_HOST sozlanmagan. VPS da MediaMTX o\'rnatilganmi?',
      );
    }

    const host = this.mediamtxHost.replace(/\/$/, '');
    return {
      url:        `${host}/${streamPath}/index.m3u8`,
      protocol:   'hls',
      expireTime: 0,   // MediaMTX da expiry yo'q — FFmpeg agent ishlayotganida doimiy
      source:     'mediamtx',
    };
  }

  // ─── PRIVATE: HikConnect Artemis API ─────────────────────────────────────

  private async getLiveUrlFromHikConnect(cameraIndexCode: string): Promise<LiveUrlResult> {
    const path = '/artemis/api/video/v1/cameras/previewURLs';
    const body = {
      cameraIndexCode,
      streamType: 0,
      protocol:   'hls',
      expireTime: 3600,
    };

    const response = await this.artemisPost<{ url: string; expireTime?: number }>(path, body);

    return {
      url:        response.url,
      protocol:   'hls',
      expireTime: response.expireTime ?? 3600,
      source:     'hikconnect',
    };
  }

  /**
   * HikConnect Artemis API — HMAC-SHA256 imzolangan POST so'rov
   */
  private async artemisPost<T>(path: string, body: object): Promise<T> {
    const timestamp   = Date.now().toString();
    const nonce       = crypto.randomUUID();
    const contentType = 'application/json';
    const accept      = 'application/json';
    const bodyStr     = JSON.stringify(body);
    const contentMd5  = crypto.createHash('md5').update(bodyStr).digest('base64');

    const signedHeaders = [
      `x-ca-key:${this.appKey}`,
      `x-ca-nonce:${nonce}`,
      `x-ca-timestamp:${timestamp}`,
    ].join('\n');

    const stringToSign = [
      'POST', accept, contentMd5, contentType, '',
      signedHeaders, path,
    ].join('\n');

    const signature = crypto
      .createHmac('sha256', this.appSecret)
      .update(stringToSign)
      .digest('base64');

    try {
      const res = await axios.post<{ code: string; msg: string; data: T }>(
        `${this.hikHost}${path}`,
        body,
        {
          headers: {
            'Content-Type':           contentType,
            'Accept':                 accept,
            'x-ca-key':               this.appKey,
            'x-ca-nonce':             nonce,
            'x-ca-timestamp':         timestamp,
            'x-ca-signature':         signature,
            'x-ca-signature-headers': 'x-ca-key,x-ca-nonce,x-ca-timestamp',
          },
          timeout: 10_000,
        },
      );

      if (res.data.code !== '0' && res.data.code !== '200') {
        throw new InternalServerErrorException(
          `HikConnect API xatosi: ${res.data.code} — ${res.data.msg}`,
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
