import {
  MOBILE_APP_PAGE_URL,
  SUPPORT_APP_MESSAGE,
  SUPPORT_BOT_COMMANDS,
  SUPPORT_BOT_DESCRIPTION,
  SUPPORT_BOT_SHORT_DESCRIPTION,
  SUPPORT_OPERATOR_MESSAGE,
  SUPPORT_OPERATOR_URL,
  SUPPORT_OPERATOR_USERNAME,
} from './support-bot.metadata';

describe('Support bot public metadata', () => {
  it('Telegram limitlariga mos va mijozga rasmiy maqsadni tushuntiradi', () => {
    expect(SUPPORT_BOT_DESCRIPTION.length).toBeLessThanOrEqual(512);
    expect(SUPPORT_BOT_SHORT_DESCRIPTION.length).toBeLessThanOrEqual(120);
    expect(SUPPORT_BOT_DESCRIPTION).toContain('StaffPlusPRO');
    expect(SUPPORT_BOT_DESCRIPTION).toContain('14 kunlik bepul sinov');
  });

  it('start, trial, ilova va operator buyruqlarini e’lon qiladi', () => {
    expect(SUPPORT_BOT_COMMANDS.map(({ command }) => command)).toEqual([
      'start',
      'trial',
      'ilova',
      'operator',
    ]);
    for (const item of SUPPORT_BOT_COMMANDS) {
      expect(item.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(item.description.length).toBeLessThanOrEqual(256);
    }
  });

  it('ilova xabari rasmiy sahifani va operatorni ko‘rsatadi', () => {
    expect(MOBILE_APP_PAGE_URL).toBe('https://clinicuk24.com/ilova');
    expect(SUPPORT_APP_MESSAGE).toContain(MOBILE_APP_PAGE_URL);
    expect(SUPPORT_APP_MESSAGE).toContain('@staffpluse_support');
    // Telegram xabar limiti
    expect(SUPPORT_APP_MESSAGE.length).toBeLessThanOrEqual(4096);
  });

  it('jonli operator username bitta joyda va to‘g‘ri yozilgan', () => {
    expect(SUPPORT_OPERATOR_USERNAME).toBe('staffpluse_support');
    expect(SUPPORT_OPERATOR_URL).toBe('https://t.me/staffpluse_support');
    expect(SUPPORT_OPERATOR_MESSAGE).toContain('@staffpluse_support');
  });
});
