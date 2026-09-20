import { Body, Controller, Post } from '@nestjs/common';
import { SupportBotService } from './support-bot.service';

/**
 * StaffPlusPRO mijozlar uchun Telegram support bot webhook'i.
 * Ichki HR botining /telegram/webhook'idan ALOHIDA endpoint.
 */
@Controller('support-bot')
export class SupportBotController {
  constructor(private readonly supportBotService: SupportBotService) {}

  /** POST /support-bot/webhook — JWT guard YO'Q, Telegram shu yerga POST qiladi */
  @Post('webhook')
  async handleWebhook(@Body() update: any) {
    await this.supportBotService.handleUpdate(update);
    return { ok: true };
  }
}
