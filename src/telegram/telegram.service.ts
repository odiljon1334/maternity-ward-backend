import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Telegraf, Markup } from 'telegraf';
import * as fs from 'fs';
import * as path from 'path';
import { formatMinutes, isHospitalBlocked } from '../common/utils/payment.util';

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

// Max list length before truncating (Telegram 4096 char limit)
const MAX_LIST = 50;

function nowStr() {
  return new Date().toLocaleTimeString('uz-UZ', {
    hour: '2-digit', minute: '2-digit', timeZone: TZ,
  });
}

function todayDateStr() {
  return new Date().toLocaleDateString('uz-UZ', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ,
  });
}

/** Keyboard: ulashilmagan → faqat "Tizimga ulanish", ulashilgan → barcha tugmalar */
function mainKeyboard(linked: boolean) {
  if (!linked) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔗 Tizimga ulanish', 'cmd_link')],
    ]);
  }
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Bugungi davomat', 'cmd_today'),
      Markup.button.callback('⏳ Kelmaganlar', 'cmd_absent'),
    ],
    [
      Markup.button.callback('📈 Haftalik', 'cmd_week'),
      Markup.button.callback('💰 Oylik', 'cmd_month'),
    ],
    [
      Markup.button.callback('⚙️ Sozlamalar', 'cmd_settings'),
    ],
  ]);
}

/** Sub-keyboard for today detail */
function todayDetailKeyboard(hospitalId: string | null) {
  const hid = hospitalId || 'null';
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📋 Kelganlar ro\'yhati', `cmd_came:${hid}`),
      Markup.button.callback('❌ Kelmaganlar ro\'yhati', `cmd_notcame:${hid}`),
    ],
  ]);
}

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf;

  // chatId → waiting for phone number input
  private pendingLink = new Set<string>();

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

    // ── /start ────────────────────────────────────────────────────────────────
    bot.start(async (ctx) => {
      const chatId = String(ctx.chat.id);
      const username = ctx.from?.username || ctx.from?.first_name || '';
      const firstName = ctx.from?.first_name || 'Foydalanuvchi';

      // Faqat mavjud (linked) subscriptionni yangilaymiz — null yaratmaymiz
      const existing = await this.prisma.telegramSubscription.findFirst({
        where: { chatId, hospitalId: { not: null } },
        orderBy: { createdAt: 'desc' },
      });

      if (existing) {
        await this.prisma.telegramSubscription.update({
          where: { id: existing.id },
          data: { isActive: true, username },
        });
      }
      // Yangi foydalanuvchi uchun subscription yaratmaymiz — ulashganda yaratiladi

      const linked = await this.getLinkedHospital(chatId);
      const hospitalLine = linked
        ? `\n🏥 Kasalxona: <b>${linked.name}</b>`
        : '\n⚠️ Hali kasalxona ulanmagan.';

      await ctx.reply(
        `👋 Assalomu alaykum, <b>${firstName}</b>!\n\n` +
        `MaternityCare — shifoxona davomat monitoring tizimi.` +
        hospitalLine +
        `\n\nQuyidagi tugmalardan foydalaning:`,
        { parse_mode: 'HTML', ...mainKeyboard(!!linked) },
      );
    });

    // ── /stop ─────────────────────────────────────────────────────────────────
    bot.command('stop', async (ctx) => {
      await this.prisma.telegramSubscription.updateMany({
        where: { chatId: String(ctx.chat.id) },
        data: { isActive: false },
      });
      await ctx.reply('🔕 Bildirishnomalar o\'chirildi.\n/start buyrug\'i bilan qayta ulaning.');
    });

    // ── Text commands ─────────────────────────────────────────────────────────
    bot.command('today', async (ctx) => {
      const sub = await this.getSubscriber(ctx);
      const { text, keyboard } = await this.buildTodaySummary(sub?.hospitalId || null);
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    });

    bot.command('absent', async (ctx) => {
      const sub = await this.getSubscriber(ctx);
      await ctx.reply(await this.buildNotCheckedInList(sub?.hospitalId || null), { parse_mode: 'HTML' });
    });

    bot.command('week', async (ctx) => {
      const sub = await this.getSubscriber(ctx);
      await ctx.reply(await this.buildWeeklyReport(sub?.hospitalId || null), { parse_mode: 'HTML' });
    });

    bot.command('month', async (ctx) => {
      const sub = await this.getSubscriber(ctx);
      const now = new Date();
      await ctx.reply(
        await this.buildMonthlyReport(now.getMonth() + 1, now.getFullYear(), sub?.hospitalId || null),
        { parse_mode: 'HTML' },
      );
    });

    // ── Inline button: main actions ───────────────────────────────────────────
    bot.action('cmd_today', async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = this.chatIdFromCtx(ctx);
      const sub = await this.getSubscriberByChatId(chatId);
      const { text, keyboard } = await this.buildTodaySummary(sub?.hospitalId || null);
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    });

    bot.action('cmd_absent', async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = this.chatIdFromCtx(ctx);
      const sub = await this.getSubscriberByChatId(chatId);
      await ctx.reply(await this.buildNotCheckedInList(sub?.hospitalId || null), { parse_mode: 'HTML' });
    });

    bot.action('cmd_week', async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = this.chatIdFromCtx(ctx);
      const sub = await this.getSubscriberByChatId(chatId);
      await ctx.reply(await this.buildWeeklyReport(sub?.hospitalId || null), { parse_mode: 'HTML' });
    });

    bot.action('cmd_month', async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = this.chatIdFromCtx(ctx);
      const sub = await this.getSubscriberByChatId(chatId);
      const now = new Date();
      await ctx.reply(
        await this.buildMonthlyReport(now.getMonth() + 1, now.getFullYear(), sub?.hospitalId || null),
        { parse_mode: 'HTML' },
      );
    });

    bot.action('cmd_settings', async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = this.chatIdFromCtx(ctx);
      const linked = await this.getLinkedHospital(chatId);
      if (linked) {
        await ctx.reply(
          `⚙️ <b>Sozlamalar</b>\n\n` +
          `🏥 Ulangan kasalxona: <b>${linked.name}</b>\n\n` +
          `Kasalxonani o'zgartirish uchun /start buyrug'ini yuboring.`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🔓 Kasalxonani uzish', 'cmd_unlink')],
              [Markup.button.callback('⬅️ Orqaga', 'cmd_back')],
            ]),
          },
        );
      }
    });

    bot.action('cmd_unlink', async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = this.chatIdFromCtx(ctx);
      await this.prisma.telegramSubscription.updateMany({
        where: { chatId },
        data: { isActive: false },
      });
      await ctx.reply(
        '✅ Kasalxona ulanishi uzildi.\n\nQayta ulash uchun /start bosing.',
        { ...mainKeyboard(false) },
      );
    });

    bot.action('cmd_back', async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = this.chatIdFromCtx(ctx);
      const linked = await this.getLinkedHospital(chatId);
      await ctx.reply('🏠 Asosiy menyu:', { ...mainKeyboard(!!linked) });
    });

    bot.action('cmd_link', async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = this.chatIdFromCtx(ctx);
      this.pendingLink.add(chatId);
      await ctx.reply(
        '📱 Kasalxona tizimiga ro\'yxatdan o\'tgan <b>telefon raqamingizni</b> yuboring.\n\n' +
        'Misol: <code>+998901234567</code>',
        { parse_mode: 'HTML' },
      );
    });

    // ── Inline button: today came/not-came detail lists ───────────────────────
    bot.action(/^cmd_came:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const hospitalId = (ctx.match as RegExpMatchArray)[1] === 'null' ? null : (ctx.match as RegExpMatchArray)[1];
      await ctx.reply(await this.buildCameList(hospitalId), { parse_mode: 'HTML' });
    });

    bot.action(/^cmd_notcame:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const hospitalId = (ctx.match as RegExpMatchArray)[1] === 'null' ? null : (ctx.match as RegExpMatchArray)[1];
      await ctx.reply(await this.buildNotCheckedInList(hospitalId), { parse_mode: 'HTML' });
    });

    // ── Text: phone number for linking ────────────────────────────────────────
    bot.on('text', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const text = ctx.message.text.trim();

      if (!this.pendingLink.has(chatId)) return;

      const digits = text.replace(/\D/g, '');
      if (digits.length < 9) {
        await ctx.reply(
          '❌ Noto\'g\'ri format. Raqamni to\'liq kiriting.\nMisol: <code>+998901234567</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const last9 = digits.slice(-9);
      const employee = await this.prisma.employee.findFirst({
        where: { phone: { endsWith: last9 } },
        include: { hospital: true, user: true },
      });

      if (!employee) {
        await ctx.reply(
          `❌ <b>${text}</b> raqamli hodim tizimda topilmadi.\n\nAdministrator bilan bog\'laning.`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (!employee.hospitalId) {
        await ctx.reply('❌ Bu hodim hech qanday kasalxonaga biriktirilmagan.', { parse_mode: 'HTML' });
        return;
      }

      // Faqat DIRECTOR roli bo'lgan foydalanuvchilar ulay oladi
      if (!employee.user || employee.user.role !== 'DIRECTOR') {
        await ctx.reply(
          '⛔ <b>Kirish rad etildi</b>\n\n' +
          'Faqat tug\'ruq xona <b>direktori</b> Telegram botni ulay oladi.\n\n' +
          'Agar siz direktor bo\'lsangiz, tizim administratori bilan bog\'laning.',
          { parse_mode: 'HTML' },
        );
        return;
      }

      this.pendingLink.delete(chatId);

      const username = ctx.from?.username || ctx.from?.first_name || '';
      const existingSub = await this.prisma.telegramSubscription.findFirst({
        where: { chatId, hospitalId: employee.hospitalId },
      });

      if (existingSub) {
        await this.prisma.telegramSubscription.update({
          where: { id: existingSub.id },
          data: { isActive: true, username },
        });
      } else {
        await this.prisma.telegramSubscription.create({
          data: { chatId, username, role: 'DIRECTOR', hospitalId: employee.hospitalId, isActive: true },
        });
      }

      await ctx.reply(
        `✅ <b>${employee.hospital?.name}</b> kasalxonasiga muvaffaqiyatli ulandi!\n\n` +
        `👤 Direktor: <b>${employee.fullName}</b>\n\n` +
        `Endi real vaqtda davomat xabarlari yuboriladi. 🎉`,
        { parse_mode: 'HTML', ...mainKeyboard(true) },
      );
    });
  }

  // ─── helpers ────────────────────────────────────────────────────────────────
  private chatIdFromCtx(ctx: any): string {
    return String(ctx.chat?.id || ctx.from?.id);
  }

  private async getLinkedHospital(chatId: string) {
    const sub = await this.prisma.telegramSubscription.findFirst({
      where: { chatId, isActive: true, hospitalId: { not: null } },
      include: { hospital: true },
      orderBy: { createdAt: 'desc' },
    });
    return sub?.hospital || null;
  }

  private async getSubscriber(ctx: any) {
    return this.getSubscriberByChatId(String(ctx.chat.id));
  }

  private async getSubscriberByChatId(chatId: string) {
    return this.prisma.telegramSubscription.findFirst({
      where: { chatId, isActive: true, hospitalId: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ──────────────────────────────────────────
  // NOTIFY: hodim keldi/ketdi — RASM BILAN
  // ──────────────────────────────────────────
  async notifyAttendance(
    employee: any,
    action: string,   // TerminalEventType yoki 'CHECK_IN' | 'CHECK_OUT'
    attendance: any,
    snapshotBuffer?: Buffer,
  ) {
    if (!this.bot) return;

    // Kasalxona to'lovi OVERDUE bo'lsa — Telegram xabar yuborilmaydi
    if (await isHospitalBlocked(this.prisma, employee.hospitalId)) {
      this.logger.warn(`Hospital ${employee.hospitalId} blocked — Telegram notification skipped`);
      return;
    }

    // Faqat shu kasalxonaga ulangan subscriberlar — null hospitalId'ga yubormaymiz
    const subscribers = await this.prisma.telegramSubscription.findMany({
      where: {
        isActive: true,
        hospitalId: employee.hospitalId,
      },
    });
    if (!subscribers.length) return;

    const checkTime = action === 'CHECK_IN' ? attendance.checkIn : attendance.checkOut;
    const timeStr = new Date(checkTime).toLocaleTimeString('uz-UZ', {
      hour: '2-digit', minute: '2-digit', timeZone: TZ,
    });

    let emoji = '✅';
    let actionText = 'KELDI';
    let extra = '';

    if (action === 'CHECK_IN') {
      if (attendance.lateMinutes > 0) {
        emoji = '⚠️';
        extra = `\n⏱ <b>${formatMinutes(attendance.lateMinutes)} kechikdi</b>`;
      }
    } else {
      emoji = '🚶';
      actionText = 'KETDI';
      if (attendance.earlyLeaveMin > 0) {
        extra = `\n⚡ <b>${formatMinutes(attendance.earlyLeaveMin)} erta ketdi</b>`;
      } else if (attendance.overtimeMinutes > 0) {
        extra = `\n⭐ +${formatMinutes(attendance.overtimeMinutes)} overtime`;
      }
    }

    const caption =
      `${emoji} <b>${employee.fullName}</b> ${actionText}\n` +
      `🕐 Vaqt: <b>${timeStr}</b>\n` +
      `🏥 Kasalxona: ${employee.hospital?.name || '—'}\n` +
      `🏢 Bo'lim: ${employee.department?.name || '—'}\n` +
      `💼 Lavozim: ${employee.position?.name || '—'}` +
      extra;

    // 1-ustuvorlik: terminal snapshot (real-time yuz rasmi)
    // 2-ustuvorlik: DB dagi saqlab qo'yilgan rasm
    let photoBuffer: Buffer | null = snapshotBuffer || null;
    if (!photoBuffer && employee.photoUrl) {
      const uploadDir = process.env.UPLOAD_DIR || './uploads';
      const filename = (employee.photoUrl as string).replace(/^\/uploads\//, '');
      const filePath = path.join(uploadDir, filename);
      if (fs.existsSync(filePath)) {
        try { photoBuffer = fs.readFileSync(filePath); } catch { /* skip */ }
      }
    }

    const photoSource = photoBuffer
      ? { source: photoBuffer, filename: snapshotBuffer ? 'snapshot.jpg' : 'photo.jpg' }
      : null;

    for (const sub of subscribers) {
      try {
        if (photoSource) {
          await this.bot.telegram.sendPhoto(
            sub.chatId,
            photoSource,
            { caption, parse_mode: 'HTML' },
          );
        } else {
          await this.bot.telegram.sendMessage(sub.chatId, caption, { parse_mode: 'HTML' });
        }
      } catch (e) {
        this.logger.warn(`Failed to send to ${sub.chatId}: ${e.message}`);
      }
    }
  }

  // ──────────────────────────────────────────
  // BROADCAST
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

  async sendToChat(chatId: string, message: string) {
    if (!this.bot) return;
    await this.bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
  }

  async broadcastToHospital(hospitalId: string | null, message: string) {
    if (!this.bot) return;
    const subscribers = await this.prisma.telegramSubscription.findMany({
      where: {
        isActive: true,
        OR: [
          { hospitalId },
          { hospitalId: null },
        ],
      },
    });
    for (const sub of subscribers) {
      try {
        await this.bot.telegram.sendMessage(sub.chatId, message, { parse_mode: 'HTML' });
      } catch (e) {
        this.logger.warn(`broadcastToHospital failed to ${sub.chatId}`);
      }
    }
  }

  // ──────────────────────────────────────────
  // HELPERS — report builders
  // ──────────────────────────────────────────

  /**
   * Bugungi davomat xulosasi + "Kelganlar / Kelmaganlar" tugmalari
   */
  private async buildTodaySummary(
    hospitalId: string | null,
  ): Promise<{ text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> }> {
    const todayStart = this.todayStart();
    const dateLabel = todayDateStr();
    const timeLabel = nowStr();

    const empWhere: any = { firedAt: null };
    if (hospitalId) empWhere.hospitalId = hospitalId;

    // Rejalashtirilgan bugun (schedule bo'lsa)
    const schedWhere: any = { date: todayStart, status: 'WORKING' };
    if (hospitalId) schedWhere.employee = { hospitalId };
    const scheduled = await this.prisma.schedule.findMany({
      where: schedWhere,
      select: { employeeId: true },
    });

    // Check-in qilganlar (bugun)
    const attWhere: any = { workDate: todayStart, checkIn: { not: null } };
    if (hospitalId) attWhere.employee = { hospitalId };
    const attendances = await this.prisma.attendanceRecord.findMany({
      where: attWhere,
      select: { employeeId: true, lateMinutes: true },
    });

    let totalScheduled: number;
    let cameCount: number;
    let lateCount: number;
    let notCameCount: number;

    if (scheduled.length > 0) {
      // Schedule bor — faqat jadvalda bo'lganlarni hisoblash
      const scheduledIds = new Set(scheduled.map(s => s.employeeId));
      const cameInSchedule = attendances.filter(a => scheduledIds.has(a.employeeId));
      totalScheduled = scheduled.length;
      cameCount = cameInSchedule.length;
      lateCount = cameInSchedule.filter(a => a.lateMinutes > 0).length;
      notCameCount = totalScheduled - cameCount;
    } else {
      // Schedule yo'q — barcha xodimlar va attendanceRecord dan hisoblash
      totalScheduled = await this.prisma.employee.count({ where: empWhere });
      cameCount = attendances.length;
      lateCount = attendances.filter(a => a.lateMinutes > 0).length;
      notCameCount = totalScheduled - cameCount;
    }

    const text =
      `📊 <b>Bugungi davomat</b>\n` +
      `📅 ${dateLabel} | 🕐 ${timeLabel} holat\n\n` +
      `👥 Jami xodimlar: <b>${totalScheduled} ta</b>\n` +
      `✅ Keldi: <b>${cameCount} ta</b>\n` +
      `❌ Hali kelmagan: <b>${Math.max(0, notCameCount)} ta</b>\n` +
      `⚠️ Kechikkan: <b>${lateCount} ta</b>`;

    return { text, keyboard: todayDetailKeyboard(hospitalId) };
  }

  /**
   * Bugun kelganlar ro'yhati (ism + kelgan vaqt)
   */
  private async buildCameList(hospitalId: string | null): Promise<string> {
    const todayStart = this.todayStart();
    const dateLabel = todayDateStr();

    const attWhere: any = { workDate: todayStart, checkIn: { not: null } };
    if (hospitalId) attWhere.employee = { hospitalId };

    const records = await this.prisma.attendanceRecord.findMany({
      where: attWhere,
      include: { employee: { include: { department: true } } },
      orderBy: { checkIn: 'asc' },
    });

    // Schedule bo'lsa, faqat jadvalda bo'lganlarni ko'rsatish
    const schedWhere: any = { date: todayStart, status: 'WORKING' };
    if (hospitalId) schedWhere.employee = { hospitalId };
    const scheduled = await this.prisma.schedule.findMany({ where: schedWhere, select: { employeeId: true } });

    const came = scheduled.length > 0
      ? records.filter(r => new Set(scheduled.map(s => s.employeeId)).has(r.employeeId))
      : records;

    if (!came.length) {
      return `📋 <b>Kelganlar — ${dateLabel}</b>\n\nHali hech kim kelmagan.`;
    }

    const list = came.slice(0, MAX_LIST).map((r, i) => {
      const time = new Date(r.checkIn!).toLocaleTimeString('uz-UZ', {
        hour: '2-digit', minute: '2-digit', timeZone: TZ,
      });
      const late = r.lateMinutes > 0 ? ` ⚠️ +${r.lateMinutes} daq` : '';
      return `${i + 1}. <b>${r.employee.fullName}</b> — ${time}${late}`;
    }).join('\n');

    const tail = came.length > MAX_LIST ? `\n\n<i>...va yana ${came.length - MAX_LIST} ta</i>` : '';

    return `✅ <b>Kelganlar — ${dateLabel}</b> (${came.length} ta)\n\n${list}${tail}`;
  }

  /**
   * Bugun rejalashtirilgan, lekin hali check-in qilmaganlar
   */
  private async buildNotCheckedInList(hospitalId: string | null): Promise<string> {
    const todayStart = this.todayStart();
    const dateLabel = todayDateStr();
    const timeLabel = nowStr();

    const schedWhere: any = { date: todayStart, status: 'WORKING' };
    if (hospitalId) schedWhere.employee = { hospitalId };

    const schedules = await this.prisma.schedule.findMany({
      where: schedWhere,
      include: { employee: { include: { department: true } } },
    });

    if (!schedules.length) {
      return `📋 <b>${dateLabel}</b>\n\nBugun uchun ish grafigi topilmadi.`;
    }

    const attWhere: any = { workDate: todayStart, checkIn: { not: null } };
    if (hospitalId) attWhere.employee = { hospitalId };

    const checkedIn = await this.prisma.attendanceRecord.findMany({
      where: attWhere,
      select: { employeeId: true },
    });
    const checkedInIds = new Set(checkedIn.map(r => r.employeeId));

    const notYet = schedules.filter(s => !checkedInIds.has(s.employeeId));

    if (!notYet.length) {
      return `✅ <b>${dateLabel}</b>\n\nBarcha ${schedules.length} ta rejalashtirilgan hodim keldi!`;
    }

    const list = notYet.slice(0, MAX_LIST).map((s, i) =>
      `${i + 1}. <b>${s.employee.fullName}</b> — ${s.employee.department?.name || '—'} ❌`,
    ).join('\n');

    const tail = notYet.length > MAX_LIST ? `\n\n<i>...va yana ${notYet.length - MAX_LIST} ta</i>` : '';

    return (
      `⏳ <b>Hali kelmaganlar — ${dateLabel}</b>\n` +
      `🕐 ${timeLabel} holat\n\n` +
      `${list}${tail}\n\n` +
      `Jami: <b>${notYet.length} ta</b> / ${schedules.length} ta rejalashtirilgan`
    );
  }

  /**
   * Haftalik hisobot — weeklyAttendanceStat bo'lmasa, attendanceRecord dan hisoblanadi
   */
  private async buildWeeklyReport(hospitalId: string | null): Promise<string> {
    const weekStart = this.weekStart();

    const where: any = {
      weekStart,
      OR: [
        { totalLateMin: { gt: 0 } },
        { totalEarlyMin: { gt: 0 } },
        { daysAbsent: { gt: 0 } },
      ],
    };
    if (hospitalId) where.employee = { hospitalId };

    const stats = await this.prisma.weeklyAttendanceStat.findMany({
      where,
      include: { employee: { include: { department: true } } },
      orderBy: { totalLateMin: 'desc' },
      take: 20,
    });

    if (stats.length) {
      const list = stats.map((s, i) => {
        const deduct = Number(s.deductionAmount) > 0
          ? ` | 💰 -${Math.round(Number(s.deductionAmount)).toLocaleString()} so'm`
          : '';
        return `${i + 1}. <b>${s.employee.fullName}</b>\n   ⏱ ${s.totalLateMin} min kech | 🚶 ${s.totalEarlyMin} min erta${deduct}`;
      }).join('\n\n');
      return `📈 <b>Haftalik hisobot</b>\n\n${list}`;
    }

    // weeklyAttendanceStat yo'q — raw recordlardan hisoblash
    const rawWhere: any = {
      workDate: { gte: weekStart },
      OR: [
        { lateMinutes: { gt: 0 } },
        { earlyLeaveMin: { gt: 0 } },
        { status: 'ABSENT' },
      ],
    };
    if (hospitalId) rawWhere.employee = { hospitalId };

    const raw = await this.prisma.attendanceRecord.findMany({
      where: rawWhere,
      include: { employee: { include: { department: true } } },
      orderBy: { workDate: 'asc' },
    });

    if (!raw.length) {
      return `✅ <b>Haftalik hisobot</b>\n\nBu hafta hech qanday kechikish yoki sababsiz yo\'qlik qayd etilmagan.`;
    }

    // Hodim bo'yicha guruhlash
    const empMap = new Map<string, { name: string; dept: string; lateMin: number; earlyMin: number; absent: number }>();
    for (const r of raw) {
      if (!empMap.has(r.employeeId)) {
        empMap.set(r.employeeId, {
          name: r.employee.fullName,
          dept: r.employee.department?.name || '—',
          lateMin: 0, earlyMin: 0, absent: 0,
        });
      }
      const s = empMap.get(r.employeeId)!;
      s.lateMin += r.lateMinutes;
      s.earlyMin += r.earlyLeaveMin;
      if (r.status === 'ABSENT') s.absent++;
    }

    const sorted = [...empMap.values()].sort((a, b) => b.lateMin - a.lateMin).slice(0, 20);
    const weekLabel = weekStart.toLocaleDateString('uz-UZ', { day: '2-digit', month: '2-digit', timeZone: TZ });

    const list = sorted.map((s, i) => {
      const parts: string[] = [];
      if (s.lateMin > 0) parts.push(`⏱ ${s.lateMin} min kech`);
      if (s.earlyMin > 0) parts.push(`🚶 ${s.earlyMin} min erta`);
      if (s.absent > 0) parts.push(`❌ ${s.absent} kun yo'q`);
      return `${i + 1}. <b>${s.name}</b> (${s.dept})\n   ${parts.join(' | ')}`;
    }).join('\n\n');

    return `📈 <b>Haftalik hisobot</b> (${weekLabel} dan)\n\n${list}`;
  }

  private async buildMonthlyReport(month: number, year: number, hospitalId: string | null): Promise<string> {
    const where: any = { month, year };
    if (hospitalId) where.employee = { hospitalId };

    const payrolls = await this.prisma.payrollRecord.findMany({
      where,
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

  // ── date utils (Asia/Tashkent = UTC+5) ──────────────────────────────────────

  /** Bugungi kun boshlang'ich vaqti — Toshkent vaqti bo'yicha (UTC+5) */
  private todayStart(): Date {
    const TZ_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5
    const now = new Date();
    // Toshkent vaqtiga o'tkazamiz
    const tashkent = new Date(now.getTime() + TZ_OFFSET_MS);
    // Kun boshiga (UTC da 00:00 Toshkent = UTC-5 oldingi kuni)
    tashkent.setUTCHours(0, 0, 0, 0);
    // UTC ga qaytaramiz
    return new Date(tashkent.getTime() - TZ_OFFSET_MS);
  }

  /** Haftaning dushanba kunidan boshlanish vaqti — Toshkent vaqti bo'yicha */
  private weekStart(): Date {
    const TZ_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5
    const now = new Date();
    const tashkent = new Date(now.getTime() + TZ_OFFSET_MS);
    tashkent.setUTCHours(0, 0, 0, 0);

    // 0=Yakshanba, 1=Dushanba ... 6=Shanba
    const day = tashkent.getUTCDay();
    // Dushanbaga qaytish: Yakshanba uchun -6, qolganlar uchun -(day-1)
    const daysBack = day === 0 ? 6 : day - 1;
    tashkent.setUTCDate(tashkent.getUTCDate() - daysBack);

    return new Date(tashkent.getTime() - TZ_OFFSET_MS);
  }
}
