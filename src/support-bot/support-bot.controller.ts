import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { SupportBotService } from './support-bot.service';

/**
 * StaffPlusPRO mijozlar uchun Telegram support bot webhook'i.
 * Ichki HR botining /telegram/webhook'idan ALOHIDA endpoint.
 */
@Controller('support-bot')
export class SupportBotController {
  constructor(
    private readonly supportBotService: SupportBotService,
    private readonly config: ConfigService,
  ) {}

  /** POST /support-bot/webhook — JWT guard YO'Q, Telegram shu yerga POST qiladi */
  @Post('webhook')
  async handleWebhook(
    @Body() update: any,
    @Headers('x-telegram-bot-api-secret-token') secret?: string,
  ) {
    this.assertValidWebhookSecret(secret);
    await this.supportBotService.handleUpdate(update);
    return { ok: true };
  }

  private assertValidWebhookSecret(provided?: string) {
    const expected = this.config.get<string>('SUPPORT_BOT_WEBHOOK_SECRET');
    if (!expected) {
      // Productionda secret'siz webhook qabul qilinmaydi (fail-closed):
      // aks holda istalgan kishi soxta update (masalan to'lov) yubora oladi.
      if (process.env.NODE_ENV === 'production') {
        throw new UnauthorizedException('Webhook secret not configured');
      }
      return; // dev/o'tish davri
    }
    const actual = Buffer.from(provided ?? '');
    const wanted = Buffer.from(expected);
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
      throw new UnauthorizedException('Invalid Telegram webhook secret');
    }
  }
}
