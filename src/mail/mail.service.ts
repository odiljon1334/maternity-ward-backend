import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

/**
 * MailService — Resend orqali email yuborish.
 *
 * .env kerakli o'zgaruvchilar:
 *   RESEND_API_KEY   — resend.com dashboard'idan olinadi
 *   MAIL_FROM        — masalan: "MaternityCare <no-reply@clinicuk24.com>"
 *                       (clinicuk24.com Resend'da domen sifatida tasdiqlangandan keyin ishlaydi;
 *                       tasdiqlanmaguncha test uchun "onboarding@resend.dev" ishlatiladi)
 *
 * RESEND_API_KEY berilmagan bo'lsa — servis xato tashlamaydi, faqat log yozadi
 * va false qaytaradi. Bu production'dagi boshqa funksiyalarni (login va h.k.)
 * email sozlanmagan taqdirda ham ishlab turishini kafolatlaydi.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    this.from =
      this.config.get<string>('MAIL_FROM') ||
      'MaternityCare <onboarding@resend.dev>';

    if (!apiKey) {
      this.logger.warn(
        'RESEND_API_KEY sozlanmagan — email yuborish o\'chirilgan (faqat log qilinadi)',
      );
      this.resend = null;
    } else {
      this.resend = new Resend(apiKey);
    }
  }

  /** OTP kod yuboruvchi email — email tasdiqlash uchun */
  async sendOtpEmail(to: string, code: string, fullName?: string) {
    const greeting = fullName ? `Hurmatli ${fullName},` : 'Assalomu alaykum,';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#111827;">MaternityCare — Email tasdiqlash</h2>
        <p>${greeting}</p>
        <p>Email manzilingizni tasdiqlash uchun quyidagi kodni kiriting:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f3f4f6;padding:16px 24px;border-radius:8px;text-align:center;color:#111827;">
          ${code}
        </div>
        <p style="color:#6b7280;font-size:13px;margin-top:16px;">
          Kod 10 daqiqa amal qiladi. Agar bu so'rovni siz yubormagan bo'lsangiz, xabarni e'tiborsiz qoldiring.
        </p>
      </div>`;
    return this.send(to, 'MaternityCare — Email tasdiqlash kodi', html);
  }

  /** Parolni tiklash havolasi — link bosilgach yangi parol qo'yiladi */
  async sendPasswordResetEmail(
    to: string,
    resetUrl: string,
    fullName?: string,
  ) {
    const greeting = fullName ? `Hurmatli ${fullName},` : 'Assalomu alaykum,';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#111827;">MaternityCare — Parolni tiklash</h2>
        <p>${greeting}</p>
        <p>Parolingizni tiklash uchun quyidagi tugmani bosing:</p>
        <p style="text-align:center;margin:24px 0;">
          <a href="${resetUrl}" style="background:#4f46e5;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
            Parolni tiklash
          </a>
        </p>
        <p style="color:#6b7280;font-size:13px;">
          Havola 15 daqiqa amal qiladi. Agar bu so'rovni siz yubormagan bo'lsangiz, xabarni e'tiborsiz qoldiring — parolingiz o'zgarmaydi.
        </p>
        <p style="color:#9ca3af;font-size:12px;word-break:break-all;">${resetUrl}</p>
      </div>`;
    return this.send(to, 'MaternityCare — Parolni tiklash', html);
  }

  private async send(to: string, subject: string, html: string): Promise<boolean> {
    if (!this.resend) {
      this.logger.warn(
        `[MOCK EMAIL — RESEND_API_KEY yo'q] to=${to} subject="${subject}"`,
      );
      return false;
    }
    try {
      const { error } = await this.resend.emails.send({
        from: this.from,
        to,
        subject,
        html,
      });
      if (error) {
        this.logger.error(`Resend xatolik: ${JSON.stringify(error)}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Email yuborishda xatolik: ${err}`);
      return false;
    }
  }
}
