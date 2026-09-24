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
 *
 * Navbat `updatedAt` bo'yicha aylanadi: har bir ko'rilgan yozuv oxiriga
 * o'tadi, shuning uchun rasm kutayotgan eski yozuvlar yangilarini to'sib
 * qo'ymaydi. Rasm kutayotgan yozuv uchun xizmat faqat xodim profili
 * (rasmi) yangilangandan keyin qayta chaqiriladi.
 *
 * Muddati o'tgan (tekshirib bo'lmagan) yozuvlar jimgina yopilmaydi —
 * rahbarlarga muassasa bo'yicha bitta ogohlantirish yuboriladi.
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
      // workDate — Toshkent yarim tuni; chegara ham Toshkent kuni bo'yicha
      const since = dayjs()
        .tz(TZ)
        .subtract(PENDING_TTL_DAYS, 'day')
        .startOf('day')
        .toDate();

      summary.expired = await this.expireOld(since);

      const rows = await this.prisma.attendanceRecord.findMany({
        where: { faceCheckPending: true, workDate: { gte: since } },
        // Aylanma navbat: har ko'rilgan yozuv updatedAt'i yangilanib oxiriga o'tadi
        orderBy: { updatedAt: 'asc' },
        take: BATCH,
        select: {
          id: true,
          selfieUrl: true,
          workDate: true,
          checkIn: true,
          updatedAt: true,
          faceCheckReason: true,
          employee: {
            select: {
              id: true,
              fullName: true,
              hospitalId: true,
              photoUrl: true,
              updatedAt: true,
            },
          },
        },
      });

      for (const row of rows) {
        try {
          const outcome = await this.recheckOne(row, summary);
          if (outcome === 'STOP') break;
        } catch (e: any) {
          // Bitta yozuvdagi xato (masalan o'chirilgan) butun navbatni to'xtatmasin
          this.logger.warn(
            `Face recheck: yozuv ${row.id} o'tkazib yuborildi: ${e?.message ?? e}`,
          );
        }
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

  private async recheckOne(
    row: {
      id: string;
      selfieUrl: string | null;
      workDate: Date;
      checkIn: Date | null;
      updatedAt: Date;
      faceCheckReason: string | null;
      employee: {
        id: string;
        fullName: string;
        hospitalId: string;
        photoUrl: string | null;
        updatedAt: Date;
      };
    },
    summary: FaceRecheckSummary,
  ): Promise<'NEXT' | 'STOP'> {
    const selfie = this.readUpload(row.selfieUrl);
    if (!selfie) {
      await this.finish(row.id, false, 'NO_SELFIE');
      return 'NEXT';
    }

    const reference = this.readUpload(row.employee.photoUrl);
    // Profil rasmi hali yo'q, yoki avval tekshirilgan rasmda yuz topilmagan va
    // o'shandan beri profil o'zgarmagan — xizmatni bekorga chaqirmaymiz.
    const photoUnchanged =
      row.faceCheckReason === 'REFERENCE_FACE_NOT_FOUND' &&
      row.employee.updatedAt.getTime() <= row.updatedAt.getTime();
    if (!reference || photoUnchanged) {
      summary.waitingPhoto++;
      await this.markWaiting(
        row.id,
        reference ? 'REFERENCE_FACE_NOT_FOUND' : 'NO_REFERENCE_PHOTO',
      );
      return 'NEXT';
    }

    const [ref, live] = await Promise.all([
      prepareFaceImage(reference),
      prepareFaceImage(selfie),
    ]);
    const result = await this.faceMatch.verify(ref, live);
    summary.checked++;

    if (result.reason === 'SERVICE_ERROR' || result.reason === 'DISABLED') {
      summary.serviceDown = true;
      return 'STOP';
    }
    if (!result.mismatch && !result.reason) {
      await this.finish(row.id, true, null);
      summary.verified++;
      this.audit(row, 'FACE_MATCH_OK', null, result.similarity);
      return 'NEXT';
    }
    if (
      result.reason === 'NO_REFERENCE_PHOTO' ||
      result.reason === 'REFERENCE_FACE_NOT_FOUND'
    ) {
      summary.waitingPhoto++;
      await this.markWaiting(row.id, result.reason);
      return 'NEXT';
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
    return 'NEXT';
  }

  /** Kutishda qoladi; updatedAt yangilanadi — navbat oxiriga o'tadi */
  private markWaiting(id: string, reason: string) {
    return this.prisma.attendanceRecord.updateMany({
      where: { id, faceCheckPending: true },
      data: { faceCheckReason: reason },
    });
  }

  /**
   * Muddati o'tgan kutilayotgan tekshiruvlar yopiladi. Jimgina emas: har bir
   * muassasa rahbarlariga bitta ogohlantirish va audit yozuvi — aks holda
   * rasmsiz xodim nomidan kelish hech kim bilmagan holda tasdiqsiz qolardi.
   */
  private async expireOld(since: Date): Promise<number> {
    const stale = await this.prisma.attendanceRecord.findMany({
      where: { faceCheckPending: true, workDate: { lt: since } },
      select: {
        id: true,
        faceCheckReason: true,
        employee: { select: { fullName: true, hospitalId: true } },
      },
      take: 1000,
    });
    if (!stale.length) return 0;

    await this.prisma.attendanceRecord.updateMany({
      where: { id: { in: stale.map((r) => r.id) }, faceCheckPending: true },
      data: { faceCheckPending: false, faceCheckReason: 'EXPIRED' },
    });

    const byHospital = new Map<string, typeof stale>();
    for (const r of stale) {
      const list = byHospital.get(r.employee.hospitalId) ?? [];
      list.push(r);
      byHospital.set(r.employee.hospitalId, list);
    }
    for (const [hospitalId, list] of byHospital) {
      this.auditLog.log({
        hospitalId,
        action: 'FACE_MATCH_EXPIRED',
        entity: 'AttendanceRecord',
        entityId: list[0].id,
        details: {
          stage: 'CHECK_IN_RECHECK',
          count: list.length,
          attendanceIds: list.slice(0, 50).map((r) => r.id),
        },
      });
      const names = [...new Set(list.map((r) => r.employee.fullName))];
      const noPhoto = list.some(
        (r) => r.faceCheckReason === 'NO_REFERENCE_PHOTO',
      );
      await this.notifyHospital(hospitalId, {
        title: 'Yuz tekshiruvi: tasdiqlanmagan check-inlar',
        message:
          `${list.length} ta check-in ${PENDING_TTL_DAYS} kun ichida yuz bo'yicha tasdiqlanmadi: ` +
          `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` va yana ${names.length - 5} kishi` : ''}.` +
          (noPhoto
            ? " Sabab — profil rasmi yo'q yoki yaroqsiz: xodimlar profiliga rasm yuklang."
            : ' Davomat yozuvlarini tekshiring.'),
        metadata: { kind: 'face-recheck-expired', count: list.length },
      }).catch((e) =>
        this.logger.warn(
          `Muddati o'tgan yuz tekshiruvi bildirishnomasi yuborilmadi: ${e?.message ?? e}`,
        ),
      );
    }
    return stale.length;
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
    // updateMany + faceCheckPending: yozuv o'chirilgan yoki qo'lda yopilgan
    // bo'lsa xato bermaydi va natijani ustidan yozmaydi
    return this.prisma.attendanceRecord.updateMany({
      where: { id, faceCheckPending: true },
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

  private async notifyHospital(
    hospitalId: string,
    payload: { title: string; message: string; metadata: Record<string, any> },
  ) {
    const managers = await this.prisma.user.findMany({
      where: {
        hospitalId,
        role: { in: ['DIRECTOR', 'ADMIN'] },
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (!managers.length) return;
    await this.notifications.createForUsers(
      managers.map((m) => m.id),
      { type: 'ALERT', ...payload },
    );
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
    const day = dayjs(row.workDate).tz(TZ).format('DD.MM.YYYY');
    const time = row.checkIn ? dayjs(row.checkIn).tz(TZ).format('HH:mm') : '';
    const why =
      reason === 'LIVE_FACE_NOT_FOUND'
        ? 'selfida yuz aniqlanmadi'
        : 'selfi profil rasmiga mos kelmadi';
    await this.notifyHospital(row.employee.hospitalId, {
      title: 'Yuz tekshiruvi: shubhali check-in',
      message: `${row.employee.fullName} — ${day} ${time} check-in: ${why}. Davomat yozuvini tekshiring.`,
      metadata: { kind: 'face-recheck-failed', attendanceId: row.id, reason },
    });
  }
}
