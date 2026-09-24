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

  it("xodim sahifasidan: faqat o'z muassasasi ish joylari biriktiriladi", async () => {
    const prisma = makePrisma();
    prisma.workSite.count = jest.fn(
      async ({ where }: any) =>
        where.id.in.filter(
          (id: string) => id === 's1' && where.hospitalId === 'hA',
        ).length,
    );
    const svc = new WorkSitesService(prisma);
    // boshqa muassasa xodimi
    await expect(svc.setEmployeeSites('hA', 'e2', ['s1'])).rejects.toThrow(
      NotFoundException,
    );
    // boshqa muassasa ish joyi
    await expect(
      svc.setEmployeeSites('hA', 'e1', ['s1', 'sX']),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.employeeWorkSite.createMany).not.toHaveBeenCalled();

    await svc.setEmployeeSites('hA', 'e1', ['s1', 's1']);
    expect(prisma.employeeWorkSite.deleteMany).toHaveBeenCalledWith({
      where: { employeeId: 'e1', workSiteId: { notIn: ['s1'] } },
    });
    expect(prisma.employeeWorkSite.createMany).toHaveBeenCalledWith({
      data: [{ employeeId: 'e1', workSiteId: 's1' }],
      skipDuplicates: true,
    });
  });

  it("xodimning GPS markazlari: barcha ish joylari 'assigned' bilan, shaxsiy markaz", async () => {
    const prisma = makePrisma();
    prisma.employee.findFirst = jest.fn(async ({ where }: any) =>
      where.id === 'e1' && where.hospitalId === 'hA'
        ? {
            id: 'e1',
            fullName: 'Ali',
            gpsLat: 40.8,
            gpsLng: 72.3,
            gpsRadius: 100,
            workSites: [{ workSiteId: 's1' }],
            hospital: { gpsLat: 40.7, gpsLng: 72.2, gpsRadius: 300 },
          }
        : null,
    );
    prisma.workSite.findMany = jest.fn(async () => [
      { id: 's1', name: 'Bino', isActive: true },
      { id: 's2', name: 'Maktab', isActive: true },
    ]);
    const svc = new WorkSitesService(prisma);
    const r = await svc.employeeSites('hA', 'e1');
    expect(r.sites.map((x: any) => [x.id, x.assigned])).toEqual([
      ['s1', true],
      ['s2', false],
    ]);
    expect(r.legacyCenter).toEqual({ lat: 40.8, lng: 72.3, radius: 100 });
    expect(r.hospitalCenter).toEqual({ lat: 40.7, lng: 72.2, radius: 300 });
    await expect(svc.employeeSites('hB', 'e1')).rejects.toThrow(
      NotFoundException,
    );
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
