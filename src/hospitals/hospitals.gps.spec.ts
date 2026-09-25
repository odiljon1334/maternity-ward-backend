import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { HospitalsController } from './hospitals.controller';

/**
 * Geofence markazini boshqarish — faqat o'z muassasasi (2026-09-23 audit, 4a).
 */
function makeController(assistantHospitals: string[] = []) {
  const svc: any = {
    resolveAllowedHospitalIds: jest.fn(async (role: string) =>
      role === 'ASSISTANT_ADMIN' ? assistantHospitals : null,
    ),
    updateGpsRadius: jest.fn(async () => ({})),
    resetGps: jest.fn(async () => ({})),
    resetTelegramSubs: jest.fn(async () => ({})),
    getGps: jest.fn(async () => ({})),
    setGps: jest.fn(async () => ({})),
  };
  return { ctrl: new HospitalsController(svc), svc };
}

const director = { sub: 'u1', role: UserRole.DIRECTOR, hospitalId: 'hA' };

describe('HospitalsController — GPS muassasa chegarasi', () => {
  it("DIRECTOR boshqa muassasa radiusini o'zgartira olmaydi", async () => {
    const { ctrl, svc } = makeController();
    await expect(ctrl.updateGpsRadius('hB', 500, director)).rejects.toThrow(
      ForbiddenException,
    );
    expect(svc.updateGpsRadius).not.toHaveBeenCalled();
  });

  it('DIRECTOR boshqa muassasa markazini tozalay olmaydi', async () => {
    const { ctrl, svc } = makeController();
    await expect(ctrl.resetGps('hB', director)).rejects.toThrow(
      ForbiddenException,
    );
    expect(svc.resetGps).not.toHaveBeenCalled();
  });

  it("DIRECTOR o'z muassasasida ishlaydi", async () => {
    const { ctrl, svc } = makeController();
    await ctrl.updateGpsRadius('hA', 300, director);
    expect(svc.updateGpsRadius).toHaveBeenCalledWith('hA', 300);
  });

  it('ASSISTANT_ADMIN faqat biriktirilgan muassasada', async () => {
    const { ctrl, svc } = makeController(['hA']);
    const asst = { sub: 'u2', role: UserRole.ASSISTANT_ADMIN };
    await expect(ctrl.resetTelegramSubs('hB', asst)).rejects.toThrow(
      ForbiddenException,
    );
    await ctrl.resetTelegramSubs('hA', asst);
    expect(svc.resetTelegramSubs).toHaveBeenCalledWith('hA');
  });

  it('SUPER_ADMIN istalgan muassasada', async () => {
    const { ctrl, svc } = makeController();
    await ctrl.resetGps('hZ', { sub: 's', role: UserRole.SUPER_ADMIN });
    expect(svc.resetGps).toHaveBeenCalledWith('hZ');
  });

  it("me/gps faqat JWT'dagi muassasaga yoziladi", async () => {
    const { ctrl, svc } = makeController();
    await ctrl.setOwnGps('hA', { lat: 41.3, lng: 69.2, radius: 150 });
    expect(svc.setGps).toHaveBeenCalledWith('hA', {
      lat: 41.3,
      lng: 69.2,
      radius: 150,
    });
    expect(() => ctrl.setOwnGps('', { lat: 1, lng: 1 })).toThrow(
      ForbiddenException,
    );
  });

  it('asosiy bino: SUPER_ADMIN tanlangan muassasani belgilaydi', async () => {
    const { ctrl, svc } = makeController();
    const dto = { lat: 40.78, lng: 72.34, radius: 150 } as any;
    await ctrl.setHospitalGps('hZ', dto, {
      sub: 's',
      role: UserRole.SUPER_ADMIN,
    });
    expect(svc.setGps).toHaveBeenCalledWith('hZ', dto);
  });

  it('asosiy bino: ASSISTANT_ADMIN faqat biriktirilgan, DIRECTOR faqat o‘ziniki', async () => {
    const { ctrl, svc } = makeController(['hA']);
    const asst = { sub: 'u2', role: UserRole.ASSISTANT_ADMIN };
    const dto = { lat: 1, lng: 1 } as any;
    await expect(ctrl.setHospitalGps('hB', dto, asst)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(ctrl.getHospitalGps('hB', director)).rejects.toThrow(
      ForbiddenException,
    );
    await ctrl.getHospitalGps('hA', director);
    expect(svc.getGps).toHaveBeenCalledWith('hA');
    expect(svc.setGps).not.toHaveBeenCalled();
  });
});
