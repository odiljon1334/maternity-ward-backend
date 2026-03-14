import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Telegraf } from 'telegraf';
import { AttendanceStatus } from '@prisma/client';
import dayjs from 'dayjs';
import 'dayjs/locale/uz';

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || token === 'your_telegram_bot_token') {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set — bot disabled');
      return;
    }

    this.bot = new Telegraf(token);
    this.setupCommands();
    this.bot.launch().catch((err) => this.logger.error('Bot launch failed:', err));
    this.logger.log('Telegram bot started');
  }

  private setupCommands() {
    const bot = this.bot;

    // /start — register as subscriber
    bot.start(async (ctx) => {
      const chatId = String(ctx.chat.id);
      const username = ctx.from?.username || ctx.from?.first_name || '';

      await this.prisma.telegramSubscription.upsert({
        where: { chatId },
        update: { isActive: true, username },
        create: { chatId, username, role: 'DIRECTOR', isActive: true },
      });

      await ctx.reply(
        `👋 Salom, ${ctx.from?.first_name}!\n\n` +
        `🏥 Tug'ruq xona davomat tizimiga xush kelibsiz.\n\n` +
        `📋 Mavjud buyruqlar:\n` +
        `/today — Bugungi davomat\n` +
        `/absent — Kelmagan hodimlar\n` +
        `/week — Haftalik hisobot\n` +
        `/month — Oylik hisobot\n` +
        `/stop — Bildirishnomalarni o'chirish`,
      );
    });

    // /stop — unsubscribe
    bot.command('stop', async (ctx) => {
      await this.prisma.telegramSubscription.updateMany({
        where: { chatId: String(ctx.chat.id) },
        data: { isActive: false },
      });
      await ctx.reply('❌ Bildirishnomalar o\'chirildi. /start buyrug\'i bilan qayta ulaning.');
    });

    // /today — today's attendance summary
    bot.command('today', async (ctx) => {
      const text = await this.buildTodaySummary();
      await ctx.reply(text, { parse_mode: 'HTML' });
    });

    // /absent — absent employees today
    bot.command('absent', async (ctx) => {
      const text = await this.buildAbsentList();
      await ctx.reply(text, { parse_mode: 'HTML' });
    });

    // /week — weekly report
    bot.command('week', async (ctx) => {
      const text = await this.buildWeeklyReport();
      await ctx.reply(text, { parse_mode: 'HTML' });
    });

    // /month — monthly report
    bot.command('month', async (ctx) => {
      const now = new Date();
      const text = await this.buildMonthlyReport(now.getMonth() + 1, now.getFullYear());
      await ctx.reply(text, { parse_mode: 'HTML' });
    });
  }

  // ──────────────────────────────────────────
  // NOTIFY: hodim keldi/ketdi
  // ──────────────────────────────────────────
  async notifyAttendance(employee: any, action: 'CHECK_IN' | 'CHECK_OUT', attendance: any) {
    if (!this.bot) return;

    const subscribers = await this.prisma.telegramSubscription.findMany({
      where: { isActive: true },
    });
    if (!subscribers.length) return;

    const timeStr = dayjs(action === 'CHECK_IN' ? attendance.checkIn : attendance.checkOut)
      .tz ? dayjs(action === 'CHECK_IN' ? attendance.checkIn : attendance.checkOut).format('HH:mm')
      : new Date(action === 'CHECK_IN' ? attendance.checkIn : attendance.checkOut).toLocaleTimeString('uz-UZ', {
          hour: '2-digit', minute: '2-digit', timeZone: TZ,
        });

    let emoji = '✅';
    let actionText = 'KELDI';
    let extra = '';

    if (action === 'CHECK_IN') {
      if (attendance.lateMinutes > 0) {
        emoji = '⚠️';
        extra = `\n⏱ <b>${attendance.lateMinutes} daqiqa kechikdi</b>`;
      }
    } else {
      emoji = '🚶';
      actionText = 'KETDI';
      if (attendance.earlyLeaveMin > 0) {
        extra = `\n⚡ <b>${attendance.earlyLeaveMin} daqiqa erta ketdi</b>`;
      } else if (attendance.overtimeMinutes > 0) {
        extra = `\n⭐ +${attendance.overtimeMinutes} daqiqa overtime`;
      }
    }

    const text =
      `${emoji} <b>${employee.fullName}</b> ${actionText}\n` +
      `🕐 Vaqt: <b>${timeStr}</b>\n` +
      `🏢 Bo'lim: ${employee.department?.name || '—'}\n` +
      `💼 Lavozim: ${employee.position?.name || '—'}` +
      extra;

    for (const sub of subscribers) {
      try {
        await this.bot.telegram.sendMessage(sub.chatId, text, { parse_mode: 'HTML' });
      } catch (e) {
        this.logger.warn(`Failed to send to ${sub.chatId}: ${e.message}`);
      }
    }
  }

  // ──────────────────────────────────────────
  // BROADCAST: custom message
  // ──────────────────────────────────────────
  async broadcast(message: string) {
    if (!this.bot) return;
    const subscribers = await this.prisma.telegramSubscription.findMany({ where: { isActive: true } });
    for (const sub of subscribers) {
      try {
        await this.bot.telegram.sendMessage(sub.chatId, message, { parse_mode: 'HTML' });
      } catch (e) {
        this.logger.warn(`Broadcast failed to ${sub.chatId}`);
      }
    }
  }

  // ──────────────────────────────────────────
  // HELPERS: Report builders
  // ──────────────────────────────────────────
  private async buildTodaySummary(): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const records = await this.prisma.attendanceRecord.findMany({
      where: { workDate: new Date(today) },
      include: { employee: { include: { department: true } } },
    });

    const present = records.filter(r => ['PRESENT', 'LATE', 'LATE_EARLY', 'EARLY_LEAVE'].includes(r.status));
    const absent = records.filter(r => r.status === 'ABSENT');
    const late = records.filter(r => ['LATE', 'LATE_EARLY'].includes(r.status));

    return (
      `📊 <b>Bugungi davomat (${today})</b>\n\n` +
      `✅ Keldi: <b>${present.length}</b>\n` +
      `❌ Kelmadi: <b>${absent.length}</b>\n` +
      `⚠️ Kechikdi: <b>${late.length}</b>\n\n` +
      `Jami qaydlar: ${records.length}`
    );
  }

  private async buildAbsentList(): Promise<string> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const absent = await this.prisma.attendanceRecord.findMany({
      where: { workDate: today, status: 'ABSENT' },
      include: { employee: { include: { department: true } } },
    });

    if (!absent.length) return '✅ Bugun hamma kelgan!';

    const list = absent
      .map((a, i) => `${i + 1}. ${a.employee.fullName} — ${a.employee.department.name}`)
      .join('\n');

    return `❌ <b>Kelmagan hodimlar (${today.toLocaleDateString('uz-UZ')})</b>\n\n${list}`;
  }

  private async buildWeeklyReport(): Promise<string> {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1);
    weekStart.setHours(0, 0, 0, 0);

    const stats = await this.prisma.weeklyAttendanceStat.findMany({
      where: {
        weekStart,
        OR: [
          { totalLateMin: { gt: 0 } },
          { totalEarlyMin: { gt: 0 } },
          { daysAbsent: { gt: 0 } },
        ],
      },
      include: { employee: { include: { department: true } } },
      orderBy: { totalLateMin: 'desc' },
      take: 20,
    });

    if (!stats.length) return '✅ Bu hafta davomati yaxshi!';

    const list = stats
      .map((s, i) => {
        const deduct = Number(s.deductionAmount) > 0 ? ` | 💰 -${Math.round(Number(s.deductionAmount)).toLocaleString()} so'm` : '';
        return `${i + 1}. <b>${s.employee.fullName}</b>\n   ⏱ ${s.totalLateMin} min kech | 🚶 ${s.totalEarlyMin} min erta${deduct}`;
      })
      .join('\n\n');

    return `📈 <b>Haftalik hisobot</b>\n\n${list}`;
  }

  private async buildMonthlyReport(month: number, year: number): Promise<string> {
    const payrolls = await this.prisma.payrollRecord.findMany({
      where: { month, year },
      include: { employee: { include: { department: true } } },
      orderBy: { netSalary: 'desc' },
      take: 30,
    });

    if (!payrolls.length) return `📋 ${month}/${year} uchun maosh hisoblari yo'q`;

    const totalNet = payrolls.reduce((s, p) => s + Number(p.netSalary), 0);
    const totalDeductions = payrolls.reduce(
      (s, p) => s + Number(p.lateDeduction) + Number(p.absenceDeduction) + Number(p.earlyLeaveDeduction),
      0,
    );

    return (
      `💰 <b>Oylik maosh — ${month}/${year}</b>\n\n` +
      `👥 Hodimlar soni: ${payrolls.length}\n` +
      `💵 Jami net maosh: <b>${Math.round(totalNet).toLocaleString()} so'm</b>\n` +
      `📉 Jami kesimlar: ${Math.round(totalDeductions).toLocaleString()} so'm\n\n` +
      `<i>Batafsil ma'lumot uchun tizimga kiring</i>`
    );
  }
}
