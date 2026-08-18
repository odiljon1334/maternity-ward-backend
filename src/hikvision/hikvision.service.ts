import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HikvisionService {
  private readonly logger = new Logger(HikvisionService.name);
  private readonly http: AxiosInstance;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const baseUrl = this.config.get(
      'HIK_GATEWAY_URL',
      'http://95.111.252.83:8080',
    );
    const user = this.config.get('HIK_GATEWAY_USER', 'admin');
    const pass = this.config.get('HIK_GATEWAY_PASS', '');

    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 15_000,
      auth: { username: user, password: pass },
    });
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
      {
        UserInfoDelCond: {
          EmployeeNoList: [{ employeeNo }],
        },
      },
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
        FaceInfo: {
          employeeNo,
          faceLibType: 'blackFD',
        },
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
      {
        FaceInfoDelCond: {
          EmployeeNoList: [{ employeeNo }],
        },
      },
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
        hospitalId: hospitalId,
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
          }).catch(() => {}); // ignore duplicate

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

  async getTerminalsWithStatus(hospitalId: string) {
    const terminals = await this.prisma.hikTerminal.findMany({
      where: { hospitalId },
      orderBy: { createdAt: 'desc' },
    });

    // Gateway dan barcha qurilmalar statusini olish
    let gatewayDevices: any[] = [];
    try {
      const res = await this.http.post(
        '/ISAPI/ContentMgmt/DeviceMgmt/deviceList?format=json',
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
      gatewayDevices = res.data?.SearchResult?.MatchList ?? [];
    } catch {
      // Gateway ulanmasa — hammasi offline
    }

    // devIndex bo'yicha status map
    const statusMap: Record<string, string> = {};
    for (const item of gatewayDevices) {
      const dev = item.Device;
      if (dev?.devIndex) {
        statusMap[dev.devIndex] = dev.devStatus ?? 'offline';
      }
    }

    return terminals.map((t) => ({
      ...t,
      onlineStatus: statusMap[t.devIndex] ?? 'offline',
    }));
  }

  async getAllTerminalsWithStatus() {
    const terminals = await this.prisma.hikTerminal.findMany({
      orderBy: { createdAt: 'desc' },
    });

    let gatewayDevices: any[] = [];
    try {
      const res = await this.http.post(
        '/ISAPI/ContentMgmt/DeviceMgmt/deviceList?format=json',
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
      gatewayDevices = res.data?.SearchResult?.MatchList ?? [];
    } catch {
      /* offline */
    }

    const statusMap: Record<string, string> = {};
    for (const item of gatewayDevices) {
      const dev = item.Device;
      if (dev?.devIndex) statusMap[dev.devIndex] = dev.devStatus ?? 'offline';
    }

    return terminals.map((t) => ({
      ...t,
      onlineStatus: statusMap[t.devIndex] ?? 'offline',
    }));
  }
}
