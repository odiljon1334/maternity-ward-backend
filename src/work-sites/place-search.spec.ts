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
    expect(parseCoordinates('Navoiy 12, 5-uy')).toBeNull();
    expect(parseCoordinates('info@1,2 street')).toBeNull();
  });

  it("imkonsiz qiymat koordinata bo'lmaydi; Yandex poi[point] — belgilangan nuqta", () => {
    expect(parseCoordinates('120.5, 40.2')).toEqual({ lat: 40.2, lng: 120.5 });
    expect(parseCoordinates('120.5, 140.2')).toBeNull();
    expect(
      parseCoordinates(
        'https://yandex.uz/maps/?ll=72.30%2C40.70&poi%5Bpoint%5D=72.3442%2C40.7821&z=17',
      ),
    ).toEqual({ lat: 40.7821, lng: 72.3442 });
  });

  it("buzilgan %-kodli uzun havola ham o'qiladi", () => {
    const url =
      'https://yandex.uz/maps/10329/andijan/?ll=72.344200%2C40.782100&mode=search&text=%D0%B';
    expect(parseCoordinates(url)).toEqual({ lat: 40.7821, lng: 72.3442 });
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
    // Tur so'zi yonidagi raqam olinadi (uy raqami emas)
    expect(buildQueryVariants('Andijon 5-uy 1-maktab')[1]).toMatch(
      /^1-son maktab/,
    );
    expect(buildQueryVariants('школа 12 Андижан')[1]).toBe(
      '12-son maktab Андижан',
    );
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
    delete process.env.YANDEX_SUGGEST_API_KEY;
    delete process.env.YANDEX_DAILY_CAP;
    delete process.env.YANDEX_MAPS_LANG;
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

  it('Yandex qidiruv natija bersa — geokoder matn qidiruvi va OSM chaqirilmaydi', async () => {
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
              {
                geometry: { coordinates: [72.3451, 40.7811] },
                properties: {
                  name: '1-sonli maktab (Andijon)',
                  CompanyMetaData: {},
                },
              },
              {
                geometry: { coordinates: [69.24, 41.31] },
                properties: { name: 'Toshkent', CompanyMetaData: {} },
              },
            ],
          },
        };
      }
      throw new Error(`kutilmagan so'rov: ${url}`);
    });
    const svc = new PlaceSearchService(prisma);
    const res = await svc.search('1 maktab', 'h1', 'u1');
    expect(res.map((r) => r.name)).toEqual(['1-sonli maktab', 'Toshkent']); // 40 m ichidagi dublikat tashlandi
    expect(res[1].distance).toBeGreaterThan(50_000);
    const urls = mockedGet.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('geocode-maps'))).toBe(false);
    expect(urls.some((u) => u.includes('nominatim'))).toBe(false);
  });

  it("faqat YANDEX_SEARCH_API_KEY: bitta so'rovda tashkilot va manzil, type berilmaydi", async () => {
    process.env.YANDEX_SEARCH_API_KEY = 'k';
    mockedGet.mockResolvedValue({
      data: {
        features: [
          {
            geometry: { coordinates: [72.345, 40.781] },
            properties: {
              name: '1-sonli maktab',
              CompanyMetaData: { address: 'Andijon, Navoiy 1' },
            },
          },
          {
            geometry: { coordinates: [72.36, 40.79] },
            properties: {
              name: "Navoiy ko'chasi",
              GeocoderMetaData: {
                text: "O'zbekiston, Andijon, Navoiy ko'chasi",
              },
            },
          },
        ],
      },
    });
    const svc = new PlaceSearchService(prisma);
    const res = await svc.search('Navoiy maktab', 'h1', 'u1');
    expect(res.map((r) => r.source)).toEqual(['YANDEX_ORG', 'YANDEX_GEO']);
    expect(res[1].address).toMatch(/Navoiy ko'chasi/);
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(mockedGet.mock.calls[0][1].params.type).toBeUndefined();
  });

  it("uz_UZ tili qabul qilinmasa (400) — ru_RU bilan qayta so'raladi", async () => {
    process.env.YANDEX_SEARCH_API_KEY = 'k';
    process.env.GEO_OSM_DISABLED = 'true';
    mockedGet
      .mockRejectedValueOnce(
        Object.assign(new Error('bad lang'), { response: { status: 400 } }),
      )
      .mockResolvedValueOnce({
        data: {
          features: [
            {
              geometry: { coordinates: [72.345, 40.781] },
              properties: { name: 'Школа №1', CompanyMetaData: {} },
            },
          ],
        },
      });
    const svc = new PlaceSearchService(prisma);
    const res = await svc.search('школа 1', 'h1', 'u1');
    expect(res).toHaveLength(1);
    expect(mockedGet.mock.calls.map((c) => c[1].params.lang)).toEqual([
      'uz_UZ',
      'ru_RU',
    ]);
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
  describe('Geosaggest + geokoder (bepul tarif)', () => {
    const suggestData = {
      results: [
        {
          title: { text: '1-sonli umumiy o‘rta ta’lim maktabi' },
          subtitle: { text: 'Maktab · Andijon' },
          tags: ['business'],
          distance: { value: 812.4, text: '812 m' },
          address: { formatted_address: 'Andijon, Navoiy shoh ko‘chasi, 1' },
          uri: 'ymapsbm1://org?oid=123456',
        },
        {
          title: { text: 'Navoiy shoh ko‘chasi' },
          tags: ['street'],
          distance: { value: 1500 },
          address: {
            formatted_address: 'O‘zbekiston, Andijon, Navoiy shoh ko‘chasi',
          },
          uri: 'ymapsbm1://geo?data=abc',
        },
        { title: { text: 'uri yo‘q' }, tags: [] },
      ],
    };
    const geoObject = {
      name: '1-sonli maktab',
      metaDataProperty: {
        GeocoderMetaData: { text: 'Узбекистан, Андижан, улица Навои, 1' },
      },
      Point: { pos: '72.345 40.781' },
    };

    beforeEach(() => {
      process.env.YANDEX_SUGGEST_API_KEY = 's';
      process.env.YANDEX_GEOCODER_API_KEY = 'g';
      process.env.GEO_OSM_DISABLED = 'true';
    });

    it("qidiruv: faqat 1 ta Geosaggest so'rovi, koordinatasiz natijalar uri bilan", async () => {
      mockedGet.mockResolvedValue({ data: suggestData });
      const svc = new PlaceSearchService(prisma);
      const res = await svc.search('1-maktab Andijon', 'h1', 'u1');
      expect(mockedGet).toHaveBeenCalledTimes(1);
      const [url, cfg] = mockedGet.mock.calls[0];
      expect(url).toContain('suggest-maps.yandex.ru/v1/suggest');
      expect(cfg.params).toMatchObject({
        apikey: 's',
        text: '1-maktab Andijon',
        types: 'biz,geo',
        attrs: 'uri',
        print_address: 1,
        lang: 'ru',
        ll: '72.34,40.78',
      });
      expect(res).toHaveLength(2);
      expect(res[0]).toMatchObject({
        source: 'YANDEX_ORG',
        lat: null,
        lng: null,
        distance: 812,
        uri: 'ymapsbm1://org?oid=123456',
        address: 'Andijon, Navoiy shoh ko‘chasi, 1',
      });
      expect(res[1].source).toBe('YANDEX_GEO');
    });

    it("geokoder kaliti bo'lmasa Geosaggest ishlatilmaydi (uri'ni koordinataga aylantirib bo'lmaydi)", async () => {
      delete process.env.YANDEX_GEOCODER_API_KEY;
      const svc = new PlaceSearchService(prisma);
      await expect(svc.search('maktab', 'h1', 'u1')).resolves.toEqual([]);
      expect(mockedGet).not.toHaveBeenCalled();
    });

    it("Geosaggest bo'sh bo'lsa — geokoder matn bo'yicha, ru_RU tilida", async () => {
      mockedGet.mockImplementation(async (url: string) =>
        url.includes('suggest')
          ? { data: { results: [] } }
          : {
              data: {
                response: {
                  GeoObjectCollection: {
                    featureMember: [{ GeoObject: geoObject }],
                  },
                },
              },
            },
      );
      const svc = new PlaceSearchService(prisma);
      const res = await svc.search('Navoiy 1', 'h1', 'u1');
      const geoCall = mockedGet.mock.calls.find(([u]) =>
        String(u).includes('geocode-maps'),
      );
      expect(geoCall[1].params).toMatchObject({
        geocode: 'Navoiy 1',
        lang: 'ru_RU',
      });
      expect(res[0]).toMatchObject({
        lat: 40.781,
        lng: 72.345,
        source: 'YANDEX_GEO',
      });
    });

    it("resolve: uri bo'yicha koordinata, masofa bilan; takroriy tanlov keshdan", async () => {
      mockedGet.mockResolvedValue({
        data: {
          response: {
            GeoObjectCollection: { featureMember: [{ GeoObject: geoObject }] },
          },
        },
      });
      const svc = new PlaceSearchService(prisma);
      (svc as any).issueUri('ymapsbm1://org?oid=123456', 'h1');
      const p = await svc.resolve('ymapsbm1://org?oid=123456', 'h1', 'u1');
      expect(p).toMatchObject({
        lat: 40.781,
        lng: 72.345,
        address: 'Узбекистан, Андижан, улица Навои, 1',
      });
      expect(p.distance).toBeLessThan(1000);
      expect(mockedGet.mock.calls[0][1].params).toMatchObject({
        uri: 'ymapsbm1://org?oid=123456',
        apikey: 'g',
        lang: 'ru_RU',
      });
      await svc.resolve('ymapsbm1://org?oid=123456', 'h1', 'u1');
      expect(mockedGet).toHaveBeenCalledTimes(1);
    });

    it("resolve: noto'g'ri uri va kalitsiz holat rad etiladi", async () => {
      const svc = new PlaceSearchService(prisma);
      await expect(
        svc.resolve('https://evil.example/x', 'h1', 'u1'),
      ).rejects.toThrow(/Noto'g'ri/);
      delete process.env.YANDEX_GEOCODER_API_KEY;
      await expect(
        svc.resolve('ymapsbm1://org?oid=1', 'h1', 'u1'),
      ).rejects.toThrow(/sozlanmagan/);
      expect(mockedGet).not.toHaveBeenCalled();
    });

    it('resolve: geokoder xato bersa 503, topilmasa 404', async () => {
      const svc = new PlaceSearchService(prisma);
      (svc as any).issueUri('ymapsbm1://org?oid=1', 'h1');
      (svc as any).issueUri('ymapsbm1://org?oid=2', 'h1');
      mockedGet.mockRejectedValueOnce(
        Object.assign(new Error('forbidden'), { response: { status: 403 } }),
      );
      await expect(
        svc.resolve('ymapsbm1://org?oid=1', 'h1', 'u1'),
      ).rejects.toMatchObject({ status: 503 });
      mockedGet.mockResolvedValueOnce({
        data: { response: { GeoObjectCollection: { featureMember: [] } } },
      });
      await expect(
        svc.resolve('ymapsbm1://org?oid=2', 'h1', 'u1'),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("resolve: qidiruvda berilmagan yoki boshqa muassasaga berilgan uri rad etiladi (limitni bekorga yeb bo'lmaydi)", async () => {
      mockedGet.mockResolvedValue({ data: suggestData });
      const svc = new PlaceSearchService(prisma);
      await expect(
        svc.resolve('ymapsbm1://org?oid=999', 'h1', 'u1'),
      ).rejects.toThrow(/eskirgan/);
      await svc.search('1-maktab Andijon', 'h1', 'u1');
      await expect(
        svc.resolve('ymapsbm1://org?oid=123456', 'h2', 'u1'),
      ).rejects.toThrow(/eskirgan/);
      const callsBefore = mockedGet.mock.calls.length;
      mockedGet.mockResolvedValue({
        data: {
          response: {
            GeoObjectCollection: { featureMember: [{ GeoObject: geoObject }] },
          },
        },
      });
      await expect(
        svc.resolve('ymapsbm1://org?oid=123456', 'h1', 'u1'),
      ).resolves.toMatchObject({ lat: 40.781 });
      expect(mockedGet.mock.calls.length).toBe(callsBefore + 1);
    });

    it("bo'sh natija keshlanmaydi (tarmoq uzilishi so'rovni yashirmasin)", async () => {
      mockedGet.mockResolvedValue({ data: { results: [] } });
      process.env.YANDEX_GEOCODER_API_KEY = 'g';
      const svc = new PlaceSearchService(prisma);
      await svc.search('yoq joy', 'h1', 'u1');
      const n = mockedGet.mock.calls.length;
      await svc.search('yoq joy', 'h1', 'u1');
      expect(mockedGet.mock.calls.length).toBeGreaterThan(n);
    });

    it("kunlik chegara: YANDEX_DAILY_CAP dan keyin Yandex'ga so'rov ketmaydi", async () => {
      process.env.YANDEX_DAILY_CAP = '2';
      mockedGet.mockResolvedValue({ data: suggestData });
      const svc = new PlaceSearchService(prisma);
      await svc.search('joy a', 'h1', 'u1');
      await svc.search('joy b', 'h1', 'u1');
      const callsAfterTwo = mockedGet.mock.calls.length;
      await svc.search('joy c', 'h1', 'u1');
      expect(
        mockedGet.mock.calls
          .slice(callsAfterTwo)
          .some(([u]) => String(u).includes('suggest')),
      ).toBe(false);
    });
  });
});
