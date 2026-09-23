import { Telegraf, Telegram } from 'telegraf';
import { TelegramService } from './telegram.service';

/**
 * HR bot — shifoxonalar orasidagi izolyatsiya testlari (2026-09-23 audit).
 *
 * Ilgari ulanmagan chat uchun builderlarga `null` uzatilar va ular
 * filtrni olib tashlab BARCHA shifoxonalar ma'lumotini qaytarardi.
 * Shuningdek `cmd_came:<id>` / `pay_*:<id>` callback'laridagi ID'ga
 * ishonilardi. Bu testlar haqiqiy Telegraf handlerlari orqali (tarmoqsiz,
 * `callApi` soxtalashtirilgan) shu teshiklar yopilganini tekshiradi.
 */

const LINKED_CHAT = 111;
const STRANGER_CHAT = 999;

export function makeHarness() {
  const prisma: any = {
    telegramSubscription: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.chatId === String(LINKED_CHAT)
          ? { id: 's1', chatId: where.chatId, hospitalId: 'h1', isActive: true }
          : null,
      ),
    },
    schedule: { findMany: jest.fn(async () => []) },
    attendanceRecord: { findMany: jest.fn(async () => []) },
    employee: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
  };
  const config: any = { get: jest.fn(() => undefined) };
  const access: any = {
    findLinkCandidates: jest.fn(async () => []),
    linkChat: jest.fn(async () => true),
  };
  const service = new TelegramService(config, prisma, access);

  const bot = new Telegraf('123:TEST');
  // Telegraf har bir update uchun yangi Telegram instansiyasini yaratadi —
  // shuning uchun prototype darajasida soxtalashtiramiz (tarmoqqa chiqmaydi).
  const callApi = jest
    .spyOn(Telegram.prototype as any, 'callApi')
    .mockImplementation(async (method: any) =>
      method === 'getMe' ? { id: 1, is_bot: true, username: 'test_bot' } : true,
    ) as unknown as jest.Mock;
  (bot as any).botInfo = { id: 1, is_bot: true, username: 'test_bot' };
  (service as any).bot = bot;
  (service as any).setupCommands();

  const sentTexts = () =>
    callApi.mock.calls
      .filter(([m]) => m === 'sendMessage')
      .map(([, p]: any) => String(p.text));

  return { prisma, access, bot, callApi, sentTexts };
}

let updateId = 1;
function commandUpdate(chatId: number, text: string) {
  return {
    update_id: updateId++,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'X' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  };
}
function callbackUpdate(chatId: number, data: string) {
  return {
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      chat_instance: 'ci',
      from: { id: chatId, is_bot: false, first_name: 'X' },
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        text: 'x',
      },
      data,
    },
  };
}

/** Barcha schedule/attendance so'rovlari berilgan shifoxona bilan filtrlanganmi */
function expectAllQueriesScopedTo(prisma: any, hospitalId: string) {
  const calls = [
    ...prisma.schedule.findMany.mock.calls,
    ...prisma.attendanceRecord.findMany.mock.calls,
  ];
  expect(calls.length).toBeGreaterThan(0);
  for (const [args] of calls) {
    expect(args.where.employee).toEqual({ hospitalId });
  }
}

describe('TelegramService — shifoxona izolyatsiyasi', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['/bugun', '/kelmaganlar', '/haftalik', '/oylik'])(
    "ulanmagan chat %s yozsa hech qanday ma'lumot so'ralmaydi",
    async (cmd) => {
      const h = makeHarness();
      await h.bot.handleUpdate(commandUpdate(STRANGER_CHAT, cmd) as any);

      expect(h.prisma.schedule.findMany).not.toHaveBeenCalled();
      expect(h.prisma.attendanceRecord.findMany).not.toHaveBeenCalled();
      expect(h.prisma.employee.findMany).not.toHaveBeenCalled();
      expect(h.sentTexts().join('\n')).toContain(
        'avval kasalxona tizimiga ulaning',
      );
    },
  );

  it.each(['cmd_came:null', 'cmd_notcame:null', 'cmd_came:h2', 'cmd_today'])(
    "ulanmagan chat '%s' callback'ini yuborsa ma'lumot olmaydi",
    async (data) => {
      const h = makeHarness();
      await h.bot.handleUpdate(callbackUpdate(STRANGER_CHAT, data) as any);

      expect(h.prisma.schedule.findMany).not.toHaveBeenCalled();
      expect(h.prisma.attendanceRecord.findMany).not.toHaveBeenCalled();
    },
  );

  it('ulangan chat /kelmaganlar — faqat o‘z shifoxonasi bilan filtrlanadi', async () => {
    const h = makeHarness();
    await h.bot.handleUpdate(commandUpdate(LINKED_CHAT, '/kelmaganlar') as any);
    expectAllQueriesScopedTo(h.prisma, 'h1');
  });

  it("callback'dagi boshqa shifoxona ID'si e'tiborga olinmaydi (cmd_came:h2 → h1)", async () => {
    const h = makeHarness();
    await h.bot.handleUpdate(callbackUpdate(LINKED_CHAT, 'cmd_came:h2') as any);
    expectAllQueriesScopedTo(h.prisma, 'h1');
  });

  it("yangi formatdagi callback (ID'siz cmd_notcame) ham ishlaydi", async () => {
    const h = makeHarness();
    await h.bot.handleUpdate(callbackUpdate(LINKED_CHAT, 'cmd_notcame') as any);
    expectAllQueriesScopedTo(h.prisma, 'h1');
  });
});
