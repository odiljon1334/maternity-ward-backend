import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkSitesService } from './work-sites.service';
import { resolveWorkSiteHospital } from './work-sites.controller';

function makePrisma() {
  const sites: any[] = [{ id: 's1', hospitalId: 'hA' }];
  const employees: any[] = [
    {
      id: 'e1',
      hospitalId: 'hA',
      firedAt: null,
      gpsLat: 40.8,
      gpsLng: 72.3,
      gpsRadius: 100,
    },
    { id: 'e2', hospitalId: 'hB', firedAt: null, gpsLat: null, gpsLng: null },
  ];
  const prisma: any = {
    workSite: {
      findFirst: jest.fn(
        async ({ where }: any) =>
          sites.find(
            (s) => s.id === where.id && s.hospitalId === where.hospitalId,
          ) ?? null,
      ),
      update: jest.fn(async (a: any) => a),
      delete: jest.fn(async (a: any) => a),
      create: jest.fn(async ({ data }: any) => ({ id: 'new-site', ...data })),
    },
    employee: {
      count: jest.fn(
        async ({ where }: any) =>
          employees.filter(
            (e) =>
              where.id.in.includes(e.id) &&
              e.hospitalId === where.hospitalId &&
              !e.firedAt,
          ).length,
      ),
      findFirst: jest.fn(
        async ({ where }: any) =>
          employees.find(
            (e) => e.id === where.id && e.hospitalId === where.hospitalId,
          ) ?? null,
      ),
      update: jest.fn(async (a: any) => a),
      updateMany: jest.fn(async ({ where }: any) => ({
        count: employees.filter(
          (e) =>
            e.id === where.id &&
            e.hospitalId === where.hospitalId &&
            e.gpsLat != null,
        ).length,
      })),
    },
    employeeWorkSite: {
      deleteMany: jest.fn(async () => ({})),
      createMany: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    ),
  };
  return prisma;
}

describe('WorkSites — muassasa chegarasi', () => {
  it("boshqa muassasa ish joyini o'zgartirib/o'chirib bo'lmaydi", async () => {
    const prisma = makePrisma();
    const svc = new WorkSitesService(prisma);
    await expect(svc.update('hB', 's1', { name: 'X' })).rejects.toThrow(
      NotFoundException,
    );
    await expect(svc.remove('hB', 's1')).rejects.toThrow(NotFoundException);
    expect(prisma.workSite.update).not.toHaveBeenCalled();
    expect(prisma.workSite.delete).not.toHaveBeenCalled();
  });

  it("boshqa muassasa xodimini ish joyiga biriktirib bo'lmaydi", async () => {
    const prisma = makePrisma();
    const svc = new WorkSitesService(prisma);
    await expect(svc.setEmployees('hA', 's1', ['e1', 'e2'])).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.employeeWorkSite.createMany).not.toHaveBeenCalled();
    await svc.setEmployees('hA', 's1', ['e1', 'e1']);
    expect(prisma.employeeWorkSite.createMany).toHaveBeenCalledWith({
      data: [{ employeeId: 'e1', workSiteId: 's1' }],
      skipDuplicates: true,
    });
  });

  it("koordinataning faqat bittasini o'zgartirib bo'lmaydi", async () => {
    const svc = new WorkSitesService(makePrisma());
    await expect(svc.update('hA', 's1', { lat: 40 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('eski shaxsiy markazni tasdiqlash: ish joyi yaratiladi, xodim biriktiriladi, shaxsiy markaz tozalanadi', async () => {
    const prisma = makePrisma();
    const svc = new WorkSitesService(prisma);
    const site = await svc.approveLegacyCenter('hA', 'e1', {
      name: '5-bog‘cha',
    });
    expect(site).toMatchObject({
      hospitalId: 'hA',
      gpsLat: 40.8,
      gpsLng: 72.3,
      gpsRadius: 100,
    });
    expect(prisma.employeeWorkSite.create).toHaveBeenCalledWith({
      data: { employeeId: 'e1', workSiteId: 'new-site' },
    });
    expect(prisma.employee.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { gpsLat: null, gpsLng: null },
    });
  });

  it("boshqa muassasa xodimining markazini tasdiqlab/rad etib bo'lmaydi", async () => {
    const svc = new WorkSitesService(makePrisma());
    await expect(
      svc.approveLegacyCenter('hB', 'e1', { name: 'X' }),
    ).rejects.toThrow(NotFoundException);
    await expect(svc.rejectLegacyCenter('hB', 'e1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('resolveWorkSiteHospital: JWT ustun; SUPER_ADMIN target bilan; ikkalasi yo‘q — xato', () => {
    expect(resolveWorkSiteHospital('hA', 'hB')).toBe('hA');
    expect(resolveWorkSiteHospital(null, 'hB')).toBe('hB');
    expect(() => resolveWorkSiteHospital(null)).toThrow(BadRequestException);
  });
});
