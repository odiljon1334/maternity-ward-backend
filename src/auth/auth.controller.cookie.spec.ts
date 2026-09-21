import { AuthController } from './auth.controller';

describe('AuthController browser session cookie', () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;

  afterEach(() => {
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
  });

  function setup(hostname: string) {
    const authService = {
      login: jest.fn().mockResolvedValue({
        accessToken: 'test-token',
        user: { id: 'user-1' },
      }),
    };
    const controller = new AuthController(authService as any);
    const req = { hostname, headers: {}, ip: '127.0.0.1' } as any;
    const res = { cookie: jest.fn(), clearCookie: jest.fn() } as any;
    return { controller, req, res };
  }

  it('API subdomenidagi login cookie asosiy saytga ham yuboriladi', async () => {
    process.env.FRONTEND_URL = 'https://clinicuk24.com';
    const { controller, req, res } = setup('api.clinicuk24.com');

    await controller.login({ username: 'user', password: 'pass' }, req, res);

    expect(res.clearCookie).toHaveBeenCalledWith(
      'access_token',
      expect.not.objectContaining({ domain: expect.any(String) }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      'test-token',
      expect.objectContaining({
        domain: 'clinicuk24.com',
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      }),
    );
  });

  it('API va frontend bitta hostda bo‘lsa cookie doirasi kengaymaydi', async () => {
    process.env.FRONTEND_URL = 'https://clinicuk24.com';
    const { controller, req, res } = setup('clinicuk24.com');

    await controller.login({ username: 'user', password: 'pass' }, req, res);

    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      'test-token',
      expect.not.objectContaining({ domain: expect.any(String) }),
    );
  });

  it('logout eski va umumiy domen cookie larini o‘chiradi', () => {
    process.env.FRONTEND_URL = 'https://clinicuk24.com';
    const { controller, req, res } = setup('api.clinicuk24.com');

    controller.logout(req, res);

    expect(res.clearCookie).toHaveBeenCalledTimes(2);
    expect(res.clearCookie).toHaveBeenCalledWith(
      'access_token',
      expect.objectContaining({ domain: 'clinicuk24.com' }),
    );
  });
});
