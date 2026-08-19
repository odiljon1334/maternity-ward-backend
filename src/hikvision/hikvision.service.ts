import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HikvisionService {
  private readonly logger = new Logger(HikvisionService.name);
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;
  private readonly gatewayUser: string;
  private readonly gatewayPass: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.baseUrl = this.config.get(
      'HIK_GATEWAY_URL',
      'http://95.111.252.83:8080',
    );
    this.gatewayUser = this.config.get('HIK_GATEWAY_USER', 'admin');
    this.gatewayPass = this.config.get('HIK_GATEWAY_PASS', '');

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 15_000,
      auth: { username: this.gatewayUser, password: this.gatewayPass },
    });
  }

  // ─── Digest Auth helper ───────────────────────────────────────────────────

  private async digestRequest(
    method: string,
    url: string,
    data?: any,
  ): Promise<any> {
    try {
      return await axios({
        method,
        url,
        data,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err: any) {
      if (err.response?.status !== 401) throw err;

      const wwwAuth = err.response.headers['www-authenticate'] || '';
      const realm = wwwAuth.match(/realm="([^"]+)"/)?.[1] ?? '';
      const nonce = wwwAuth.match(/nonce="([^"]+)"/)?.[1] ?? '';
      const qop = (wwwAuth.match(/qop="([^"]+)"/)?.[1] ?? '')
        .split(',')[0]
        .trim();

      const parsedUrl = new URL(url);
      const uri = parsedUrl.pathname + parsedUrl.search;
      const nc = '00000001';
      const cnonce = crypto.randomBytes(8).toString('hex');

      const ha1 = crypto
        .createHash('md5')
        .update(`${this.gatewayUser}:${realm}:${this.gatewayPass}`)
        .digest('hex');
      const ha2 = crypto
        .createHash('md5')
        .update(`${method.toUpperCase()}:${uri}`)
        .digest('hex');
      const response = crypto
        .createHash('md5')
        .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        .digest('hex');

      const authHeader = `Digest username="${this.gatewayUser}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;

      return axios({
        method,
        url,
        data,
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
      });
    }
  }

  // ─── Gateway device list (Digest auth) ───────────────────────────────────

  private async fetchGatewayDevices(): Promise<any[]> {
    try {
      this.logger.log("fetchGatewayDevices: so'rov yuborilmoqda...");
      const res = await this.digestRequest(
        'POST',
        `${this.baseUrl}/ISAPI/ContentMgmt/DeviceMgmt/deviceList?format=json`,
        {
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
      );
      const devices = res.data?.SearchResult?.MatchList ?? [];
      this.logger.log(
        `fetchGatewayDevices: ${devices.length} ta qurilma. ${JSON.stringify(devices.map((d: any) => ({ devIndex: d.Device?.devIndex, status: d.Device?.devStatus })))}`,
      );
      return devices;
    } catch (err: any) {
      this.logger.error(`fetchGatewayDevices xato: ${err.message}`);
      return [];
    }
  }

  private buildStatusMap(gatewayDevices: any[]): Record<string, string> {
    const statusMap: Record<string, string> = {};
    for (const item of gatewayDevices) {
      const dev = item.Device;
      if (dev?.devIndex) statusMap[dev.devIndex] = dev.devStatus ?? 'offline';
    }
    return statusMap;
  }

  // ─── Person ───────────────────────────────────────────────────────────────

  async addPerson(
    devIndex: string,
    data: {
      employeeNo: string;
      name: string;
      beginTime?: string;
      endTime?: string;
    },
  ) {
    const res = await this.http.post(
      `/ISAPI/AccessControl/UserInfo/Record?format=json&devIndex=${devIndex}`,
      {
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
      },
    );
    const result = res.data?.UserInfoOutList?.UserInfoOut?.[0];
    if (result?.statusCode !== 1) {
      throw new Error(`addPerson failed: ${result?.errorMsg}`);
    }
    this.logger.log(`Person added: ${data.employeeNo}`);
    return result;
  }

  async deletePerson(devIndex: string, employeeNo: string) {
    const res = await this.http.put(
      `/ISAPI/AccessControl/UserInfo/Delete?format=json&devIndex=${devIndex}`,
      { UserInfoDelCond: { EmployeeNoList: [{ employeeNo }] } },
    );
    this.logger.log(`Person deleted: ${employeeNo}`);
    return res.data;
  }

  // ─── Face ─────────────────────────────────────────────────────────────────

  async addFacePicture(
    devIndex: string,
    employeeNo: string,
    imageBuffer: Buffer,
    mimeType = 'image/jpeg',
  ) {
    const form = new FormData();
    form.append(
      'FaceDataRecord',
      JSON.stringify({
        FaceInfo: { employeeNo, faceLibType: 'blackFD' },
      }),
      { contentType: 'application/json' },
    );
    form.append('FaceImage', imageBuffer, {
      filename: `${employeeNo}.jpg`,
      contentType: mimeType,
    });
    const res = await this.http.post(
      `/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json&devIndex=${devIndex}`,
      form,
      { headers: form.getHeaders() },
    );
    this.logger.log(`Face added: ${employeeNo}`);
    return res.data;
  }

  async deleteFacePicture(devIndex: string, employeeNo: string) {
    const res = await this.http.put(
      `/ISAPI/Intelligent/FDLib/FaceDataRecord/Delete?format=json&devIndex=${devIndex}`,
      { FaceInfoDelCond: { EmployeeNoList: [{ employeeNo }] } },
    );
    return res.data;
  }

  // ─── Gateway devices ──────────────────────────────────────────────────────

  async getDevices() {
    const res = await this.http.get(
      '/ISAPI/ResourceManagement/devList?format=json',
    );
    return res.data;
  }

  // ─── HikTerminal CRUD ─────────────────────────────────────────────────────

  async getTerminals(hospitalId: string) {
    return this.prisma.hikTerminal.findMany({
      where: { hospitalId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addTerminal(
    hospitalId: string,
    data: { name: string; devIndex: string },
  ) {
    return this.prisma.hikTerminal.create({
      data: {
        name: data.name,
        devIndex: data.devIndex,
        hospitalId,
      },
    });
  }

  async removeTerminal(id: string, hospitalId: string) {
    return this.prisma.hikTerminal.delete({
      where: { id, hospitalId },
    });
  }

  async toggleTerminal(id: string, hospitalId: string, isActive: boolean) {
    return this.prisma.hikTerminal.update({
      where: { id, hospitalId },
      data: { isActive },
    });
  }

  // ─── Terminal status ──────────────────────────────────────────────────────

  async getTerminalsWithStatus(hospitalId: string) {
    const terminals = await this.prisma.hikTerminal.findMany({
      where: { hospitalId },
      orderBy: { createdAt: 'desc' },
    });
    const gatewayDevices = await this.fetchGatewayDevices();
    const statusMap = this.buildStatusMap(gatewayDevices);
    return terminals.map((t) => ({
      ...t,
      onlineStatus: statusMap[t.devIndex] ?? 'offline',
    }));
  }

  async getAllTerminalsWithStatus() {
    const terminals = await this.prisma.hikTerminal.findMany({
      orderBy: { createdAt: 'desc' },
    });
    const gatewayDevices = await this.fetchGatewayDevices();
    const statusMap = this.buildStatusMap(gatewayDevices);
    return terminals.map((t) => ({
      ...t,
      onlineStatus: statusMap[t.devIndex] ?? 'offline',
    }));
  }

  // ─── Bulk Sync ────────────────────────────────────────────────────────────

  async syncHospital(hospitalId: string) {
    const terminals = await this.prisma.hikTerminal.findMany({
      where: { hospitalId, isActive: true },
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
        employeeNo: { not: null },
        photoUrl: { not: null },
      },
      select: { employeeNo: true, fullName: true, photoUrl: true },
    });

    const uploadDir = this.config.get('UPLOAD_DIR', './uploads');
    let success = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const emp of employees) {
      const filename = emp.photoUrl!.replace(/^\/uploads\//, '');
      const filePath = path.join(uploadDir, filename);

      if (!fs.existsSync(filePath)) {
        failed++;
        errors.push(`${emp.employeeNo}: rasm fayli topilmadi`);
        continue;
      }

      const imageBuffer = fs.readFileSync(filePath);

      for (const terminal of terminals) {
        try {
          await this.addPerson(terminal.devIndex, {
            employeeNo: emp.employeeNo!,
            name: emp.fullName,
          }).catch(() => {});

          await this.addFacePicture(
            terminal.devIndex,
            emp.employeeNo!,
            imageBuffer,
          );
          success++;
        } catch (err: any) {
          failed++;
          errors.push(`${emp.employeeNo} → ${terminal.name}: ${err.message}`);
        }
      }
    }

    return { total: employees.length, success, failed, errors };
  }
}
