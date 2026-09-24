import axios from 'axios';
import { buildQueryVariants, parseCoordinates } from './place-search.util';
import { PlaceSearchService } from './place-search.service';

jest.mock('axios');
const mockedGet = axios.get as jest.Mock;

describe('place-search.util', () => {
  it("oddiy koordinata juftligi (vergul, bo'shliq, nuqta-vergul)", () => {
    expect(parseCoordinates('40.7821, 72.3442')).toEqual({
      lat: 40.7821,
      lng: 72.3442,
    });
    expect(parseCoordinates('40.7821 72.3442')).toEqual({
      lat: 40.7821,
      lng: 72.3442,
    });
    expect(parseCoordinates('40,7821; 72,3442')).toEqual({
      lat: 40.7821,
      lng: 72.3442,
    });
  });

  it("tartibi almashgan juftlik (uzunlik, kenglik) to'g'rilanadi", () => {
    expect(parseCoordinates('72.3442, 40.7821')).toEqual({
      lat: 40.7821,
      lng: 72.3442,
    });
  });

  it('Yandex havolasi: ll/pt/whatshere — tartib "uzunlik,kenglik"', () => {
    expect(
      parseCoordinates(
        'https://yandex.uz/maps/10329/andijan/?ll=72.344200%2C40.782100&z=17',
      ),
    ).toEqual({ lat: 40.7821, lng: 72.3442 });
    expect(
      parseCoordinates(
        'https://yandex.ru/maps/?whatshere%5Bpoint%5D=72.35%2C40.79&whatshere%5Bzoom%5D=17',
      ),
    ).toEqual({ lat: 40.79, lng: 72.35 });
    expect(
      parseCoordinates('https://yandex.uz/maps/?pt=72.3,40.7&z=16'),
    ).toEqual({ lat: 40.7, lng: 72.3 });
  });

  it('Google havolasi: @lat,lng va !3d!4d', () => {
    expect(
      parseCoordinates(
        'https://www.google.com/maps/place/School/@40.7821,72.3442,17z/data=!3m1',
      ),
    ).toEqual({ lat: 40.7821, lng: 72.3442 });
    expect(
      parseCoordinates(
        'https://www.google.com/maps/place/X/data=!3d40.78!4d72.34',
      ),
    ).toEqual({
      lat: 40.78,
      lng: 72.34,
    });
    expect(parseCoordinates('https://maps.google.com/?q=40.78,72.34')).toEqual({
      lat: 40.78,
      lng: 72.34,
    });
  });

  it('oddiy matn koordinata deb olinmaydi', () => {
    expect(parseCoordinates('1-maktab Andijon')).toBeNull();
    expect(parseCoordinates("Navoiy ko'chasi 12")).toBeNull();
  });

  it("raqamli muassasa uchun OSM'dagi yozilish variantlari", () => {
    expect(buildQueryVariants('1-maktab Andijon shahar')).toEqual([
      '1-maktab Andijon shahar',
      '1-son maktab Andijon',
      'школа № 1 Andijon',
    ]);
    expect(buildQueryVariants("5-sonli bog'cha Asaka")[1]).toBe(
      "5-son bog'cha Asaka",
    );
    expect(buildQueryVariants('Navoiy ko‘chasi')).toEqual(["Navoiy ko'chasi"]);
  });
});

describe('PlaceSearchService', () => {
  const ENV = { ...process.env };
  const prisma: any = {
    hospital: {
      findUnique: jest.fn(async () => ({ gpsLat: 40.78, gpsLng: 72.34 })),
    },
  };

  beforeEach(() => {
    mockedGet.mockReset();
    process.env = { ...ENV };
    delete process.env.YANDEX_SEARCH_API_KEY;
    delete process.env.YANDEX_GEOCODER_API_KEY;
    delete process.env.GEO_OSM_DISABLED;
  });
  afterAll(() => {
    process.env = ENV;
  });

  it("havola qo'yilsa — tashqi xizmatga murojaat qilinmaydi", async () => {
    const svc = new PlaceSearchService(prisma);
    const res = await svc.search(
      'https://yandex.uz/maps/?ll=72.35%2C40.79',
      'h1',
      'u1',
    );
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ lat: 40.79, lng: 72.35, source: 'COORDS' });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("OSM: birinchi variant bo'sh bo'lsa keyingisi sinaladi, natija keshlanadi", async () => {
    mockedGet.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({
      data: [
        {
          lat: '40.781',
          lon: '72.345',
          name: '1-son maktab',
          display_name: '1-son maktab, Andijon',
        },
      ],
    });
    const svc = new PlaceSearchService(prisma);
    const res = await svc.search('1-maktab Andijon', 'h1', 'u1');
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ name: '1-son maktab', source: 'OSM' });
    expect(res[0].distance).toBeLessThan(1000);
    expect(mockedGet).toHaveBeenCalledTimes(2);
    // Nominatim qoidasi: User-Agent yuboriladi
    expect(mockedGet.mock.calls[0][1].headers['User-Agent']).toMatch(
      /StaffPlusPRO/,
    );

    await svc.search('1-maktab Andijon', 'h1', 'u1');
    expect(mockedGet).toHaveBeenCalledTimes(2); // keshdan
  }, 10_000);

  it("Yandex kaliti bo'lsa tashkilotlar oldin, OSM chaqirilmaydi; dublikat birlashtiriladi", async () => {
    process.env.YANDEX_SEARCH_API_KEY = 'k';
    process.env.YANDEX_GEOCODER_API_KEY = 'g';
    mockedGet.mockImplementation(async (url: string) => {
      if (url.includes('search-maps')) {
        return {
          data: {
            features: [
              {
                geometry: { coordinates: [72.345, 40.781] },
                properties: {
                  name: '1-sonli maktab',
                  CompanyMetaData: { address: 'Andijon, Navoiy 1' },
                },
              },
            ],
          },
        };
      }
      return {
        data: {
          response: {
            GeoObjectCollection: {
              featureMember: [
                {
                  GeoObject: {
                    name: 'Navoiy 1',
                    description: 'Andijon',
                    Point: { pos: '72.3451 40.7811' },
                  },
                },
                {
                  GeoObject: {
                    name: 'Toshkent',
                    description: 'O‘zbekiston',
                    Point: { pos: '69.24 41.31' },
                  },
                },
              ],
            },
          },
        },
      };
    });
    const svc = new PlaceSearchService(prisma);
    const res = await svc.search('1 maktab', 'h1', 'u1');
    expect(res.map((r) => r.source)).toEqual(['YANDEX_ORG', 'YANDEX_GEO']);
    expect(res[0].name).toBe('1-sonli maktab');
    expect(res[1].name).toBe('Toshkent'); // 40 m ichidagi dublikat tashlandi, uzoq natija oxirida
    expect(
      mockedGet.mock.calls.some(([u]) => String(u).includes('nominatim')),
    ).toBe(false);
  });

  it("tashqi xizmat xato bersa — bo'sh ro'yxat, xato tashlanmaydi", async () => {
    mockedGet.mockRejectedValue(new Error('timeout'));
    process.env.GEO_OSM_DISABLED = 'false';
    const svc = new PlaceSearchService(prisma);
    await expect(svc.search('xyz joy', 'h1', 'u1')).resolves.toEqual([]);
  }, 10_000);

  it("bir foydalanuvchi daqiqasiga 20 tadan ko'p qidira olmaydi", async () => {
    process.env.GEO_OSM_DISABLED = 'true';
    const svc = new PlaceSearchService(prisma);
    for (let i = 0; i < 20; i++) await svc.search(`joy ${i}`, 'h1', 'u1');
    await expect(svc.search('joy 21', 'h1', 'u1')).rejects.toThrow(/Juda ko'p/);
  });
});
