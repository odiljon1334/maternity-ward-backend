import {
  addPeriods,
  buildCoverage,
  coverageLabel,
  billingStartPeriods,
  isPeriodCovered,
  lastPaidPeriod,
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

  it("keyingi to'lov oyi: oynadagi eng eski to'lanmagan oy (avto-blok bilan bir xil 3 oy)", () => {
    const now = new Date('2026-09-24T10:00:00+05:00');
    const set = (xs: string[]) => (p: string) => xs.includes(p);
    // Hech narsa to'lanmagan — 3 oy oldingi oy (blok aynan shunga qaraydi)
    expect(billingStartPeriods(set([]), { now }).monthly).toBe('2026-06');
    // Hammasi to'langan — joriy oy
    expect(
      billingStartPeriods(set(['2026-06', '2026-07', '2026-08']), { now })
        .monthly,
    ).toBe('2026-09');
    // Bo'shliq: iyul to'lanmagan — avval iyul
    expect(
      billingStartPeriods(set(['2026-06', '2026-08', '2026-09']), { now })
        .monthly,
    ).toBe('2026-07');
    // Oldindan to'langan — birinchi qoplanmagan kelgusi oy
    expect(
      billingStartPeriods(
        set(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']),
        { now },
      ).monthly,
    ).toBe('2026-11');
    // Sinov davri sentyabrda tugagan yangi muassasa — sentyabrdan
    expect(
      billingStartPeriods(set([]), { now, firstBillable: '2026-09' }).monthly,
    ).toBe('2026-09');
  });

  it('yillik boshlanish 12 oyning birortasi qoplangan oyga tushmaydi', () => {
    const now = new Date('2026-09-24T10:00:00+05:00');
    const paid = ['2026-06', '2026-08', '2026-09'];
    const r = billingStartPeriods((p) => paid.includes(p), { now });
    expect(r.monthly).toBe('2026-07'); // bo'shliq oylik to'lanadi
    expect(r.annual).toBe('2026-10'); // yillik to'langan oylar ustiga tushmaydi
  });

  it("xodim qo'shilsa to'lov paytida to'liq to'langan oy qarzga aylanmaydi", () => {
    // 50 xodim × 15 000 = 750 000 to'langan; endi 51 xodim (765 000 kutiladi)
    const cov = buildCoverage([
      { period: '2026-08', months: 1, amount: 750_000, employeeCount: 50 },
    ]);
    expect(isPeriodCovered(765_000, cov.get('2026-08'))).toBe(true);
    // Snapshotsiz eski yozuv — joriy summa bilan solishtiriladi
    const old = buildCoverage([
      { period: '2026-08', months: 1, amount: 750_000 },
    ]);
    expect(isPeriodCovered(765_000, old.get('2026-08'))).toBe(false);
    // Snapshot bo'yicha ham kam to'langan — to'lanmagan
    const short = buildCoverage([
      { period: '2026-08', months: 1, amount: 700_000, employeeCount: 50 },
    ]);
    expect(isPeriodCovered(765_000, short.get('2026-08'))).toBe(false);
  });

  it("bot invoysi bilan to'langan oy to'liq qoplangan; kelishilgan narx (501+) — har qanday to'lov", () => {
    const inv = buildCoverage([
      { period: '2026-08', months: 1, amount: 100, invoiceId: 'inv-1' },
    ]);
    expect(isPeriodCovered(999_999, inv.get('2026-08'))).toBe(true);
    const nego = buildCoverage([
      { period: '2026-08', months: 1, amount: 5_000_000, employeeCount: 700 },
    ]);
    expect(isPeriodCovered(8_400_000, nego.get('2026-08'))).toBe(true);
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
