import { isHeartbeat } from './hikvision-webhook.controller';

describe('isHeartbeat — terminal heartBeat hodisasi', () => {
  it('JSON heartBeat', () => {
    expect(
      isHeartbeat({
        ipAddress: '192.168.1.9',
        eventType: 'heartBeat',
        eventState: 'active',
      }),
    ).toBe(true);
  });
  it('XML heartBeat', () => {
    expect(
      isHeartbeat(
        '<EventNotificationAlert><eventType>heartBeat</eventType></EventNotificationAlert>',
      ),
    ).toBe(true);
  });
  it('yuz orqali kirish hodisasi heartbeat emas', () => {
    expect(
      isHeartbeat({
        eventType: 'AccessControllerEvent',
        AccessControllerEvent: { employeeNoString: '12' },
      }),
    ).toBe(false);
    expect(isHeartbeat(undefined)).toBe(false);
  });
});
