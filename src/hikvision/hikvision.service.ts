import { ProfileFaceValidationService } from './profile-face-validation.service';
import {
  Injectable,
  Optional,
  BadRequestException,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosResponse } from 'axios';
import sharp from 'sharp';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'crypto';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';
import { HikPersonQueueService } from './hik-person-queue.service';
import { HikPersonDelivery } from '@prisma/client';
import { HikSyncQueueService } from './hik-sync-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  translateHikvisionError,
  parseHikvisionErrorBody,
} from '../common/utils/hikvision-error-messages.util';

/**
 * Hikvision Gateway'dan kelgan xatolik.
 *
 * - message           → texnik (inglizcha) xabar, loglar va
 *                        isAlreadyExistsError() kabi ichki tekshiruvlar uchun
 * - friendlyMessage    → o'zbekcha, foydalanuvchiga ko'rsatsa bo'ladigan xabar
 * - raw                → Hikvision'dan kelgan xom JSON javob (agar bo'lsa)
 */
export class HikvisionApiError extends Error {
  readonly friendlyMessage: string;
  readonly raw: unknown;
  readonly httpStatus?: number;

  constructor(technicalMessage: string, raw?: unknown, httpStatus?: number) {
    super(technicalMessage);
    this.name = 'HikvisionApiError';
    this.raw = raw;
    this.httpStatus = httpStatus;
    this.friendlyMessage = translateHikvisionError(
      parseHikvisionErrorBody(raw),
    );
  }
}

@Injectable()
export class HikvisionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HikvisionService.name);
  private readonly syncLeaseContext = new AsyncLocalStorage<() => void>();

  private readonly baseUrl: string;
  private readonly gatewayUser: string;
  private readonly gatewayPass: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly syncQueue: HikSyncQueueService,
    @Optional() private readonly personQueue?: HikPersonQueueService,
    private readonly profileFaceValidation: ProfileFaceValidationService = new ProfileFaceValidationService(),
  ) {
    this.baseUrl = (
      this.config.get<string>('HIK_GATEWAY_URL', 'http://95.111.252.83:8080') ||
      ''
    ).replace(/\/+$/, '');

    this.gatewayUser = this.config.get<string>('HIK_GATEWAY_USER', 'admin');

    this.gatewayPass = this.config.get<string>('HIK_GATEWAY_PASS', '');

    this.logger.log(`Hikvision Gateway: ${this.baseUrl}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // URL
  // ═══════════════════════════════════════════════════════════════════════════

  private buildUrl(pathName: string, query?: Record<string, string>): string {
    const url = new URL(
      pathName.startsWith('http') ? pathName : `${this.baseUrl}${pathName}`,
    );

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    return url.toString();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Digest helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private parseDigestChallenge(wwwAuthenticate: string) {
    const realm = wwwAuthenticate.match(/realm="([^"]+)"/i)?.[1] ?? '';

    const nonce = wwwAuthenticate.match(/nonce="([^"]+)"/i)?.[1] ?? '';

    const qopRaw = wwwAuthenticate.match(/qop="([^"]+)"/i)?.[1] ?? '';

    const algorithm =
      wwwAuthenticate.match(/algorithm=([^\s,]+)/i)?.[1] ?? 'MD5';

    const qop = qopRaw
      ? (qopRaw
          .split(',')
          .map((v) => v.trim())
          .find((v) => v.toLowerCase() === 'auth') ?? qopRaw.split(',')[0])
      : '';

    if (!realm || !nonce) {
      throw new Error(`Invalid Digest challenge: ${wwwAuthenticate}`);
    }

    return {
      realm,
      nonce,
      qop,
      algorithm,
    };
  }

  private createDigestAuthorization(
    method: string,
    requestUrl: string,
    wwwAuthenticate: string,
    nonceCount = 1,
  ): string {
    const { realm, nonce, qop, algorithm } =
      this.parseDigestChallenge(wwwAuthenticate);

    const parsedUrl = new URL(requestUrl);

    const uri = parsedUrl.pathname + (parsedUrl.search || '');

    const methodUpper = method.toUpperCase();

    const ha1 = crypto
      .createHash('md5')
      .update(`${this.gatewayUser}:${realm}:${this.gatewayPass}`)
      .digest('hex');

    const ha2 = crypto
      .createHash('md5')
      .update(`${methodUpper}:${uri}`)
      .digest('hex');

    let response: string;

    if (qop) {
      const nc = nonceCount.toString(16).padStart(8, '0');
      const cnonce = crypto.randomBytes(16).toString('hex');

      response = crypto
        .createHash('md5')
        .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        .digest('hex');

      return [
        `Digest username="${this.gatewayUser}"`,
        `realm="${realm}"`,
        `nonce="${nonce}"`,
        `uri="${uri}"`,
        `algorithm=${algorithm}`,
        `qop=${qop}`,
        `nc=${nc}`,
        `cnonce="${cnonce}"`,
        `response="${response}"`,
      ].join(', ');
    }

    response = crypto
      .createHash('md5')
      .update(`${ha1}:${nonce}:${ha2}`)
      .digest('hex');

    return [
      `Digest username="${this.gatewayUser}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${uri}"`,
      `algorithm=${algorithm}`,
      `response="${response}"`,
    ].join(', ');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Digest request (JSON va multipart uchun yagona)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Digest challenge keshlanadi va keyingi so'rovlar DARHOL Authorization
   * bilan yuboriladi (nc oshib boradi). Ilgari HAR BIR so'rov ikki marta
   * ketardi (avval 401 olish uchun, keyin haqiqiy) — yuz rasmi esa ikki
   * marta yuklanardi. Gateway nonce'ni eskirgan deb topsa (401) — yangi
   * challenge bilan bir marta qayta yuboriladi.
   */
  private digestState: { challenge: string; nc: number } | null = null;

  private digestAuthFor(method: string, requestUrl: string): string {
    const st = this.digestState!;
    st.nc += 1;
    return this.createDigestAuthorization(
      method,
      requestUrl,
      st.challenge,
      st.nc,
    );
  }

  private async sendDigest<T = any>(
    method: string,
    requestUrl: string,
    build: () => { data?: any; headers?: Record<string, string> },
    timeout: number,
  ): Promise<AxiosResponse<T>> {
    const methodUpper = method.toUpperCase();

    const send = async (authorization?: string) => {
      this.syncLeaseContext.getStore()?.();
      // FormData — oqim: har yuborishda yangisi yaratiladi (build())
      const { data, headers } = build();
      try {
        return await axios.request<T>({
          method: methodUpper,
          url: requestUrl,
          data,
          headers: {
            Accept: 'application/json',
            ...(headers ?? {}),
            ...(authorization ? { Authorization: authorization } : {}),
          },
          timeout,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });
      } catch (error: any) {
        throw this.normalizeAxiosError(error);
      }
    };

    let response = await send(
      this.digestState
        ? this.digestAuthFor(methodUpper, requestUrl)
        : undefined,
    );
    if (response.status !== 401) return this.ensureOk(response);

    const wwwAuthenticate = response.headers['www-authenticate'];
    if (!wwwAuthenticate) {
      throw new Error(
        `Gateway returned 401 but WWW-Authenticate header is missing`,
      );
    }
    this.digestState = {
      challenge: Array.isArray(wwwAuthenticate)
        ? wwwAuthenticate.join(', ')
        : String(wwwAuthenticate),
      nc: 0,
    };

    response = await send(this.digestAuthFor(methodUpper, requestUrl));
    if (response.status === 401) this.digestState = null; // login/parol noto'g'ri
    return this.ensureOk(response);
  }

  private ensureOk<T>(response: AxiosResponse<T>): AxiosResponse<T> {
    if (response.status >= 400) throw this.createHttpError(response);
    return response;
  }

  private digestRequest<T = any>(
    method: string,
    requestUrl: string,
    options: {
      data?: any;
      headers?: Record<string, string>;
    } = {},
  ): Promise<AxiosResponse<T>> {
    return this.sendDigest<T>(
      method,
      requestUrl,
      () => ({ data: options.data, headers: options.headers }),
      15_000,
    );
  }

  private digestMultipartRequest<T = any>(
    method: string,
    requestUrl: string,
    createForm: () => FormData,
  ): Promise<AxiosResponse<T>> {
    return this.sendDigest<T>(
      method,
      requestUrl,
      () => {
        const form = createForm();
        return { data: form, headers: form.getHeaders() };
      },
      30_000,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Error helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * HTTP 400+ javobini xato obyektiga aylantiradi.
   *
   * - Texnik xabar (err.message) o'zgarishsiz qoladi — loglarda va
   *   isAlreadyExistsError() kabi ichki tekshiruvlarda ishlatiladi.
   * - err.friendlyMessage — Hikvision javobidagi statusCode/subStatusCode
   *   asosida tarjima qilingan, foydalanuvchiga ko'rsatsa bo'ladigan matn.
   */
  private createHttpError(response: AxiosResponse): HikvisionApiError {
    const data =
      typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data);

    const technicalMessage = `Hikvision Gateway HTTP ${response.status}: ${data}`;

    return new HikvisionApiError(
      technicalMessage,
      response.data,
      response.status,
    );
  }

  private normalizeAxiosError(error: any): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(error?.message ?? 'Unknown Hikvision request error');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Person
  // ═══════════════════════════════════════════════════════════════════════════

  async addPerson(
    devIndex: string,
    data: {
      employeeNo: string;
      name: string;
      beginTime?: string;
      endTime?: string;
    },
  ) {
    if (!devIndex) {
      throw new Error('Hikvision devIndex is required');
    }

    if (!data.employeeNo) {
      throw new Error('Hikvision employeeNo is required');
    }

    const url = this.buildUrl('/ISAPI/AccessControl/UserInfo/Record', {
      format: 'json',
      devIndex,
    });

    const payload = {
      UserInfo: [
        {
          employeeNo: data.employeeNo,
          name: data.name,
          Valid: {
            beginTime: data.beginTime ?? '2020-01-01T00:00:00',

            endTime: data.endTime ?? '2030-12-31T23:59:59',
          },
        },
      ],
    };

    this.logger.log(
      `Hikvision AddPerson: employee=${data.employeeNo}, devIndex=${devIndex}`,
    );

    const response = await this.digestRequest('POST', url, {
      data: payload,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const result = response.data?.UserInfoOutList?.UserInfoOut?.[0];

    /*
     * Hikvision success:
     *
     * statusCode = 1
     */

    if (result && result.statusCode !== 1) {
      const technicalMessage = `Hikvision addPerson failed: ${
        result.errorMsg ?? JSON.stringify(result)
      }`;
      throw new HikvisionApiError(technicalMessage, result);
    }

    this.logger.log(`Hikvision Person added successfully: ${data.employeeNo}`);

    return result ?? response.data;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Delete Person
  // ═══════════════════════════════════════════════════════════════════════════

  async deletePerson(devIndex: string, employeeNo: string) {
    const url = this.buildUrl('/ISAPI/AccessControl/UserInfo/Delete', {
      format: 'json',
      devIndex,
    });

    const payload = {
      UserInfoDelCond: {
        EmployeeNoList: [
          {
            employeeNo,
          },
        ],
      },
    };

    const response = await this.digestRequest('PUT', url, {
      data: payload,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.logger.log(`Hikvision Person deleted: ${employeeNo}`);

    return response.data;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Add Face Picture
  // ═══════════════════════════════════════════════════════════════════════════

  /** Terminal uchun yuz rasmi: ≤600px JPEG (bir marta tayyorlab, bir necha terminalga) */
  compressFace(imageBuffer: Buffer): Promise<Buffer> {
    return sharp(imageBuffer)
      .rotate()
      .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: false })
      .toBuffer();
  }

  async validateProfilePhoto(buffer: Buffer) {
    await this.profileFaceValidation.assertFace(buffer);
  }

  async addFacePicture(
    devIndex: string,
    employeeNo: string,
    imageBuffer: Buffer,
    opts: { compressed?: boolean; replace?: boolean } = {},
  ) {
    if (!devIndex) throw new Error('Hikvision devIndex is required');
    if (!employeeNo) throw new Error('Hikvision employeeNo is required');
    if (!imageBuffer || imageBuffer.length === 0)
      throw new Error('Hikvision face image is empty');

    const compressed = opts.compressed
      ? imageBuffer
      : await this.compressFace(imageBuffer);

    await this.validateProfilePhoto(compressed);

    this.logger.log(
      `Hikvision Face upload: employee=${employeeNo}, devIndex=${devIndex}, ` +
        `original=${imageBuffer.length}b → compressed=${compressed.length}b`,
    );

    const url = this.buildUrl(
      opts.replace
        ? '/ISAPI/Intelligent/FDLib/FDSetUp'
        : '/ISAPI/Intelligent/FDLib/FaceDataRecord',
      {
        format: 'json',
        devIndex,
      },
    );

    const createForm = () => {
      const form = new FormData();
      form.append(
        'FaceDataRecord',
        JSON.stringify(
          opts.replace
            ? { faceLibType: 'blackFD', FDID: '1', FPID: employeeNo }
            : { FaceInfo: { employeeNo, faceLibType: 'blackFD' } },
        ),
        { contentType: 'application/json' },
      );
      form.append('FaceImage', compressed, {
        filename: `${employeeNo}.jpg`,
        contentType: 'image/jpeg',
        knownLength: compressed.length,
      });
      return form;
    };

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;
    let lastError: any;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.digestMultipartRequest(
          opts.replace ? 'PUT' : 'POST',
          url,
          createForm,
        );
        this.logger.log(
          `Hikvision Face uploaded successfully: employee=${employeeNo}` +
            (attempt > 1 ? ` (attempt ${attempt})` : ''),
        );
        return response.data;
      } catch (err: any) {
        lastError = err;
        const isRetryable = /urlDownloadFail/i.test(err?.message ?? '');
        if (!isRetryable || attempt === MAX_RETRIES) throw err;
        this.logger.warn(
          `Face upload retry ${attempt}/${MAX_RETRIES}: employee=${employeeNo} — ${err.message}`,
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    throw lastError;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Delete Face
  // ═══════════════════════════════════════════════════════════════════════════

  async deleteFacePicture(devIndex: string, employeeNo: string) {
    const url = this.buildUrl(
      '/ISAPI/Intelligent/FDLib/FaceDataRecord/Delete',
      {
        format: 'json',
        devIndex,
      },
    );

    const payload = {
      FaceInfoDelCond: {
        EmployeeNoList: [
          {
            employeeNo,
          },
        ],
      },
    };

    const response = await this.digestRequest('PUT', url, {
      data: payload,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.logger.log(`Hikvision Face deleted: employee=${employeeNo}`);

    return response.data;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Gateway device list
  // ═══════════════════════════════════════════════════════════════════════════

  private gatewayDevicesInFlight: Promise<any[]> | null = null;

  private requestGatewayDevices(): Promise<any[]> {
    // Monitoring va bir nechta ochiq sahifa bir xil Gateway so‘rovini bo‘lishadi.
    if (this.gatewayDevicesInFlight) return this.gatewayDevicesInFlight;
    const request = this.loadGatewayDevices();
    this.gatewayDevicesInFlight = request;
    const clear = () => {
      if (this.gatewayDevicesInFlight === request)
        this.gatewayDevicesInFlight = null;
    };
    void request.then(clear, clear);
    return request;
  }

  private async loadGatewayDevices(): Promise<any[]> {
    const url = this.buildUrl('/ISAPI/ContentMgmt/DeviceMgmt/deviceList', {
      format: 'json',
    });
    const devices: any[] = [];
    const seen = new Set<string>();
    const pageSize = 100;
    for (let page = 0; page < 50; page++) {
      const response = await this.withRetry(
        () =>
          this.digestRequest('POST', url, {
            data: {
              SearchDescription: {
                position: page * pageSize,
                maxResult: pageSize,
                Filter: {
                  key: '',
                  devType: '',
                  protocolType: ['ehomeV5'],
                  devStatus: ['online', 'offline'],
                },
              },
            },
            headers: { 'Content-Type': 'application/json' },
          }),
        2,
      );
      const result = response.data?.SearchResult;
      if (!result || !Array.isArray(result.MatchList)) {
        throw new Error(
          'Gateway deviceList javobi noto‘g‘ri: SearchResult.MatchList yo‘q',
        );
      }
      let added = 0;
      for (const item of result.MatchList) {
        const id = item?.Device?.devIndex;
        if (!id) throw new Error('Gateway deviceList: devIndex yo‘q');
        if (!seen.has(id)) {
          seen.add(id);
          devices.push(item);
          added++;
        }
      }
      const total =
        result.totalMatches == null ? NaN : Number(result.totalMatches);
      if (Number.isFinite(total) && devices.length >= total) return devices;
      if (result.MatchList.length < pageSize) {
        if (Number.isFinite(total) && devices.length < total)
          throw new Error('Gateway deviceList to‘liq olinmadi');
        return devices;
      }
      if (added === 0)
        throw new Error('Gateway pagination bir xil sahifani qaytardi');
    }
    throw new Error('Gateway deviceList sahifalash chegarasidan oshdi');
  }

  private async fetchGatewayStatus() {
    try {
      const devices = await this.requestGatewayDevices();
      return {
        statusMap: this.buildStatusMap(devices),
        gatewayReachable: true,
        statusCheckedAt: new Date().toISOString(),
      };
    } catch {
      this.logger.warn(
        'Gateway holatini olib bo‘lmadi; terminallar holati noma’lum',
      );
      return {
        statusMap: {} as Record<string, string>,
        gatewayReachable: false,
        statusCheckedAt: null,
      };
    }
  }

  private buildStatusMap(gatewayDevices: any[]): Record<string, string> {
    const statusMap: Record<string, string> = {};

    for (const item of gatewayDevices) {
      const device = item?.Device;

      if (device?.devIndex) {
        const status = String(device.devStatus ?? '').toLowerCase();
        statusMap[device.devIndex] =
          status === 'online' || status === 'offline' ? status : 'unknown';
      }
    }

    return statusMap;
  }

  /**
   * Cron monitoring uchun qat'iy snapshot. Gateway ishlamasa xato tashlaydi:
   * bu holatda terminallarni yolg'ondan offline deb belgilash mumkin emas.
   */
  async getTerminalStatusSnapshot(): Promise<Record<string, string>> {
    const devices = await this.requestGatewayDevices();
    return this.buildStatusMap(devices);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Gateway devices
  // ═══════════════════════════════════════════════════════════════════════════

  async getDevices() {
    const url = this.buildUrl('/ISAPI/ResourceManagement/devList', {
      format: 'json',
    });

    const response = await this.digestRequest('GET', url);

    return response.data;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HikTerminal CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  async getTerminals(hospitalId: string) {
    return this.prisma.hikTerminal.findMany({
      where: {
        hospitalId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async addTerminal(
    hospitalId: string,
    data: {
      name: string;
      devIndex: string;
      password: string;
    },
  ) {
    return this.prisma.hikTerminal.create({
      data: {
        name: data.name,
        devIndex: data.devIndex,
        password: data.password ?? null,
        hospitalId,
      },
    });
  }

  async removeTerminal(id: string, hospitalId: string) {
    return this.prisma.hikTerminal.delete({
      where: {
        id,
        hospitalId,
      },
    });
  }

  async toggleTerminal(id: string, hospitalId: string, isActive: boolean) {
    return this.prisma.hikTerminal.update({
      where: {
        id,
        hospitalId,
      },
      data: {
        isActive,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Terminal status
  // ═══════════════════════════════════════════════════════════════════════════

  async getTerminalsWithStatus(hospitalId: string) {
    const terminals = await this.prisma.hikTerminal.findMany({
      where: {
        hospitalId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const { statusMap, gatewayReachable, statusCheckedAt } =
      await this.fetchGatewayStatus();

    return terminals.map((terminal) => ({
      ...terminal,
      onlineStatus: statusMap[terminal.devIndex] ?? 'unknown',
      gatewayReachable,
      statusCheckedAt,
    }));
  }

  async getAllTerminalsWithStatus() {
    const terminals = await this.prisma.hikTerminal.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });

    const { statusMap, gatewayReachable, statusCheckedAt } =
      await this.fetchGatewayStatus();

    return terminals.map((terminal) => ({
      ...terminal,
      onlineStatus: statusMap[terminal.devIndex] ?? 'unknown',
      gatewayReachable,
      statusCheckedAt,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Yordamchilar: "allaqachon mavjud", reboot, mavjud userlar ro'yxati
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Hikvision "allaqachon mavjud" xatolarini aniqlaydi (masalan
   * deviceUserAlreadyExistFace, employeeNoAlreadyExist va h.k.).
   * Turli firmware/model'larda aniq nom farq qilishi mumkin — shuning uchun
   * "AlreadyExist" so'z birikmasiga (katta-kichik harfga qaramay) qarab tekshiriladi.
   *
   * DIQQAT: bu funksiya har doim TEXNIK xabar (err.message) bilan
   * chaqirilishi kerak, err.friendlyMessage bilan emas — chunki tarjima
   * qilingan o'zbekcha matnda "AlreadyExist" so'zi bo'lmaydi.
   */
  private isAlreadyExistsError(message: string): boolean {
    return /alreadyexist/i.test(message);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Reboot — faqat qo'lda, admin so'rovi bilan chaqiriladi
  // ═══════════════════════════════════════════════════════════════════════════

  async rebootTerminal(devIndex: string) {
    const url = this.buildUrl('/ISAPI/System/reboot', { devIndex });
    const response = await this.digestRequest('PUT', url, {});
    this.logger.warn(
      `Hikvision terminal reboot buyurildi: devIndex=${devIndex}`,
    );
    return response.data;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Search: terminaldagi mavjud UserInfo (person) ro'yxati
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Terminaldagi mavjud userlarni qaytaradi: employeeNo → hasFace.
   * UserInfo/Search javobidagi "numOfFace" maydoni orqali (haqiqiy terminal
   * javobida tasdiqlangan) — FDSearch'ga ehtiyoj yo'q, bitta so'rov yetarli.
   */
  private async getExistingPersons(
    devIndex: string,
  ): Promise<Map<string, boolean>> {
    const url = this.buildUrl('/ISAPI/AccessControl/UserInfo/Search', {
      format: 'json',
      devIndex,
    });

    const result = new Map<string, boolean>();
    let position = 0;
    const pageSize = 30;
    const searchID = crypto.randomUUID();

    // Cheksiz tsiklga tushib qolmaslik uchun xavfsizlik chegarasi
    for (let page = 0; page < 500; page++) {
      const response = await this.digestRequest('POST', url, {
        data: {
          UserInfoSearchCond: {
            searchID,
            searchResultPosition: position,
            maxResults: pageSize,
          },
        },
        headers: { 'Content-Type': 'application/json' },
      });

      const search = response.data?.UserInfoSearch;
      if (
        !search ||
        (search.UserInfo !== undefined && !Array.isArray(search.UserInfo))
      ) {
        throw new Error('Terminal UserInfoSearch javobi noto‘g‘ri');
      }
      const list: any[] = search.UserInfo ?? [];
      const beforeCount = result.size;

      for (const u of list) {
        if (u?.employeeNo) {
          result.set(String(u.employeeNo), Number(u.numOfFace ?? 0) > 0);
        }
      }

      const status = search?.responseStatusStrg;
      const numOfMatches = Number(search?.numOfMatches ?? list.length);

      if (status !== 'MORE') return result;
      if (numOfMatches <= 0 || result.size === beforeCount) {
        throw new Error(
          'Terminal foydalanuvchi sahifasi takrorlandi yoki to‘liq olinmadi',
        );
      }
      position += list.length;
    }

    throw new Error(
      'Terminal foydalanuvchi qidiruvi sahifalash chegarasidan oshdi',
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Bulk Sync — fon vazifasi (progress bilan), mavjudlarini skip qiladi
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Ilgari sync bitta HTTP so'rov ichida ketma-ket bajarilardi: 100+ xodim ×
  // bir nechta terminalda so'rov daqiqalab osilib turar, proxy/brauzer
  // uzilsa "xatolik" chiqib natija yo'qolardi, terminal o'chiq bo'lsa har
  // xodim uchun 15 soniya timeout kutilardi. Endi:
  //  - POST darhol javob qaytaradi, ish fonda davom etadi; GET — holat/progress.
  //  - Bir muassasada bir vaqtda faqat bitta sync (qayta bosish — o'sha ish).
  //  - Terminallar parallel (HIK_SYNC_TERMINAL_CONCURRENCY, standart 3),
  //    bitta terminalga bir vaqtda HIK_SYNC_DEVICE_CONCURRENCY (standart 1).
  //  - Vaqtinchalik xatolar (timeout, uzilish, 5xx, band) 2 marta qayta sinaladi.
  //  - Terminal ketma-ket 3 marta javob bermasa — qolgan xodimlar kutilmaydi,
  //    bitta aniq xato bilan to'xtatiladi.
  //  - Yuz rasmi har xodim uchun bir marta siqiladi (har terminal uchun emas).

  onModuleInit() {
    this.personQueue?.start((task, fence) => this.deliverPerson(task, fence));
    this.syncQueue.start((job, assertLease) =>
      this.syncLeaseContext.run(assertLease, () =>
        this.queueHospitalPeople(job, assertLease),
      ),
    );
  }

  async onModuleDestroy() {
    await this.syncQueue.stop();
  }

  /** Enqueue is committed before the API acknowledges acceptance. */
  async startSync(hospitalId: string): Promise<HikSyncJob> {
    return this.syncQueue.enqueue({
      id: crypto.randomUUID(),
      hospitalId,
      state: 'RUNNING',
      queuePhase: 'WAITING',
      attempt: 0,
      total: 0,
      withoutPhoto: 0,
      units: 0,
      done: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      errorsTruncated: 0,
      perTerminal: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: 'Vazifa doimiy navbatga qo‘shildi',
    });
  }

  getSyncStatus(hospitalId: string): Promise<HikSyncJob | null> {
    return this.syncQueue.latest(hospitalId);
  }

  /** Internal scripts can await completion; HTTP endpoints never block for a run. */
  async syncHospital(hospitalId: string): Promise<HikSyncJob> {
    const accepted = await this.startSync(hospitalId);
    while (true) {
      const job = await this.getSyncStatus(hospitalId);
      if (!job || job.id !== accepted.id) throw new Error('Sync task changed');
      if (job.state !== 'RUNNING') return job;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async queueDevicePerson(
    devIndex: string,
    employeeNo: string,
    remove = false,
  ) {
    const terminal = await this.prisma.hikTerminal.findUnique({
      where: { devIndex },
    });
    if (!terminal)
      throw new BadRequestException('Terminal muassasaga biriktirilmagan');
    const employee = await this.prisma.employee.findUnique({
      where: { employeeNo },
      include: { user: { select: { status: true } } },
    });
    if (!employee || employee.hospitalId !== terminal.hospitalId)
      throw new BadRequestException(
        'Xodim bu terminal muassasasiga tegishli emas',
      );
    const action = remove
      ? 'DELETE'
      : employee.firedAt ||
          ['INACTIVE', 'FIRED'].includes(employee.status) ||
          (employee.user && employee.user.status !== 'ACTIVE')
        ? 'BLOCK'
        : 'UPSERT';
    if (action === 'UPSERT' && !employee.photoUrl?.trim())
      return { queued: false, reason: 'NO_PHOTO' };
    await this.prisma
      .$executeRaw`SELECT staffplus_queue_person(${employee.id},${employeeNo},${terminal.hospitalId},${employee.fullName},${employee.photoUrl},${action},${terminal.id})`;
    return { queued: true };
  }

  async personDeliveryStatus(
    hospitalId: string,
    employeeId?: string,
    page = 1,
    summary = false,
  ) {
    return this.personQueue!.status(hospitalId, employeeId, page, summary);
  }
  async personDeliveryPeople(
    hospitalId: string,
    employeeId?: string,
    filter = 'ALL',
    page = 1,
    summary = false,
  ) {
    return this.personQueue!.people(
      hospitalId,
      employeeId,
      filter,
      page,
      summary,
    );
  }
  async retryPersonDelivery(id: string, hospitalId: string) {
    return this.personQueue!.retry(id, hospitalId);
  }

  private checkDeviceAck(body: any) {
    const codes = [
      body?.statusCode,
      body?.ResponseStatus?.statusCode,
      ...(body?.UserInfoOutList?.UserInfoOut ?? []).map(
        (x: any) => x.statusCode,
      ),
    ].filter((x) => x !== undefined);
    if (codes.some((c) => Number(c) !== 1))
      throw Error(
        `ERROR:Terminal amalni rad etdi. ${translateHikvisionError(parseHikvisionErrorBody(body?.ResponseStatus ?? body))}`,
      );
  }
  private async readTerminalPerson(devIndex: string, employeeNo: string) {
    const response = await this.digestRequest(
      'POST',
      this.buildUrl('/ISAPI/AccessControl/UserInfo/Search', {
        format: 'json',
        devIndex,
      }),
      {
        data: {
          UserInfoSearchCond: {
            searchID: crypto.randomUUID(),
            searchResultPosition: 0,
            maxResults: 30,
            EmployeeNoList: [{ employeeNo }],
          },
        },
      },
    );
    const search = response.data?.UserInfoSearch;
    if (
      !search ||
      !Array.isArray(search.UserInfo ?? []) ||
      !['OK', 'MORE', 'NO MATCH'].includes(search.responseStatusStrg)
    )
      throw Error('WAIT:Terminal ro‘yxati ishonchli tasdiqlanmadi');
    if (search.responseStatusStrg === 'MORE')
      throw Error('WAIT:Terminal xodim filtri tasdiqlanmadi');
    return (
      (search.UserInfo ?? []).find(
        (x: any) => String(x.employeeNo) === employeeNo,
      ) ?? null
    );
  }

  private async deliverPerson(
    task: HikPersonDelivery,
    fence: () => Promise<void>,
  ) {
    if (task.action === 'UPSERT' && !task.photoUrl?.trim())
      throw Error('SKIP:NO_PHOTO');
    const terminal = await this.prisma.hikTerminal.findFirst({
      where: {
        id: task.terminalId,
        hospitalId: task.hospitalId,
        isActive: true,
      },
    });
    if (!terminal)
      throw Error('WAIT:Terminal faol emas yoki muassasadan uzilgan');
    const status = await this.getTerminalStatusSnapshot();
    if (status[terminal.devIndex] !== 'online')
      throw Error(
        status[terminal.devIndex] === 'offline'
          ? 'WAIT:Terminal offline; qayta ulanganda yuboriladi'
          : 'WAIT:Terminal ulanishi tasdiqlanmadi; qayta tekshiriladi',
      );
    await fence();
    const existing = await this.readTerminalPerson(
      terminal.devIndex,
      task.employeeNo,
    );
    if (task.action !== 'UPSERT') {
      if (existing) {
        await fence();
        this.checkDeviceAck(
          await this.deletePerson(terminal.devIndex, task.employeeNo),
        );
      }
      await fence();
      if (await this.readTerminalPerson(terminal.devIndex, task.employeeNo))
        throw Error('WAIT:Terminaldan olib tashlash hali tasdiqlanmadi');
      return;
    }
    if (
      task.deliveredPhotoUrl === task.photoUrl &&
      existing?.name === task.fullName &&
      existing?.userType === 'normal' &&
      existing?.Valid?.enable === true &&
      existing?.Valid?.beginTime === '2020-01-01T00:00:00' &&
      existing?.Valid?.endTime === '2037-12-31T23:59:59' &&
      Number(existing?.numOfFace ?? 0) > 0
    ) {
      await fence();
      return;
    }
    let face: Buffer | null = null;
    if (task.photoUrl) {
      // Validate/compress before touching the terminal; rejected files preserve its existing face.
      const base = path.resolve(
        this.config.get<string>('UPLOAD_DIR', './uploads'),
      );
      const file = path.resolve(
        base,
        task.photoUrl.replace(/^\/uploads\//, ''),
      );
      if (!file.startsWith(base + path.sep))
        throw Error('ERROR:Profil rasmi manzili noto‘g‘ri');
      try {
        face = await this.compressFace(await fs.promises.readFile(file));
      } catch {
        throw Error('ERROR:Profil rasmi topilmadi yoki o‘qib bo‘lmadi');
      }
    }
    try {
      await this.validateProfilePhoto(face!);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Yuz tekshiruvi bajarilmadi';
      throw Error(
        `${(error as any)?.getStatus?.() === 400 ? 'ERROR' : 'WAIT'}:${message}`,
      );
    }
    await fence();
    const response = await this.digestRequest(
      'PUT',
      this.buildUrl('/ISAPI/AccessControl/UserInfo/SetUp', {
        format: 'json',
        devIndex: terminal.devIndex,
      }),
      {
        data: {
          UserInfo: {
            employeeNo: task.employeeNo,
            name: task.fullName,
            userType: 'normal',
            Valid: {
              enable: true,
              beginTime: '2020-01-01T00:00:00',
              endTime: '2037-12-31T23:59:59',
              timeType: 'local',
            },
          },
        },
      },
    );
    this.checkDeviceAck(response.data);
    if (
      face &&
      (task.photoUrl !== task.deliveredPhotoUrl ||
        Number(existing?.numOfFace ?? 0) === 0)
    ) {
      await fence();
      try {
        this.checkDeviceAck(
          await this.addFacePicture(terminal.devIndex, task.employeeNo, face, {
            compressed: true,
            replace: true,
          }),
        );
      } catch (error: any) {
        if (error?.httpStatus === 400 || error?.httpStatus === 403)
          throw Error(
            `ERROR:${error.friendlyMessage ?? 'Yuz rasmi terminal tomonidan rad etildi; suratni yoki qurilma imkoniyatini tekshiring'}`,
          );
        throw error;
      }
    }
    await fence();
    const confirmed = await this.readTerminalPerson(
      terminal.devIndex,
      task.employeeNo,
    );
    if (!confirmed || confirmed.name !== task.fullName)
      throw Error('WAIT:Xodim ma’lumoti terminalda hali tasdiqlanmadi');
    if (!face)
      throw Error('ERROR:Xodim yozuvi yuborildi; yuz rasmi yuklanishi kerak');
    if (Number(confirmed.numOfFace ?? 0) < 1)
      throw Error('WAIT:Yuz rasmi terminalda hali tasdiqlanmadi');
  }

  private async queueHospitalPeople(job: HikSyncJob, assertLease: () => void) {
    const employees = await this.prisma.employee.findMany({
      where: { hospitalId: job.hospitalId },
      select: { id: true, photoUrl: true },
    });
    job.total = employees.length;
    job.withoutPhoto = employees.filter((e) => !e.photoUrl).length;
    for (const employee of employees) {
      assertLease();
      // SQL reads current employee/account state in the same statement; bulk sync cannot resurrect a fired person.
      await this.prisma.$executeRaw`
        SELECT staffplus_queue_person(e.id,e."employeeNo",e."hospitalId",e."fullName",e."photoUrl",
          CASE WHEN e."firedAt" IS NOT NULL OR e.status::text IN ('INACTIVE','FIRED')
           OR EXISTS (SELECT 1 FROM "User" u WHERE u.id=e."userId" AND u.status::text<>'ACTIVE') THEN 'BLOCK' ELSE 'UPSERT' END)
        FROM "Employee" e WHERE e.id=${employee.id} AND e."hospitalId"=${job.hospitalId}`;
      job.done++;
    }
    job.units = employees.length;
    job.message =
      'Vazifalar doimiy navbatga saqlandi. Terminalga yetkazilmoqda.';
    job.state = 'DONE';
    job.finishedAt = new Date().toISOString();
  }

  private isTransientError(err: any): boolean {
    if (!err) return false;
    if (
      [
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNABORTED',
        'EPIPE',
        'ECONNREFUSED',
        'EAI_AGAIN',
        'ENOTFOUND',
      ].includes(err.code)
    )
      return true;
    if (typeof err.httpStatus === 'number' && err.httpStatus >= 500)
      return true;
    return /timeout|socket hang up|busy/i.test(String(err.message ?? ''));
  }

  private async withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: any;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i === attempts || !this.isTransientError(err)) throw err;
        await new Promise((r) => setTimeout(r, SYNC_RETRY_BASE_MS * i));
      }
    }
    throw lastErr;
  }
}

// ─── Sync yordamchilari ─────────────────────────────────────────────────────

export interface HikSyncError {
  employeeNo: string;
  name: string;
  reason: string;
}

export interface HikSyncJob {
  id: string;
  hospitalId: string;
  state: 'RUNNING' | 'DONE' | 'FAILED';
  queuePhase?: 'WAITING' | 'ACTIVE' | 'DONE' | 'FAILED';
  attempt?: number;
  retryable?: boolean;
  /** Rasmli faol xodimlar soni */
  total: number;
  /** Rasmi yo'q (yuborilmaydigan) xodimlar */
  withoutPhoto: number;
  /** Jami ish birligi: xodim × terminal; done — bajarilgani (progress) */
  units: number;
  done: number;
  created: number;
  skipped: number;
  failed: number;
  errors: HikSyncError[];
  errorsTruncated: number;
  perTerminal: {
    terminalId: string;
    terminalName: string;
    created: number;
    skipped: number;
    failed: number;
    aborted: boolean;
  }[];
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
}

export let SYNC_RETRY_BASE_MS = 1500;
/** Testlar uchun: qayta urinish kutishini qisqartirish */
export function setSyncRetryBaseMs(ms: number) {
  SYNC_RETRY_BASE_MS = ms;
}
