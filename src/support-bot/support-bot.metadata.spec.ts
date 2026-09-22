import {
  SUPPORT_BOT_COMMANDS,
  SUPPORT_BOT_DESCRIPTION,
  SUPPORT_BOT_SHORT_DESCRIPTION,
} from './support-bot.metadata';

describe('Support bot public metadata', () => {
  it('Telegram limitlariga mos va mijozga rasmiy maqsadni tushuntiradi', () => {
    expect(SUPPORT_BOT_DESCRIPTION.length).toBeLessThanOrEqual(512);
    expect(SUPPORT_BOT_SHORT_DESCRIPTION.length).toBeLessThanOrEqual(120);
    expect(SUPPORT_BOT_DESCRIPTION).toContain('StaffPlusPRO');
    expect(SUPPORT_BOT_DESCRIPTION).toContain('14 kunlik bepul sinov');
  });

  it('start va trial buyruqlarini e’lon qiladi', () => {
    expect(SUPPORT_BOT_COMMANDS.map(({ command }) => command)).toEqual([
      'start',
      'trial',
    ]);
    for (const item of SUPPORT_BOT_COMMANDS) {
      expect(item.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(item.description.length).toBeLessThanOrEqual(256);
    }
  });
});
