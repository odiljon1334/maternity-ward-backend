import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosResponse } from 'axios';
import * as crypto from 'crypto';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

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

  private createHttpError(response: AxiosResponse): Error {
    const data =
      typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data);

    return new Error(`Hikvision Gateway HTTP ${response.status}: ${data}`);
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
      throw new Error(
        `Hikvision addPerson failed: ${
          result.errorMsg ?? JSON.stringify(result)
        }`,
      );
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
    mimeType = 'image/jpeg',
  ) {
    if (!devIndex) {
      throw new Error('Hikvision devIndex is required');
    }

    if (!employeeNo) {
      throw new Error('Hikvision employeeNo is required');
    }

    if (!imageBuffer || imageBuffer.length === 0) {
      throw new Error('Hikvision face image is empty');
    }

    const url = this.buildUrl('/ISAPI/Intelligent/FDLib/FaceDataRecord', {
      format: 'json',
      devIndex,
    });

    this.logger.log(
      `Hikvision Face upload: employee=${employeeNo}, devIndex=${devIndex}, size=${imageBuffer.length}`,
    );

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
        {
          contentType: 'application/json',
        },
      );

      form.append('FaceImage', imageBuffer, {
        filename: `${employeeNo}.jpg`,
        contentType: mimeType,
        knownLength: imageBuffer.length,
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

  async syncHospital(hospitalId: string) {
    const terminals = await this.prisma.hikTerminal.findMany({
      where: {
        hospitalId,
        isActive: true,
      },
    });

    if (terminals.length === 0) {
      return {
        total: 0,
        success: 0,
        failed: 0,
        errors: ['Terminal topilmadi'],
      };
    }

    const employees = await this.prisma.employee.findMany({
      where: {
        hospitalId,
        firedAt: null,
        employeeNo: {
          not: null,
        },
        photoUrl: {
          not: null,
        },
      },
      select: {
        employeeNo: true,
        fullName: true,
        photoUrl: true,
      },
    });

    const uploadDir = this.config.get<string>('UPLOAD_DIR', './uploads');

    let success = 0;
    let failed = 0;

    const errors: string[] = [];

    for (const employee of employees) {
      if (!employee.employeeNo) {
        continue;
      }

      if (!employee.photoUrl) {
        continue;
      }

      const filename = employee.photoUrl.replace(/^\/uploads\//, '');

      const filePath = path.join(uploadDir, filename);

      if (!fs.existsSync(filePath)) {
        failed++;

        errors.push(`${employee.employeeNo}: rasm fayli topilmadi`);

        continue;
      }

      const imageBuffer = fs.readFileSync(filePath);

      for (const terminal of terminals) {
        try {
          /*
           * 1. Person
           */
          await this.addPerson(terminal.devIndex, {
            employeeNo: employee.employeeNo,
            name: employee.fullName,
          });

          /*
           * 2. Face
           */
          await this.addFacePicture(
            terminal.devIndex,
            employee.employeeNo,
            imageBuffer,
          );

          success++;

          this.logger.log(
            `Sync success: ${employee.employeeNo} → ${terminal.name}`,
          );
        } catch (err: any) {
          failed++;

          const message = err?.message ?? 'Unknown error';

          errors.push(`${employee.employeeNo} → ${terminal.name}: ${message}`);

          this.logger.error(
            `Sync failed: ${employee.employeeNo} → ${terminal.name}: ${message}`,
          );
        }
      }
    }

    return {
      total: employees.length,
      success,
      failed,
      errors,
    };
  }
}
