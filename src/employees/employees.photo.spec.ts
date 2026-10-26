import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmployeesService } from './employees.service';
import * as imageUtil from '../common/utils/image.util';

describe('Employee profile photo gate', () => {
  afterEach(() => jest.restoreAllMocks());
  it('commits a valid photo only after validation succeeds', async () => {
    const employee = {
      id: 'e',
      employeeNo: '101',
      photoUrl: '/uploads/old.jpg',
    };
    const prisma: any = {
      employee: {
        findUnique: jest.fn().mockResolvedValue(employee),
        update: jest
          .fn()
          .mockResolvedValue({ ...employee, photoUrl: '/uploads/new.jpg' }),
      },
    };
    const gate = {
      validateProfilePhoto: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new EmployeesService(prisma, gate as any);
    jest.spyOn(svc, 'findOne').mockResolvedValue(employee as any);
    jest
      .spyOn(imageUtil, 'processAndSavePhoto')
      .mockImplementation(async () => {
        expect(gate.validateProfilePhoto).toHaveBeenCalled();
        return { filename: 'new.jpg', sizeKb: 1 };
      });
    const result = await svc.updatePhoto('e', Buffer.from('portrait'), 'h');
    expect(result.photoUrl).toBe('/uploads/new.jpg');
    expect(prisma.employee.update).toHaveBeenCalledTimes(1);
  });
  it.each([
    new BadRequestException('Rasmda yuz aniqlanmadi'),
    new ServiceUnavailableException('Tekshiruv ishlamadi'),
  ])(
    'rejects before file, old photo, DB or outbox can change: %s',
    async (error) => {
      const prisma: any = {
        employee: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'e', photoUrl: '/uploads/old.jpg' }),
          update: jest.fn(),
        },
      };
      const gate = { validateProfilePhoto: jest.fn().mockRejectedValue(error) };
      const svc = new EmployeesService(prisma, gate as any);
      jest.spyOn(svc, 'findOne').mockResolvedValue({ id: 'e' } as any);
      const save = jest.spyOn(imageUtil, 'processAndSavePhoto');
      await expect(svc.updatePhoto('e', Buffer.from('tree'), 'h')).rejects.toBe(
        error,
      );
      expect(save).not.toHaveBeenCalled();
      expect(prisma.employee.update).not.toHaveBeenCalled();
    },
  );
});
