import { LocationService } from './location.service';

describe('LocationService.getLatestLocations', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('REST lokatsiya ro‘yxatiga lavozim, bo‘lim va muassasa nomini qo‘shadi', async () => {
    const now = new Date();
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'user-1',
            employee: {
              fullName: 'Test Xodim',
              photoUrl: null,
              gpsLat: null,
              gpsLng: null,
              gpsRadius: 100,
              department: { name: 'Oilaviy shifokorlik' },
              position: {
                name: '25-maktab hamshirasi',
                gpsLat: null,
                gpsLng: null,
              },
              hospital: {
                name: '2-son poliklinika',
                gpsLat: null,
                gpsLng: null,
              },
              attendances: [
                { checkIn: now, checkOut: null, status: 'PRESENT' },
              ],
            },
            liveLocations: [
              {
                id: 'location-1',
                userId: 'user-1',
                latitude: 40.7821,
                longitude: 72.3442,
                accuracy: 8,
                speed: null,
                battery: 84,
                isOutside: false,
                createdAt: now,
              },
            ],
          },
        ]),
      },
    };
    const service = new LocationService(prisma as any);

    const result = await service.getLatestLocations('hospital-1');

    expect(result).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        positionName: '25-maktab hamshirasi',
        departmentName: 'Oilaviy shifokorlik',
        hospitalName: '2-son poliklinika',
      }),
    ]);
  });

  it("faol smenadagi GPS 10 daqiqadan beri yangilanmagan bo'lsa signal uzilgan deb qaytaradi", async () => {
    const now = new Date('2026-09-23T08:30:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const staleLocationAt = new Date(now.getTime() - 11 * 60 * 1000);
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'user-stale',
            employee: {
              fullName: 'Signal uzilgan xodim',
              photoUrl: null,
              gpsLat: 40.7821,
              gpsLng: 72.3442,
              gpsRadius: 100,
              department: { name: "Bo'lim" },
              position: { name: 'Hamshira', gpsLat: null, gpsLng: null },
              hospital: {
                name: 'Test muassasa',
                gpsLat: null,
                gpsLng: null,
              },
              attendances: [
                {
                  checkIn: new Date('2026-09-23T07:00:00.000Z'),
                  checkOut: null,
                  status: 'PRESENT',
                },
              ],
            },
            liveLocations: [
              {
                id: 'location-stale',
                userId: 'user-stale',
                latitude: 40.7821,
                longitude: 72.3442,
                accuracy: 12,
                speed: null,
                battery: 75,
                isOutside: false,
                createdAt: staleLocationAt,
              },
            ],
          },
        ]),
      },
    };
    const service = new LocationService(prisma as any);

    const result = await service.getLatestLocations('hospital-1');

    expect(result).toEqual([
      expect.objectContaining({
        userId: 'user-stale',
        isStale: true,
        trackingStatus: 'SIGNAL_LOST',
      }),
    ]);
  });
});
