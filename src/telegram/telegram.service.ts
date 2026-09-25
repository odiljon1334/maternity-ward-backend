import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Telegraf, Markup, type Context } from 'telegraf';
import type { NewInvoiceParameters } from 'telegraf/typings/telegram-types';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { formatMinutes, isHospitalBlocked } from '../common/utils/payment.util';
import { getStaffPricing } from '../common/utils/pricing.util';
import { SubscriptionBillingService } from '../payments/subscription-billing.service';
import { coverageLabel } from '../payments/billing.util';
import { DateUtil } from '../common/utils/date.util';
import {
  BotLinkCandidate,
  LINK_PAYLOAD_PREFIX,
  TelegramAccessService,
} from './telegram-access.service';
import {
  checkedInText,
  checkedOutText,
  checkinReminderText,
  checkoutDueText,
  esc,
  linkedText,
} from './employee-messages';

const TZ = process.env.TIMEZONE || 'Asia/Tashkent';

// ─── Yandex Static Maps ───────────────────────────────────────────────────────
// API key .env da YANDEX_MAPS_KEY=... sifatida saqlang
// Key bo'lmasa ham asosiy map ishlaydi (limitlangan)
const YANDEX_KEY = process.env.YANDEX_MAPS_KEY || '';

/**
 * Yandex Static Maps URL — map rasmini olish uchun
 * @param lat, lng — koordinatalar
 * @param markerColor — 'rd' (red), 'gn' (green), 'bl' (blue)
 */
function yandexStaticMapUrl(
  lat: number,
  lng: number,
  markerColor = 'rd',
): string {
  const key = YANDEX_KEY ? `&apikey=${YANDEX_KEY}` : '';
  return (
    `https://static-maps.yandex.ru/1.x/?lang=uz_UZ` +
    `&ll=${lng},${lat}&z=16&l=map&size=450,300` +
    `&pt=${lng},${lat},pm2${markerColor}m${key}`
  );
}

/** Yandex Maps havolasi (interaktiv) */
function yandexMapLink(lat: number, lng: number): string {
  return `https://yandex.uz/maps/?pt=${lng},${lat}&z=16&l=map`;
}

/**
 * Haversine formulasi — ikkita GPS nuqta orasidagi masofani hisoblab beradi (metr)
 */
function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000; // Yer radiusi metrda
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Yandex Static Maps URL dan rasm buffer ni yuklab olish */
function fetchImageBuffer(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => resolve(null));
      })
      .on('error', () => resolve(null));
  });
}

// Max list length before truncating (Telegram 4096 char limit)
const MAX_LIST = 50;

function nowStr() {
  return new Date().toLocaleTimeString('uz-UZ', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  });
}

function todayDateStr() {
  return new Date().toLocaleDateString('uz-UZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: TZ,
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
    [Markup.button.callback('💳 Obuna', 'cmd_subscription')],
    [Markup.button.callback('⚙️ Sozlamalar', 'cmd_settings')],
  ]);
}

/** Oddiy xodim (shaxsiy ulanish) menyusi */
function employeeKeyboard(remindersOn: boolean) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📅 Bugungi smenam', 'cmd_my_today')],
    [
      Markup.button.callback(
        remindersOn ? "🔕 Eslatmalarni o'chirish" : '🔔 Eslatmalarni yoqish',
        'cmd_my_reminders',
      ),
    ],
    [Markup.button.callback('🔓 Botdan uzish', 'cmd_my_unlink')],
  ]);
}

/** Telegram raqamni o'zi tasdiqlab yuboradigan tugma (faqat shaxsiy chatda). */
function contactKeyboard() {
  return Markup.keyboard([
    [Markup.button.contactRequest('📱 Raqamni ulashish')],
  ])
    .oneTime()
    .resize();
}

const LINK_INSTRUCTIONS =
  '📱 Ulanish uchun pastdagi <b>«📱 Raqamni ulashish»</b> tugmasini bosing — ' +
  "Telegram raqamingizni o'zi tasdiqlab yuboradi.\n\n" +
  '👤 <b>Xodimlar</b>: raqamingiz muassasa bazasidagi raqamga mos kelishi kerak. ' +
  "Eng oson yo'l — StaffPlusPRO ilovasida «Ko'proq → Telegram bot → Ulash».\n" +
  "👔 <b>Rahbarlar</b>: hisobotlar uchun «Telegram bot ruxsati» ro'yxatida bo'lishingiz kerak.";

/** Sub-keyboard for today detail.
 *  XAVFSIZLIK: callback data'da hospitalId YO'Q — handler shifoxonani doim
 *  chat obunasidan oladi (callback data'ni mijoz soxtalashtirishi mumkin). */
function todayDetailKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📋 Kelganlar ro'yhati", 'cmd_came'),
      Markup.button.callback("❌ Kelmaganlar ro'yhati", 'cmd_notcame'),
    ],
  ]);
}

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf;
  private botUsername: string | null = null;

  // Bir raqam bir nechta muassasadagi ruxsatli xodimga mos kelsa — tanlov
  // kutilmoqda. Callback'da faqat INDEX yuboriladi, ID emas.
  private pendingChoices = new Map<
    string,
    { candidates: BotLinkCandidate[]; expiresAt: number }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly access: TelegramAccessService,
    private readonly billing: SubscriptionBillingService,
  ) {}

  async onModuleInit() {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || token === 'your_telegram_bot_token') {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set — bot disabled');
      return;
    }

    this.bot = new Telegraf(token);
    // To'lov tokeni formati: <provayder_id>:TEST|LIVE:<...> (BotFather → Payments)
    const payToken = this.config.get<string>('TELEGRAM_PAYMENT_TOKEN');
    if (payToken) {
      const m = /^\d+:(TEST|LIVE):\S+$/.exec(payToken.trim());
      if (!m) {
        this.logger.warn(
          "TELEGRAM_PAYMENT_TOKEN formati noto'g'ri (kutilgan: 123456:LIVE:xxxx) — bot to'lovlari ishlamaydi",
        );
      } else if (m[1] === 'TEST') {
        this.logger.warn(
          'TELEGRAM_PAYMENT_TOKEN — TEST rejimi: haqiqiy pul yechilmaydi',
        );
      }
    }
    this.setupCommands();
    // Mobil ilova ulanish havolasi (t.me/<username>?start=...) uchun
    this.botUsername =
      (await this.bot.telegram.getMe().catch(() => null))?.username ??
      this.config.get<string>('TELEGRAM_BOT_USERNAME') ??
      null;
    await this.bot.telegram
      .setMyCommands([
        {
          command: 'start',
          description: '🏠 Botni ishga tushirish / Asosiy menyu',
        },
        { command: 'bugun', description: '📊 Bugungi davomat xulosasi' },
        { command: 'kelmaganlar', description: '⏳ Hali kelmagan hodimlar' },
        {
          command: 'haftalik',
          description: '📈 Haftalik kechikishlar hisoboti',
        },
        { command: 'oylik', description: '💰 Oylik maosh hisoboti' },
        { command: 'stop', description: "🔕 Bildirishnomalarni o'chirish" },
      ])
      .catch(() => {});

    await this.registerWebhook(
      'TELEGRAM_WEBHOOK_URL',
      'TELEGRAM_WEBHOOK_SECRET',
    );

    this.logger.log('Telegram bot started (webhook mode)');
  }

  /**
   * URL va secret ikkalasi ENV'da bo'lsa, webhookni Telegram API orqali
   * atomik yangilaydi. Birortasi yo'q bo'lsa, avvalgi production webhook
   * sozlamasiga mutlaqo tegmaymiz — deploy vaqtida bildirishnomalar uzilmaydi.
   */
  private async registerWebhook(urlKey: string, secretKey: string) {
    const url = this.config.get<string>(urlKey)?.trim();
    const secret = this.config.get<string>(secretKey)?.trim();
    if (!url || !secret) {
      this.logger.warn(
        `${urlKey}/${secretKey} sozlanmagan — mavjud Telegram webhook o'zgartirilmadi`,
      );
      return;
    }

    try {
      await this.bot.telegram.setWebhook(url, { secret_token: secret });
      this.logger.log(
        `Telegram webhook himoyalangan holda ro'yxatdan o'tdi: ${url}`,
      );
    } catch (error) {
      // Eski webhook Telegram tomonida saqlanib qoladi; bitta API xatosi
      // botni yoki Nest startup'ini to'xtatmasligi kerak.
      this.logger.error(
        `Telegram webhook ro'yxatdan o'tmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private setupCommands() {
    const bot = this.bot;

    // ── /start ────────────────────────────────────────────────────────────────
    bot.start(async (ctx) => {
      const chatId = String(ctx.chat.id);
      const username = ctx.from?.username || ctx.from?.first_name || '';
      const firstName = ctx.from?.first_name || 'Foydalanuvchi';

      // Mobil ilovadan kelgan bir martalik havola: /start L_<token>
      const payload = String((ctx as any).payload ?? '').trim();
      if (payload.startsWith(LINK_PAYLOAD_PREFIX)) {
        if (ctx.chat.type !== 'private') return;
        await this.handleAppLink(
          ctx,
          payload.slice(LINK_PAYLOAD_PREFIX.length),
        );
        return;
      }

      // Faqat FAOL subscription username ni yangilaymiz.
      // isActive=false bo'lgan (o'chirilgan) subscriptionni QAYTA TIKLAMAYMIZ —
      // foydalanuvchi telefon raqamini qayta kiritishi shart.
      const activeExisting = await this.prisma.telegramSubscription.findFirst({
        where: { chatId, hospitalId: { not: null }, isActive: true },
        orderBy: { createdAt: 'desc' },
      });

      if (activeExisting) {
        await this.prisma.telegramSubscription.update({
          where: { id: activeExisting.id },
          data: { username }, // faqat username, isActive TEGINMAYMİZ
        });
      }

      const linked = await this.getLinkedHospital(chatId);
      if (!linked) {
        // Rahbar emas, lekin xodim sifatida ulangan — xodim menyusi
        const personal = await this.access.personalLinksOf(chatId);
        if (personal.length) {
          await ctx.reply(
            `👋 Assalomu alaykum, <b>${esc(firstName)}</b>!\n\n` +
              `StaffPlusPRO — sizning ish kuningiz yordamchisi.\n` +
              personal
                .map((p) => `🏥 ${esc(p.hospital?.name ?? '—')}`)
                .join('\n'),
            {
              parse_mode: 'HTML',
              ...employeeKeyboard(personal.some((p) => p.telegramReminders)),
            },
          );
          return;
        }
      }
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
      await this.access.setReminders({ chatId: String(ctx.chat.id) }, false);
      await ctx.reply(
        "🔕 Bildirishnomalar o'chirildi.\n/start buyrug'i bilan qayta ulaning.",
      );
    });

    // ── Text commands ─────────────────────────────────────────────────────────
    // ── /today | /bugun ───────────────────────────────────────────────────────
    const handleToday = async (ctx: any) => {
      const hospitalId = await this.requireLinkedHospitalId(ctx);
      if (!hospitalId) return;
      const { text, keyboard } = await this.buildTodaySummary(hospitalId);
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    };
    bot.command('today', handleToday);
    bot.command('bugun', handleToday);

    // ── /absent | /kechikganlar | /kelmaganlar ────────────────────────────────
    const handleAbsent = async (ctx: any) => {
      const hospitalId = await this.requireLinkedHospitalId(ctx);
      if (!hospitalId) return;
      await ctx.reply(await this.buildNotCheckedInList(hospitalId), {
        parse_mode: 'HTML',
      });
    };
    bot.command('absent', handleAbsent);
    bot.command('kechikganlar', handleAbsent);
    bot.command('kelmaganlar', handleAbsent);

    // ── /week | /haftalik ─────────────────────────────────────────────────────
    const handleWeek = async (ctx: any) => {
      const hospitalId = await this.requireLinkedHospitalId(ctx);
      if (!hospitalId) return;
      await ctx.reply(await this.buildWeeklyReport(hospitalId), {
        parse_mode: 'HTML',
      });
    };
    bot.command('week', handleWeek);
    bot.command('haftalik', handleWeek);

    // ── /month | /oylik | /hisobot ────────────────────────────────────────────
    const handleMonth = async (ctx: any) => {
      const hospitalId = await this.requireLinkedHospitalId(ctx);
      if (!hospitalId) return;
      const now = new Date();
      await ctx.reply(
        await this.buildMonthlyReport(
          now.getMonth() + 1,
          now.getFullYear(),
          hospitalId,
        ),
        { parse_mode: 'HTML' },
      );
    };
    bot.command('month', handleMonth);
    bot.command('oylik', handleMonth);
    bot.command('hisobot', handleMonth);

    // ── /yordam | /help ───────────────────────────────────────────────────────
    const handleHelp = async (ctx: any) => {
      await ctx.reply(
        `📖 <b>Mavjud buyruqlar:</b>\n\n` +
          `/bugun — Bugungi davomat xulosasi\n` +
          `/kelmaganlar — Bugun hali kelmagan hodimlar\n` +
          `/haftalik — Haftalik hisobot\n` +
          `/oylik — Oylik maosh hisoboti\n` +
          `/hisobot — Oylik hisobot\n` +
          `/stop — Bildirishnomalarni o'chirish\n\n` +
          `Yoki quyidagi tugmalardan foydalaning 👇`,
        { parse_mode: 'HTML' },
      );
    };
    bot.command('yordam', handleHelp);
    bot.command('help', handleHelp);

    // ── Inline button: main actions ───────────────────────────────────────────
    bot.action('cmd_today', async (ctx) => {
      await ctx.answerCbQuery();
      const hospitalId = await this.requireLinkedHospitalId(ctx);
      if (!hospitalId) return;
      const { text, keyboard } = await this.buildTodaySummary(hospitalId);
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    });

    bot.action('cmd_absent', async (ctx) => {
      await ctx.answerCbQuery();
      const hospitalId = await this.requireLinkedHospitalId(ctx);
      if (!hospitalId) return;
      await ctx.reply(await this.buildNotCheckedInList(hospitalId), {
        parse_mode: 'HTML',
      });
    });

    bot.action('cmd_week', async (ctx) => {
      await ctx.answerCbQuery();
      const hospitalId = await this.requireLinkedHospitalId(ctx);
      if (!hospitalId) return;
      await ctx.reply(await this.buildWeeklyReport(hospitalId), {
        parse_mode: 'HTML',
      });
    });

    bot.action('cmd_month', async (ctx) => {
      await ctx.answerCbQuery();
      const hospitalId = await this.requireLinkedHospitalId(ctx);
      if (!hospitalId) return;
      const now = new Date();
      await ctx.reply(
        await this.buildMonthlyReport(
          now.getMonth() + 1,
          now.getFullYear(),
          hospitalId,
        ),
        { parse_mode: 'HTML' },
      );
    });

    // ── OBUNA: holat ko'rsatish ───────────────────────────────────────────────
    bot.action('cmd_subscription', async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = this.chatIdFromCtx(ctx);
      const linked = await this.getLinkedHospital(chatId);
      if (!linked) return ctx.reply('⚠️ Avval kasalxonani ulang.');

      const empCount = await this.prisma.employee.count({
        where: { hospitalId: linked.id, firedAt: null },
      });

      // Obuna holati — to'lovlar qoplamasi bo'yicha (qo'lda kiritilgan va
      // Telegram to'lovlari birga, yillik to'lov 12 oyni qoplaydi)
      const pricing = getStaffPricing(empCount);
      const state = await this.billing.getState(linked.id);
      const fmtDate = (d: Date) =>
        d.toLocaleDateString('uz-UZ', { timeZone: 'Asia/Tashkent' });
      const subLine =
        state.paidThrough && state.paidThrough.getTime() >= Date.now()
          ? `✅ <b>Obuna to'langan:</b> ${fmtDate(state.paidThrough)} gacha`
          : state.overduePeriods.length
            ? `⚠️ <b>To'lanmagan oylar:</b> ${state.overduePeriods.map((p) => coverageLabel(p, 1)).join(', ')}`
            : `❌ <b>Joriy oy hali to'lanmagan</b>`;
      const nextLine = `🗓 Keyingi to'lov: <b>${coverageLabel(state.nextPeriod, 1)}</b> dan boshlab`;

      if (pricing.negotiated) {
        await ctx.reply(
          `💳 <b>Obuna boshqaruvi</b>\n\n` +
            `🏥 ${linked.name}\n` +
            `👥 Faol xodimlar: <b>${empCount} nafar</b>\n\n` +
            `${subLine}\n\n` +
            `📌 <b>Tarif:</b> 500 nafardan ortiq xodim uchun narx individual ` +
            `kelishiladi. Iltimos, operator bilan bog'laning: +998 95 577 54 54`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('⬅️ Orqaga', 'cmd_back')],
            ]),
          },
        );
        return;
      }

      const monthlyTotal = pricing.monthlyTotal!;
      const annualTotal = pricing.annualTotal!;
      const saving = monthlyTotal * 12 - annualTotal;
      const breakdownLine = pricing.isFlat
        ? `📅 Oylik: <b>${monthlyTotal.toLocaleString()} so'm</b> (FIKS narx)\n` +
          `📆 Yillik: <b>${annualTotal.toLocaleString()} so'm</b>\n`
        : `📅 Oylik: ${empCount} × ${pricing.perEmployeeMonthly!.toLocaleString()} = <b>${monthlyTotal.toLocaleString()} so'm</b>\n` +
          `📆 Yillik: ${empCount} × ${pricing.perEmployeeAnnual!.toLocaleString()} = <b>${annualTotal.toLocaleString()} so'm</b>\n`;

      await ctx.reply(
        `💳 <b>Obuna boshqaruvi</b>\n\n` +
          `🏥 ${linked.name}\n` +
          `👥 Faol xodimlar: <b>${empCount} nafar</b>\n\n` +
          `${subLine}\n${nextLine}\n\n` +
          `📌 <b>Tarif (${pricing.planLabel}):</b>\n` +
          breakdownLine +
          `   <i>(${saving.toLocaleString()} so'm tejaysiz)</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(
                `📅 Oylik — ${monthlyTotal.toLocaleString()} so'm`,
                `pay_monthly:${linked.id}`,
              ),
            ],
            [
              Markup.button.callback(
                `📆 Yillik — ${annualTotal.toLocaleString()} so'm`,
                `pay_annual:${linked.id}`,
              ),
            ],
            [Markup.button.callback('⬅️ Orqaga', 'cmd_back')],
          ]),
        },
      );
    });

    // ── TO'LOV: invoice yuborish ─────────────────────────────────────────────
    const sendSubscriptionInvoice = async (
      ctx: any,
      hospitalId: string,
      type: 'MONTHLY' | 'ANNUAL',
    ) => {
      const paymentToken = this.config.get<string>('TELEGRAM_PAYMENT_TOKEN');
      if (!paymentToken)
        return ctx.reply(
          "⚠️ To'lov tizimi sozlanmagan. Admin bilan bog'laning.",
        );

      const hospital = await this.prisma.hospital.findUnique({
        where: { id: hospitalId },
        select: { name: true },
      });
      if (!hospital) return;

      // Summa, qoplanadigan oylar va invoys yozuvi — serverda (SubscriptionBillingService)
      const inv = await this.billing.createInvoice(
        hospitalId,
        this.chatIdFromCtx(ctx),
        type,
      );
      if ('reason' in inv) {
        if (inv.reason === 'NEGOTIATED') {
          return ctx.reply(
            '⚠️ 500 nafardan ortiq xodim uchun narx individual kelishiladi. ' +
              "Iltimos, operator bilan bog'laning: +998 95 577 54 54",
          );
        }
        return ctx.reply(
          "⚠️ Hozircha to'lov yaratib bo'lmadi. Operator bilan bog'laning: +998 95 577 54 54",
        );
      }

      const { pricing } = inv;
      const isMonthly = type === 'MONTHLY';
      const title = isMonthly ? '📅 Oylik obuna' : '📆 Yillik obuna';
      const perUnitLabel = isMonthly
        ? pricing.perEmployeeMonthly
        : pricing.perEmployeeAnnual;
      const descriptionLine =
        `${hospital.name} — ${inv.coverage}\n` +
        (pricing.isFlat
          ? `📦 ${pricing.planLabel} — FIKS narx`
          : `👥 ${inv.employeeCount} nafar xodim × ${perUnitLabel!.toLocaleString()} so'm`);

      try {
        // Telegraf v4: sendInvoice BITTA obyekt qabul qiladi. Ilgari eski
        // (v3) pozitsion argumentlar bilan chaqirilardi — Telegram'ga `title`
        // umuman bormasdi: "400: parameter "title" is required".
        const invoice: NewInvoiceParameters = {
          title,
          description: descriptionLine,
          payload: inv.payload, // "inv:<id>" — summa/muddat serverdagi yozuvdan olinadi
          provider_token: paymentToken,
          currency: 'UZS',
          prices: [
            {
              label: inv.coverage,
              // Telegram eng kichik birlikda kutadi: UZS exp=2 → so'm × 100
              amount: inv.amountMinor,
            },
          ],
          photo_url: 'https://clinicuk24.com/icons/icon-192x192.png',
          need_name: false,
          need_phone_number: false,
        };
        await (ctx as Context).replyWithInvoice(invoice);
      } catch (e) {
        // Masalan summa to'lov tizimi chegarasidan katta — invoys ochiq qolmasin
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(
          `Invoys yuborilmadi (invoice=${inv.invoiceId}, ${inv.amountSom} so'm): ${msg}` +
            (msg.includes('PAYMENT_PROVIDER_INVALID')
              ? " — TELEGRAM_PAYMENT_TOKEN shu botga tegishli emas yoki bekor qilingan. BotFather → HR bot (TELEGRAM_BOT_TOKEN egasi) → Payments'dan olingan tokenni qo'ying."
              : ''),
        );
        await this.billing.cancelInvoice(inv.invoiceId).catch(() => undefined);
        await ctx.reply(
          "⚠️ To'lov oynasini ochib bo'lmadi. Iltimos, operator bilan bog'laning: +998 95 577 54 54",
        );
      }
    };

    bot.action(/^pay_(monthly|annual)(?::(.+))?$/, async (ctx) => {
      await ctx.answerCbQuery();
      const type = ctx.match[1].toUpperCase() as 'MONTHLY' | 'ANNUAL';
      // Tugmadagi hospitalId — foydalanuvchi ko'rgan "Obuna" xabaridagi
      // muassasa (chat bir nechta muassasaga ulangan bo'lishi mumkin).
      // XAVFSIZLIK: unga faqat shu chatning FAOL ulanishi bo'lsa ishoniladi;
      // aks holda (eski tugma) — chatning asosiy muassasasi.
      const requested = ctx.match[2];
      let hospitalId: string | null = null;
      if (requested) {
        const sub = await this.prisma.telegramSubscription.findFirst({
          where: {
            chatId: this.chatIdFromCtx(ctx),
            hospitalId: requested,
            isActive: true,
          },
          select: { hospitalId: true },
        });
        hospitalId = sub?.hospitalId ?? null;
      }
      hospitalId ??= await this.requireLinkedHospitalId(ctx);
      if (!hospitalId) return;
      await sendSubscriptionInvoice(ctx, hospitalId, type);
    });

    // ── PRE-CHECKOUT: invoys va summani tekshirish ───────────────────────────
    // Ilgari har qanday so'rov tekshiruvsiz tasdiqlanardi.
    bot.on('pre_checkout_query', async (ctx) => {
      const q = ctx.preCheckoutQuery;
      try {
        const res = await this.billing.validatePreCheckout({
          payload: q.invoice_payload,
          currency: q.currency,
          totalAmount: q.total_amount,
        });
        if ('message' in res)
          await ctx.answerPreCheckoutQuery(false, res.message);
        else await ctx.answerPreCheckoutQuery(true);
      } catch (e) {
        this.logger.error(
          `pre_checkout tekshiruvi xatosi: ${e instanceof Error ? e.message : String(e)}`,
        );
        await ctx.answerPreCheckoutQuery(
          false,
          "Texnik xatolik. Birozdan so'ng qayta urinib ko'ring.",
        );
      }
    });

    // ── MUVAFFAQIYATLI TO'LOV (idempotent) ───────────────────────────────────
    bot.on('message', async (ctx: any, next: () => Promise<void>) => {
      const payment = ctx.message?.successful_payment;
      if (!payment) return next(); // text va boshqa xabarlarni on('text') ga o'tkazish

      let result: Awaited<
        ReturnType<SubscriptionBillingService['recordSuccessfulPayment']>
      >;
      try {
        result = await this.billing.recordSuccessfulPayment({
          payload: payment.invoice_payload,
          currency: payment.currency,
          totalAmount: payment.total_amount,
          telegramChargeId: payment.telegram_payment_charge_id,
          providerChargeId: payment.provider_payment_charge_id,
          chatId: String(ctx.chat.id),
          payerName: ctx.from?.first_name || 'Foydalanuvchi',
        });
      } catch (e) {
        // Pul yechilgan, lekin yozib bo'lmadi. Xom ma'lumot log'da qoladi
        // (qayta urinishlar ham muvaffaqiyatsiz bo'lsa, operator shundan
        // qo'lda kiritadi). Xato qayta tashlanadi — webhook 500 qaytaradi va
        // Telegram yangilanishni qayta yuboradi; yozish idempotent
        // (telegramPaymentId UNIQUE), shuning uchun ikki marta yozilmaydi.
        this.logger.error(
          `TO'LOV YOZILMADI: chat=${ctx.chat?.id} charge=${payment.telegram_payment_charge_id} ` +
            `provider=${payment.provider_payment_charge_id} payload=${payment.invoice_payload} ` +
            `amount=${payment.total_amount} ${payment.currency}: ${e instanceof Error ? e.message : String(e)}`,
        );
        throw e;
      }

      if (result.status === 'UNKNOWN_INVOICE') {
        await ctx.reply(
          "✅ To'lov qabul qilindi. Hisobingizga biriktirish uchun operator siz bilan bog'lanadi: +998 95 577 54 54",
        );
        return;
      }

      const validLine = result.validUntil
        ? `📅 Amal qilish muddati: <b>${result.validUntil.toLocaleDateString('uz-UZ', { timeZone: 'Asia/Tashkent' })}</b> gacha\n`
        : '';
      await ctx.reply(
        `✅ <b>To'lov ${result.status === 'DUPLICATE' ? 'avval qabul qilingan' : 'muvaffaqiyatli'}!</b>\n\n` +
          `🏥 ${result.hospitalName}\n` +
          `💰 ${result.amountSom.toLocaleString()} so'm\n` +
          `🗓 Davr: <b>${result.coverage}</b>\n` +
          (result.employeeCount != null
            ? `👥 ${result.employeeCount} nafar xodim\n`
            : '') +
          validLine +
          `\nRahmat! 🙏`,
        { parse_mode: 'HTML', ...mainKeyboard(true) },
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

    // ── Xodim menyusi ──────────────────────────────────────────────────────
    bot.action('cmd_my_today', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply(await this.buildMyToday(this.chatIdFromCtx(ctx)), {
        parse_mode: 'HTML',
      });
    });

    bot.action('cmd_my_reminders', async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = this.chatIdFromCtx(ctx);
      const links = await this.access.personalLinksOf(chatId);
      if (!links.length) return this.sendLinkPrompt(ctx);
      const next = !links.some((l) => l.telegramReminders);
      await this.access.setReminders({ chatId }, next);
      await ctx.reply(
        next
          ? '🔔 Eslatmalar yoqildi. Ish boshlanishidan 30 daqiqa oldin xabar olasiz.'
          : "🔕 Eslatmalar o'chirildi. Kelish/ketish va so'rov natijalari ham kelmaydi.",
        { ...employeeKeyboard(next) },
      );
    });

    bot.action('cmd_my_unlink', async (ctx) => {
      await ctx.answerCbQuery();
      await this.access.unlinkPersonal({ chatId: this.chatIdFromCtx(ctx) });
      await ctx.reply(
        "🔓 Bot bilan bog'lanish uzildi. Qayta ulanish uchun /start bosing.",
        { ...mainKeyboard(false) },
      );
    });

    bot.action('cmd_link', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendLinkPrompt(ctx);
    });

    // ── Inline button: today came/not-came detail lists ───────────────────────
    // Eski xabarlardagi `cmd_came:<id>` tugmalari ham ishlashi uchun regex
    // ':<...>' qismini qabul qiladi, lekin uni E'TIBORGA OLMAYDI — shifoxona
    // doim chat obunasidan olinadi.
    bot.action(/^cmd_came(?::.*)?$/, async (ctx) => {
      await ctx.answerCbQuery();
      const hospitalId = await this.requireLinkedHospitalId(ctx);
      if (!hospitalId) return;
      await ctx.reply(await this.buildCameList(hospitalId), {
        parse_mode: 'HTML',
      });
    });

    bot.action(/^cmd_notcame(?::.*)?$/, async (ctx) => {
      await ctx.answerCbQuery();
      const hospitalId = await this.requireLinkedHospitalId(ctx);
      if (!hospitalId) return;
      await ctx.reply(await this.buildNotCheckedInList(hospitalId), {
        parse_mode: 'HTML',
      });
    });

    // ── Ulanish: Telegram tasdiqlagan raqam (contact) ────────────────────────
    bot.on('contact', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const contact = ctx.message.contact;

      if (ctx.chat.type !== 'private') return;

      // Faqat O'Z raqamini ulashgan bo'lishi shart — boshqa kontaktni
      // "forward" qilib ulanib bo'lmaydi.
      if (!contact?.user_id || contact.user_id !== ctx.from?.id) {
        await ctx.reply(
          "⚠️ Faqat o'zingizning raqamingizni «📱 Raqamni ulashish» tugmasi orqali yuboring.",
          contactKeyboard(),
        );
        return;
      }

      const candidates = await this.access.findLinkCandidates(
        contact.phone_number,
      );
      // Raqam egasi Telegram tomonidan tasdiqlangan — shu raqamli barcha
      // xodim profillari shaxsiy eslatmalar uchun shu chatga bog'lanadi.
      const personal = await this.access.linkPersonalByPhone(
        contact.phone_number,
        chatId,
      );

      if (!candidates.length) {
        if (personal.length) {
          this.logger.log(
            `Telegram (xodim) ulandi: chat=${chatId} profiles=${personal.length}`,
          );
          await ctx.reply(linkedText(personal), {
            parse_mode: 'HTML',
            ...Markup.removeKeyboard(),
          });
          await ctx.reply('🏠 Menyu:', { ...employeeKeyboard(true) });
          return;
        }
        // Hech qanday ism/muassasa/rol oshkor qilinmaydi.
        this.logger.warn(`Telegram ulanish rad etildi: chat=${chatId}`);
        await ctx.reply(
          '⛔ Bu raqam tizimda topilmadi.\n\n' +
            "StaffPlusPRO ilovasida «Ko'proq → Telegram bot → Ulash» tugmasidan foydalaning " +
            "yoki administratorga raqamingizni to'g'rilashni so'rang.",
          Markup.removeKeyboard(),
        );
        return;
      }

      if (candidates.length === 1) {
        await this.completeLink(ctx, candidates[0]);
        return;
      }

      // Raqam egasi Telegram tomonidan tasdiqlangan — unga o'z muassasalari
      // ro'yxatini ko'rsatish xavfsiz.
      this.pendingChoices.set(chatId, {
        candidates,
        expiresAt: Date.now() + 10 * 60_000,
      });
      await ctx.reply('✅ Raqam tasdiqlandi.', Markup.removeKeyboard());
      await ctx.reply(
        'Raqamingiz bir nechta muassasada ruxsatga ega. Qaysi biriga ulanasiz?',
        Markup.inlineKeyboard(
          candidates.map((c, i) => [
            Markup.button.callback(`🏥 ${c.hospitalName}`, `link_pick:${i}`),
          ]),
        ),
      );
    });

    bot.action(/^link_pick:(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = this.chatIdFromCtx(ctx);
      const pending = this.pendingChoices.get(chatId);
      const index = Number((ctx.match as RegExpMatchArray)[1]);
      const candidate =
        pending && pending.expiresAt > Date.now()
          ? pending.candidates[index]
          : undefined;
      this.pendingChoices.delete(chatId);
      if (!candidate) {
        await this.sendLinkPrompt(
          ctx,
          "⌛ Tanlov muddati o'tdi. Qaytadan urinib ko'ring.",
        );
        return;
      }
      await this.completeLink(ctx, candidate);
    });

    // ── Matn: eski usul (raqamni yozish) endi ishlamaydi ─────────────────────
    bot.on('text', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const text = ctx.message.text.trim();
      if (text.startsWith('/')) return;

      const digits = text.replace(/\D/g, '');
      if (digits.length < 9) return;
      if (await this.getLinkedHospital(chatId)) return;

      await this.sendLinkPrompt(
        ctx,
        "🔒 Xavfsizlik uchun raqamni qo'lda yozish endi qabul qilinmaydi.",
      );
    });
  }

  private async sendLinkPrompt(ctx: any, prefix?: string) {
    if (ctx.chat?.type && ctx.chat.type !== 'private') {
      await ctx.reply(
        'ℹ️ Botga ulanish faqat shaxsiy chatda mumkin — botga shaxsiy xabar yozing.',
      );
      return;
    }
    await ctx.reply((prefix ? `${prefix}\n\n` : '') + LINK_INSTRUCTIONS, {
      parse_mode: 'HTML',
      ...contactKeyboard(),
    });
  }

  private async completeLink(ctx: any, candidate: BotLinkCandidate) {
    const chatId = this.chatIdFromCtx(ctx);
    const username = ctx.from?.username || ctx.from?.first_name || '';
    const linked = await this.access.linkChat(chatId, username, candidate);
    if (!linked) {
      await ctx.reply(
        '⛔ Ruxsat bekor qilingan. Muassasa rahbariyatiga murojaat qiling.',
        Markup.removeKeyboard(),
      );
      return;
    }
    this.logger.log(
      `Telegram ulandi: chat=${chatId} → ${candidate.hospitalName} (${candidate.fullName})`,
    );
    await ctx.reply(
      `✅ <b>${candidate.hospitalName}</b> muassasasiga muvaffaqiyatli ulandingiz!\n\n` +
        `👤 ${candidate.fullName}\n\n` +
        `Endi real vaqtda davomat xabarlari yuboriladi. 🎉`,
      { parse_mode: 'HTML', ...Markup.removeKeyboard() },
    );
    await ctx.reply('🏠 Asosiy menyu:', { ...mainKeyboard(true) });
  }

  // ─── Shaxsiy ulanish (mobil ilova havolasi) ─────────────────────────────────
  private async handleAppLink(ctx: any, token: string) {
    const chatId = this.chatIdFromCtx(ctx);
    const res = await this.access.consumeLinkToken(token, chatId);
    if (res === 'expired' || res === 'invalid') {
      await ctx.reply(
        res === 'expired'
          ? "⌛ Havola muddati o'tgan. Ilovada «Ulash» tugmasini qayta bosing."
          : '⚠️ Havola yaroqsiz yoki allaqachon ishlatilgan. Ilovada «Ulash» tugmasini qayta bosing.',
      );
      return;
    }
    this.logger.log(
      `Telegram (ilova) ulandi: chat=${chatId} employee=${res.employeeId}`,
    );
    await ctx.reply(linkedText([res]), { parse_mode: 'HTML' });
    await ctx.reply('🏠 Menyu:', { ...employeeKeyboard(true) });
  }

  getBotUsername(): string | null {
    return this.botUsername;
  }

  /**
   * Xodimning shaxsiy chatiga xabar. Xodim botni bloklagan bo'lsa (403) —
   * eslatmalar o'chiriladi, keyingi daqiqalarda qayta urinilmaydi.
   */
  async sendPersonal(chatId: string, html: string): Promise<boolean> {
    if (!this.bot) return false;
    try {
      await this.bot.telegram.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return true;
    } catch (e: any) {
      const code = e?.response?.error_code ?? e?.code;
      if (code === 403) {
        await this.access.setReminders({ chatId }, false).catch(() => {});
        this.logger.warn(
          `Xodim botni bloklagan — eslatmalar o'chirildi: chat=${chatId}`,
        );
      } else {
        this.logger.warn(
          `Shaxsiy xabar yuborilmadi (${chatId}): ${e?.message ?? e}`,
        );
      }
      return false;
    }
  }

  private personalChat(employee: any): string | null {
    if (!employee?.telegramChatId || employee.telegramReminders === false)
      return null;
    return String(employee.telegramChatId);
  }

  /** Kelish/ketish qayd etilganda xodimning o'ziga (terminal va ilova uchun umumiy) */
  async notifyEmployeeAttendance(
    employee: any,
    action: 'CHECK_IN' | 'CHECK_OUT',
    attendance: any,
    opts: { place?: string | null; night?: boolean } = {},
  ): Promise<void> {
    const chatId = this.personalChat(employee);
    if (!chatId || !attendance) return;
    const at = action === 'CHECK_IN' ? attendance.checkIn : attendance.checkOut;
    if (!at) return;
    const time = new Date(at).toLocaleTimeString('uz-UZ', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: TZ,
    });
    // Kechki/tungi smena: kelish 18:00 dan keyin yoki 05:00 dan oldin
    const hour = Number(time.slice(0, 2));
    const night =
      opts.night ?? (action === 'CHECK_IN' && (hour >= 18 || hour < 5));
    const html =
      action === 'CHECK_IN'
        ? checkedInText({
            fullName: employee.fullName,
            time,
            lateMinutes: attendance.lateMinutes,
            place: opts.place,
            night,
          })
        : checkedOutText({
            fullName: employee.fullName,
            time,
            workedMin: attendance.netWorkMin,
            earlyLeaveMin: attendance.earlyLeaveMin,
            overtimeMin: attendance.overtimeMinutes,
          });
    await this.sendPersonal(chatId, html);
  }

  async sendCheckinReminder(
    employee: {
      fullName?: string | null;
      telegramChatId?: string | null;
      telegramReminders?: boolean;
    },
    info: { start: string; shiftName?: string | null; minutesLeft: number },
  ): Promise<boolean> {
    const chatId = this.personalChat(employee);
    if (!chatId) return false;
    return this.sendPersonal(
      chatId,
      checkinReminderText({ fullName: employee.fullName, ...info }),
    );
  }

  async sendCheckoutDue(
    employee: {
      fullName?: string | null;
      telegramChatId?: string | null;
      telegramReminders?: boolean;
    },
    end: string,
  ): Promise<boolean> {
    const chatId = this.personalChat(employee);
    if (!chatId) return false;
    return this.sendPersonal(
      chatId,
      checkoutDueText({ fullName: employee.fullName, end }),
    );
  }

  /** Xodim menyusi: "Bugungi smenam" */
  private async buildMyToday(chatId: string): Promise<string> {
    const links = await this.access.personalLinksOf(chatId);
    if (!links.length) return '⚠️ Siz hali ulanmagansiz. /start bosing.';
    const workDate = DateUtil.startOfDay(new Date());
    const hm = (d?: Date | null) =>
      d
        ? new Date(d).toLocaleTimeString('uz-UZ', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: TZ,
          })
        : '—';

    const parts: string[] = [];
    for (const l of links) {
      const [sch, rec] = await Promise.all([
        this.prisma.schedule.findFirst({
          where: { employeeId: l.id, date: workDate },
          include: { shift: true },
        }),
        this.prisma.attendanceRecord.findFirst({
          where: { employeeId: l.id, workDate },
        }),
      ]);
      const shift = sch?.shift
        ? `${esc(sch.shift.name)} · <b>${sch.shift.startTime} – ${sch.shift.endTime}</b>`
        : sch && sch.status !== 'WORKING'
          ? 'Bugun ish kuni emas'
          : 'Grafik belgilanmagan';
      const status = rec?.checkOut
        ? `✅ Keldi ${hm(rec.checkIn)} · Ketdi ${hm(rec.checkOut)}`
        : rec?.checkIn
          ? `🟢 Ishdasiz — keldi ${hm(rec.checkIn)}${rec.lateMinutes ? ` (${rec.lateMinutes} daq kechikish)` : ''}`
          : '⏳ Hali check-in qilinmagan';
      parts.push(
        `🏥 <b>${esc(l.hospital?.name ?? '—')}</b>\n📅 ${shift}\n${status}`,
      );
    }
    return parts.join('\n\n');
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

  /**
   * Chat ulangan shifoxona ID'sini qaytaradi. Chat ulanmagan bo'lsa —
   * "avval ulaning" deb javob beradi va null qaytaradi (handler to'xtashi
   * kerak).
   *
   * XAVFSIZLIK: hisobot/ro'yxat builderlari faqat shu metod bergan ID bilan
   * chaqirilishi shart. Ilgari ulanmagan chat uchun `null` uzatilardi va
   * builderlar filtrni olib tashlab, BARCHA shifoxonalar ma'lumotini
   * qaytarardi.
   */
  private async requireLinkedHospitalId(ctx: any): Promise<string | null> {
    const sub = await this.getSubscriberByChatId(this.chatIdFromCtx(ctx));
    if (sub?.hospitalId) return sub.hospitalId;
    await ctx.reply(
      "⚠️ Bu ma'lumotni ko'rish uchun avval kasalxona tizimiga ulaning.",
      { ...mainKeyboard(false) },
    );
    return null;
  }

  // ──────────────────────────────────────────
  // NOTIFY: hodim keldi/ketdi — RASM BILAN
  // ──────────────────────────────────────────
  async notifyAttendance(
    employee: any,
    action: string, // TerminalEventType yoki 'CHECK_IN' | 'CHECK_OUT'
    attendance: any,
    snapshotBuffer?: Buffer,
  ) {
    if (!this.bot) return;

    // Faqat shu kasalxonaga ulangan subscriberlar — null hospitalId'ga yubormaymiz
    const subscribers = await this.prisma.telegramSubscription.findMany({
      where: {
        isActive: true,
        hospitalId: employee.hospitalId,
      },
    });
    if (!subscribers.length) return;

    const checkTime =
      action === 'CHECK_IN' ? attendance.checkIn : attendance.checkOut;
    const timeStr = new Date(checkTime).toLocaleTimeString('uz-UZ', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: TZ,
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
      const filename = (employee.photoUrl as string).replace(
        /^\/uploads\//,
        '',
      );
      const filePath = path.join(uploadDir, filename);
      if (fs.existsSync(filePath)) {
        try {
          photoBuffer = fs.readFileSync(filePath);
        } catch {
          /* skip */
        }
      }
    }

    const photoSource = photoBuffer
      ? {
          source: photoBuffer,
          filename: snapshotBuffer ? 'snapshot.jpg' : 'photo.jpg',
        }
      : null;

    // ⚡ Obunachilarga PARALLEL yuboriladi.
    // Ilgari ketma-ket edi: har bir rasm yuklash 1-3 soniya, 5 obunachida
    // oxirgisi 15 soniya kech olardi.
    await Promise.allSettled(
      subscribers.map(async (sub) => {
        try {
          if (photoSource) {
            await this.bot.telegram.sendPhoto(sub.chatId, photoSource, {
              caption,
              parse_mode: 'HTML',
            });
          } else {
            await this.bot.telegram.sendMessage(sub.chatId, caption, {
              parse_mode: 'HTML',
            });
          }
        } catch (e) {
          this.logger.warn(
            `Failed to send to ${sub.chatId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );
  }

  // ──────────────────────────────────────────
  // NOTIFY: mobil GPS + selfie check-in/out
  // ──────────────────────────────────────────

  /**
   * Xodim mobil ilovadan ish joyida check-in/out qilganda directorga xabar yuboradi.
   * Selfie rasm + GPS joylashuv (interaktiv xarita) birgalikda jo'natiladi.
   *
   * @param employee   — employee with hospital, department, position
   * @param action     — 'CHECK_IN' | 'CHECK_OUT'
   * @param attendance — saved AttendanceRecord
   * @param selfieBuffer — optional selfie image buffer
   */
  async notifyMobileCheckin(
    employee: any,
    action: 'CHECK_IN' | 'CHECK_OUT',
    attendance: any,
    selfieBuffer?: Buffer,
  ): Promise<void> {
    if (!this.bot) return;

    const subscribers = await this.prisma.telegramSubscription.findMany({
      where: { isActive: true, hospitalId: employee.hospitalId },
    });
    if (!subscribers.length) return;

    // Kasalxona GPS ni olish (masofa hisoblash uchun)
    const hospital = await this.prisma.hospital.findUnique({
      where: { id: employee.hospitalId },
      select: { gpsLat: true, gpsLng: true, name: true },
    });

    const isCheckIn = action === 'CHECK_IN';
    const checkTime = isCheckIn ? attendance.checkIn : attendance.checkOut;
    const timeStr = new Date(checkTime).toLocaleTimeString('uz-UZ', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: TZ,
    });

    const emoji = isCheckIn ? (attendance.lateMinutes > 0 ? '⚠️' : '✅') : '🚶';
    const actionText = isCheckIn ? 'KELDI (mobil)' : 'KETDI (mobil)';

    let extra = '';
    if (isCheckIn && attendance.lateMinutes > 0) {
      extra = `\n⏱ <b>${formatMinutes(attendance.lateMinutes)} kechikdi</b>`;
    } else if (!isCheckIn && attendance.earlyLeaveMin > 0) {
      extra = `\n⚡ <b>${formatMinutes(attendance.earlyLeaveMin)} erta ketdi</b>`;
    }
    if (isCheckIn && attendance.faceCheckPending) {
      extra += `\n🕓 Yuz hali tekshirilmadi — keyinroq avtomatik tekshiriladi`;
    }

    // GPS — check-in uchun gpsLat/gpsLng, check-out uchun checkOutGps*
    const lat = isCheckIn
      ? (attendance.gpsLat ?? null)
      : (attendance.checkOutGpsLat ?? null);
    const lng = isCheckIn
      ? (attendance.gpsLng ?? null)
      : (attendance.checkOutGpsLng ?? null);
    const accuracy = isCheckIn
      ? attendance.gpsAccuracy
      : attendance.checkOutGpsAccuracy;

    // Ish joyi bilan masofa (kasalxona GPS o'rnatilgan bo'lsa)
    let distanceLine = '';
    if (lat && lng && hospital?.gpsLat && hospital?.gpsLng) {
      const meters = haversineMeters(
        lat,
        lng,
        hospital.gpsLat,
        hospital.gpsLng,
      );
      const dist =
        meters < 1000
          ? `${Math.round(meters)} m`
          : `${(meters / 1000).toFixed(1)} km`;
      const inZone = meters <= 250; // 250m tolerance
      distanceLine = `\n${inZone ? '🟢' : '🔴'} Ish joyidan: <b>${dist}</b>`;
    }

    // Yandex Maps havolasi
    const gpsLine =
      lat && lng
        ? `\n🗺 <a href="${yandexMapLink(lat, lng)}">Yandex Maps da ko'rish</a>`
        : '';
    const accuracyLine = accuracy
      ? `\n🎯 GPS aniqlik: ±${Math.round(accuracy)}m`
      : '';

    const caption =
      `${emoji} <b>${employee.fullName}</b> ${actionText}\n` +
      `🕐 Vaqt: <b>${timeStr}</b>\n` +
      `🏥 Tashkilot: ${employee.hospital?.name || hospital?.name || '—'}\n` +
      `🏢 Bo'lim: ${employee.department?.name || '—'}\n` +
      `💼 Lavozim: ${employee.position?.name || '—'}` +
      extra +
      distanceLine +
      gpsLine +
      accuracyLine;

    // Selfie buffer
    let photoBuffer: Buffer | null = selfieBuffer || null;

    // Selfie buffer kelmasa — saqlangan fayldan o'qiymiz
    if (!photoBuffer) {
      const storedUrl = isCheckIn
        ? attendance.selfieUrl
        : (attendance.checkOutSelfieUrl ?? attendance.selfieUrl);
      if (storedUrl) {
        const uploadDir = process.env.UPLOAD_DIR || './uploads';
        const filename = (storedUrl as string).replace(/^\/uploads\//, '');
        const filePath = path.join(uploadDir, filename);
        if (fs.existsSync(filePath)) {
          try {
            photoBuffer = fs.readFileSync(filePath);
          } catch {
            /* skip */
          }
        }
      } else if (employee.photoUrl) {
        const uploadDir = process.env.UPLOAD_DIR || './uploads';
        const filename = (employee.photoUrl as string).replace(
          /^\/uploads\//,
          '',
        );
        const filePath = path.join(uploadDir, filename);
        if (fs.existsSync(filePath)) {
          try {
            photoBuffer = fs.readFileSync(filePath);
          } catch {
            /* skip */
          }
        }
      }
    }

    // Yandex Static Maps rasmi (GPS bor bo'lsa)
    let mapBuffer: Buffer | null = null;
    if (lat && lng) {
      mapBuffer = await fetchImageBuffer(
        yandexStaticMapUrl(lat, lng, isCheckIn ? 'gn' : 'rd'),
      ).catch(() => null);
    }

    for (const sub of subscribers) {
      try {
        // 1. Selfie + matn
        if (photoBuffer) {
          await this.bot.telegram.sendPhoto(
            sub.chatId,
            { source: photoBuffer, filename: 'selfie.jpg' },
            { caption, parse_mode: 'HTML' },
          );
        } else {
          await this.bot.telegram.sendMessage(sub.chatId, caption, {
            parse_mode: 'HTML',
          });
        }

        // 2. Yandex Maps static xarita rasmi
        if (mapBuffer) {
          await this.bot.telegram.sendPhoto(
            sub.chatId,
            { source: mapBuffer, filename: 'location.jpg' },
            {
              caption: `📍 ${isCheckIn ? 'Kelish' : 'Ketish'} joyi`,
              parse_mode: 'HTML',
            },
          );
        } else if (lat && lng) {
          // Static map yuklab bo'lmasa — Telegram native location
          await this.bot.telegram.sendLocation(sub.chatId, lat, lng);
        }
      } catch (e) {
        this.logger.warn(
          `notifyMobileCheckin failed to ${sub.chatId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  // ──────────────────────────────────────────
  // BROADCAST
  // ──────────────────────────────────────────
  async broadcast(message: string) {
    if (!this.bot) return;
    const subscribers = await this.prisma.telegramSubscription.findMany({
      where: { isActive: true },
    });
    for (const sub of subscribers) {
      try {
        await this.bot.telegram.sendMessage(sub.chatId, message, {
          parse_mode: 'HTML',
        });
      } catch (e) {
        this.logger.warn(`Broadcast failed to ${sub.chatId}`);
      }
    }
  }

  async sendToChat(chatId: string, message: string) {
    if (!this.bot) return;
    await this.bot.telegram.sendMessage(chatId, message, {
      parse_mode: 'HTML',
    });
  }

  async broadcastToHospital(hospitalId: string, message: string) {
    if (!this.bot) return;
    // Faqat shu shifoxonaga ulangan chatlar — ulanmagan (hospitalId=null)
    // chatlarga shifoxona ma'lumoti yuborilmaydi.
    const subscribers = await this.prisma.telegramSubscription.findMany({
      where: { isActive: true, hospitalId },
    });
    for (const sub of subscribers) {
      try {
        await this.bot.telegram.sendMessage(sub.chatId, message, {
          parse_mode: 'HTML',
        });
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
  private async buildTodaySummary(hospitalId: string): Promise<{
    text: string;
    keyboard: ReturnType<typeof Markup.inlineKeyboard>;
  }> {
    const todayStart = this.todayStart();
    const dateLabel = todayDateStr();
    const timeLabel = nowStr();

    const empWhere: any = { firedAt: null };
    empWhere.hospitalId = hospitalId;

    // Rejalashtirilgan bugun (schedule bo'lsa)
    const schedWhere: any = { date: todayStart, status: 'WORKING' };
    schedWhere.employee = { hospitalId };
    const scheduled = await this.prisma.schedule.findMany({
      where: schedWhere,
      select: { employeeId: true },
    });

    // Check-in qilganlar (bugun)
    const attWhere: any = { workDate: todayStart, checkIn: { not: null } };
    attWhere.employee = { hospitalId };
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
      const scheduledIds = new Set(scheduled.map((s) => s.employeeId));
      const cameInSchedule = attendances.filter((a) =>
        scheduledIds.has(a.employeeId),
      );
      totalScheduled = scheduled.length;
      cameCount = cameInSchedule.length;
      lateCount = cameInSchedule.filter((a) => a.lateMinutes > 0).length;
      notCameCount = totalScheduled - cameCount;
    } else {
      // Schedule yo'q — barcha xodimlar va attendanceRecord dan hisoblash
      totalScheduled = await this.prisma.employee.count({ where: empWhere });
      cameCount = attendances.length;
      lateCount = attendances.filter((a) => a.lateMinutes > 0).length;
      notCameCount = totalScheduled - cameCount;
    }

    const text =
      `📊 <b>Bugungi davomat</b>\n` +
      `📅 ${dateLabel} | 🕐 ${timeLabel} holat\n\n` +
      `👥 Jami xodimlar: <b>${totalScheduled} ta</b>\n` +
      `✅ Keldi: <b>${cameCount} ta</b>\n` +
      `❌ Hali kelmagan: <b>${Math.max(0, notCameCount)} ta</b>\n` +
      `⚠️ Kechikkan: <b>${lateCount} ta</b>`;

    return { text, keyboard: todayDetailKeyboard() };
  }

  /**
   * Bugun kelganlar ro'yhati (ism + kelgan vaqt)
   */
  private async buildCameList(hospitalId: string): Promise<string> {
    const todayStart = this.todayStart();
    const dateLabel = todayDateStr();

    const attWhere: any = { workDate: todayStart, checkIn: { not: null } };
    attWhere.employee = { hospitalId };

    const records = await this.prisma.attendanceRecord.findMany({
      where: attWhere,
      include: { employee: { include: { department: true } } },
      orderBy: { checkIn: 'asc' },
    });

    // Schedule bo'lsa, faqat jadvalda bo'lganlarni ko'rsatish
    const schedWhere: any = { date: todayStart, status: 'WORKING' };
    schedWhere.employee = { hospitalId };
    const scheduled = await this.prisma.schedule.findMany({
      where: schedWhere,
      select: { employeeId: true },
    });

    const came =
      scheduled.length > 0
        ? records.filter((r) =>
            new Set(scheduled.map((s) => s.employeeId)).has(r.employeeId),
          )
        : records;

    if (!came.length) {
      return `📋 <b>Kelganlar — ${dateLabel}</b>\n\nHali hech kim kelmagan.`;
    }

    const list = came
      .slice(0, MAX_LIST)
      .map((r, i) => {
        const time = new Date(r.checkIn!).toLocaleTimeString('uz-UZ', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: TZ,
        });
        const late = r.lateMinutes > 0 ? ` ⚠️ +${r.lateMinutes} daq` : '';
        return `${i + 1}. <b>${r.employee.fullName}</b> — ${time}${late}`;
      })
      .join('\n');

    const tail =
      came.length > MAX_LIST
        ? `\n\n<i>...va yana ${came.length - MAX_LIST} ta</i>`
        : '';

    return `✅ <b>Kelganlar — ${dateLabel}</b> (${came.length} ta)\n\n${list}${tail}`;
  }

  /**
   * Bugun rejalashtirilgan, lekin hali check-in qilmaganlar
   */
  private async buildNotCheckedInList(hospitalId: string): Promise<string> {
    const todayStart = this.todayStart();
    const dateLabel = todayDateStr();
    const timeLabel = nowStr();

    const schedWhere: any = { date: todayStart, status: 'WORKING' };
    schedWhere.employee = { hospitalId };

    const schedules = await this.prisma.schedule.findMany({
      where: schedWhere,
      include: { employee: { include: { department: true } } },
    });

    if (!schedules.length) {
      return `📋 <b>${dateLabel}</b>\n\nBugun uchun ish grafigi topilmadi.`;
    }

    const attWhere: any = { workDate: todayStart, checkIn: { not: null } };
    attWhere.employee = { hospitalId };

    const checkedIn = await this.prisma.attendanceRecord.findMany({
      where: attWhere,
      select: { employeeId: true },
    });
    const checkedInIds = new Set(checkedIn.map((r) => r.employeeId));

    const notYet = schedules.filter((s) => !checkedInIds.has(s.employeeId));

    if (!notYet.length) {
      return `✅ <b>${dateLabel}</b>\n\nBarcha ${schedules.length} ta rejalashtirilgan hodim keldi!`;
    }

    const list = notYet
      .slice(0, MAX_LIST)
      .map(
        (s, i) =>
          `${i + 1}. <b>${s.employee.fullName}</b> — ${s.employee.department?.name || '—'} ❌`,
      )
      .join('\n');

    const tail =
      notYet.length > MAX_LIST
        ? `\n\n<i>...va yana ${notYet.length - MAX_LIST} ta</i>`
        : '';

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
  private async buildWeeklyReport(hospitalId: string): Promise<string> {
    const weekStart = this.weekStart();

    const where: any = {
      weekStart,
      OR: [
        { totalLateMin: { gt: 0 } },
        { totalEarlyMin: { gt: 0 } },
        { daysAbsent: { gt: 0 } },
      ],
    };
    where.employee = { hospitalId };

    const stats = await this.prisma.weeklyAttendanceStat.findMany({
      where,
      include: { employee: { include: { department: true } } },
      orderBy: { totalLateMin: 'desc' },
      take: 20,
    });

    if (stats.length) {
      const list = stats
        .map(
          (s, i) =>
            `${i + 1}. <b>${s.employee.fullName}</b>\n   ⏱ ${s.totalLateMin} min kech | 🚶 ${s.totalEarlyMin} min erta`,
        )
        .join('\n\n');
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
    rawWhere.employee = { hospitalId };

    const raw = await this.prisma.attendanceRecord.findMany({
      where: rawWhere,
      include: { employee: { include: { department: true } } },
      orderBy: { workDate: 'asc' },
    });

    if (!raw.length) {
      return `✅ <b>Haftalik hisobot</b>\n\nBu hafta hech qanday kechikish yoki sababsiz yo\'qlik qayd etilmagan.`;
    }

    // Hodim bo'yicha guruhlash
    const empMap = new Map<
      string,
      {
        name: string;
        dept: string;
        lateMin: number;
        earlyMin: number;
        absent: number;
      }
    >();
    for (const r of raw) {
      if (!empMap.has(r.employeeId)) {
        empMap.set(r.employeeId, {
          name: r.employee.fullName,
          dept: r.employee.department?.name || '—',
          lateMin: 0,
          earlyMin: 0,
          absent: 0,
        });
      }
      const s = empMap.get(r.employeeId)!;
      s.lateMin += r.lateMinutes;
      s.earlyMin += r.earlyLeaveMin;
      if (r.status === 'ABSENT') s.absent++;
    }

    const sorted = [...empMap.values()]
      .sort((a, b) => b.lateMin - a.lateMin)
      .slice(0, 20);
    const weekLabel = weekStart.toLocaleDateString('uz-UZ', {
      day: '2-digit',
      month: '2-digit',
      timeZone: TZ,
    });

    const list = sorted
      .map((s, i) => {
        const parts: string[] = [];
        if (s.lateMin > 0) parts.push(`⏱ ${s.lateMin} min kech`);
        if (s.earlyMin > 0) parts.push(`🚶 ${s.earlyMin} min erta`);
        if (s.absent > 0) parts.push(`❌ ${s.absent} kun yo'q`);
        return `${i + 1}. <b>${s.name}</b> (${s.dept})\n   ${parts.join(' | ')}`;
      })
      .join('\n\n');

    return `📈 <b>Haftalik hisobot</b> (${weekLabel} dan)\n\n${list}`;
  }

  private async buildMonthlyReport(
    month: number,
    year: number,
    hospitalId: string,
  ): Promise<string> {
    const where: any = { month, year };
    where.employee = { hospitalId };

    const payrolls = await this.prisma.payrollRecord.findMany({
      where,
      include: { employee: { include: { department: true } } },
      orderBy: { netSalary: 'desc' },
      take: 30,
    });

    if (!payrolls.length)
      return `📋 ${month}/${year} uchun maosh hisoblari yo'q`;

    const totalNet = payrolls.reduce((s, p) => s + Number(p.netSalary), 0);
    const totalDeductions = payrolls.reduce(
      (s, p) =>
        s +
        Number(p.lateDeduction) +
        Number(p.absenceDeduction) +
        Number(p.earlyLeaveDeduction),
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

  // ──────────────────────────────────────────
  // NOTIFY: xodim ish vaqtida geofence tashqarisiga chiqdi
  // ──────────────────────────────────────────

  /**
   * Xodim ish vaqtida (check-in qilgan, check-out qilmagan) ruxsat etilgan
   * hududdan tashqariga chiqsa — directorga darhol xabar (statik xarita bilan).
   * Chaqiruvchi (`PushService.notifyGeofenceViolation`) allaqachon cooldown
   * (20 daqiqa) tekshirgan — bu yerda faqat yuborish mantig'i.
   */
  async notifyGeofenceAlert(
    employee: any,
    distanceMeters: number,
    lat: number,
    lng: number,
  ): Promise<void> {
    if (!this.bot) return;

    const subscribers = await this.prisma.telegramSubscription.findMany({
      where: { isActive: true, hospitalId: employee.hospitalId },
    });
    if (!subscribers.length) return;

    const dist =
      distanceMeters < 1000
        ? `${Math.round(distanceMeters)} m`
        : `${(distanceMeters / 1000).toFixed(1)} km`;

    const timeStr = new Date().toLocaleTimeString('uz-UZ', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: TZ,
    });

    const caption =
      `🔴 <b>${employee.fullName}</b> ish joyini tark etdi!\n` +
      `📏 Ish joyidan: <b>${dist}</b> uzoqlikda\n` +
      `🕐 Vaqt: <b>${timeStr}</b>\n` +
      `🏢 Bo'lim: ${employee.department?.name || '—'}\n` +
      `💼 Lavozim: ${employee.position?.name || '—'}\n` +
      `🗺 <a href="${yandexMapLink(lat, lng)}">Joylashuvni ko'rish</a>`;

    const mapUrl = yandexStaticMapUrl(lat, lng, 'rd');

    await Promise.allSettled(
      subscribers.map(async (sub) => {
        try {
          await this.bot.telegram.sendPhoto(sub.chatId, mapUrl, {
            caption,
            parse_mode: 'HTML',
          });
        } catch (e) {
          // Statik xarita yuklanmasa — hech bo'lmasa matnli xabar boradi
          try {
            await this.bot.telegram.sendMessage(sub.chatId, caption, {
              parse_mode: 'HTML',
            });
          } catch (e2) {
            this.logger.warn(
              `Geofence alert failed for ${sub.chatId}: ${e2 instanceof Error ? e2.message : String(e2)}`,
            );
          }
        }
      }),
    );
  }

  /** Soxta joylashuv (Fake GPS) — muassasa Telegram obunachilariga matnli xabar */
  async notifyMockLocation(
    employee: {
      fullName?: string | null;
      hospitalId: string;
      department?: { name?: string | null } | null;
      position?: { name?: string | null } | null;
    },
    context: 'CHECK_IN' | 'CHECK_OUT' | 'TRACKING',
  ): Promise<void> {
    if (!this.bot) return;
    const subscribers = await this.prisma.telegramSubscription.findMany({
      where: { isActive: true, hospitalId: employee.hospitalId },
    });
    if (!subscribers.length) return;

    const esc = (v: string) =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const timeStr = new Date().toLocaleTimeString('uz-UZ', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: TZ,
    });
    const where =
      context === 'CHECK_IN'
        ? 'Kelishni belgilashda'
        : context === 'CHECK_OUT'
          ? 'Ketishni belgilashda'
          : 'Ish vaqtidagi kuzatuvda';
    const text =
      `🚩 <b>${esc(employee.fullName || 'Xodim')}</b> soxta joylashuvdan foydalandi\n` +
      `📍 ${where} telefonida Fake GPS ilovasi aniqlandi\n` +
      `🕐 Vaqt: <b>${timeStr}</b>\n` +
      `🏢 Bo'lim: ${esc(employee.department?.name || '—')}\n` +
      `💼 Lavozim: ${esc(employee.position?.name || '—')}`;

    await Promise.allSettled(
      subscribers.map((sub) =>
        this.bot.telegram
          .sendMessage(sub.chatId, text, { parse_mode: 'HTML' })
          .catch((e) =>
            this.logger.warn(
              `Mock-location alert failed for ${sub.chatId}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          ),
      ),
    );
  }

  // ──────────────────────────────────────────
  // NOTIFY: oylik to'lov qarzdorligi eslatmasi (FAZA 5, 2-bosqich, 2026-09-19)
  // ──────────────────────────────────────────

  /**
   * Shifoxona qarzdor bo'lsa (consecutiveUnpaidMonths > 0) — direktorga
   * oyiga bir marta Telegram orqali eslatma. Takroriy yuborilmasligini
   * chaqiruvchi (`CronService.paymentReminderCron`) `Hospital.lastPaymentReminderPeriod`
   * orqali nazorat qiladi — bu metod faqat yuborish mantig'i.
   */
  async notifyPaymentReminder(
    hospital: { id: string; name: string },
    debtInfo: { consecutiveUnpaidMonths: number; totalDebt: number },
  ): Promise<void> {
    if (!this.bot) return;

    const subscribers = await this.prisma.telegramSubscription.findMany({
      where: { isActive: true, hospitalId: hospital.id, role: 'DIRECTOR' },
    });
    if (!subscribers.length) return;

    const debtStr = debtInfo.totalDebt.toLocaleString('uz-UZ') + " so'm";

    const message =
      `💳 <b>To'lov eslatmasi</b>\n\n` +
      `Hurmatli direktor, <b>${hospital.name}</b> uchun to'lov muddati o'tgan.\n\n` +
      `📅 Uzluksiz to'lanmagan oylar: <b>${debtInfo.consecutiveUnpaidMonths} oy</b>\n` +
      `💰 Jami qarz: <b>${debtStr}</b>\n\n` +
      `Iltimos, to'lovni imkon qadar tezroq amalga oshiring.`;

    await Promise.allSettled(
      subscribers.map(async (sub) => {
        try {
          await this.bot.telegram.sendMessage(sub.chatId, message, {
            parse_mode: 'HTML',
          });
        } catch (e) {
          this.logger.warn(
            `Payment reminder failed for ${sub.chatId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );
  }

  // ──────────────────────────────────────────
  // LEAVE REQUEST NOTIFICATIONS
  // ──────────────────────────────────────────

  /**
   * Ta'til so'rovi yaratilganda / tasdiqlanganida / rad etilganda xabar yuborish
   * @param leave  — LeaveRequest with employee.hospital, employee.department
   * @param action — 'CREATED' | 'APPROVED' | 'REJECTED'
   */
  async notifyLeaveRequest(
    leave: any,
    action: 'CREATED' | 'APPROVED' | 'REJECTED',
  ): Promise<void> {
    if (!this.bot) return;

    const employee = leave.employee;
    const hospital = employee?.hospital;
    const startStr = new Date(leave.startDate).toLocaleDateString('uz-UZ', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: TZ,
    });
    const endStr = new Date(leave.endDate).toLocaleDateString('uz-UZ', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: TZ,
    });

    const LEAVE_LABELS: Record<string, string> = {
      VACATION: "Yillik ta'til",
      SICK: 'Kasallik',
      PERSONAL: 'Shaxsiy sabab',
      MATERNITY: "Tug'ruq ta'tili",
      UNPAID: "Haqsiz ta'til",
    };

    const typeLabel = LEAVE_LABELS[leave.type] ?? leave.type;

    if (action === 'CREATED') {
      // Direktorga xabar — PENDING so'rov keldi
      const subscribers = await this.prisma.telegramSubscription.findMany({
        where: { isActive: true, hospitalId: leave.hospitalId },
      });
      if (!subscribers.length) return;

      const emoji =
        leave.type === 'SICK' ? '🤒' : leave.type === 'MATERNITY' ? '🤱' : '🏖';
      const message =
        `${emoji} <b>Ta'til so'rovi</b>\n\n` +
        `👤 Xodim: <b>${employee?.fullName || '—'}</b>\n` +
        `🏢 Bo'lim: ${employee?.department?.name || '—'}\n` +
        `📋 Tur: <b>${typeLabel}</b>\n` +
        `📅 Muddat: <b>${startStr} – ${endStr}</b> (${leave.daysCount} kun)\n` +
        (leave.reason ? `💬 Sabab: ${leave.reason}\n` : '') +
        `\n⏳ Tasdiqlash yoki rad etish uchun tizimga kiring.`;

      for (const sub of subscribers) {
        try {
          await this.bot.telegram.sendMessage(sub.chatId, message, {
            parse_mode: 'HTML',
          });
        } catch (e) {
          this.logger.warn(
            `Leave notify failed to ${sub.chatId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } else {
      // Xodimga shaxsiy xabar — agar telegramChatId bo'lsa
      if (!employee?.telegramChatId) return;

      const isApproved = action === 'APPROVED';
      const emoji = isApproved ? '✅' : '❌';
      const statusText = isApproved ? 'TASDIQLANDI' : 'RAD ETILDI';

      const message =
        `${emoji} <b>Ta'til so'rovingiz ${statusText}</b>\n\n` +
        `📋 Tur: <b>${typeLabel}</b>\n` +
        `📅 Muddat: <b>${startStr} – ${endStr}</b> (${leave.daysCount} kun)\n` +
        (leave.reviewNote ? `\n💬 Izoh: <i>${leave.reviewNote}</i>` : '');

      try {
        await this.bot.telegram.sendMessage(employee.telegramChatId, message, {
          parse_mode: 'HTML',
        });
      } catch (e) {
        this.logger.warn(
          `Leave decision notify to employee failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  async handleUpdate(update: any): Promise<void> {
    if (!this.bot) return;
    await this.bot.handleUpdate(update);
  }

  async notifyTerminalConnectivity(
    hospitalId: string,
    hospitalName: string,
    terminalName: string,
    isOnline: boolean,
  ) {
    if (!this.bot) return;

    const subscribers = await this.prisma.telegramSubscription.findMany({
      where: { isActive: true, hospitalId },
    });
    if (!subscribers.length) return;

    const escapeHtml = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const message = isOnline
      ? `✅ <b>Terminal aloqasi tiklandi</b>\n\n🏥 ${escapeHtml(hospitalName)}\n📟 ${escapeHtml(terminalName)} yana online.`
      : `⚠️ <b>Terminal bilan aloqa uzildi</b>\n\n🏥 ${escapeHtml(hospitalName)}\n📟 ${escapeHtml(terminalName)} bir necha daqiqadan beri offline. Elektr va internet ulanishini tekshiring.`;

    await Promise.allSettled(
      subscribers.map((sub) =>
        this.bot!.telegram.sendMessage(sub.chatId, message, {
          parse_mode: 'HTML',
        }),
      ),
    );
  }

  async notifyMissedCheckout(
    hospitalId: string,
    employeeName: string,
    expectedCheckOut: Date,
  ) {
    if (!this.bot) return;

    const subscribers = await this.prisma.telegramSubscription.findMany({
      where: {
        isActive: true,
        hospitalId,
        role: 'DIRECTOR',
      },
    });
    if (!subscribers.length) return;

    const escapeHtml = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const time = expectedCheckOut.toLocaleTimeString('uz-UZ', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: TZ,
    });
    const message =
      `⚠️ <b>Check-out qilinmadi</b>\n\n` +
      `👤 ${escapeHtml(employeeName)} bugun check-out qilmadi.\n` +
      `🕐 Davomat grafik bo‘yicha <b>${time}</b> da avtomatik yakunlandi.`;

    await Promise.allSettled(
      subscribers.map((sub) =>
        this.bot!.telegram.sendMessage(sub.chatId, message, {
          parse_mode: 'HTML',
        }),
      ),
    );
  }
}
