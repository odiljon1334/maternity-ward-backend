import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosResponse } from 'axios';
import sharp from 'sharp';
import * as crypto from 'crypto';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';
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
export class HikvisionService {
  private readonly logger = new Logger(HikvisionService.name);

  private readonly baseUrl: string;
  private readonly gatewayUser: string;
  private readonly gatewayPass: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
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

  async addFacePicture(
    devIndex: string,
    employeeNo: string,
    imageBuffer: Buffer,
    opts: { compressed?: boolean } = {},
  ) {
    if (!devIndex) throw new Error('Hikvision devIndex is required');
    if (!employeeNo) throw new Error('Hikvision employeeNo is required');
    if (!imageBuffer || imageBuffer.length === 0)
      throw new Error('Hikvision face image is empty');

    const compressed = opts.compressed
      ? imageBuffer
      : await this.compressFace(imageBuffer);

    this.logger.log(
      `Hikvision Face upload: employee=${employeeNo}, devIndex=${devIndex}, ` +
        `original=${imageBuffer.length}b → compressed=${compressed.length}b`,
    );

    const url = this.buildUrl('/ISAPI/Intelligent/FDLib/FaceDataRecord', {
      format: 'json',
      devIndex,
    });

    const createForm = () => {
      const form = new FormData();
      form.append(
        'FaceDataRecord',
        JSON.stringify({ FaceInfo: { employeeNo, faceLibType: 'blackFD' } }),
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
          'POST',
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

  private async requestGatewayDevices(): Promise<any[]> {
    this.logger.log('fetchGatewayDevices: request...');

    const url = this.buildUrl('/ISAPI/ContentMgmt/DeviceMgmt/deviceList', {
      format: 'json',
    });

    const response = await this.digestRequest('POST', url, {
      data: {
        SearchDescription: {
          position: 0,
          maxResult: 100,
          Filter: {
            key: '',
            devType: '',
            protocolType: ['ehomeV5'],
            devStatus: ['online', 'offline'],
          },
        },
      },
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const devices = response.data?.SearchResult?.MatchList ?? [];

    this.logger.log(`fetchGatewayDevices: ${devices.length} devices`);

    return devices;
  }

  private async fetchGatewayDevices(): Promise<any[]> {
    try {
      return await this.requestGatewayDevices();
    } catch (err: any) {
      this.logger.error(`fetchGatewayDevices error: ${err.message}`);

      return [];
    }
  }

  private buildStatusMap(gatewayDevices: any[]): Record<string, string> {
    const statusMap: Record<string, string> = {};

    for (const item of gatewayDevices) {
      const device = item?.Device;

      if (device?.devIndex) {
        statusMap[device.devIndex] = device.devStatus ?? 'offline';
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

    const gatewayDevices = await this.fetchGatewayDevices();

    const statusMap = this.buildStatusMap(gatewayDevices);

    return terminals.map((terminal) => ({
      ...terminal,
      onlineStatus: statusMap[terminal.devIndex] ?? 'offline',
    }));
  }

  async getAllTerminalsWithStatus() {
    const terminals = await this.prisma.hikTerminal.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });

    const gatewayDevices = await this.fetchGatewayDevices();

    const statusMap = this.buildStatusMap(gatewayDevices);

    return terminals.map((terminal) => ({
      ...terminal,
      onlineStatus: statusMap[terminal.devIndex] ?? 'offline',
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

    // Cheksiz tsiklga tushib qolmaslik uchun xavfsizlik chegarasi
    for (let page = 0; page < 500; page++) {
      const searchID = crypto.randomUUID();
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
      const list: any[] = search?.UserInfo ?? [];

      for (const u of list) {
        if (u?.employeeNo) {
          result.set(String(u.employeeNo), Number(u.numOfFace ?? 0) > 0);
        }
      }

      const status = search?.responseStatusStrg;
      const numOfMatches = Number(search?.numOfMatches ?? list.length);

      if (status !== 'MORE' || numOfMatches < pageSize) break;
      position += pageSize;
    }

    return result;
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

  private readonly syncJobs = new Map<string, HikSyncJob>();

  /** Sync'ni boshlaydi (yoki ishlayotganini qaytaradi) — darhol javob beradi */
  startSync(hospitalId: string): HikSyncJob {
    this.pruneSyncJobs();
    const running = this.syncJobs.get(hospitalId);
    if (running?.state === 'RUNNING') return this.snapshot(running);

    const job: HikSyncJob = {
      id: crypto.randomUUID(),
      hospitalId,
      state: 'RUNNING',
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
      message: null,
    };
    this.syncJobs.set(hospitalId, job);
    void this.runSync(job).catch((err: any) => {
      this.logger.error(
        `Sync ishdan chiqdi (hospital=${hospitalId}): ${err?.message ?? err}`,
      );
      job.state = 'FAILED';
      job.message =
        "Sinxronlash kutilmagan xato bilan to'xtadi. Qayta urinib ko'ring.";
      job.finishedAt = new Date().toISOString();
    });
    return this.snapshot(job);
  }

  /** Oxirgi (yoki ishlayotgan) sync holati; hech qachon ishga tushmagan bo'lsa — null */
  getSyncStatus(hospitalId: string): HikSyncJob | null {
    this.pruneSyncJobs();
    const job = this.syncJobs.get(hospitalId);
    return job ? this.snapshot(job) : null;
  }

  /** Sync'ni boshlab, tugashini kutadi (skriptlar va testlar uchun) */
  async syncHospital(hospitalId: string): Promise<HikSyncJob> {
    this.startSync(hospitalId);
    const job = this.syncJobs.get(hospitalId)!;
    while (job.state === 'RUNNING') {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.snapshot(job);
  }

  private snapshot(job: HikSyncJob): HikSyncJob {
    return {
      ...job,
      errors: [...job.errors],
      perTerminal: job.perTerminal.map((t) => ({ ...t })),
    };
  }

  private pruneSyncJobs() {
    const cutoff = Date.now() - SYNC_JOB_TTL_MS;
    for (const [id, j] of this.syncJobs) {
      if (
        j.state !== 'RUNNING' &&
        j.finishedAt &&
        Date.parse(j.finishedAt) < cutoff
      )
        this.syncJobs.delete(id);
    }
  }

  private pushSyncError(job: HikSyncJob, e: HikSyncError) {
    if (job.errors.length < SYNC_MAX_ERRORS) job.errors.push(e);
    else job.errorsTruncated++;
  }

  private async runSync(job: HikSyncJob): Promise<void> {
    const terminals = await this.prisma.hikTerminal.findMany({
      where: { hospitalId: job.hospitalId, isActive: true },
    });
    if (terminals.length === 0) {
      this.pushSyncError(job, {
        employeeNo: '-',
        name: '-',
        reason: 'Faol terminal topilmadi',
      });
      job.state = 'DONE';
      job.finishedAt = new Date().toISOString();
      return;
    }

    const all = await this.prisma.employee.findMany({
      where: {
        hospitalId: job.hospitalId,
        firedAt: null,
        employeeNo: { not: null },
      },
      select: { employeeNo: true, fullName: true, photoUrl: true },
    });
    const employees = all.filter((e) => !!e.employeeNo && !!e.photoUrl);
    job.withoutPhoto = all.length - employees.length;
    job.total = employees.length;
    job.units = employees.length * terminals.length;

    const uploadDir = this.config.get<string>('UPLOAD_DIR', './uploads');

    // Yuz rasmi har xodim uchun BIR marta o'qiladi va siqiladi
    const faces = new Map<string, Promise<Buffer | null>>();
    const faceOf = (e: {
      employeeNo: string | null;
      photoUrl: string | null;
    }) => {
      const key = e.employeeNo!;
      let p = faces.get(key);
      if (!p) {
        const file = path.join(
          uploadDir,
          e.photoUrl!.replace(/^\/uploads\//, ''),
        );
        p = fs.promises
          .readFile(file)
          .then((buf) => this.compressFace(buf))
          .catch(() => null);
        faces.set(key, p);
      }
      return p;
    };
    const missingReported = new Set<string>();

    const terminalLimit = envInt(
      this.config.get('HIK_SYNC_TERMINAL_CONCURRENCY'),
      3,
    );
    const deviceLimit = envInt(
      this.config.get('HIK_SYNC_DEVICE_CONCURRENCY'),
      1,
    );

    await runPool(terminals, terminalLimit, async (terminal) => {
      const stat = {
        terminalId: terminal.id,
        terminalName: terminal.name,
        created: 0,
        skipped: 0,
        failed: 0,
        aborted: false,
      };
      job.perTerminal.push(stat);

      const fail = (n = 1) => {
        stat.failed += n;
        job.failed += n;
        job.done += n;
      };

      // Terminaldagi mavjud userlar: employeeNo → hasFace
      let existing: Map<string, boolean>;
      try {
        existing = await this.withRetry(() =>
          this.getExistingPersons(terminal.devIndex),
        );
      } catch (err: any) {
        stat.aborted = true;
        fail(employees.length);
        this.pushSyncError(job, {
          employeeNo: '-',
          name: terminal.name,
          reason: `${terminal.name}: terminal javob bermadi (${err?.friendlyMessage ?? err?.message ?? 'xato'}) — ${employees.length} xodim yuborilmadi. Terminal internetga ulanganini tekshirib, qayta urinib ko'ring.`,
        });
        this.logger.error(
          `Sync: ${terminal.name} ro'yxatini olib bo'lmadi: ${err?.message}`,
        );
        return;
      }

      let consecutiveNetFails = 0;
      let remaining = employees.length;

      await runPool(employees, deviceLimit, async (employee) => {
        if (stat.aborted) return; // qolganlari pastda bir yo'la hisoblanadi
        remaining--;
        const employeeNo = employee.employeeNo!;
        const personExists = existing.has(employeeNo);
        const faceExists = existing.get(employeeNo) === true;
        if (personExists && faceExists) {
          stat.skipped++;
          job.skipped++;
          job.done++;
          return;
        }

        const face = faceExists ? null : await faceOf(employee);
        if (!faceExists && !face) {
          fail();
          if (!missingReported.has(employeeNo)) {
            missingReported.add(employeeNo);
            this.pushSyncError(job, {
              employeeNo,
              name: employee.fullName,
              reason:
                "Profil rasmi fayli topilmadi yoki o'qib bo'lmadi — rasmni qayta yuklang",
            });
          }
          return;
        }

        try {
          let changed = false;
          if (!personExists) {
            await this.withRetry(() =>
              this.addPerson(terminal.devIndex, {
                employeeNo,
                name: employee.fullName,
              }),
            ).catch((err) => {
              if (!this.isAlreadyExistsError(err?.message ?? '')) throw err;
            });
            changed = true;
          }
          if (!faceExists) {
            await this.withRetry(() =>
              this.addFacePicture(terminal.devIndex, employeeNo, face!, {
                compressed: true,
              }),
            ).catch((err) => {
              if (!this.isAlreadyExistsError(err?.message ?? '')) throw err;
            });
            changed = true;
          }
          consecutiveNetFails = 0;
          if (changed) {
            stat.created++;
            job.created++;
          } else {
            stat.skipped++;
            job.skipped++;
          }
          job.done++;
        } catch (err: any) {
          fail();
          const technical = err?.message ?? "Noma'lum xato";
          this.logger.error(
            `[Sync xatoligi | ${employeeNo} @ ${terminal.name}] ${technical}`,
          );
          if (this.isTransientError(err)) consecutiveNetFails++;
          else consecutiveNetFails = 0;

          if (consecutiveNetFails >= SYNC_ABORT_AFTER_NET_FAILS) {
            stat.aborted = true;
            fail(remaining);
            this.pushSyncError(job, {
              employeeNo: '-',
              name: terminal.name,
              reason: `${terminal.name}: terminal ketma-ket javob bermadi — qolgan ${remaining} xodim yuborilmadi. Aloqani tekshirib, qayta urinib ko'ring.`,
            });
            remaining = 0;
            return;
          }
          this.pushSyncError(job, {
            employeeNo,
            name: employee.fullName,
            reason: `${terminal.name}: ${err?.friendlyMessage ?? technical}`,
          });
        }
      });
    });

    job.state = 'DONE';
    job.finishedAt = new Date().toISOString();
    this.logger.log(
      `Sync tugadi (hospital=${job.hospitalId}): ${job.created} yangi, ${job.skipped} skip, ${job.failed} xato, ${job.units} birlik`,
    );
  }

  /** Vaqtinchalik xato: tarmoq uzilishi, timeout, 5xx, qurilma band */
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

const SYNC_JOB_TTL_MS = 6 * 3600_000;
const SYNC_MAX_ERRORS = 300;
const SYNC_ABORT_AFTER_NET_FAILS = 3;
export let SYNC_RETRY_BASE_MS = 1500;
/** Testlar uchun: qayta urinish kutishini qisqartirish */
export function setSyncRetryBaseMs(ms: number) {
  SYNC_RETRY_BASE_MS = ms;
}

function envInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 10) : fallback;
}

/** items'ni ko'pi bilan `limit` ta parallel ishlov bilan bajaradi */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next++];
        await worker(item);
      }
    },
  );
  await Promise.all(runners);
}
