import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as webpush from 'web-push';
import { NotificationType, UserRole } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  url?: string; // URL to open on click
  tag?: string; // Replaces existing notification with same tag
  data?: Record<string, any>;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly configured: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const email = process.env.VAPID_EMAIL || 'mailto:admin@maternity-ward.uz';

    if (publicKey && privateKey) {
      webpush.setVapidDetails(email, publicKey, privateKey);
      this.configured = true;
    } else {
      this.logger.warn(
        'VAPID keys not configured — push notifications disabled',
      );
      this.configured = false;
    }
  }

  // ── Save subscription ──────────────────────────────────────────────
  async subscribe(
    userId: string,
    sub: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
      userAgent?: string;
    },
  ) {
    return this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      update: {
        userId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: sub.userAgent,
      },
      create: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: sub.userAgent,
      },
    });
  }

  // ── Remove subscription ────────────────────────────────────────────
  async unsubscribe(userId: string, endpoint: string) {
    const sub = await this.prisma.pushSubscription.findUnique({
      where: { endpoint },
    });
    if (!sub || sub.userId !== userId)
      throw new NotFoundException('Obuna topilmadi');
    return this.prisma.pushSubscription.delete({ where: { endpoint } });
  }

  // ── Send to specific user ──────────────────────────────────────────
  async sendToUser(userId: string, payload: PushPayload) {
    if (!this.configured) return;

    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId },
    });

    if (subs.length === 0) {
      this.logger.warn(`No push subscriptions for user: ${userId}`);
      return;
    }

    await Promise.allSettled(subs.map((s) => this.sendOne(s, payload)));
  }

  // ── Send to all users of a hospital, returns matched userIds ──────
  async sendToHospital(
    hospitalId: string,
    payload: PushPayload,
    roles?: string[],
  ): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: roles?.length
        ? {
            role: { in: roles as UserRole[] },
            OR: [{ hospitalId }, { role: UserRole.SUPER_ADMIN }],
          }
        : { hospitalId },
      include: { pushSubscriptions: true },
    });

    if (this.configured) {
      const allSubs = users.flatMap((u) => u.pushSubscriptions);
      if (allSubs.length === 0) {
        this.logger.warn(`No push subscriptions for hospital: ${hospitalId}`);
      } else {
        await Promise.allSettled(allSubs.map((s) => this.sendOne(s, payload)));
      }
    }

    return users.map((u) => u.id);
  }

  // ── Send to all users (SUPER_ADMIN broadcast) ─────────────────────
  async sendToAll(payload: PushPayload) {
    if (!this.configured) return;

    const subs = await this.prisma.pushSubscription.findMany();
    await Promise.allSettled(subs.map((s) => this.sendOne(s, payload)));
  }

  // ── Internal: send one notification ───────────────────────────────
  private async sendOne(
    sub: { endpoint: string; p256dh: string; auth: string },
    payload: PushPayload,
  ) {
    try {
      const result = await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify({
          title: payload.title,
          body: payload.body,
          icon: payload.icon ?? '/icons/icon-192x192.png',
          badge: payload.badge ?? '/icons/icon-192x192.png',
          url: payload.url ?? '/dashboard',
          tag: payload.tag,
          data: payload.data,
        }),
        { TTL: 60 * 60 * 24 },
      );
      this.logger.log(`Push sent successfully: ${result.statusCode}`);
    } catch (err: any) {
      this.logger.error(`Push failed: ${err?.statusCode} — ${err?.body}`);
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        await this.prisma.pushSubscription
          .delete({ where: { endpoint: sub.endpoint } })
          .catch(() => null);
      }
    }
  }

  // ── Convenience methods for common events ─────────────────────────
  // Har biri: (1) push yuboradi (agar VAPID sozlangan bo'lsa),
  // (2) Notification jadvaliga yozadi (doim, push holatidan qat'i nazar —
  //     shunda bell icon push o'chiq bo'lsa ham tarixni ko'rsatadi).

  /** Ta'til so'rovi yaratilganda direktorni xabardor qilish */
  async notifyLeaveCreated(
    hospitalId: string,
    employeeName: string,
    leaveType: string,
  ) {
    const LEAVE_LABELS: Record<string, string> = {
      VACATION: "Ta'til",
      SICK: 'Kasal',
      PERSONAL: 'Shaxsiy',
      MATERNITY: "Tuğruq ta'tili",
      UNPAID: "Haqsiz ta'til",
    };
    const title = "Yangi ta'til so'rovi 📋";
    const body = `${employeeName} — ${LEAVE_LABELS[leaveType] ?? leaveType} so'rov yubordi`;

    const recipientIds = await this.sendToHospital(
      hospitalId,
      { title, body, url: '/dashboard/leaves', tag: 'leave-new' },
      ['DIRECTOR', 'ADMIN', 'SUPER_ADMIN'],
    );

    await this.notifications
      .createForUsers(recipientIds, {
        type: NotificationType.ALERT,
        title,
        message: body,
        metadata: { kind: 'leave-new', hospitalId },
      })
      .catch((e) =>
        this.logger.warn(`Notification persist failed: ${e?.message ?? e}`),
      );
  }

  /** Ta'til so'rovi tasdiqlanganda/rad etilganda xodimni xabardor qilish */
  async notifyLeaveReviewed(
    userId: string,
    decision: 'APPROVED' | 'REJECTED',
    leaveType: string,
  ) {
    const LEAVE_LABELS: Record<string, string> = {
      VACATION: "Ta'til",
      SICK: 'Kasal',
      PERSONAL: 'Shaxsiy',
      MATERNITY: "Tuğruq ta'tili",
      UNPAID: "Haqsiz ta'til",
    };
    const label = LEAVE_LABELS[leaveType] ?? leaveType;
    const title =
      decision === 'APPROVED'
        ? "Ta'til tasdiqlandi ✅"
        : "Ta'til rad etildi ❌";
    const body =
      decision === 'APPROVED'
        ? `${label} so'rovingiz tasdiqlandi`
        : `${label} so'rovingiz rad etildi`;

    await this.sendToUser(userId, {
      title,
      body,
      url: '/dashboard/my-leaves',
      tag: 'leave-reviewed',
    });

    await this.notifications
      .create({
        type: NotificationType.ALERT,
        title,
        message: body,
        userId,
        metadata: { kind: 'leave-reviewed', decision },
      })
      .catch((e) =>
        this.logger.warn(`Notification persist failed: ${e?.message ?? e}`),
      );
  }

  /** Maosh hisoblanganda xodimni xabardor qilish */
  async notifyPayrollGenerated(
    userId: string,
    month: number,
    year: number,
    netSalary: number,
  ) {
    const MONTHS = [
      '',
      'Yanvar',
      'Fevral',
      'Mart',
      'Aprel',
      'May',
      'Iyun',
      'Iyul',
      'Avgust',
      'Sentyabr',
      'Oktyabr',
      'Noyabr',
      'Dekabr',
    ];
    const title = 'Maosh hisoblandi 💰';
    const body = `${MONTHS[month]} ${year} — ${Math.round(netSalary).toLocaleString('ru-RU')} so'm`;

    await this.sendToUser(userId, {
      title,
      body,
      url: '/dashboard/my-payroll',
      tag: `payroll-${month}-${year}`,
    });

    await this.notifications
      .create({
        type: NotificationType.PAYMENT,
        title,
        message: body,
        userId,
        metadata: { kind: 'payroll', month, year },
      })
      .catch((e) =>
        this.logger.warn(`Notification persist failed: ${e?.message ?? e}`),
      );
  }

  /** Bugungi check-in eslatmasi (kun boshida) */
  async notifyCheckinReminder(hospitalId: string) {
    const title = 'Bugungi ish kuni boshlandi 🏥';
    const body = 'Iltimos, check-in qilishni unutmang';

    const recipientIds = await this.sendToHospital(
      hospitalId,
      { title, body, url: '/dashboard/my-checkin', tag: 'checkin-reminder' },
      ['EMPLOYEE'],
    );

    await this.notifications
      .createForUsers(recipientIds, {
        type: NotificationType.ALERT,
        title,
        message: body,
        metadata: { kind: 'checkin-reminder', hospitalId },
      })
      .catch((e) =>
        this.logger.warn(`Notification persist failed: ${e?.message ?? e}`),
      );
  }

  /** Ish vaqti tugagan, lekin check-out qilinmagan xodimga eslatma */
  async notifyCheckoutReminder(userId: string, recordId: string) {
    const title = 'Check-out eslatmasi ⏰';
    const body = 'Ish vaqtingiz tugadi. Iltimos, check-out qilishni unutmang!';

    await this.sendToUser(userId, {
      title,
      body,
      url: '/dashboard/my-checkin',
      tag: `checkout-reminder-${recordId}`,
    });

    await this.notifications
      .create({
        type: NotificationType.ALERT,
        title,
        message: body,
        userId,
        metadata: { kind: 'checkout-reminder', recordId },
      })
      .catch((e) =>
        this.logger.warn(`Notification persist failed: ${e?.message ?? e}`),
      );
  }
}
