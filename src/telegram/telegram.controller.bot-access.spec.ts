import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { TelegramController } from './telegram.controller';

function makeController() {
  const access: any = {
    list: jest.fn(async (h: string) => ({ hospitalId: h })),
    setAccess: jest.fn(async () => ({})),
    revokeSubscription: jest.fn(async () => ({})),
  };
  const ctrl = new TelegramController({} as any, {} as any, {} as any, access);
  return { ctrl, access };
}

describe('TelegramController — bot-access muassasa chegarasi', () => {
  it("DIRECTOR so'rovdagi boshqa hospitalId bilan faqat o'z muassasasini oladi", async () => {
    const { ctrl, access } = makeController();
    await ctrl.listBotAccess(
      { role: UserRole.DIRECTOR, hospitalId: 'h1' },
      'h2',
    );
    expect(access.list).toHaveBeenCalledWith('h1');
  });

  it("ADMIN body'dagi hospitalId'ni o'zgartira olmaydi", async () => {
    const { ctrl, access } = makeController();
    await ctrl.setBotAccess({ role: UserRole.ADMIN, hospitalId: 'h1' }, 'e9', {
      enabled: true,
      hospitalId: 'h2',
    });
    expect(access.setAccess).toHaveBeenCalledWith('h1', 'e9', true);
  });

  it('SUPER_ADMIN hospitalId yubormasa xato', () => {
    const { ctrl } = makeController();
    expect(() =>
      ctrl.listBotAccess({ role: UserRole.SUPER_ADMIN, hospitalId: null }),
    ).toThrow(BadRequestException);
  });

  it('SUPER_ADMIN tanlangan muassasa bilan ishlaydi', async () => {
    const { ctrl, access } = makeController();
    await ctrl.revokeBotSubscription(
      { role: UserRole.SUPER_ADMIN, hospitalId: null },
      's1',
      'h7',
    );
    expect(access.revokeSubscription).toHaveBeenCalledWith('h7', 's1');
  });

  it("muassasasi yo'q tenant roli rad etiladi", () => {
    const { ctrl } = makeController();
    expect(() =>
      ctrl.listBotAccess({ role: UserRole.DIRECTOR, hospitalId: null }, 'h2'),
    ).toThrow(ForbiddenException);
  });
});
