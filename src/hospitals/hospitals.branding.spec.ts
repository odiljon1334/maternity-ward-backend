import { Test, TestingModule } from '@nestjs/testing';
import { HospitalsService } from './hospitals.service';
import { PrismaService } from '../prisma/prisma.service';
import * as fs from 'fs';

/**
 * HospitalsService — tenant self-service branding (2026-09-19, Odiljon
 * so'rovi, FAZA 5 / 8.7-bosqich): `updateOwnInfo` va `updateOwnLogo`
 * metodlari uchun unit testlar. Haqiqiy fayl tizimi/`sharp` chaqirilmasligi
 * uchun `../common/utils/image.util` soxtalashtirilgan (`attendance`
 * modulidagi `processAndSavePhoto` testlarida ishlatilgan naqshga o'xshab).
 */

jest.mock('../common/utils/image.util', () => ({
  processAndSaveLogo: jest
    .fn()
    .mockResolvedValue({ filename: 'logo-test.png', sizeKb: 12 }),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  mkdirSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

describe('HospitalsService — branding (updateOwnInfo/updateOwnLogo)', () => {
  let service: HospitalsService;

  function makeFakePrisma(hospital: any) {
    return {
      hospital: {
        findUnique: jest.fn().mockResolvedValue(hospital),
        update: jest.fn(async ({ data, select }: any) => {
          const updated = { ...hospital, ...data };
          if (!select) return updated;
          const out: any = {};
          for (const key of Object.keys(select)) out[key] = updated[key];
          return out;
        }),
      },
    };
  }

  async function build(hospital: any) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HospitalsService,
        { provide: PrismaService, useValue: makeFakePrisma(hospital) },
      ],
    }).compile();
    service = module.get(HospitalsService);
    return module.get(PrismaService) as any;
  }

  it('updateOwnInfo — shifoxona nomini yangilaydi', async () => {
    await build({
      id: 'h1',
      name: 'Eski nom',
      logoUrl: null,
      departments: [],
      _count: { employees: 0, users: 0 },
    });
    const result = await service.updateOwnInfo('h1', { name: 'Yangi nom' });
    expect(result.name).toBe('Yangi nom');
  });

  it("updateOwnLogo — eski logotip bo'lmasa, faylni o'chirishga urinmaydi", async () => {
    const prisma = await build({
      id: 'h1',
      name: 'Shifoxona',
      logoUrl: null,
      departments: [],
      _count: { employees: 0, users: 0 },
    });
    const result = await service.updateOwnLogo('h1', Buffer.from('img'));
    expect(result.logoUrl).toBe('/uploads/logo-test.png');
    expect(prisma.hospital.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'h1' },
        data: { logoUrl: '/uploads/logo-test.png' },
      }),
    );
  });

  it("updateOwnLogo — eski logotip bo'lsa, eski faylni o'chiradi", async () => {
    await build({
      id: 'h1',
      name: 'Shifoxona',
      logoUrl: '/uploads/old-logo.png',
      departments: [],
      _count: { employees: 0, users: 0 },
    });
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const result = await service.updateOwnLogo('h1', Buffer.from('img'));
    expect(result.logoUrl).toBe('/uploads/logo-test.png');
    expect(fs.unlinkSync).toHaveBeenCalled();
  });
});
