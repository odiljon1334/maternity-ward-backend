import {
  Controller, Post, HttpCode, Logger, Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AttendanceService, HikvisionEvent } from './attendance.service';
import { TelegramService } from '../telegram/telegram.service';
import { Request } from 'express';

/** Hikvision qurilmalari tez-tez so'rov yuboradi — rate limit o'chirilgan */
@SkipThrottle({ default: true, login: true })
@Controller('hikvision')
export class HikvisionWebhookController {
  private readonly logger = new Logger(HikvisionWebhookController.name);

  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly telegramService: TelegramService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(@Req() req: Request) {
    const ct = String(req.headers['content-type'] || '');
    const body = req.body as Buffer;

    this.logger.log(`Hikvision webhook ct=${ct.split(';')[0]} size=${body?.length ?? 0}b`);

    const parsed = this.parseHikvisionPayload(ct, body);
    this.logger.log(`Parsed: employeeNo=${parsed.employeeNo} eventTime=${parsed.eventTime} kind=${parsed.kind}`);

    if (!parsed.employeeNo) {
      const raw = JSON.stringify(parsed.eventRaw) ?? '';
      // AccessControllerEvent ichida employeeNoString borligini alohida log qilamiz
      const ace = parsed.eventRaw?.AccessControllerEvent;
      this.logger.warn(
        `No employeeNo found.\n` +
        `  AccessControllerEvent keys: ${ace ? Object.keys(ace).join(', ') : 'none'}\n` +
        `  employeeNoString: ${ace?.employeeNoString}\n` +
        `  employeeNo: ${ace?.employeeNo}\n` +
        `  Full raw (800ch): ${raw.slice(0, 800)}`
      );
      return { status: 'ignored' };
    }

    const event: HikvisionEvent = {
      employeeNo: parsed.employeeNo,
      deviceId: parsed.deviceId,
      eventTime: parsed.eventTime,
      raw: parsed.eventRaw,
    };

    try {
      const result = await this.attendanceService.processHikvisionEvent(event);

      if (result) {
        // Terminaldan kelgan real-time rasm (snapshot) — DB rasmdan ustun turadi
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

  // ─── PARSER ─────────────────────────────────────────────────────────────────

  private parseHikvisionPayload(ct: string, body?: Buffer): {
    kind: 'json' | 'xml' | 'multipart' | 'unknown';
    employeeNo?: string;
    deviceId?: string;
    eventTime?: string;
    eventRaw?: any;
    snapshotBytes?: Buffer;
  } {
    if (!body || body.length === 0) return { kind: 'unknown' };

    // ── JSON ──────────────────────────────────────────────────────────────────
    if (ct.includes('application/json')) {
      try {
        const obj = JSON.parse(body.toString('utf8'));
        return {
          kind: 'json',
          employeeNo: this.extractEmployeeNo(obj),
          deviceId: this.extractDeviceId(obj),
          eventTime: this.extractEventTime(obj),
          eventRaw: obj,
        };
      } catch {
        return { kind: 'unknown', eventRaw: body.toString('utf8') };
      }
    }

    // ── XML ───────────────────────────────────────────────────────────────────
    if (ct.includes('xml') || ct.includes('text/plain')) {
      const xml = body.toString('utf8');
      return {
        kind: 'xml',
        employeeNo: this.extractEmployeeNoXml(xml),
        deviceId: this.extractDeviceIdXml(xml),
        eventTime: this.extractEventTimeXml(xml),
        eventRaw: xml,
      };
    }

    // ── MULTIPART ─────────────────────────────────────────────────────────────
    if (ct.includes('multipart')) {
      const boundaryMatch = ct.match(/boundary=([^;]+)/i);
      const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^"|"$/g, '') : '';
      if (!boundary) return { kind: 'multipart', eventRaw: 'no-boundary' };

      const parts = this.splitMultipart(body, boundary);
      let jsonObj: any;
      let xmlText: string | undefined;
      let snap: Buffer | undefined;

      for (const p of parts) {
        const h = p.headers.toLowerCase();

        // JSON part
        if (!jsonObj && h.includes('application/json')) {
          try { jsonObj = JSON.parse(p.body.toString('utf8')); } catch { /* skip */ }
        }

        // XML part
        if (!xmlText && (h.includes('xml') || h.includes('text/plain'))) {
          const t = p.body.toString('utf8');
          if (t.includes('<')) xmlText = t;
        }

        // Snapshot image
        if (!snap) {
          const isJpeg = h.includes('image/jpeg') || h.includes('image/jpg') || h.includes('image/png');
          const hasFilename = /filename=["']?[^"'\s]*\.(jpg|jpeg|png)/i.test(h);
          const jpegMagic = p.body.length > 3 && p.body[0] === 0xff && p.body[1] === 0xd8 && p.body[2] === 0xff;
          if (isJpeg || hasFilename || jpegMagic) snap = p.body;
        }
      }

      // Fallback: try to parse any part as JSON
      if (!jsonObj) {
        for (const p of parts) {
          try {
            const t = p.body.toString('utf8').trim();
            if (t.startsWith('{') && t.endsWith('}')) { jsonObj = JSON.parse(t); break; }
          } catch { /* skip */ }
        }
      }

      // Fallback: XML from any part with '<'
      if (!xmlText) {
        const maybe = parts.find(p => p.body.toString('utf8').includes('<'));
        if (maybe) xmlText = maybe.body.toString('utf8');
      }

      const employeeNo = jsonObj
        ? this.extractEmployeeNo(jsonObj)
        : xmlText ? this.extractEmployeeNoXml(xmlText) : undefined;

      const deviceId = jsonObj
        ? this.extractDeviceId(jsonObj)
        : xmlText ? this.extractDeviceIdXml(xmlText) : undefined;

      const eventTime = jsonObj
        ? this.extractEventTime(jsonObj)
        : xmlText ? this.extractEventTimeXml(xmlText) : undefined;

      return {
        kind: 'multipart',
        employeeNo,
        deviceId,
        eventTime,
        eventRaw: jsonObj ?? xmlText ?? '(multipart-no-data)',
        snapshotBytes: snap,
      };
    }

    // ── Unknown — try JSON anyway ─────────────────────────────────────────────
    try {
      const obj = JSON.parse(body.toString('utf8'));
      return { kind: 'json', employeeNo: this.extractEmployeeNo(obj), eventRaw: obj };
    } catch { /* skip */ }

    return { kind: 'unknown', eventRaw: body.toString('utf8') };
  }

  // ─── Extract helpers ─────────────────────────────────────────────────────────

  private extractEmployeeNo(obj: any): string | undefined {
    const v =
      obj?.employeeNo || obj?.EmployeeNo ||
      obj?.employeeNoString || obj?.EmployeeNoString ||
      obj?.cardNo || obj?.personId ||
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
      obj?.deviceId || obj?.deviceID || obj?.DeviceID ||
      obj?.ipAddress ||
      obj?.AccessControllerEvent?.deviceId ||
      obj?.Events?.[0]?.deviceId;
    return v ? String(v).trim() : undefined;
  }

  private extractEventTime(obj: any): string | undefined {
    const v =
      obj?.dateTime || obj?.DateTime || obj?.eventTime ||
      obj?.triggerTime || obj?.TriggerTime ||
      obj?.AccessControllerEvent?.dateTime ||
      obj?.AccessControllerEvent?.DateTime ||
      obj?.Events?.[0]?.dateTime || obj?.Events?.[0]?.time;
    return v ? String(v).trim() : undefined;
  }

  private extractEmployeeNoXml(xml: string): string | undefined {
    let m = xml.match(/<employeeNo[^>]*>\s*([^<]+)\s*<\/employeeNo>/i);
    if (m?.[1]) return m[1].trim();
    m = xml.match(/<FPID>\s*([^<]+)\s*<\/FPID>/i);
    if (m?.[1]) return m[1].trim();
    m = xml.match(/employeeNo\s*=\s*"([^"]+)"/i);
    if (m?.[1]) return m[1].trim();
    return undefined;
  }

  private extractDeviceIdXml(xml: string): string | undefined {
    let m = xml.match(/<deviceID[^>]*>\s*([^<]+)\s*<\/deviceID>/i);
    if (m?.[1]) return m[1].trim();
    m = xml.match(/<serialNumber>\s*([^<]+)\s*<\/serialNumber>/i);
    if (m?.[1]) return m[1].trim();
    return undefined;
  }

  private extractEventTimeXml(xml: string): string | undefined {
    let m = xml.match(/<dateTime[^>]*>\s*([^<]+)\s*<\/dateTime>/i);
    if (m?.[1]) return m[1].trim();
    m = xml.match(/<triggerTime[^>]*>\s*([^<]+)\s*<\/triggerTime>/i);
    if (m?.[1]) return m[1].trim();
    return undefined;
  }

  // ─── Multipart splitter ──────────────────────────────────────────────────────

  private splitMultipart(buf: Buffer, boundary: string): Array<{ headers: string; body: Buffer }> {
    const boundaryBuf = Buffer.from(`--${boundary}`);
    const endBoundaryBuf = Buffer.from(`--${boundary}--`);
    const parts: Array<{ headers: string; body: Buffer }> = [];

    let start = buf.indexOf(boundaryBuf);
    if (start === -1) return parts;

    while (start !== -1) {
      if (buf.indexOf(endBoundaryBuf, start) === start) break;

      let partStart = start + boundaryBuf.length;
      if (buf[partStart] === 13 && buf[partStart + 1] === 10) partStart += 2;

      const next = buf.indexOf(boundaryBuf, partStart);
      if (next === -1) break;

      const partBuf = buf.slice(partStart, next);
      const sep = partBuf.indexOf(Buffer.from('\r\n\r\n'));
      if (sep !== -1) {
        parts.push({
          headers: partBuf.slice(0, sep).toString('utf8'),
          body: this.trimCrlf(partBuf.slice(sep + 4)),
        });
      }

      start = next;
    }

    return parts;
  }

  private trimCrlf(b: Buffer): Buffer {
    let end = b.length;
    while (end >= 2 && b[end - 2] === 13 && b[end - 1] === 10) end -= 2;
    return b.slice(0, end);
  }
}
