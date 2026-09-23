import { LeaveController, scopeHospitalId } from './leave.controller';

/**
 * Leave — muassasalar orasidagi izolyatsiya (2026-09-23 audit, 3-band).
 * Tenant rollari (DIRECTOR/ADMIN/DEPARTMENT_HEAD) `?targetHospitalId=`
 * orqali boshqa muassasaga o'ta olmasligi kerak.
 */
function makeController() {
  const svc: any = {
    getAll: jest.fn(async () => ({})),
    review: jest.fn(async () => ({})),
    revokeApproval: jest.fn(async () => ({})),
  };
  return { ctrl: new LeaveController(svc), svc };
}

describe('LeaveController — muassasa chegarasi', () => {
  it("DIRECTOR ?targetHospitalId=B bilan faqat o'z muassasasi (A) ro'yxatini oladi", async () => {
    const { ctrl, svc } = makeController();
    await ctrl.getAll('hA', 'hB');
    expect(svc.getAll).toHaveBeenCalledWith('hA', expect.anything());
  });

  it("DIRECTOR boshqa muassasa so'rovini ko'rib chiqishda o'z muassasasi bilan tekshiriladi", async () => {
    const { ctrl, svc } = makeController();
    await ctrl.review(
      'leave-1',
      'u1',
      'hA',
      { status: 'APPROVED' } as any,
      'hB',
    );
    expect(svc.review).toHaveBeenCalledWith(
      'leave-1',
      'u1',
      expect.anything(),
      'hA',
    );
  });

  it("DIRECTOR boshqa muassasa ta'tilini qaytara olmaydi (revoke ham JWT bilan)", async () => {
    const { ctrl, svc } = makeController();
    await ctrl.revoke('leave-1', 'hA', 'hB');
    expect(svc.revokeApproval).toHaveBeenCalledWith('leave-1', 'hA');
  });

  it("SUPER_ADMIN (JWT'da muassasa yo'q) tanlangan muassasa bilan ishlaydi", async () => {
    const { ctrl, svc } = makeController();
    await ctrl.getAll(null, 'hB');
    expect(svc.getAll).toHaveBeenCalledWith('hB', expect.anything());
  });

  it('scopeHospitalId: JWT ustun, bo‘lmasa target, bo‘lmasa bo‘sh', () => {
    expect(scopeHospitalId('hA', 'hB')).toBe('hA');
    expect(scopeHospitalId(null, 'hB')).toBe('hB');
    expect(scopeHospitalId(undefined)).toBe('');
  });
});
