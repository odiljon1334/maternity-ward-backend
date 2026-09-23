import { Telegraf, Telegram } from 'telegraf';
import { TelegramService } from './telegram.service';
import { BotLinkCandidate } from './telegram-access.service';

/**
 * HR botga ulanish — faqat Telegram tasdiqlagan raqam (contact) orqali va
 * faqat ruxsat ro'yxatidagi xodimlar (2026-09-23 audit, 2-band).
 */

const CHAT = 555;

function makeHarness(candidates: BotLinkCandidate[] = []) {
  const prisma: any = {
    telegramSubscription: { findFirst: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => []),
    employee: { findMany: jest.fn(async () => []) },
  };
  const access: any = {
    findLinkCandidates: jest.fn(async () => candidates),
    linkChat: jest.fn(async () => true),
  };
  const service = new TelegramService(
    { get: jest.fn(() => undefined) } as any,
    prisma,
    access,
  );
  const bot = new Telegraf('123:TEST');
  const callApi = jest
    .spyOn(Telegram.prototype as any, 'callApi')
    .mockImplementation(async (method: any) =>
      method === 'getMe' ? { id: 1, is_bot: true, username: 'b' } : true,
    ) as unknown as jest.Mock;
  (bot as any).botInfo = { id: 1, is_bot: true, username: 'b' };
  (service as any).bot = bot;
  (service as any).setupCommands();
  const sent = () =>
    callApi.mock.calls
      .filter(([m]) => m === 'sendMessage')
      .map(([, p]: any) => String(p.text))
      .join('\n');
  return { prisma, access, bot, sent };
}

let uid = 1;
const base = (chatType = 'private') => ({
  message_id: 1,
  date: Math.floor(Date.now() / 1000),
  chat: { id: CHAT, type: chatType },
  from: { id: CHAT, is_bot: false, first_name: 'X' },
});
const contactUpdate = (userId: number, chatType = 'private') => ({
  update_id: uid++,
  message: {
    ...base(chatType),
    contact: {
      phone_number: '+998901234567',
      first_name: 'X',
      user_id: userId,
    },
  },
});
const textUpdate = (text: string) => ({
  update_id: uid++,
  message: { ...base(), text },
});
const callbackUpdate = (data: string) => ({
  update_id: uid++,
  callback_query: {
    id: String(uid),
    chat_instance: 'ci',
    from: { id: CHAT, is_bot: false, first_name: 'X' },
    message: { ...base(), text: 'x' },
    data,
  },
});

const cand = (n: number): BotLinkCandidate => ({
  employeeId: `e${n}`,
  fullName: `Xodim ${n}`,
  hospitalId: `h${n}`,
  hospitalName: `Klinika ${n}`,
});

describe('TelegramService — contact orqali ulanish', () => {
  afterEach(() => jest.restoreAllMocks());

  it('raqamni matn qilib yozish endi hech kimni ulamaydi va xodim qidirilmaydi', async () => {
    const h = makeHarness([cand(1)]);
    await h.bot.handleUpdate(textUpdate('+998 90 123 45 67') as any);
    expect(h.access.findLinkCandidates).not.toHaveBeenCalled();
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(h.access.linkChat).not.toHaveBeenCalled();
    expect(h.sent()).toContain('Raqamni ulashish');
  });

  it('boshqa odamning kontaktini yuborsa rad etiladi (user_id mos emas)', async () => {
    const h = makeHarness([cand(1)]);
    await h.bot.handleUpdate(contactUpdate(777) as any);
    expect(h.access.findLinkCandidates).not.toHaveBeenCalled();
    expect(h.access.linkChat).not.toHaveBeenCalled();
  });

  it('guruh chatida contact qabul qilinmaydi', async () => {
    const h = makeHarness([cand(1)]);
    await h.bot.handleUpdate(contactUpdate(CHAT, 'group') as any);
    expect(h.access.linkChat).not.toHaveBeenCalled();
  });

  it("ro'yxatda yo'q raqam — ism/muassasa oshkor qilinmaydi", async () => {
    const h = makeHarness([]);
    await h.bot.handleUpdate(contactUpdate(CHAT) as any);
    expect(h.access.linkChat).not.toHaveBeenCalled();
    expect(h.sent()).toContain("ro'yxatida yo'q");
    expect(h.sent()).not.toMatch(/Xodim|Klinika|DIRECTOR|ADMIN/);
  });

  it('bitta mos xodim — darhol ulanadi', async () => {
    const h = makeHarness([cand(1)]);
    await h.bot.handleUpdate(contactUpdate(CHAT) as any);
    expect(h.access.linkChat).toHaveBeenCalledWith(String(CHAT), 'X', cand(1));
  });

  it("bir nechta muassasa — tanlangan index bo'yicha ulanadi", async () => {
    const h = makeHarness([cand(1), cand(2)]);
    await h.bot.handleUpdate(contactUpdate(CHAT) as any);
    expect(h.access.linkChat).not.toHaveBeenCalled();
    await h.bot.handleUpdate(callbackUpdate('link_pick:1') as any);
    expect(h.access.linkChat).toHaveBeenCalledWith(String(CHAT), 'X', cand(2));
  });

  it("contact'siz to'g'ridan-to'g'ri link_pick yuborilsa hech narsa ulanmaydi", async () => {
    const h = makeHarness([cand(1), cand(2)]);
    await h.bot.handleUpdate(callbackUpdate('link_pick:0') as any);
    expect(h.access.linkChat).not.toHaveBeenCalled();
  });
});
