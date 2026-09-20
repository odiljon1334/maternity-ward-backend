import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import axios from 'axios';
import { TelegramService } from '../telegram/telegram.service';
import { SUPPORT_BOT_SYSTEM_PROMPT } from './faq-prompt';

const TZ = 'Asia/Tashkent';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const MAX_HISTORY = 6; // oxirgi N ta xabar (user+assistant juftlashib)
const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 daqiqa harakatsizlikdan keyin unutiladi
const RATE_LIMIT_MAX = 20; // 1 soatda bitta chat uchun maksimal xabar
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

interface ChatSession {
  history: { role: 'user' | 'assistant'; content: string }[];
  lastActivity: number;
  timestamps: number[]; // rate-limit uchun
}

/** Telegram HTML parse_mode uchun xavfsizlik */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * StaffPlusPRO marketing sayti mijozlari (tashrifchilar) uchun Telegram
 * support bot. Ichki HR botidan (TelegramService, TELEGRAM_BOT_TOKEN)
 * BUTUNLAY ALOHIDA bot — o'z tokeni, o'z auditoriyasi bor.
 *
 * Ish vaqtida: foydalanuvchiga qabul xabari yuboriladi va xabar staff
 * guruhiga forward qilinadi (odam javob beradi).
 * Ish vaqtidan tashqarida: OpenRouter'dagi bepul Hermes modeli orqali
 * shablon (faq-prompt.ts) asosida avtomatik javob beradi.
 */
@Injectable()
export class SupportBotService implements OnModuleInit {
  private readonly logger = new Logger(SupportBotService.name);
  private bot: Telegraf;
  private sessions = new Map<string, ChatSession>();

  constructor(
    private readonly config: ConfigService,
    private readonly telegramService: TelegramService,
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
          'vaqtidan tashqarida esa AI yordamchimiz javob beradi.',
      );
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

    this.logger.log('Support bot started (webhook mode)');
  }

  async handleUpdate(update: any): Promise<void> {
    if (!this.bot) return;
    await this.bot.handleUpdate(update);
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
