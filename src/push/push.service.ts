import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as webpush from 'web-push';

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

  constructor(private readonly prisma: PrismaService) {
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
    await Promise.allSettled(subs.map((s) => this.sendOne(s, payload)));
  }

  // ── Send to all users of a hospital ───────────────────────────────
  async sendToHospital(
    hospitalId: string,
    payload: PushPayload,
    roles?: string[],
  ) {
    if (!this.configured) return;

    const where: any = { hospitalId };
    if (roles?.length) where.role = { in: roles };

    const users = await this.prisma.user.findMany({
      where,
      include: { pushSubscriptions: true },
    });

    const allSubs = users.flatMap((u) => u.pushSubscriptions);
    await Promise.allSettled(allSubs.map((s) => this.sendOne(s, payload)));
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
      await webpush.sendNotification(
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
        { TTL: 60 * 60 * 24 }, // 24 soat saqlanadi
      );
    } catch (err: any) {
      // 410 Gone yoki 404 = subscription o'chirilgan → DBdan tozalaymiz
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        await this.prisma.pushSubscription
          .delete({ where: { endpoint: sub.endpoint } })
          .catch(() => null);
        this.logger.debug(
          `Stale push sub removed: ${sub.endpoint.slice(0, 40)}…`,
        );
      } else {
        this.logger.error(`Push send failed: ${err?.message}`);
      }
    }
  }

  // ── Convenience methods for common events ─────────────────────────

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
    await this.sendToHospital(
      hospitalId,
      {
        title: "Yangi ta'til so'rovi 📋",
        body: `${employeeName} — ${LEAVE_LABELS[leaveType] ?? leaveType} so'rov yubordi`,
        url: '/dashboard/leaves',
        tag: 'leave-new',
      },
      ['DIRECTOR', 'ADMIN', 'SUPER_ADMIN'],
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
    await this.sendToUser(userId, {
      title:
        decision === 'APPROVED'
          ? "Ta'til tasdiqlandi ✅"
          : "Ta'til rad etildi ❌",
      body:
        decision === 'APPROVED'
          ? `${label} so'rovingiz tasdiqlandi`
          : `${label} so'rovingiz rad etildi`,
      url: '/dashboard/my-leaves',
      tag: 'leave-reviewed',
    });
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
    await this.sendToUser(userId, {
      title: 'Maosh hisoblandi 💰',
      body: `${MONTHS[month]} ${year} — ${Math.round(netSalary).toLocaleString('ru-RU')} so'm`,
      url: '/dashboard/my-payroll',
      tag: `payroll-${month}-${year}`,
    });
  }

  /** Bugungi check-in eslatmasi (kun boshida) */
  async notifyCheckinReminder(hospitalId: string) {
    await this.sendToHospital(
      hospitalId,
      {
        title: 'Bugungi ish kuni boshlandi 🏥',
        body: 'Iltimos, check-in qilishni unutmang',
        url: '/dashboard/my-checkin',
        tag: 'checkin-reminder',
      },
      ['EMPLOYEE'],
    );
  }
}
