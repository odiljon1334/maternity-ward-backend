import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { TelegramService } from '../telegram/telegram.service';
import {
  ContractService,
  TrialContractData,
} from '../contract/contract.service';
import { SUPPORT_BOT_SYSTEM_PROMPT } from './faq-prompt';
import { TrialLeadSource } from '@prisma/client';
import { TrialLeadsService } from '../trial-leads/trial-leads.service';

const TZ = 'Asia/Tashkent';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const MAX_HISTORY = 6; // oxirgi N ta xabar (user+assistant juftlashib)
const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 daqiqa harakatsizlikdan keyin unutiladi
const RATE_LIMIT_MAX = 20; // 1 soatda bitta chat uchun maksimal xabar
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Yangi mijoz (lead) ma'lumot yig'ish oqimidagi bosqichlar, tartib bilan */
type FlowStep =
  | 'fullName'
  | 'phone'
  | 'institutionName'
  | 'staffCount'
  | 'faceId'
  | 'plan'
  | 'contactTime';

const FLOW_ORDER: FlowStep[] = [
  'fullName',
  'phone',
  'institutionName',
  'staffCount',
  'faceId',
  'plan',
  'contactTime',
];

interface LeadFlowState {
  step: FlowStep;
  data: Partial<{
    fullName: string;
    phone: string;
    institutionName: string;
    staffCount: number;
    faceId: boolean;
    plan: 'start' | 'biznes' | 'korporativ';
    contactTime: string;
  }>;
}

interface ChatSession {
  history: { role: 'user' | 'assistant'; content: string }[];
  lastActivity: number;
  timestamps: number[]; // rate-limit uchun
  flow?: LeadFlowState;
}

/** Bot orqali "yangi mijoz" oqimini boshlab yuboradigan kalit so'zlar */
const TRIAL_TRIGGER_RE =
  /shartnoma|sinov|ro.?yxatdan|yangi mijoz|tarif tanla|tarif olish/i;

/** Telegram HTML parse_mode uchun xavfsizlik */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const PLAN_LABELS: Record<string, string> = {
  start: 'Start (1 – 15 xodim)',
  biznes: 'Biznes (16 – 100 xodim)',
  korporativ: 'Korporativ (100+ xodim)',
};

/**
 * StaffPlusPRO marketing sayti mijozlari (tashrifchilar) uchun Telegram
 * support bot. Ichki HR botidan (TelegramService, TELEGRAM_BOT_TOKEN)
 * BUTUNLAY ALOHIDA bot — o'z tokeni, o'z auditoriyasi bor.
 *
 * Ish vaqtida: foydalanuvchiga qabul xabari yuboriladi va xabar staff
 * guruhiga forward qilinadi (odam javob beradi).
 * Ish vaqtidan tashqarida: Google Gemini orqali shablon (faq-prompt.ts)
 * asosida avtomatik javob beradi.
 *
 * Bundan tashqari — "yangi mijoz" (lead-intake) oqimi: mijoz "shartnoma"/
 * "sinov" kabi so'z yozsa yoki tugmani bossa, bot ketma-ket F.I.Sh,
 * telefon, muassasa, xodimlar soni, FaceID kerak-kerakmasligi va tarifni
 * so'raydi, so'ng avtomatik PDF shartnoma-oferta yaratib mijozga yuboradi
 * va Odiljonga (SUPPORT_STAFF_CHAT_ID) har bir lead haqida shaxsiy
 * bildirishnoma + shu PDF'ni yuboradi.
 */
@Injectable()
export class SupportBotService implements OnModuleInit {
  private readonly logger = new Logger(SupportBotService.name);
  private bot: Telegraf;
  private sessions = new Map<string, ChatSession>();

  constructor(
    private readonly config: ConfigService,
    private readonly telegramService: TelegramService,
    private readonly contractService: ContractService,
    private readonly trialLeadsService: TrialLeadsService,
  ) {}

  async onModuleInit() {
    const token = this.config.get<string>('SUPPORT_BOT_TOKEN');
    if (!token) {
      this.logger.warn(
        "SUPPORT_BOT_TOKEN sozlanmagan — support bot o'chirilgan",
      );
      return;
    }

    this.bot = new Telegraf(token);

    this.bot.start(async (ctx) => {
      await ctx.reply(
        'Assalomu alaykum! 👋 StaffPlusPRO support botiga xush kelibsiz.\n\n' +
          'Savolingizni shu yerga yozing — ish vaqtida operatorimiz, ish ' +
          'vaqtidan tashqarida esa AI yordamchimiz javob beradi.\n\n' +
          '14 kunlik bepul sinovni hoziroq boshlashingiz ham mumkin:',
        Markup.inlineKeyboard([
          Markup.button.callback(
            '🚀 14 kunlik BEPUL sinovni boshlash',
            'start_trial',
          ),
        ]),
      );
    });

    this.bot.action('start_trial', async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = String(ctx.chat?.id ?? '');
      if (!chatId) return;
      const session = this.getSession(chatId);
      session.flow = { step: 'fullName', data: {} };
      await this.askFlowStep(ctx, session);
    });

    this.bot.action(/^faceid_(ha|yoq)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = String(ctx.chat?.id ?? '');
      const session = this.sessions.get(chatId);
      if (!session?.flow || session.flow.step !== 'faceId') {
        await ctx.reply(
          "Bu so'rov muddati o'tgan. Qaytadan boshlash uchun /trial buyrug'ini yuboring.",
        );
        return;
      }
      const value = (ctx as any).match[1] === 'ha';
      session.flow.data.faceId = value;
      this.advanceFlow(session.flow);
      await this.askFlowStep(ctx, session);
    });

    this.bot.action(/^plan_(start|biznes|korporativ)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const chatId = String(ctx.chat?.id ?? '');
      const session = this.sessions.get(chatId);
      if (!session?.flow || session.flow.step !== 'plan') {
        await ctx.reply(
          "Bu so'rov muddati o'tgan. Qaytadan boshlash uchun /trial buyrug'ini yuboring.",
        );
        return;
      }
      const plan = (ctx as any).match[1] as 'start' | 'biznes' | 'korporativ';
      session.flow.data.plan = plan;
      this.advanceFlow(session.flow);
      await this.askFlowStep(ctx, session);
    });

    this.bot.command('trial', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const session = this.getSession(chatId);
      session.flow = { step: 'fullName', data: {} };
      await this.askFlowStep(ctx, session);
    });

    this.bot.on('text', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const text = ctx.message.text?.trim();
      if (!text) return;

      if (this.isRateLimited(chatId)) {
        await ctx.reply(
          "Juda ko'p xabar yubordingiz. Iltimos, birozdan so'ng qayta urinib ko'ring.",
        );
        return;
      }

      const session = this.getSession(chatId);

      // ── 1) Lead-intake oqimi davom etayotgan bo'lsa — shu yerda tugaydi
      if (session.flow) {
        await this.handleFlowTextInput(ctx, session, text);
        return;
      }

      // ── 2) Oqimni boshlovchi kalit so'z topilsa
      if (TRIAL_TRIGGER_RE.test(text)) {
        session.flow = { step: 'fullName', data: {} };
        await this.askFlowStep(ctx, session);
        return;
      }

      // ── 3) Oddiy FAQ oqimi (o'zgarishsiz)
      if (this.isWorkingHours()) {
        await ctx.reply(
          'Xabaringiz uchun rahmat! Hozir ish vaqti — operatorimiz tez orada javob beradi.',
        );
        await this.forwardToStaff(ctx, text);
        return;
      }

      try {
        await ctx.sendChatAction('typing');
      } catch {
        // e'tiborsiz qoldiriladi
      }
      const reply = await this.askAi(chatId, text);
      await ctx.reply(reply);
    });

    await this.registerWebhook();
    this.logger.log('Support bot started (webhook mode)');
  }

  /** Secret+URL bo'lmasa avvalgi support-bot webhookiga tegmaydi. */
  private async registerWebhook() {
    const url = this.config.get<string>('SUPPORT_BOT_WEBHOOK_URL')?.trim();
    const secret = this.config
      .get<string>('SUPPORT_BOT_WEBHOOK_SECRET')
      ?.trim();
    if (!url || !secret) {
      this.logger.warn(
        "SUPPORT_BOT_WEBHOOK_URL/SUPPORT_BOT_WEBHOOK_SECRET sozlanmagan — mavjud webhook o'zgartirilmadi",
      );
      return;
    }

    try {
      await this.bot.telegram.setWebhook(url, { secret_token: secret });
      this.logger.log(
        `Support bot webhook himoyalangan holda ro'yxatdan o'tdi: ${url}`,
      );
    } catch (error) {
      this.logger.error(
        `Support bot webhook ro'yxatdan o'tmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async handleUpdate(update: any): Promise<void> {
    if (!this.bot) return;
    await this.bot.handleUpdate(update);
  }

  // ── Lead-intake oqimi ────────────────────────────────────────────────────

  private advanceFlow(flow: LeadFlowState) {
    const idx = FLOW_ORDER.indexOf(flow.step);
    if (idx >= 0 && idx < FLOW_ORDER.length - 1) {
      flow.step = FLOW_ORDER[idx + 1];
    } else {
      flow.step = 'contactTime'; // xavfsizlik uchun, amalda yetib bormaydi
    }
  }

  private async askFlowStep(ctx: any, session: ChatSession) {
    const flow = session.flow;
    if (!flow) return;
    switch (flow.step) {
      case 'fullName':
        await ctx.reply("Ismingiz va familiyangizni to'liq kiriting (F.I.Sh):");
        break;
      case 'phone':
        await ctx.reply(
          'Telefon raqamingizni kiriting (masalan: +998901234567):',
        );
        break;
      case 'institutionName':
        await ctx.reply('Muassasangiz nomini kiriting:');
        break;
      case 'staffCount':
        await ctx.reply('Muassasangizda nechta xodim bor? (faqat raqam bilan)');
        break;
      case 'faceId':
        await ctx.reply(
          "FaceID qurilmasi kerakmi? (qurilma narxi alohida to'lanadi, " +
            "Andijon hududida o'rnatish xizmati BEPUL)",
          Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Ha, kerak', 'faceid_ha'),
              Markup.button.callback('❌ Kerak emas', 'faceid_yoq'),
            ],
          ]),
        );
        break;
      case 'plan':
        await ctx.reply(
          'Qaysi tarifni tanlaysiz?',
          Markup.inlineKeyboard([
            [Markup.button.callback('Start (1–15 xodim)', 'plan_start')],
            [Markup.button.callback('Biznes (16–100 xodim)', 'plan_biznes')],
            [Markup.button.callback('Korporativ (100+)', 'plan_korporativ')],
          ]),
        );
        break;
      case 'contactTime':
        await ctx.reply(
          "Siz bilan bog'lanish uchun qulay kun/vaqtni yozing " +
            '(masalan: "Ertaga tushdan keyin" yoki "Har kuni 10:00–12:00"):',
        );
        break;
    }
  }

  private async handleFlowTextInput(
    ctx: any,
    session: ChatSession,
    text: string,
  ) {
    const flow = session.flow;
    if (!flow) return;

    switch (flow.step) {
      case 'fullName':
        if (text.length < 3) {
          await ctx.reply("Iltimos, to'liq ism-familiyangizni kiriting.");
          return;
        }
        flow.data.fullName = text;
        break;
      case 'phone':
        if (text.replace(/\D/g, '').length < 9) {
          await ctx.reply(
            'Iltimos, haqiqiy telefon raqam kiriting (masalan: +998901234567).',
          );
          return;
        }
        flow.data.phone = text;
        break;
      case 'institutionName':
        if (text.length < 2) {
          await ctx.reply('Iltimos, muassasa nomini kiriting.');
          return;
        }
        flow.data.institutionName = text;
        break;
      case 'staffCount': {
        const n = parseInt(text.replace(/\D/g, ''), 10);
        if (!n || n < 1 || n > 20000) {
          await ctx.reply(
            'Iltimos, xodimlar sonini faqat raqam bilan kiriting (masalan: 25).',
          );
          return;
        }
        flow.data.staffCount = n;
        break;
      }
      case 'contactTime':
        flow.data.contactTime = text;
        break;
      // 'faceId' va 'plan' bosqichlari faqat tugma (action) orqali to'ldiriladi
      default:
        return;
    }

    if (flow.step === 'contactTime') {
      await this.finalizeLead(ctx, session);
      return;
    }

    this.advanceFlow(flow);
    await this.askFlowStep(ctx, session);
  }

  private async finalizeLead(ctx: any, session: ChatSession) {
    const flow = session.flow;
    if (!flow) return;
    const data = flow.data;

    const contractData: TrialContractData = {
      fullName: data.fullName || "Noma'lum",
      phone: data.phone || "Noma'lum",
      institutionName: data.institutionName || "Noma'lum",
      staffCount: data.staffCount ?? null,
      plan: data.plan ?? null,
      faceId: data.faceId ?? null,
      contactTime: data.contactTime ?? null,
    };

    session.flow = undefined; // oqim tugadi, chat oddiy FAQ rejimiga qaytadi

    try {
      await this.trialLeadsService.capture({
        source: TrialLeadSource.TELEGRAM_BOT,
        institutionName: contractData.institutionName,
        contactName: contractData.fullName,
        phone: contractData.phone,
        staffCount: contractData.staffCount,
        plan: contractData.plan,
        faceId: contractData.faceId,
        contactTime: contractData.contactTime,
        telegramChatId: String(ctx.chat?.id ?? '') || null,
        telegramUsername: ctx.from?.username || null,
      });
    } catch (e) {
      // DB vaqtincha ishlamasa ham mijoz PDF va operator Telegram xabarini
      // olishi kerak; mavjud tashqi oqim saqlanib qoladi.
      this.logger.error(
        `Telegram trial lead bazaga saqlanmadi: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    let pdfBuffer: Buffer | null = null;
    try {
      pdfBuffer =
        await this.contractService.generateTrialContractPdf(contractData);
    } catch (e) {
      this.logger.error(`Shartnoma PDF yaratishda xatolik: ${e}`);
    }

    if (pdfBuffer) {
      try {
        await ctx.replyWithDocument(
          {
            source: pdfBuffer,
            filename: 'StaffPlusPRO-shartnoma-loyihasi.pdf',
          },
          {
            caption:
              "📄 Shartnoma loyihangiz tayyor! Ma'lumotlaringiz operatorimizga " +
              "yuborildi — tez orada siz bilan bog'lanamiz.",
          },
        );
      } catch (e) {
        this.logger.error(`Mijozga PDF yuborishda xatolik: ${e}`);
        await ctx.reply(
          "Ma'lumotlaringiz qabul qilindi, tez orada operatorimiz siz bilan bog'lanadi!",
        );
      }
    } else {
      await ctx.reply(
        "Ma'lumotlaringiz qabul qilindi, tez orada operatorimiz siz bilan bog'lanadi!",
      );
    }

    const username = ctx.from?.username
      ? `@${escapeHtml(ctx.from.username)}`
      : escapeHtml(ctx.from?.first_name || "Noma'lum");

    await this.sendLeadNotification(
      this.buildLeadSummaryText(contractData, username, ctx.chat?.id),
      pdfBuffer,
    );
  }

  private buildLeadSummaryText(
    data: TrialContractData,
    username: string,
    chatId?: number | string,
  ): string {
    const lines = [
      '🆕 <b>Yangi LEAD — Support bot orqali</b>',
      '',
      `👤 F.I.Sh: <b>${escapeHtml(data.fullName)}</b>`,
      `📞 Telefon: <code>${escapeHtml(data.phone)}</code>`,
      `🏢 Muassasa: ${escapeHtml(data.institutionName)}`,
      data.staffCount != null ? `👥 Xodimlar soni: ${data.staffCount}` : null,
      `💳 Tarif: ${data.plan ? PLAN_LABELS[data.plan] || data.plan : 'Kelishiladi'}`,
      `📷 FaceID: ${data.faceId == null ? 'Kelishiladi' : data.faceId ? 'Kerak' : 'Kerak emas'}`,
      data.contactTime
        ? `🕐 Qulay vaqt: ${escapeHtml(data.contactTime)}`
        : null,
      '',
      `💬 Telegram: ${username}${chatId ? ` (chat: <code>${chatId}</code>)` : ''}`,
    ].filter(Boolean);
    return lines.join('\n');
  }

  /**
   * PublicController'dan (marketing saytidagi "14 kunlik sinov" veb-forma)
   * chaqiriladi — mijoz veb-forma orqali ma'lumot yuborganda ham xuddi shu
   * shartnoma-PDF avtomatik yaratilib, Odiljonga yuboriladi.
   */
  async notifyLeadFromWebForm(
    data: TrialContractData,
    extraLine?: string,
  ): Promise<void> {
    if (!this.bot) {
      this.logger.warn(
        'SUPPORT_BOT_TOKEN sozlanmagan — veb-forma lead xabari yuborilmadi',
      );
      return;
    }
    let pdfBuffer: Buffer | null = null;
    try {
      pdfBuffer = await this.contractService.generateTrialContractPdf(data);
    } catch (e) {
      this.logger.error(
        `Veb-forma uchun shartnoma PDF yaratishda xatolik: ${e}`,
      );
    }

    let text = this.buildLeadSummaryText(
      data,
      '🌐 Veb-sayt (14 kunlik sinov formasi)',
    );
    if (extraLine) text += `\n${extraLine}`;

    await this.sendLeadNotification(text, pdfBuffer);
  }

  /**
   * StaffPlusPRO operatoriga global texnik ogohlantirish yuboradi.
   * Muassasa direktorlariga yuborilmaydi: ular global infratuzilma
   * nosozligini tuzata olmaydi va keraksiz xavotir paydo bo'ladi.
   */
  async notifyOperationalAlert(message: string): Promise<boolean> {
    const staffChatId = this.config.get<string>('SUPPORT_STAFF_CHAT_ID');
    if (!staffChatId || !this.bot) {
      this.logger.warn(
        'Support bot yoki SUPPORT_STAFF_CHAT_ID sozlanmagan — texnik ogohlantirish yuborilmadi',
      );
      return false;
    }

    try {
      await this.bot.telegram.sendMessage(staffChatId, message);
      return true;
    } catch (e) {
      this.logger.error(`Texnik ogohlantirishni yuborishda xatolik: ${e}`);
      return false;
    }
  }

  private async sendLeadNotification(text: string, pdfBuffer: Buffer | null) {
    const staffChatId =
      this.config.get<string>('SUPPORT_STAFF_CHAT_ID') ||
      this.config.get<string>('TELEGRAM_LEADS_CHAT_ID');
    if (!staffChatId) {
      this.logger.warn(
        'SUPPORT_STAFF_CHAT_ID sozlanmagan — lead bildirishnomasi yuborilmadi',
      );
      return;
    }
    if (!this.bot) return;
    try {
      if (pdfBuffer) {
        await this.bot.telegram.sendDocument(
          staffChatId,
          { source: pdfBuffer, filename: 'shartnoma-loyihasi.pdf' },
          { caption: text, parse_mode: 'HTML' },
        );
      } else {
        await this.bot.telegram.sendMessage(staffChatId, text, {
          parse_mode: 'HTML',
        });
      }
    } catch (e) {
      this.logger.error(`Lead bildirishnomasini yuborishda xatolik: ${e}`);
    }
  }

  // ── Ish vaqti tekshiruvi ─────────────────────────────────────────────────
  private isWorkingHours(): boolean {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(now);

    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const day = weekdayMap[weekdayStr] ?? 1;

    const workDays = (
      this.config.get<string>('SUPPORT_WORK_DAYS') || '1,2,3,4,5,6'
    )
      .split(',')
      .map((d) => Number(d.trim()));
    if (!workDays.includes(day)) return false;

    const start =
      this.config.get<string>('SUPPORT_WORK_HOURS_START') || '09:00';
    const end = this.config.get<string>('SUPPORT_WORK_HOURS_END') || '18:00';
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);

    const nowMinutes = hour * 60 + minute;
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  // ── Oddiy xotiradagi rate-limit (chat bo'yicha) ─────────────────────────
  private isRateLimited(chatId: string): boolean {
    const session = this.getSession(chatId);
    const now = Date.now();
    session.timestamps = session.timestamps.filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS,
    );
    if (session.timestamps.length >= RATE_LIMIT_MAX) return true;
    session.timestamps.push(now);
    return false;
  }

  private getSession(chatId: string): ChatSession {
    this.cleanupSessions();
    let s = this.sessions.get(chatId);
    if (!s) {
      s = { history: [], lastActivity: Date.now(), timestamps: [] };
      this.sessions.set(chatId, s);
    }
    s.lastActivity = Date.now();
    return s;
  }

  private cleanupSessions() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > HISTORY_TTL_MS) this.sessions.delete(id);
    }
  }

  // ── AI javob (Google Gemini) ────────────────────────────────────────────
  private async askAi(chatId: string, text: string): Promise<string> {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'GEMINI_API_KEY sozlanmagan — support bot AI javob bera olmaydi',
      );
      return "Kechirasiz, hozircha avtomatik javob ishlamayapti. Ish vaqtida operatorimiz bilan bog'lanishingiz mumkin.";
    }

    const session = this.getSession(chatId);
    session.lastActivity = Date.now();
    session.history.push({ role: 'user', content: text });
    session.history = session.history.slice(-MAX_HISTORY);

    try {
      const model =
        this.config.get<string>('SUPPORT_BOT_AI_MODEL') || DEFAULT_MODEL;
      const { data } = await axios.post(
        `${GEMINI_URL}/${model}:generateContent`,
        {
          systemInstruction: {
            parts: [{ text: SUPPORT_BOT_SYSTEM_PROMPT }],
          },
          contents: session.history.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 500,
          },
        },
        {
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          timeout: 20_000,
        },
      );

      const reply =
        data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
        "Kechirasiz, javob shakllantira olmadim. Operatorimiz bilan bog'laning.";
      session.history.push({ role: 'assistant', content: reply });
      session.history = session.history.slice(-MAX_HISTORY);
      return reply;
    } catch (e) {
      this.logger.error(`Gemini chaqiruvida xatolik: ${e}`);
      return 'Kechirasiz, hozir texnik nosozlik bor. Ish vaqtida operatorimiz javob beradi.';
    }
  }

  // ── Ish vaqtida jonli xodimlarga forward qilish ─────────────────────────
  private async forwardToStaff(ctx: any, text: string) {
    const staffChatId =
      this.config.get<string>('SUPPORT_STAFF_CHAT_ID') ||
      this.config.get<string>('TELEGRAM_LEADS_CHAT_ID');
    if (!staffChatId) {
      this.logger.warn(
        'SUPPORT_STAFF_CHAT_ID va TELEGRAM_LEADS_CHAT_ID sozlanmagan — forward qilinmadi',
      );
      return;
    }
    const username = ctx.from?.username
      ? `@${escapeHtml(ctx.from.username)}`
      : escapeHtml(ctx.from?.first_name || "Noma'lum");
    const message =
      '💬 <b>Support botga yangi xabar</b>\n\n' +
      `👤 ${username} (chat: <code>${ctx.chat.id}</code>)\n` +
      `📝 ${escapeHtml(text)}`;
    try {
      await this.telegramService.sendToChat(staffChatId, message);
    } catch (e) {
      this.logger.error(`Staffga forward qilishda xatolik: ${e}`);
    }
  }
}
