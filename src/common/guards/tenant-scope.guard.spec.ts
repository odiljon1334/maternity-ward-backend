import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { TenantScopeGuard } from './tenant-scope.guard';

function makeContext(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;
}

describe('TenantScopeGuard', () => {
  function makeGuard(hospitalIds: string[]) {
    return new TenantScopeGuard({
      hospitalAssistant: {
        findMany: jest
          .fn()
          .mockResolvedValue(hospitalIds.map((hospitalId) => ({ hospitalId }))),
      },
    } as any);
  }

  it('Assistant Admin uchun bitta biriktirilgan muassasani avtomatik tanlaydi', async () => {
    const request: any = {
      user: { sub: 'assistant-1', role: UserRole.ASSISTANT_ADMIN },
      query: {},
      body: {},
    };
    await expect(
      makeGuard(['h-1']).canActivate(makeContext(request)),
    ).resolves.toBe(true);
    expect(request.user.hospitalId).toBe('h-1');
    expect(request.query.targetHospitalId).toBe('h-1');
  });

  it('biriktirilmagan Assistant Adminni rad etadi', async () => {
    const request: any = {
      user: { sub: 'assistant-1', role: UserRole.ASSISTANT_ADMIN },
      query: {},
      body: {},
    };
    await expect(
      makeGuard([]).canActivate(makeContext(request)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('boshqa muassasa IDsi bilan bypass qilishni rad etadi', async () => {
    const request: any = {
      user: { sub: 'assistant-1', role: UserRole.ASSISTANT_ADMIN },
      query: { targetHospitalId: 'other-hospital' },
      body: {},
    };
    await expect(
      makeGuard(['h-1']).canActivate(makeContext(request)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('bir nechta biriktirishda tanlanmagan filtersiz queryni rad etadi', async () => {
    const request: any = {
      user: { sub: 'assistant-1', role: UserRole.ASSISTANT_ADMIN },
      query: {},
      body: {},
    };
    await expect(
      makeGuard(['h-1', 'h-2']).canActivate(makeContext(request)),
    ).rejects.toThrow(ForbiddenException);
  });
});
