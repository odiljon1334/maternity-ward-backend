import {
  Controller, Post, Body, Headers, HttpCode, Logger, Req,
} from '@nestjs/common';
import { AttendanceService, HikvisionEvent } from './attendance.service';
import { TelegramService } from '../telegram/telegram.service';
import { Request } from 'express';

@Controller('hikvision')
export class HikvisionWebhookController {
  private readonly logger = new Logger(HikvisionWebhookController.name);

  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly telegramService: TelegramService,
  ) {}

  /**
   * Hikvision face terminal webhook endpoint
   * Terminal POST qiladi har safar yuz tanilganda
   */
  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Body() body: any,
    @Headers() headers: Record<string, string>,
    @Req() req: Request,
  ) {
    this.logger.debug(`Hikvision webhook: ${JSON.stringify(body)}`);

    // Parse different Hikvision terminal formats
    const event = this.parseHikvisionBody(body);
    if (!event?.employeeNo) {
      this.logger.warn('Invalid webhook payload, no employeeNo');
      return { status: 'ignored' };
    }

    try {
      const result = await this.attendanceService.processHikvisionEvent(event);

      if (result) {
        // Send Telegram notification to director
        await this.telegramService.notifyAttendance(
          result.employee,
          result.action,
          result.attendance,
        );
      }

      return { status: 'ok' };
    } catch (err) {
      this.logger.error('Webhook processing error:', err);
      return { status: 'error', message: err.message };
    }
  }

  private parseHikvisionBody(body: any): HikvisionEvent | null {
    if (!body) return null;

    // Format 1: Standard Hikvision format
    if (body.AccessControllerEvent) {
      const ev = body.AccessControllerEvent;
      return {
        employeeNo: ev.employeeNoString || ev.employeeNo,
        deviceId: body.ipAddress || body.deviceID,
        eventTime: ev.dateTime || body.dateTime,
        raw: body,
      };
    }

    // Format 2: Simplified format (some terminal models)
    if (body.employeeNo || body.employeeNoString) {
      return {
        employeeNo: body.employeeNoString || body.employeeNo,
        deviceId: body.deviceId || body.deviceID,
        eventTime: body.dateTime || body.eventTime,
        raw: body,
      };
    }

    // Format 3: Nested Events format
    if (body.Events && Array.isArray(body.Events)) {
      const ev = body.Events[0];
      return {
        employeeNo: ev.employeeNoString || ev.employeeNo,
        deviceId: body.devIndex || ev.devIndex,
        eventTime: ev.DateTime || ev.dateTime,
        raw: body,
      };
    }

    return null;
  }
}
