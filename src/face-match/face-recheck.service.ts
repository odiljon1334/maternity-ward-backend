import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { prepareFaceImage } from '../common/utils/image.util';
import { FaceMatchService } from './face-match.service';

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

/** Shuncha kundan eski kutilayotgan tekshiruvlar yopiladi (EXPIRED) */
const PENDING_TTL_DAYS = 3;
/** Bir ishga tushishda nechta yozuv tekshiriladi */
const BATCH = 25;

export interface FaceRecheckSummary {
  checked: number;
  verified: number;
  rejected: number;
  waitingPhoto: number;
  expired: number;
  serviceDown: boolean;
}

/**
 * Check-in paytida yuzni tekshirib bo'lmagan yozuvlarni (xizmat ishlamadi,
 * profil rasmi yo'q/yaroqsiz — `faceCheckPending = true`) keyinroq qayta
 * tekshiradi. Check-in selfisi diskda saqlangan, shu bilan solishtiriladi.
 *
 *  - Mos keldi → faceVerified = true.
 *  - Mos kelmadi / selfida yuz yo'q → faceVerified = false, direktor va
 *    adminlarga bildirishnoma (davomat o'zi o'chirilmaydi — qarorni rahbar
 *    qiladi).
 *  - Profil rasmi hali yo'q yoki yaroqsiz → kutishda qoladi (rasm
 *    yuklangach keyingi aylanishda tekshiriladi).
 *  - Xizmat hali ishlamayapti → aylanish to'xtaydi, keyingi safar davom etadi.
 */
@Injectable()
export class FaceRecheckService {
  private readonly logger = new Logger(FaceRecheckService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly faceMatch: FaceMatchService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  async run(): Promise<FaceRecheckSummary> {
    const summary: FaceRecheckSummary = {
      checked: 0,
      verified: 0,
      rejected: 0,
      waitingPhoto: 0,
      expired: 0,
      serviceDown: false,
    };
    if (process.env.FACE_MATCH_ENABLED === 'false' || this.running)
      return summary;
    this.running = true;
    try {
      const since = dayjs()
        .subtract(PENDING_TTL_DAYS, 'day')
        .startOf('day')
        .toDate();

      const expired = await this.prisma.attendanceRecord.updateMany({
        where: { faceCheckPending: true, workDate: { lt: since } },
        data: { faceCheckPending: false, faceCheckReason: 'EXPIRED' },
      });
      summary.expired = expired.count;

      const rows = await this.prisma.attendanceRecord.findMany({
        where: { faceCheckPending: true, workDate: { gte: since } },
        orderBy: { workDate: 'asc' },
        take: BATCH,
        select: {
          id: true,
          selfieUrl: true,
          workDate: true,
          checkIn: true,
          faceCheckReason: true,
          employee: {
            select: {
              id: true,
              fullName: true,
              hospitalId: true,
              photoUrl: true,
            },
          },
        },
      });

      for (const row of rows) {
        const selfie = this.readUpload(row.selfieUrl);
        if (!selfie) {
          await this.finish(row.id, false, 'NO_SELFIE');
          continue;
        }
        const reference = this.readUpload(row.employee.photoUrl);
        if (!reference) {
          summary.waitingPhoto++;
          if (row.faceCheckReason !== 'NO_REFERENCE_PHOTO') {
            await this.prisma.attendanceRecord.update({
              where: { id: row.id },
              data: { faceCheckReason: 'NO_REFERENCE_PHOTO' },
            });
          }
          continue;
        }

        const [ref, live] = await Promise.all([
          prepareFaceImage(reference),
          prepareFaceImage(selfie),
        ]);
        const result = await this.faceMatch.verify(ref, live);
        summary.checked++;

        if (result.reason === 'SERVICE_ERROR' || result.reason === 'DISABLED') {
          summary.serviceDown = true;
          break;
        }
        if (!result.mismatch && !result.reason) {
          await this.finish(row.id, true, null);
          summary.verified++;
          this.audit(row, 'FACE_MATCH_OK', null, result.similarity);
          continue;
        }
        if (
          result.reason === 'NO_REFERENCE_PHOTO' ||
          result.reason === 'REFERENCE_FACE_NOT_FOUND'
        ) {
          summary.waitingPhoto++;
          if (row.faceCheckReason !== result.reason) {
            await this.prisma.attendanceRecord.update({
              where: { id: row.id },
              data: { faceCheckReason: result.reason },
            });
          }
          continue;
        }

        // FACE_MISMATCH yoki LIVE_FACE_NOT_FOUND
        await this.finish(row.id, false, result.reason ?? 'FACE_MISMATCH');
        summary.rejected++;
        this.audit(
          row,
          'FACE_MATCH_REJECTED',
          result.reason ?? null,
          result.similarity,
        );
        await this.notifyManagers(row, result.reason ?? 'FACE_MISMATCH').catch(
          (e) =>
            this.logger.warn(
              `Yuz tekshiruvi bildirishnomasi yuborilmadi: ${e?.message ?? e}`,
            ),
        );
      }

      if (summary.checked || summary.expired) {
        this.logger.log(
          `Face recheck: checked=${summary.checked} ok=${summary.verified} rejected=${summary.rejected} ` +
            `waitingPhoto=${summary.waitingPhoto} expired=${summary.expired} serviceDown=${summary.serviceDown}`,
        );
      }
      return summary;
    } finally {
      this.running = false;
    }
  }

  private readUpload(url: string | null | undefined): Buffer | null {
    if (!url) return null;
    try {
      const file = path.join(
        process.env.UPLOAD_DIR || './uploads',
        url.replace(/^\/uploads\//, ''),
      );
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    } catch {
      return null;
    }
  }

  private finish(id: string, verified: boolean, reason: string | null) {
    return this.prisma.attendanceRecord.update({
      where: { id },
      data: {
        faceVerified: verified,
        faceCheckPending: false,
        faceCheckReason: reason,
      },
    });
  }

  private audit(
    row: { id: string; employee: { id: string; hospitalId: string } },
    action: 'FACE_MATCH_OK' | 'FACE_MATCH_REJECTED',
    reason: string | null,
    similarity?: number,
  ) {
    this.auditLog.log({
      hospitalId: row.employee.hospitalId,
      action,
      entity: 'AttendanceRecord',
      entityId: row.id,
      details: {
        stage: 'CHECK_IN_RECHECK',
        reason,
        similarity,
        employeeId: row.employee.id,
      },
    });
  }

  private async notifyManagers(
    row: {
      id: string;
      workDate: Date;
      checkIn: Date | null;
      employee: { fullName: string; hospitalId: string };
    },
    reason: string,
  ) {
    const managers = await this.prisma.user.findMany({
      where: {
        hospitalId: row.employee.hospitalId,
        role: { in: ['DIRECTOR', 'ADMIN'] },
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (!managers.length) return;
    const day = dayjs(row.workDate).tz(TZ).format('DD.MM.YYYY');
    const time = row.checkIn ? dayjs(row.checkIn).tz(TZ).format('HH:mm') : '';
    const why =
      reason === 'LIVE_FACE_NOT_FOUND'
        ? 'selfida yuz aniqlanmadi'
        : 'selfi profil rasmiga mos kelmadi';
    await this.notifications.createForUsers(
      managers.map((m) => m.id),
      {
        type: 'ALERT',
        title: 'Yuz tekshiruvi: shubhali check-in',
        message: `${row.employee.fullName} — ${day} ${time} check-in: ${why}. Davomat yozuvini tekshiring.`,
        metadata: { kind: 'face-recheck-failed', attendanceId: row.id, reason },
      },
    );
  }
}
