import { LocationService } from './location.service';

describe('LocationService.getLatestLocations', () => {
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
});
