import {
  Body,
  Controller,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from '../telegram/telegram.service';
import { TrialRequestDto } from './dto/trial-request.dto';

const ORG_TYPE_LABELS: Record<string, string> = {
  clinic: 'Klinika',
  factory: 'Zavod',
  office: 'Ofis/IT',
  retail: 'Savdo',
  edu: "Ta'lim",
};

/** Proxy orqali kelgan so'rovlarda ham haqiqiy IP ni olish */
function getIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded)
    return (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      .split(',')[0]
      .trim();
  return req.ip ?? 'unknown';
}

/** Telegram HTML parse_mode uchun xavfsizlik: foydalanuvchi kiritgan matnni escape qilish */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Marketing sahifasidan keladigan ochiq (auth talab qilinmaydigan) so'rovlar.
 * Hozircha faqat "14 kunlik sinov" so'rovnomasi (lead capture) — HAQIQIY
 * hisob/tenant yaratmaydi, faqat so'rovni Telegram orqali sotuv jamoasiga
 * yetkazadi. Hisob qo'lda (SUPER_ADMIN tomonidan) yaratiladi.
 */
@Controller('public')
export class PublicController {
  private readonly logger = new Logger(PublicController.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly configService: ConfigService,
  ) {}

  @UseGuards(ThrottlerGuard)
  @Throttle({ public: { ttl: 3_600_000, limit: 5 } })
  @Post('trial-request')
  async trialRequest(@Body() dto: TrialRequestDto, @Req() req: Request) {
    const leadsChatId = this.configService.get<string>(
      'TELEGRAM_LEADS_CHAT_ID',
    );

    const orgTypeLabel = dto.orgType
      ? ORG_TYPE_LABELS[dto.orgType] || dto.orgType
      : '—';
    const ip = getIp(req);
    const now = new Date().toLocaleString('uz-UZ', {
      timeZone: 'Asia/Tashkent',
    });

    const lines = [
      "🆕 <b>Yangi 14 kunlik sinov so'rovi</b>",
      '',
      `🏢 Muassasa: <b>${escapeHtml(dto.hospitalName)}</b> (${escapeHtml(orgTypeLabel)})`,
      `👤 Rahbar: ${escapeHtml(dto.directorName)}`,
      `📞 Telefon: <code>${escapeHtml(dto.phone)}</code>`,
      dto.region ? `📍 Hudud: ${escapeHtml(dto.region)}` : null,
      dto.staffCount ? `👥 Taxminiy xodimlar: ${dto.staffCount}` : null,
      dto.plan
        ? `💳 Reja: ${escapeHtml(dto.plan)} (${dto.billingCycle === 'annual' ? 'yillik' : 'oylik'})`
        : null,
      dto.utmSource || dto.utmMedium || dto.utmCampaign
        ? `📊 UTM: ${escapeHtml([dto.utmSource, dto.utmMedium, dto.utmCampaign].filter(Boolean).join(' / '))}`
        : null,
      dto.pageUrl ? `🔗 Sahifa: ${escapeHtml(dto.pageUrl)}` : null,
      '',
      `🕐 ${now} · IP: <code>${escapeHtml(ip)}</code>`,
    ].filter(Boolean);

    const message = lines.join('\n');

    if (leadsChatId) {
      try {
        await this.telegramService.sendToChat(leadsChatId, message);
      } catch (e) {
        this.logger.error(
          `Trial-request Telegram xabarini yuborishda xatolik: ${e}`,
        );
      }
    } else {
      // Xabar yo'q bo'lsa ham so'rovni yo'qotmaslik uchun kamida log qoldiramiz
      this.logger.warn(
        `TELEGRAM_LEADS_CHAT_ID sozlanmagan — lead faqat logga yozildi: ${JSON.stringify(dto)}`,
      );
    }

    return { ok: true };
  }
}
