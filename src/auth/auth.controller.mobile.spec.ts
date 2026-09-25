import { ForbiddenException } from '@nestjs/common';
import { AuthController } from './auth.controller';

describe('AuthController — mobil ilova login', () => {
  const req = { headers: {}, ip: '127.0.0.1' } as any;
  const make = (role: string) => {
    const authService: any = {
      login: jest.fn().mockResolvedValue({
        accessToken: 'jwt-1',
        user: { id: 'u1', role },
      }),
      refreshMobileToken: jest.fn().mockResolvedValue({ accessToken: 'jwt-2' }),
    };
    return { controller: new AuthController(authService), authService };
  };

  it('xodim — token javobda qaytadi (cookie emas)', async () => {
    const { controller } = make('EMPLOYEE');
    await expect(
      controller.mobileLogin({ username: 'a', password: 'b' }, req),
    ).resolves.toEqual({
      accessToken: 'jwt-1',
      user: { id: 'u1', role: 'EMPLOYEE' },
    });
  });

  it('rahbar roli — rad etiladi', async () => {
    const { controller } = make('DIRECTOR');
    await expect(
      controller.mobileLogin({ username: 'a', password: 'b' }, req),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refresh yangi token beradi', async () => {
    const { controller, authService } = make('EMPLOYEE');
    await expect(controller.mobileRefresh('u1')).resolves.toEqual({
      accessToken: 'jwt-2',
    });
    expect(authService.refreshMobileToken).toHaveBeenCalledWith('u1');
  });
});
