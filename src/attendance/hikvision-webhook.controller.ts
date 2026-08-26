import {
  Controller,
  Get,
  Post,
  HttpCode,
  Logger,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { TerminalEventType } from '@prisma/client';

import { AttendanceService, HikvisionEvent } from './attendance.service';
import { TelegramService } from '../telegram/telegram.service';
import { mapHikvisionStatus } from './constants/terminal-event.map';

/** Hikvision qurilmalari tez-tez so'rov yuboradi — rate limit o'chirilgan */
@Controller('hikvision')
export class HikvisionWebhookController {
  private readonly logger = new Logger(HikvisionWebhookController.name);

  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly telegramService: TelegramService,
  ) {}

  /** Kamera aloqa tekshiruvi — GET so'rovi har 2 soniyada keladi */
  @Get('webhook')
  @HttpCode(200)
  healthCheck() {
    return { status: 'ok' };
  }

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(@Req() req: Request) {
    this.assertValidSecret(req);

    const ct = String(req.headers['content-type'] || '');
    const body = req.body as Buffer;

    this.logger.log(
      `Webhook ct=${ct.split(';')[0]} size=${body?.length ?? 0}b`,
    );

    const parsed = this.parsePayload(ct, body);

    this.logger.log(
      `Parsed: no=${parsed.employeeNo} time=${parsed.eventTime} ` +
        `status=${parsed.terminalEventType ?? 'auto'} device=${parsed.deviceId}`,
    );

    if (!parsed.employeeNo) {
      this.logger.warn(
        `employeeNo topilmadi. Raw (500ch): ${JSON.stringify(parsed.eventRaw).slice(0, 500)}`,
      );
      return { status: 'ignored', reason: 'no_employee_no' };
    }

    const event: HikvisionEvent = {
      employeeNo: parsed.employeeNo,
      deviceId: parsed.deviceId,
      deviceName: parsed.deviceName,
      eventTime: parsed.eventTime,
      terminalEventType: parsed.terminalEventType,
      rawPayload: parsed.eventRaw,
    };

    try {
      const result = await this.attendanceService.processHikvisionEvent(event);

      if (result?.notifyTelegram) {
        await this.telegramService.notifyAttendance(
          result.employee,
          result.action,
          result.attendance,
          parsed.snapshotBytes,
        );
      }

      return { status: 'ok' };
    } catch (err) {
      this.logger.error('Webhook processing error:', err);
      return { status: 'error', message: err.message };
    }
  }

  // ─── XAVFSIZLIK: URL query'dagi secret'ni tekshirish ─────────────────────────
  //
  // Terminalning "HTTP Listening" sozlamasida header/Basic Auth maydoni yo'q —
  // shuning uchun secret URL query-parametr sifatida yuboriladi:
  //   /api/v1/hikvision/webhook?key=<HIKVISION_WEBHOOK_SECRET>
  //
  // HIKVISION_WEBHOOK_SECRET .env da sozlanmagan bo'lsa, eski/hali
  // yangilanmagan terminallar bilan uzilib qolmaslik uchun faqat WARNING
  // beriladi va so'rov o'tkaziladi. Production'da bu ENV albatta sozlanishi kerak.
 private assertValidSecret(req: Request) {
  // Gateway internal networkdan kelayapti (172.18.x.x)
  // Tashqaridan kirish mumkin emas — secret tekshirish kerak emas
  const clientIp = req.ip ?? '';
  if (clientIp.includes('172.18.') || clientIp.includes('172.17.')) {
    return; // Docker internal — ishonchli
  }

  const expected = process.env.HIKVISION_WEBHOOK_SECRET;
  if (!expected) return;

  const provided = String(req.query.key ?? '');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  const valid = a.length === b.length && provided.length > 0
    ? timingSafeEqual(a, b)
    : false;

  if (!valid) {
    this.logger.warn(`Webhook: noto'g'ri/yo'q secret. IP=${req.ip}`);
    throw new UnauthorizedException('Invalid webhook secret');
  }
}

  // ─── PAYLOAD PARSER ──────────────────────────────────────────────────────────

  private parsePayload(ct: string, body?: Buffer): ParsedEvent {
    if (!body || body.length === 0) return emptyEvent();

    if (ct.includes('application/json')) return this.parseJson(body);
    if (ct.includes('xml') || ct.includes('text/plain'))
      return this.parseXml(body);
    if (ct.includes('multipart')) return this.parseMultipart(ct, body);

    // Noma'lum content-type — JSON sifatida urinib ko'r
    try {
      return this.parseJson(body);
    } catch {
      return emptyEvent();
    }
  }

  // ── JSON ──────────────────────────────────────────────────────────────────────

  private parseJson(body: Buffer): ParsedEvent {
    try {
      const obj = JSON.parse(body.toString('utf8'));
      return {
        kind: 'json',
        employeeNo: this.extractEmployeeNo(obj),
        deviceId: this.extractDeviceId(obj),
        deviceName: this.extractDeviceName(obj),
        eventTime: this.extractEventTime(obj),
        terminalEventType: this.extractTerminalEventType(obj),
        eventRaw: obj,
      };
    } catch {
      return emptyEvent();
    }
  }

  // ── XML ───────────────────────────────────────────────────────────────────────

  private parseXml(body: Buffer): ParsedEvent {
    const xml = body.toString('utf8');
    return {
      kind: 'xml',
      employeeNo: this.extractEmployeeNoXml(xml),
      deviceId: this.extractDeviceIdXml(xml),
      deviceName: this.extractDeviceNameXml(xml),
      eventTime: this.extractEventTimeXml(xml),
      terminalEventType: this.extractTerminalEventTypeXml(xml),
      eventRaw: xml,
    };
  }

  // ── MULTIPART ─────────────────────────────────────────────────────────────────

  private parseMultipart(ct: string, body: Buffer): ParsedEvent {
    const boundaryMatch = ct.match(/boundary=([^;]+)/i);
    const boundary = boundaryMatch?.[1]?.trim().replace(/^"|"$/g, '');
    if (!boundary) return emptyEvent();

    const parts = this.splitMultipart(body, boundary);
    let jsonObj: any;
    let xmlText: string | undefined;
    let snap: Buffer | undefined;

    for (const p of parts) {
      const h = p.headers.toLowerCase();

      if (!jsonObj && h.includes('application/json')) {
        try {
          jsonObj = JSON.parse(p.body.toString('utf8'));
        } catch {
          /* skip */
        }
      }

      if (!xmlText && (h.includes('xml') || h.includes('text/plain'))) {
        const t = p.body.toString('utf8');
        if (t.includes('<')) xmlText = t;
      }

      if (!snap) {
        const isImg =
          h.includes('image/jpeg') ||
          h.includes('image/jpg') ||
          h.includes('image/png');
        const hasName = /filename=["']?[^"'\s]*\.(jpg|jpeg|png)/i.test(h);
        const jpegMagic =
          p.body.length > 3 &&
          p.body[0] === 0xff &&
          p.body[1] === 0xd8 &&
          p.body[2] === 0xff;
        if (isImg || hasName || jpegMagic) snap = p.body;
      }
    }

    // JSON topilmadiymu — har bir partni sinab ko'r
    if (!jsonObj) {
      for (const p of parts) {
        try {
          const t = p.body.toString('utf8').trim();
          if (t.startsWith('{') && t.endsWith('}')) {
            jsonObj = JSON.parse(t);
            break;
          }
        } catch {
          /* skip */
        }
      }
    }

    // XML topilmadi — '<' belgisi bo'lgan partni sinab ko'r
    if (!xmlText) {
      const maybe = parts.find((p) => p.body.toString('utf8').includes('<'));
      if (maybe) xmlText = maybe.body.toString('utf8');
    }

    const src = jsonObj ?? xmlText;
    const isJson = !!jsonObj;

    return {
      kind: 'multipart',
      employeeNo: isJson
        ? this.extractEmployeeNo(src)
        : this.extractEmployeeNoXml(src as string),
      deviceId: isJson
        ? this.extractDeviceId(src)
        : this.extractDeviceIdXml(src as string),
      deviceName: isJson
        ? this.extractDeviceName(src)
        : this.extractDeviceNameXml(src as string),
      eventTime: isJson
        ? this.extractEventTime(src)
        : this.extractEventTimeXml(src as string),
      terminalEventType: isJson
        ? this.extractTerminalEventType(src)
        : this.extractTerminalEventTypeXml((src as string) ?? ''),
      eventRaw: src ?? '(multipart-no-data)',
      snapshotBytes: snap,
    };
  }

  // ─── FIELD EXTRACTORS (JSON) ─────────────────────────────────────────────────

  private extractEmployeeNo(obj: any): string | undefined {
    const v =
      obj?.employeeNo ||
      obj?.EmployeeNo ||
      obj?.employeeNoString ||
      obj?.EmployeeNoString ||
      obj?.cardNo ||
      obj?.personId ||
      obj?.UserInfo?.employeeNo ||
      obj?.AccessControllerEvent?.employeeNo ||
      obj?.AccessControllerEvent?.employeeNoString ||
      obj?.AccessControllerEvent?.cardNo ||
      obj?.Events?.[0]?.employeeNo ||
      obj?.Events?.[0]?.employeeNoString;
    return v ? String(v).trim() : undefined;
  }

  private extractDeviceId(obj: any): string | undefined {
    const v =
      obj?.deviceId ||
      obj?.deviceID ||
      obj?.DeviceID ||
      obj?.ipAddress ||
      obj?.AccessControllerEvent?.deviceId ||
      obj?.Events?.[0]?.deviceId;
    return v ? String(v).trim() : undefined;
  }

  private extractDeviceName(obj: any): string | undefined {
    const v =
      obj?.deviceName ||
      obj?.DeviceName ||
      obj?.AccessControllerEvent?.deviceName ||
      obj?.Events?.[0]?.deviceName;
    return v ? String(v).trim() : undefined;
  }

  private extractEventTime(obj: any): string | undefined {
    const v =
      obj?.dateTime ||
      obj?.DateTime ||
      obj?.eventTime ||
      obj?.triggerTime ||
      obj?.TriggerTime ||
      obj?.AccessControllerEvent?.dateTime ||
      obj?.AccessControllerEvent?.DateTime ||
      obj?.Events?.[0]?.dateTime ||
      obj?.Events?.[0]?.time;
    return v ? String(v).trim() : undefined;
  }

  /**
   * Terminal tugmasi bosilganda yuborilgan attendanceStatus yoki workCode ni o'qiydi.
   * mapHikvisionStatus() orqali TerminalEventType ga o'tkazadi.
   * Terminal status yubormas yoki noma'lum bo'lsa — null qaytaradi
   * (processHikvisionEvent time-based fallback ni ishlatadi).
   */
  private extractTerminalEventType(obj: any): TerminalEventType | null {
    const raw =
      obj?.attendanceStatus ||
      obj?.AttendanceStatus ||
      obj?.workCode ||
      obj?.WorkCode ||
      obj?.AccessControllerEvent?.attendanceStatus ||
      obj?.AccessControllerEvent?.AttendanceStatus ||
      obj?.AccessControllerEvent?.workCode ||
      obj?.Events?.[0]?.attendanceStatus ||
      obj?.Events?.[0]?.workCode;

    return mapHikvisionStatus(raw);
  }

  // ─── FIELD EXTRACTORS (XML) ──────────────────────────────────────────────────

  private extractEmployeeNoXml(xml: string): string | undefined {
    return (
      this.xmlTag(xml, 'employeeNo') ??
      this.xmlTag(xml, 'FPID') ??
      this.xmlAttr(xml, 'employeeNo')
    );
  }

  private extractDeviceIdXml(xml: string): string | undefined {
    return this.xmlTag(xml, 'deviceID') ?? this.xmlTag(xml, 'serialNumber');
  }

  private extractDeviceNameXml(xml: string): string | undefined {
    return this.xmlTag(xml, 'deviceName');
  }

  private extractEventTimeXml(xml: string): string | undefined {
    return this.xmlTag(xml, 'dateTime') ?? this.xmlTag(xml, 'triggerTime');
  }

  private extractTerminalEventTypeXml(xml: string): TerminalEventType | null {
    const raw =
      this.xmlTag(xml, 'attendanceStatus') ??
      this.xmlTag(xml, 'AttendanceStatus') ??
      this.xmlTag(xml, 'workCode');
    return mapHikvisionStatus(raw);
  }

  // ─── XML HELPERS ─────────────────────────────────────────────────────────────

  private xmlTag(xml: string, tag: string): string | undefined {
    const m = xml.match(
      new RegExp(`<${tag}[^>]*>\\s*([^<]+)\\s*<\\/${tag}>`, 'i'),
    );
    return m?.[1]?.trim() || undefined;
  }

  private xmlAttr(xml: string, attr: string): string | undefined {
    const m = xml.match(new RegExp(`${attr}\\s*=\\s*"([^"]+)"`, 'i'));
    return m?.[1]?.trim() || undefined;
  }

  // ─── MULTIPART SPLITTER ──────────────────────────────────────────────────────

  private splitMultipart(
    buf: Buffer,
    boundary: string,
  ): Array<{ headers: string; body: Buffer }> {
    const sep = Buffer.from(`--${boundary}`);
    const ending = Buffer.from(`--${boundary}--`);
    const parts: Array<{ headers: string; body: Buffer }> = [];

    let pos = buf.indexOf(sep);
    while (pos !== -1) {
      if (buf.indexOf(ending, pos) === pos) break;

      let start = pos + sep.length;
      if (buf[start] === 13 && buf[start + 1] === 10) start += 2;

      const next = buf.indexOf(sep, start);
      if (next === -1) break;

      const part = buf.slice(start, next);
      const hSep = part.indexOf(Buffer.from('\r\n\r\n'));
      if (hSep !== -1) {
        parts.push({
          headers: part.slice(0, hSep).toString('utf8'),
          body: this.trimCrlf(part.slice(hSep + 4)),
        });
      }
      pos = next;
    }
    return parts;
  }

  private trimCrlf(b: Buffer): Buffer {
    let end = b.length;
    while (end >= 2 && b[end - 2] === 13 && b[end - 1] === 10) end -= 2;
    return b.slice(0, end);
  }
}

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface ParsedEvent {
  kind: 'json' | 'xml' | 'multipart' | 'unknown';
  employeeNo?: string;
  deviceId?: string;
  deviceName?: string;
  eventTime?: string;
  terminalEventType: TerminalEventType | null;
  eventRaw?: any;
  snapshotBytes?: Buffer;
}

function emptyEvent(): ParsedEvent {
  return { kind: 'unknown', terminalEventType: null };
}
