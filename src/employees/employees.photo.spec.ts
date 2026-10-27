import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmployeesService } from './employees.service';
import * as imageUtil from '../common/utils/image.util';

describe('Employee profile photo gate', () => {
  afterEach(() => jest.restoreAllMocks());
  it('validates a preview without saving a file or updating the employee', async () => {
    const prisma: any = { employee: { update: jest.fn() } };
    const gate = {
      validateProfilePhoto: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new EmployeesService(prisma, gate as any);
    const scope = jest
      .spyOn(svc, 'findOne')
      .mockResolvedValue({ id: 'e' } as any);
    const save = jest.spyOn(imageUtil, 'processAndSavePhoto');
    const image = Buffer.from('preview');
    await expect(svc.validatePhoto('e', image, 'h')).resolves.toEqual({
      valid: true,
    });
    expect(scope).toHaveBeenCalledWith('e', 'h');
    expect(gate.validateProfilePhoto).toHaveBeenCalledWith(image);
    expect(save).not.toHaveBeenCalled();
    expect(prisma.employee.update).not.toHaveBeenCalled();
  });
  it('does not inspect photos outside the authorized employee scope', async () => {
    const gate = { validateProfilePhoto: jest.fn() };
    const svc = new EmployeesService({} as any, gate as any);
    jest.spyOn(svc, 'findOne').mockRejectedValue(new Error('not found'));
    await expect(
      svc.validatePhoto('e', Buffer.from('preview'), 'other'),
    ).rejects.toThrow('not found');
    expect(gate.validateProfilePhoto).not.toHaveBeenCalled();
  });
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
