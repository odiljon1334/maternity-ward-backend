import { Body, Controller, Logger, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { SupportBotService } from '../support-bot/support-bot.service';
import { TrialRequestDto } from './dto/trial-request.dto';
import { TrialLeadSource } from '@prisma/client';
import { TrialLeadsService } from '../trial-leads/trial-leads.service';

const ORG_TYPE_LABELS: Record<string, string> = {
  clinic: 'Klinika',
  factory: 'Zavod',
  office: 'Ofis/IT',
  retail: 'Savdo',
  edu: "Ta'lim",
};

const PLAN_MAP: Record<string, 'start' | 'biznes' | 'korporativ'> = {
  start: 'start',
  biznes: 'biznes',
  korporativ: 'korporativ',
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
 * hisob/tenant yaratmaydi, faqat so'rovni StaffPlusPRO support boti orqali
 * Odiljonga (SUPPORT_STAFF_CHAT_ID) shaxsiy xabar + avtomatik shartnoma-PDF
 * sifatida yetkazadi. Hisob qo'lda (SUPER_ADMIN tomonidan) yaratiladi.
 */
@Controller('public')
export class PublicController {
  private readonly logger = new Logger(PublicController.name);

  constructor(
    private readonly supportBotService: SupportBotService,
    private readonly trialLeadsService: TrialLeadsService,
  ) {}

  @UseGuards(ThrottlerGuard)
  @Throttle({ public: { ttl: 3_600_000, limit: 5 } })
  @Post('trial-request')
  async trialRequest(@Body() dto: TrialRequestDto, @Req() req: Request) {
    const orgTypeLabel = dto.orgType
      ? ORG_TYPE_LABELS[dto.orgType] || dto.orgType
      : '—';
    const ip = getIp(req);
    const now = new Date().toLocaleString('uz-UZ', {
      timeZone: 'Asia/Tashkent',
    });

    const extraLine = [
      dto.region ? `📍 Hudud: ${escapeHtml(dto.region)}` : null,
      `🏷️ Tashkilot turi: ${escapeHtml(orgTypeLabel)}`,
      dto.billingCycle
        ? `💳 To'lov davri: ${dto.billingCycle === 'annual' ? 'yillik' : 'oylik'}`
        : null,
      dto.utmSource || dto.utmMedium || dto.utmCampaign
        ? `📊 UTM: ${escapeHtml([dto.utmSource, dto.utmMedium, dto.utmCampaign].filter(Boolean).join(' / '))}`
        : null,
      dto.pageUrl ? `🔗 Sahifa: ${escapeHtml(dto.pageUrl)}` : null,
      `🕐 ${now} · IP: <code>${escapeHtml(ip)}</code>`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      await this.trialLeadsService.capture({
        source: TrialLeadSource.WEB_FORM,
        institutionName: dto.hospitalName,
        contactName: dto.directorName,
        phone: dto.phone,
        orgType: dto.orgType,
        region: dto.region,
        staffCount: dto.staffCount,
        plan: dto.plan,
        billingCycle: dto.billingCycle,
        utmSource: dto.utmSource,
        utmMedium: dto.utmMedium,
        utmCampaign: dto.utmCampaign,
        pageUrl: dto.pageUrl,
      });
    } catch (e) {
      // Telegram/PDF oqimini DB yozuvi xatosi sabab to'xtatmaymiz: ikkala
      // kanal bir-biriga fallback bo'lib, lead yo'qolish xavfini kamaytiradi.
      this.logger.error(
        `Trial-request lead bazaga saqlanmadi: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    try {
      await this.supportBotService.notifyLeadFromWebForm(
        {
          fullName: dto.directorName,
          phone: dto.phone,
          institutionName: dto.hospitalName,
          staffCount: dto.staffCount ?? null,
          plan: dto.plan ? (PLAN_MAP[dto.plan] ?? null) : null,
          faceId: null,
          contactTime: null,
        },
        extraLine,
      );
    } catch (e) {
      this.logger.error(
        `Trial-request lead bildirishnomasini yuborishda xatolik: ${e}`,
      );
      // Xabar yo'q bo'lsa ham so'rovni yo'qotmaslik uchun kamida log qoldiramiz
      this.logger.warn(
        `Lead ma'lumotlari (fallback log): ${JSON.stringify(dto)}`,
      );
    }

    return { ok: true };
  }
}
