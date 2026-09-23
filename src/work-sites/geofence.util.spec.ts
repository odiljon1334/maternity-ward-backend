import { buildGeoCenters, matchGeoCenter } from './geofence.util';

// ~111 m ga teng 0.001 daraja kenglik
const MAIN = {
  name: 'Poliklinika',
  gpsLat: 40.78,
  gpsLng: 72.34,
  gpsRadius: 200,
};
const SCHOOL = {
  id: 'ws-school',
  name: '12-maktab',
  gpsLat: 40.8,
  gpsLng: 72.34,
  gpsRadius: 150,
  isActive: true,
};

describe('geofence.util', () => {
  it('biriktirilgan ish joyi + asosiy bino — ikkalasida ham ruxsat', () => {
    const centers = buildGeoCenters({
      employee: {},
      hospital: MAIN,
      sites: [SCHOOL],
    });
    expect(centers.map((c) => c.source)).toEqual(['SITE', 'HOSPITAL']);

    const atSchool = matchGeoCenter(centers, 40.8005, 72.34);
    expect(atSchool?.inside).toBe(true);
    expect(atSchool?.center.workSiteId).toBe('ws-school');

    const atMain = matchGeoCenter(centers, 40.7805, 72.34);
    expect(atMain?.inside).toBe(true);
    expect(atMain?.center.source).toBe('HOSPITAL');
  });

  it("hech biri ichida bo'lmasa — eng yaqini qaytadi, inside=false", () => {
    const centers = buildGeoCenters({
      employee: {},
      hospital: MAIN,
      sites: [SCHOOL],
    });
    const m = matchGeoCenter(centers, 40.79, 72.34); // ikkalasining o'rtasida
    expect(m?.inside).toBe(false);
    expect(m?.distance).toBeGreaterThan(900);
  });

  it("faol bo'lmagan ish joyi hisobga olinmaydi", () => {
    const centers = buildGeoCenters({
      employee: {},
      hospital: MAIN,
      sites: [{ ...SCHOOL, isActive: false }],
    });
    expect(centers).toHaveLength(1);
    expect(matchGeoCenter(centers, 40.8005, 72.34)?.inside).toBe(false);
  });

  it('lavozim markazi bo‘lsa asosiy bino o‘rniga u ishlatiladi', () => {
    const centers = buildGeoCenters({
      employee: {},
      position: { gpsLat: 40.7, gpsLng: 72.3, gpsRadius: 100 },
      hospital: MAIN,
    });
    expect(centers.map((c) => c.source)).toEqual(['POSITION']);
  });

  it("eski shaxsiy markaz qo'shimcha ruxsat sifatida qoladi (ustun emas)", () => {
    const centers = buildGeoCenters({
      employee: { gpsLat: 40.9, gpsLng: 72.34, gpsRadius: null },
      hospital: MAIN,
    });
    expect(centers.map((c) => c.source)).toEqual(['PERSONAL', 'HOSPITAL']);
    expect(centers[0].radius).toBe(100);
    // asosiy binoda ham check-in qila oladi
    expect(matchGeoCenter(centers, 40.7801, 72.34)?.inside).toBe(true);
  });

  it("markaz yo'q — null (tekshirib bo'lmaydi)", () => {
    expect(buildGeoCenters({ employee: {}, hospital: { name: 'X' } })).toEqual(
      [],
    );
    expect(matchGeoCenter([], 40, 72)).toBeNull();
  });

  it('NaN koordinatali markaz tashlab yuboriladi', () => {
    const centers = buildGeoCenters({
      employee: { gpsLat: NaN, gpsLng: 72 },
      hospital: MAIN,
    });
    expect(centers.map((c) => c.source)).toEqual(['HOSPITAL']);
  });

  it('noaniqlik (tolerance) chegarani kengaytiradi', () => {
    const centers = buildGeoCenters({ employee: {}, hospital: MAIN });
    // ~222 m — radius 200
    expect(matchGeoCenter(centers, 40.782, 72.34)?.inside).toBe(false);
    expect(matchGeoCenter(centers, 40.782, 72.34, 50)?.inside).toBe(true);
  });
});
