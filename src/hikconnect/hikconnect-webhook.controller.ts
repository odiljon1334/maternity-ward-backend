// hikconnect-webhook.controller.ts
// PDF §4.17 — Webhook Message Push
//
// Hik tizimi ikki xil so'rov yuboradi:
//  1. GET  /api/v1/hikvision/webhook  — callback URL tekshiruvi (ro'yxatga olishda)
//  2. POST /api/v1/hikvision/webhook  — haqiqiy event push

import {
  Controller,
  Get,
  Post,
  Headers,
  Body,
  Res,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { HikConnectService } from './hikconnect.service';

// ─────────────────────────────────────────────────────────
// Webhook push body turlari (PDF §4.17 Alarm Message Example)
// ─────────────────────────────────────────────────────────

interface HikAlarmEvent {
  systemId?: string;
  eventType?: string;
  eventTime?: string;
  personId?: string;
  personName?: string;
  cardNo?: string;
  deviceId?: string;
  deviceName?: string;
  attendanceStatus?: number;
  authResult?: number;
  [key: string]: unknown;
}

interface HikWebhookPayload {
  batchId: string;
  list: HikAlarmEvent[];
}

// ─────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────

@Controller('api/v1/hikvision')
export class HikConnectWebhookController {
  private readonly logger = new Logger(HikConnectWebhookController.name);

  constructor(private readonly hikService: HikConnectService) {}

  /**
   * GET /api/v1/hikvision/webhook
   *
   * Hik-Connect webhook ro'yxatidan o'tishda ushbu endpoint'ga
   * GET so'rov keladi. Biz X-Hook-Signature header qaytarishimiz kerak.
   *
   * PDF §4.17 "Callback URL Signature Verification"
   */
  @Get('webhook')
  @HttpCode(HttpStatus.OK)
  handleVerification(
    @Headers('x-hook-timestamp') timestamp: string,
    @Headers('x-hook-batch-id') batchId: string,
    @Res() res: Response,
  ) {
    if (!timestamp || !batchId) {
      this.logger.warn("Webhook tekshiruvi: timestamp yoki batchId yo'q");
      return res.status(400).json({ error: 'Missing headers' });
    }

    const signature = this.hikService.generateWebhookSignature(
      timestamp,
      batchId,
    );
    this.logger.log(`Webhook URL tekshiruvi — batchId: ${batchId}`);

    return res
      .status(200)
      .header('X-Hook-Signature', signature)
      .json({ ok: true });
  }

  /**
   * POST /api/v1/hikvision/webhook
   *
   * Haqiqiy event push. Imzoni tekshiramiz, so'ng eventni qayta ishlaymiz.
   * HTTP 2XX qaytarmasak — Hik retry qiladi (retryTimes ko'rsatilgancha).
   *
   * PDF §4.17 "Push Message Signature Verification"
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhookPush(
    @Headers('x-hook-signature') signature: string,
    @Headers('x-hook-timestamp') timestamp: string,
    @Headers('x-hook-batch-id') batchId: string,
    @Body() payload: HikWebhookPayload,
  ) {
    // 1. Imzo tekshiruvi
    if (!signature || !timestamp || !batchId) {
      this.logger.warn("Webhook: majburiy headerlar yo'q");
      return { errorCode: '400', message: 'Missing headers' };
    }

    const valid = this.hikService.verifyWebhookSignature(
      signature,
      timestamp,
      batchId,
    );
    if (!valid) {
      this.logger.warn(
        `Webhook imzo tekshiruvi MUVAFFAQIYATSIZ — batchId: ${batchId}`,
      );
      // 401 qaytarsak Hik retry qilmaydi; 200 qaytarsak retry qiladi.
      // Noto'g'ri manba bo'lsa, 200 qaytarmaslik to'g'riroq.
      return { errorCode: '401', message: 'Invalid signature' };
    }

    // 2. Eventlarni qayta ishlash
    const { list = [] } = payload;
    this.logger.log(`Webhook — batchId: ${batchId}, events: ${list.length}`);

    for (const event of list) {
      await this.processEvent(event).catch((err) =>
        this.logger.error(`Event qayta ishlash xatosi: ${err.message}`, event),
      );
    }

    // 3. Hik 2XX kutadi — 200 qaytaramiz
    return { errorCode: '0' };
  }

  // ─────────────────────────────────────────────────────
  // Event qayta ishlash
  // ─────────────────────────────────────────────────────

  private async processEvent(event: HikAlarmEvent): Promise<void> {
    const { eventType, eventTime, personId, personName, cardNo, deviceName } =
      event;

    this.logger.debug(
      `Event: type=${eventType}, person=${personName ?? personId}, time=${eventTime}`,
    );

    this.logger.log(
      `✅ HikConnect event — type=${eventType} | person=${personName ?? personId} | card=${cardNo ?? '-'} | device=${deviceName ?? '-'} | time=${eventTime ?? '-'}`,
    );
  }
}
