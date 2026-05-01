import { Controller, Get, Post, Body, Headers, Logger, HttpCode } from '@nestjs/common';

/**
 * Hikvision kamera qurilmalar shu endpoint ga HTTP so'rov yuboradi:
 *   GET  /api/v1/hikvision/webhook  — kamera aloqa tekshiruvi (health-check)
 *   POST /api/v1/hikvision/webhook  — hodim kirish/chiqish eventi (ISAPI alert)
 *
 * JWT guard yo'q — kameralar token yubormaydigan qurilmalar.
 */
@Controller('hikvision')
export class HikvisionWebhookController {
  private readonly logger = new Logger(HikvisionWebhookController.name);

  /** Kamera aloqa tekshiruvi — 200 qaytarish kifoya */
  @Get('webhook')
  @HttpCode(200)
  healthCheck() {
    return { status: 'ok' };
  }

  /** Hikvision ISAPI event — kirish/chiqish ma'lumotlari */
  @Post('webhook')
  @HttpCode(200)
  handleEvent(
    @Body() body: any,
    @Headers('content-type') contentType: string,
  ) {
    this.logger.debug(`Hikvision event: ${JSON.stringify(body)?.slice(0, 200)}`);
    return { status: 'received' };
  }
}
