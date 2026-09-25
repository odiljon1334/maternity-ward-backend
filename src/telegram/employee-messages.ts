/**
 * Xodimga shaxsiy Telegram xabarlari (eslatma, kelish/ketish).
 *
 * Har bir xabarning bir nechta varianti bor — har kuni bir xil matn kelib,
 * "robot" taassurotini bermasligi uchun. Variant kun raqami bo'yicha
 * tanlanadi (tasodifiy emas) — test va takroriy yuborishda barqaror.
 */

export const esc = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "Karimova Dilnoza Akmalovna" → "Dilnoza" (murojaatda ism ishlatiladi) */
export function firstNameOf(fullName?: string | null): string {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  return parts[1] ?? parts[0] ?? '';
}

export function durationUz(totalMin: number): string {
  const m = Math.max(0, Math.round(totalMin));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} daq`;
  return r ? `${h} soat ${r} daq` : `${h} soat`;
}

function pick<T>(variants: T[], seed: number): T {
  return variants[Math.abs(seed) % variants.length];
}

/** Toshkent bo'yicha yil kuni (variant tanlash uchun) */
export function daySeed(d = new Date()): number {
  return Math.floor((d.getTime() + 5 * 3600_000) / 86_400_000);
}

function greetingFor(hhmm: string): string {
  const h = Number(hhmm.split(':')[0]);
  if (h >= 5 && h < 11) return 'Xayrli tong';
  if (h >= 11 && h < 17) return 'Xayrli kun';
  if (h >= 17 && h < 22) return 'Xayrli kech';
  return 'Xayrli tun';
}

export type ReminderInput = {
  fullName?: string | null;
  start: string; // "08:00"
  shiftName?: string | null;
  minutesLeft: number;
  seed?: number;
};

export function checkinReminderText(i: ReminderInput): string {
  const name = esc(firstNameOf(i.fullName) || 'hurmatli xodim');
  const shift = i.shiftName ? ` (${esc(i.shiftName)})` : '';
  const left =
    i.minutesLeft > 1
      ? `\n⏳ Boshlanishiga ${i.minutesLeft} daqiqa qoldi.`
      : '';
  const seed = i.seed ?? daySeed();
  return pick(
    [
      `🌅 ${greetingFor(i.start)}, ${name}!\n\n📅 Bugungi ish boshlanishi: <b>${i.start}</b>${shift}${left}\n\nCheck-in qilishni unutmang 🙂`,
      `☀️ ${name}, ish kuningiz <b>${i.start}</b> da boshlanadi${shift}.${left}\n\nIsh joyiga yetib kelgach, StaffPlusPRO ilovasida yoki terminalda check-in qiling ✅`,
      `⏰ Eslatma: bugungi smena — <b>${i.start}</b>${shift}.${left}\n\n${greetingFor(i.start)}, ${name}! Check-in qilishni unutmang.`,
    ],
    seed,
  );
}

export type CheckInInput = {
  fullName?: string | null;
  time: string;
  lateMinutes?: number | null;
  place?: string | null;
  night?: boolean;
  seed?: number;
};

export function checkedInText(i: CheckInInput): string {
  const name = esc(firstNameOf(i.fullName) || '');
  const hi = name ? `, ${name}` : '';
  const place = i.place ? `\n📍 ${esc(i.place)}` : '';
  const seed = i.seed ?? daySeed();
  if (i.lateMinutes && i.lateMinutes > 0) {
    return (
      `⏰ Kelishingiz qayd etildi — <b>${i.time}</b>${place}\n` +
      `Kechikish: ${i.lateMinutes} daqiqa.\n\n` +
      (i.night
        ? `Tungi smenangiz tinch o'tsin${hi} 🌙`
        : `Kuningiz xayrli o'tsin${hi}!`)
    );
  }
  if (i.night) {
    return `✅ Kelishingiz qayd etildi — <b>${i.time}</b>${place}\n\nTungi smenangiz tinch va xotirjam o'tsin${hi} 🌙`;
  }
  return pick(
    [
      `✅ Kelishingiz qayd etildi — <b>${i.time}</b>${place}\n\nKuningiz xayrli o'tsin${hi}! ☀️`,
      `✅ <b>${i.time}</b> — xush kelibsiz${hi}!${place}\n\nSamarali va omadli kun tilaymiz 💪`,
      `✅ Check-in: <b>${i.time}</b>${place}\n\nO'z vaqtida keldingiz — rahmat! Kuningiz yaxshi o'tsin 🌿`,
    ],
    seed,
  );
}

export type CheckOutInput = {
  fullName?: string | null;
  time: string;
  workedMin?: number | null;
  earlyLeaveMin?: number | null;
  overtimeMin?: number | null;
  seed?: number;
};

export function checkedOutText(i: CheckOutInput): string {
  const name = esc(firstNameOf(i.fullName) || '');
  const hi = name ? `, ${name}` : '';
  const worked =
    i.workedMin && i.workedMin > 0 ? durationUz(i.workedMin) : null;
  const extra =
    (i.earlyLeaveMin && i.earlyLeaveMin > 0
      ? `\n⚠️ Smena tugashidan ${i.earlyLeaveMin} daqiqa oldin ketdingiz.`
      : '') +
    (i.overtimeMin && i.overtimeMin > 0
      ? `\n➕ Qo'shimcha ish: ${durationUz(i.overtimeMin)}`
      : '');
  const seed = i.seed ?? daySeed();
  const workedLine = worked
    ? `\n⏱ Bugun ishlagan vaqtingiz: <b>${worked}</b>`
    : '';
  return pick(
    [
      `👋 Ketishingiz qayd etildi — <b>${i.time}</b>${workedLine}${extra}\n\nRahmat${hi}! Yaxshi dam oling 🌙`,
      `🏁 Ish kuni yakunlandi — <b>${i.time}</b>${workedLine}${extra}\n\nMehnatingiz uchun rahmat${hi}! Uyingizga eson-omon yetib boring 🏡`,
      `✅ Check-out: <b>${i.time}</b>${workedLine}${extra}\n\nBugun ham yaxshi ishladingiz${hi}. Hordiq chiqaring ☕`,
    ],
    seed,
  );
}

export function checkoutDueText(i: {
  fullName?: string | null;
  end: string;
}): string {
  const name = esc(firstNameOf(i.fullName) || '');
  return (
    `⏰ ${name ? `${name}, i` : 'I'}sh vaqtingiz <b>${i.end}</b> da tugadi.\n\n` +
    'Ketishni belgilashni unutmang — ilovada «Ketishni tasdiqlash» yoki terminal orqali.'
  );
}

export function linkedText(
  links: { fullName: string; hospitalName: string }[],
): string {
  const name = esc(firstNameOf(links[0]?.fullName) || links[0]?.fullName || '');
  const places = links.map((l) => `🏥 ${esc(l.hospitalName)}`).join('\n');
  return (
    `✅ Ulandingiz${name ? `, ${name}` : ''}!\n${places}\n\n` +
    'Endi shu yerga keladi:\n' +
    '• ish boshlanishidan 30 daqiqa oldin eslatma\n' +
    '• kelish va ketish qayd etilgani haqida xabar\n' +
    "• so'rovlaringiz (ta'til va boshqalar) natijasi"
  );
}
