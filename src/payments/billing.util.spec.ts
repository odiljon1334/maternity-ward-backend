import {
  addPeriods,
  buildCoverage,
  coverageLabel,
  lastPaidPeriod,
  nextBillablePeriod,
  periodEnd,
  periodOf,
  periodPaidAmount,
  periodStatus,
} from './billing.util';

describe('billing.util — obuna qoplamasi', () => {
  it("addPeriods yil chegarasidan va orqaga to'g'ri o'tadi", () => {
    expect(addPeriods('2026-11', 3)).toBe('2027-02');
    expect(addPeriods('2026-01', -1)).toBe('2025-12');
    // Eski setMonth(-1) xatosi: 31-martda "o'tgan oy" mart bo'lib qolardi
    expect(
      addPeriods(periodOf(new Date('2026-03-31T10:00:00+05:00')), -1),
    ).toBe('2026-02');
  });

  it("oy Toshkent vaqti bo'yicha aniqlanadi (server UTC bo'lsa ham)", () => {
    // 30-sentabr 20:00 UTC = 1-oktabr 01:00 Toshkent
    expect(periodOf(new Date('2026-09-30T20:00:00Z'))).toBe('2026-10');
    expect(periodEnd('2026-02').toISOString()).toBe('2026-02-28T18:59:59.999Z');
  });

  it("yillik to'lov 12 oyni to'liq qoplaydi, daromad oylarga teng bo'linadi", () => {
    const cov = buildCoverage([
      { period: '2026-09', months: 12, amount: 1_200_000 },
    ]);
    expect(cov.get('2026-09')?.prepaid).toBe(true);
    expect(cov.get('2027-08')?.prepaid).toBe(true);
    expect(cov.get('2027-09')).toBeUndefined();
    expect(cov.get('2026-12')?.recognized).toBe(100_000);
    // Yillik chegirmali summa (oylikdan kam) baribir "to'langan" hisoblanadi
    expect(periodStatus('2026-12', 150_000, cov.get('2026-12'))).toBe('PAID');
    expect(periodPaidAmount(150_000, cov.get('2026-12'))).toBe(150_000);
  });

  it("oylik qisman to'lovlar yig'iladi; yetmasa — muddatida PENDING, keyin OVERDUE", () => {
    const cov = buildCoverage([
      { period: '2026-08', amount: 50_000 },
      { period: '2026-08', amount: 40_000 },
    ]);
    expect(cov.get('2026-08')?.paidAmount).toBe(90_000);
    const inAugust = new Date('2026-08-20T10:00:00+05:00');
    const inSeptember = new Date('2026-09-02T10:00:00+05:00');
    expect(periodStatus('2026-08', 100_000, cov.get('2026-08'), inAugust)).toBe(
      'PENDING',
    );
    expect(
      periodStatus('2026-08', 100_000, cov.get('2026-08'), inSeptember),
    ).toBe('OVERDUE');
    expect(
      periodStatus('2026-08', 90_000, cov.get('2026-08'), inSeptember),
    ).toBe('PAID');
  });

  it("davri yo'q eski yozuv to'langan oyiga tegishli bo'ladi", () => {
    const cov = buildCoverage([
      { period: null, paidAt: '2026-07-15T08:00:00Z', amount: 10 },
    ]);
    expect(cov.get('2026-07')?.paidAmount).toBe(10);
  });

  it("keyingi to'lov oyi: uzluksiz davom, 2 oydan ortiq orqaga qaytmaydi", () => {
    const now = new Date('2026-09-24T10:00:00+05:00');
    expect(nextBillablePeriod(null, now)).toBe('2026-09');
    expect(nextBillablePeriod('2026-08', now)).toBe('2026-09');
    expect(nextBillablePeriod('2026-06', now)).toBe('2026-07'); // qarz oyi birinchi
    expect(nextBillablePeriod('2025-12', now)).toBe('2026-07'); // juda eski — 2 oy chegarasi
    expect(nextBillablePeriod('2026-12', now)).toBe('2027-01'); // oldindan to'lov
  });

  it("oxirgi to'langan oy: yillik va to'liq oylik hisobga olinadi, qisman emas", () => {
    const cov = buildCoverage([
      { period: '2026-01', months: 12, amount: 1 },
      { period: '2027-01', amount: 50 }, // qisman
    ]);
    expect(lastPaidPeriod(cov, 100)).toBe('2026-12');
  });

  it('qoplama matni', () => {
    expect(coverageLabel('2026-09', 1)).toBe('Sentabr 2026');
    expect(coverageLabel('2026-09', 12)).toBe('Sentabr 2026 – Avgust 2027');
  });
});
