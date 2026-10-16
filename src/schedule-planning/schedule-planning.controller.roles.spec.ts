import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { SchedulePlanningController } from './schedule-planning.controller';

function rolesFor(method: keyof SchedulePlanningController): UserRole[] {
  return Reflect.getMetadata(
    ROLES_KEY,
    SchedulePlanningController.prototype[method],
  );
}

describe('SchedulePlanningController workflow roles', () => {
  it('qoralamani Kadr inspektori rollari tahrirlaydi, direktor esa tahrirlamaydi', () => {
    expect(rolesFor('saveEntries')).toEqual([
      UserRole.SUPER_ADMIN,
      UserRole.ASSISTANT_ADMIN,
      UserRole.ADMIN,
    ]);
    expect(rolesFor('submitPlan')).not.toContain(UserRole.DIRECTOR);
  });

  it('yuborilgan rejaga faqat rahbar rollari qaror beradi', () => {
    expect(rolesFor('approvePlan')).toEqual([
      UserRole.SUPER_ADMIN,
      UserRole.DIRECTOR,
    ]);
    expect(rolesFor('rejectPlan')).not.toContain(UserRole.ADMIN);
    expect(rolesFor('approveChangeRequest')).not.toContain(UserRole.ADMIN);
  });
});
