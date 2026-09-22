import { AuditLogController } from './audit-log.controller';

describe('AuditLogController tenant scope', () => {
  function makeController() {
    const service = {
      findAll: jest.fn().mockResolvedValue({ records: [], total: 0 }),
      clearOldLogs: jest.fn(),
    };
    return {
      controller: new AuditLogController(service as any),
      service,
    };
  }

  it("tenant foydalanuvchisida query'dagi begona hospitalIdni e'tiborsiz qoldiradi", async () => {
    const { controller, service } = makeController();

    await controller.findAll(
      'own-hospital',
      'other-hospital',
      'User',
      'UPDATE',
      '2',
      '20',
    );

    expect(service.findAll).toHaveBeenCalledWith({
      hospitalId: 'own-hospital',
      entity: 'User',
      action: 'UPDATE',
      page: 2,
      limit: 20,
    });
  });

  it('platforma foydalanuvchisi tanlagan hospitalId bilan filtrlay oladi', async () => {
    const { controller, service } = makeController();

    await controller.findAll(null, 'selected-hospital');

    expect(service.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ hospitalId: 'selected-hospital' }),
    );
  });
});
