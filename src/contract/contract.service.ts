import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { getStaffPricing, formatSom } from '../common/utils/pricing.util';

export interface TrialContractData {
  fullName: string;
  phone: string;
  institutionName: string;
  staffCount?: number | null;
  plan?: 'start' | 'biznes' | 'korporativ' | null;
  faceId?: boolean | null;
  contactTime?: string | null;
}

const PLAN_LABELS: Record<string, string> = {
  start: "Start (1 – 14 xodim, 599 000 so'm/oy FIKS)",
  biznes: "Biznes (15 – 199 xodim, 15 000 so'm/xodim/oy)",
  korporativ:
    "Korporativ (200 – 500 xodim, 12 000 so'm/xodim/oy; 500+ kelishiladi)",
};

/**
 * Xodimlar soniga qarab narx tavsifini shakllantiradi (yagona manba:
 * src/common/utils/pricing.util.ts). Agar xodimlar soni hali noma'lum
 * bo'lsa — barcha bosqichlar qisqacha sanab o'tiladi.
 */
function priceDescription(staffCount?: number | null): string {
  if (staffCount == null) {
    return (
      "1\u201314 xodim: 599 000 so'm/oy (FIKS) \u00b7 15\u2013199: 15 000 so'm/xodim/oy \u00b7 " +
      "200\u2013500: 12 000 so'm/xodim/oy \u00b7 500+: kelishiladi"
    );
  }
  const pricing = getStaffPricing(staffCount);
  if (pricing.negotiated) {
    return `${staffCount} xodim uchun kelishiladi (individual muzokara)`;
  }
  if (pricing.isFlat && pricing.flatMonthly != null) {
    return `${formatSom(pricing.flatMonthly)} so'm / oy (FIKS narx, ${staffCount} xodimgacha)`;
  }
  if (pricing.perEmployeeMonthly != null && pricing.perEmployeeAnnual != null) {
    return `${formatSom(pricing.perEmployeeMonthly)} so'm / xodim / oy (yoki ${formatSom(pricing.perEmployeeAnnual)} so'm / xodim / yil)`;
  }
  return 'Kelishiladi';
}

const COLORS = {
  headerBg: '#4f46e5',
  dark: '#111827',
  muted: '#6b7280',
  border: '#e5e7eb',
  lightBg: '#f9fafb',
};

function fmtDate(d: Date): string {
  return d.toLocaleDateString('uz-UZ', {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Har bir yangi mijoz (14 kunlik sinov so'rovi yoki support bot orqali
 * to'plangan lead) uchun avtomatik shartnoma-oferta PDF hujjatini yaratadi.
 *
 * MUHIM: bu — Odiljon bilan yakuniy shartnoma shabloni kelishilmagani
 * sababli tuzilgan ODDIY, AVTOMATIK loyiha (oferta) hujjati. Yuridik
 * jihatdan yakuniy emas — mijozga "loyiha, operator bilan aniqlashtiring"
 * degan eslatma bilan yuboriladi (pastda, footer'da).
 */
@Injectable()
export class ContractService {
  async generateTrialContractPdf(data: TrialContractData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 40, bottom: 40, left: 50, right: 50 },
        info: {
          Title: `StaffPlusPRO — 14 kunlik sinov shartnomasi — ${data.institutionName}`,
          Author: 'StaffPlusPRO',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = 595 - 100;
      const now = new Date();
      const endDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

      // ── HEADER BANNER ────────────────────────────────────────────────
      doc.rect(50, 40, W, 70).fill(COLORS.headerBg);
      doc
        .fillColor('#ffffff')
        .font('Helvetica-Bold')
        .fontSize(15)
        .text('14 KUNLIK BEPUL SINOV XIZMATI — OFERTA', 50, 55, {
          width: W,
          align: 'center',
        });
      doc
        .font('Helvetica')
        .fontSize(10)
        .text('StaffPlusPRO — HR/Davomat boshqaruv tizimi', 50, 78, {
          width: W,
          align: 'center',
        });

      let y = 130;

      const section = (title: string) => {
        doc.rect(50, y, W, 20).fill(COLORS.lightBg);
        doc
          .fillColor(COLORS.dark)
          .font('Helvetica-Bold')
          .fontSize(10)
          .text(title, 58, y + 5);
        y += 28;
      };

      const row = (label: string, value: string) => {
        doc
          .font('Helvetica')
          .fontSize(9)
          .fillColor(COLORS.muted)
          .text(label, 58, y, { width: 160 });
        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor(COLORS.dark)
          .text(value || '—', 220, y, { width: W - 170 });
        y += 18;
      };

      // ── TARAFLAR ─────────────────────────────────────────────────────
      section("IJROCHI (XIZMAT KO'RSATUVCHI)");
      row('Kompaniya:', 'StaffPlusPRO');
      row('Direktor:', "Akramov Odiljon Rasuljon o'g'li");
      row('Telefon:', '+998 95 577 54 54');
      row('Manzil:', "Andijon shahri, O'zbekiston");
      y += 8;

      section('BUYURTMACHI (MIJOZ)');
      row('F.I.Sh:', data.fullName);
      row('Telefon:', data.phone);
      row('Muassasa nomi:', data.institutionName);
      row(
        'Xodimlar soni:',
        data.staffCount != null ? `${data.staffCount} ta (taxminiy)` : '—',
      );
      y += 8;

      // ── XIZMAT SHARTLARI ─────────────────────────────────────────────
      section('XIZMAT SHARTLARI');
      row(
        'Tanlangan tarif:',
        data.plan ? PLAN_LABELS[data.plan] || data.plan : 'Kelishiladi',
      );
      row('Narx:', priceDescription(data.staffCount));
      row(
        'Sinov muddati:',
        `${fmtDate(now)} — ${fmtDate(endDate)} (14 kun, bepul)`,
      );
      row(
        'FaceID qurilma:',
        data.faceId == null
          ? 'Kelishiladi'
          : data.faceId
            ? "Kerak (qurilma narxi alohida to'lanadi, o'rnatish Andijon hududida BEPUL)"
            : 'Kerak emas (smartfon selfie + GPS orqali)',
      );
      if (data.contactTime) {
        row("Bog'lanish uchun qulay vaqt:", data.contactTime);
      }
      y += 8;

      // ── ESLATMA ──────────────────────────────────────────────────────
      section('ESLATMA');
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(COLORS.muted)
        .text(
          "Ushbu hujjat — mijoz tomonidan taqdim etilgan ma'lumotlar asosida " +
            'avtomatik tuzilgan shartnoma LOYIHASI (oferta). Yakuniy shartnoma ' +
            'shartlari StaffPlusPRO operatori bilan bevosita kelishilib, ' +
            'tasdiqlanadi. Sinov muddati tugagach, tomonlar kelishuvisiz ' +
            "xizmat avtomatik pullik tarifga o'tkazilmaydi.",
          58,
          y,
          { width: W - 16 },
        );
      y += 55;

      // ── IMZOLAR ──────────────────────────────────────────────────────
      const sigW = (W - 20) / 2;
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLORS.dark)
        .text('Ijrochi:', 58, y)
        .text('_______________________', 58, y + 30)
        .text('Sana: _____ / _____ / _______', 58, y + 48);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLORS.dark)
        .text('Buyurtmachi:', 58 + sigW + 10, y)
        .text('_______________________', 58 + sigW + 10, y + 30)
        .text('Sana: _____ / _____ / _______', 58 + sigW + 10, y + 48);

      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(COLORS.muted)
        .text(
          `Avtomatik generatsiya qilindi: ${now.toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}`,
          50,
          780,
          { width: W, align: 'center' },
        );

      doc.end();
    });
  }
}
