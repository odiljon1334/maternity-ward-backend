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
      const nc = '00000001';
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
  // Generic Digest request
  // ═══════════════════════════════════════════════════════════════════════════

  private async digestRequest<T = any>(
    method: string,
    requestUrl: string,
    options: {
      data?: any;
      headers?: Record<string, string>;
    } = {},
  ): Promise<AxiosResponse<T>> {
    const methodUpper = method.toUpperCase();

    const baseHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...(options.headers ?? {}),
    };

    /*
     * IMPORTANT:
     *
     * First request is intentionally sent without Authorization.
     * Gateway returns:
     *
     * HTTP 401
     * WWW-Authenticate: Digest ...
     *
     * Then we calculate Digest and repeat the request.
     */

    let firstResponse: AxiosResponse<T>;

    try {
      firstResponse = await axios.request<T>({
        method: methodUpper,
        url: requestUrl,
        data: options.data,
        headers: baseHeaders,
        timeout: 15_000,
        validateStatus: () => true,
      });
    } catch (error: any) {
      throw this.normalizeAxiosError(error);
    }

    if (firstResponse.status !== 401) {
      if (firstResponse.status >= 400) {
        throw this.createHttpError(firstResponse);
      }

      return firstResponse;
    }

    const wwwAuthenticate = firstResponse.headers['www-authenticate'];

    if (!wwwAuthenticate) {
      throw new Error(
        `Gateway returned 401 but WWW-Authenticate header is missing`,
      );
    }

    const authorization = this.createDigestAuthorization(
      methodUpper,
      requestUrl,
      wwwAuthenticate,
    );

    const retryHeaders: Record<string, string> = {
      ...baseHeaders,
      Authorization: authorization,
    };

    let retryResponse: AxiosResponse<T>;

    try {
      retryResponse = await axios.request<T>({
        method: methodUpper,
        url: requestUrl,
        data: options.data,
        headers: retryHeaders,
        timeout: 15_000,
        validateStatus: () => true,
      });
    } catch (error: any) {
      throw this.normalizeAxiosError(error);
    }

    if (retryResponse.status >= 400) {
      throw this.createHttpError(retryResponse);
    }

    return retryResponse;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Multipart Digest request
  // ═══════════════════════════════════════════════════════════════════════════

  private async digestMultipartRequest<T = any>(
    method: string,
    requestUrl: string,
    createForm: () => FormData,
  ): Promise<AxiosResponse<T>> {
    const methodUpper = method.toUpperCase();

    /*
     * IMPORTANT:
     *
     * FormData is a stream.
     *
     * We CANNOT create one FormData and reuse it after 401.
     *
     * Therefore createForm() is called twice:
     *
     * 1. First unauthenticated request
     * 2. Digest authenticated request
     */

    const firstForm = createForm();

    const firstHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...firstForm.getHeaders(),
    };

    let firstResponse: AxiosResponse<T>;

    try {
      firstResponse = await axios.request<T>({
        method: methodUpper,
        url: requestUrl,
        data: firstForm,
        headers: firstHeaders,
        timeout: 30_000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      });
    } catch (error: any) {
      throw this.normalizeAxiosError(error);
    }

    if (firstResponse.status !== 401) {
      if (firstResponse.status >= 400) {
        throw this.createHttpError(firstResponse);
      }

      return firstResponse;
    }

    const wwwAuthenticate = firstResponse.headers['www-authenticate'];

    if (!wwwAuthenticate) {
      throw new Error(
        `Gateway returned 401 but WWW-Authenticate header is missing`,
      );
    }

    const authorization = this.createDigestAuthorization(
      methodUpper,
      requestUrl,
      wwwAuthenticate,
    );

    /*
     * NEW FormData object.
     */
    const retryForm = createForm();

    const retryHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...retryForm.getHeaders(),
      Authorization: authorization,
    };

    let retryResponse: AxiosResponse<T>;

    try {
      retryResponse = await axios.request<T>({
        method: methodUpper,
        url: requestUrl,
        data: retryForm,
        headers: retryHeaders,
        timeout: 30_000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      });
    } catch (error: any) {
      throw this.normalizeAxiosError(error);
    }

    if (retryResponse.status >= 400) {
      throw this.createHttpError(retryResponse);
    }

    return retryResponse;
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

  async addFacePicture(
    devIndex: string,
    employeeNo: string,
    imageBuffer: Buffer,
  ) {
    if (!devIndex) throw new Error('Hikvision devIndex is required');
    if (!employeeNo) throw new Error('Hikvision employeeNo is required');
    if (!imageBuffer || imageBuffer.length === 0)
      throw new Error('Hikvision face image is empty');

    // Hikvision Gateway/terminal 1MB dan katta rasmni rad etadi →
    // har doim 600x600 max, JPEG 80% ga compress qilamiz
    const compressed = await sharp(imageBuffer)
      .rotate()
      .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: false })
      .toBuffer();

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
        JSON.stringify({
          FaceInfo: {
            employeeNo,
            faceLibType: 'blackFD',
          },
        }),
        { contentType: 'application/json' },
      );

      form.append('FaceImage', compressed, {
        filename: `${employeeNo}.jpg`,
        contentType: 'image/jpeg',
        knownLength: compressed.length,
      });

      return form;
    };

    const response = await this.digestMultipartRequest('POST', url, createForm);

    this.logger.log(
      `Hikvision Face uploaded successfully: employee=${employeeNo}`,
    );

    return response.data;
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

  private async fetchGatewayDevices(): Promise<any[]> {
    try {
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
  // Bulk Sync
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
  // Bulk Sync — mavjud (person + face) bo'lganlarni skip qiladi
  // ═══════════════════════════════════════════════════════════════════════════

  async syncHospital(hospitalId: string) {
    const terminals = await this.prisma.hikTerminal.findMany({
      where: { hospitalId, isActive: true },
    });

    if (terminals.length === 0) {
      return {
        total: 0,
        created: 0,
        skipped: 0,
        failed: 0,
        errors: [{ employeeNo: '-', name: '-', reason: 'Terminal topilmadi' }],
        perTerminal: [],
      };
    }

    const employees = await this.prisma.employee.findMany({
      where: {
        hospitalId,
        firedAt: null,
        employeeNo: { not: null },
        photoUrl: { not: null },
      },
      select: { employeeNo: true, fullName: true, photoUrl: true },
    });

    const uploadDir = this.config.get<string>('UPLOAD_DIR', './uploads');

    let created = 0;
    let skipped = 0;
    let failed = 0;
    const errors: { employeeNo: string; name: string; reason: string }[] = [];
    const perTerminal: {
      terminalId: string;
      terminalName: string;
      created: number;
      skipped: number;
      failed: number;
    }[] = [];

    for (const terminal of terminals) {
      let tCreated = 0;
      let tSkipped = 0;
      let tFailed = 0;

      // Terminaldagi mavjud userlar: employeeNo → hasFace (bitta so'rov, aniq)
      let existing: Map<string, boolean>;
      try {
        existing = await this.getExistingPersons(terminal.devIndex);
      } catch (err: any) {
        this.logger.warn(
          `Terminal ${terminal.name}: mavjud ro'yxatni olishda xato (${err?.message}) — hammasi qayta yuboriladi`,
        );
        existing = new Map();
      }

      for (const employee of employees) {
        if (!employee.employeeNo || !employee.photoUrl) continue;

        const filename = employee.photoUrl.replace(/^\/uploads\//, '');
        const filePath = path.join(uploadDir, filename);

        if (!fs.existsSync(filePath)) {
          tFailed++;
          errors.push({
            employeeNo: employee.employeeNo,
            name: employee.fullName,
            reason: `Rasm fayli topilmadi (${terminal.name})`,
          });
          continue;
        }

        const personExists = existing.has(employee.employeeNo);
        const faceExists = existing.get(employee.employeeNo) === true;

        let personIsNew = false;
        let faceIsNew = false;
        let hadFatalError = false;

        // ── 1. Person ──────────────────────────────────────────────────────
        if (!personExists) {
          try {
            await this.addPerson(terminal.devIndex, {
              employeeNo: employee.employeeNo,
              name: employee.fullName,
            });
            personIsNew = true;
          } catch (err: any) {
            // isAlreadyExistsError texnik xabar (err.message) bilan tekshiriladi
            const technicalMessage = err?.message ?? "Noma'lum xato";
            if (!this.isAlreadyExistsError(technicalMessage)) {
              hadFatalError = true;
              tFailed++;
              // Foydalanuvchi ko'radigan xato ro'yxatiga — tarjima qilingan matn
              const displayMessage = err?.friendlyMessage ?? technicalMessage;
              errors.push({
                employeeNo: employee.employeeNo,
                name: employee.fullName,
                reason: `${terminal.name}: ${displayMessage}`,
              });
              // Texnik tafsilotlar faqat serverning ichki logida qoladi
              this.logger.error(
                `[Person xatoligi | ${employee.employeeNo} @ ${terminal.name}] ${technicalMessage}`,
              );
            }
          }
        }

        // ── 2. Face — faqat hali yo'q bo'lsa yuklaymiz ──────────────────────
        if (!hadFatalError && !faceExists) {
          try {
            const imageBuffer = fs.readFileSync(filePath);
            await this.addFacePicture(
              terminal.devIndex,
              employee.employeeNo,
              imageBuffer,
            );
            faceIsNew = true;
          } catch (err: any) {
            // isAlreadyExistsError texnik xabar (err.message) bilan tekshiriladi
            const technicalMessage = err?.message ?? "Noma'lum xato";
            if (!this.isAlreadyExistsError(technicalMessage)) {
              hadFatalError = true;
              tFailed++;
              // Foydalanuvchi ko'radigan xato ro'yxatiga — tarjima qilingan matn
              // (masalan: "Yuz rasmi terminal tomonidan tan olinmadi...")
              const displayMessage = err?.friendlyMessage ?? technicalMessage;
              errors.push({
                employeeNo: employee.employeeNo,
                name: employee.fullName,
                reason: `${terminal.name}: ${displayMessage}`,
              });
              // Texnik tafsilotlar (errorCode, subStatusCode va h.k.)
              // faqat serverning ichki logida qoladi — debug uchun
              this.logger.error(
                `[Yuz yuklash xatoligi | ${employee.employeeNo} @ ${terminal.name}] ${technicalMessage}`,
              );
            }
          }
        }

        if (hadFatalError) {
          this.logger.error(
            `Sync failed: ${employee.employeeNo} → ${terminal.name}`,
          );
          continue;
        }

        if (personIsNew || faceIsNew) {
          tCreated++;
          this.logger.log(
            `Sync created: ${employee.employeeNo} → ${terminal.name}`,
          );
        } else {
          tSkipped++;
        }
      }

      created += tCreated;
      skipped += tSkipped;
      failed += tFailed;
      perTerminal.push({
        terminalId: terminal.id,
        terminalName: terminal.name,
        created: tCreated,
        skipped: tSkipped,
        failed: tFailed,
      });
    }

    return {
      total: employees.length,
      created,
      skipped,
      failed,
      errors,
      perTerminal,
    };
  }
}
