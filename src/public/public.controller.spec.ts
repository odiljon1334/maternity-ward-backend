import { TrialLeadSource } from '@prisma/client';
import { PublicController } from './public.controller';

function makeController(captureError?: Error) {
  const supportBot = {
    notifyLeadFromWebForm: jest.fn().mockResolvedValue(undefined),
  };
  const trialLeads = {
    capture: captureError
      ? jest.fn().mockRejectedValue(captureError)
      : jest.fn().mockResolvedValue({ id: 'lead-1' }),
  };
  return {
    controller: new PublicController(supportBot as any, trialLeads as any),
    supportBot,
    trialLeads,
  };
}

const dto = {
  hospitalName: 'Test klinika',
  directorName: 'Ali Valiyev',
  phone: '+998901234567',
  region: 'Andijon',
  staffCount: 25,
  plan: 'biznes' as const,
};

const req: any = {
  headers: { 'x-forwarded-for': '203.0.113.10' },
  ip: '127.0.0.1',
};

describe('PublicController.trialRequest', () => {
  it('leadni avval bazaga saqlab, keyin mavjud Telegram/PDF oqimini davom ettiradi', async () => {
    const { controller, supportBot, trialLeads } = makeController();

    await expect(controller.trialRequest(dto, req)).resolves.toEqual({
      ok: true,
    });

    expect(trialLeads.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        source: TrialLeadSource.WEB_FORM,
        institutionName: 'Test klinika',
        contactName: 'Ali Valiyev',
      }),
    );
    expect(supportBot.notifyLeadFromWebForm).toHaveBeenCalledTimes(1);
    expect(trialLeads.capture.mock.invocationCallOrder[0]).toBeLessThan(
      supportBot.notifyLeadFromWebForm.mock.invocationCallOrder[0],
    );
  });

  it("DB yozuvi ishlamasa ham Telegram/PDF fallback oqimini to'xtatmaydi", async () => {
    const { controller, supportBot } = makeController(
      new Error('database unavailable'),
    );

    await expect(controller.trialRequest(dto, req)).resolves.toEqual({
      ok: true,
    });
    expect(supportBot.notifyLeadFromWebForm).toHaveBeenCalledTimes(1);
  });
});
