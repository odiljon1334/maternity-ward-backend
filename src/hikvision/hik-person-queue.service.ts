import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { HikPersonDelivery } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

type Runner = (
  task: HikPersonDelivery,
  fence: () => Promise<void>,
) => Promise<void>;
@Injectable()
export class HikPersonQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(HikPersonQueueService.name);
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  constructor(private readonly prisma: PrismaService) {}

  start(runner: Runner) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = this.runNext(runner)
        .catch(() =>
          this.logger.error('Xodim terminal navbatini bajarib bo‘lmadi'),
        )
        .finally(() => {
          this.active = undefined;
        });
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  async runNext(runner: Runner) {
    const owner = randomUUID();
    const rows = await this.prisma.$queryRaw<HikPersonDelivery[]>`
      UPDATE "HikPersonDelivery" SET "state"='ACTIVE',"leaseOwner"=${owner},
       "leaseUntil"=(now() AT TIME ZONE 'UTC')+interval '90 seconds',"attempts"="attempts"+1
      WHERE "id"=(SELECT "id" FROM "HikPersonDelivery"
       WHERE ("state"='WAITING' AND "availableAt" <= (now() AT TIME ZONE 'UTC'))
        OR ("state"='ACTIVE' AND "leaseUntil" < (now() AT TIME ZONE 'UTC'))
       ORDER BY CASE WHEN "action" IN ('DELETE','BLOCK') THEN 0 ELSE 1 END,"availableAt","createdAt"
       FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`;
    const task = rows[0];
    if (!task) return;
    let lost = false;
    const fence = async () => {
      if (lost) throw Error('LEASE_LOST');
      const result = await this.prisma.hikPersonDelivery.updateMany({
        where: {
          id: task.id,
          leaseOwner: owner,
          state: 'ACTIVE',
          revision: task.revision,
          leaseUntil: { gt: new Date() },
        },
        data: { leaseUntil: new Date(Date.now() + 90_000) },
      });
      if (result.count !== 1) {
        lost = true;
        throw Error('TASK_CHANGED');
      }
    };
    const heartbeat = setInterval(() => {
      void this.prisma.hikPersonDelivery
        .updateMany({
          where: {
            id: task.id,
            leaseOwner: owner,
            state: 'ACTIVE',
            leaseUntil: { gt: new Date() },
          },
          data: { leaseUntil: new Date(Date.now() + 90_000) },
        })
        .then((r) => {
          if (r.count !== 1) lost = true;
        })
        .catch(() => {
          lost = true;
        });
    }, 20_000);
    heartbeat.unref();
    try {
      await fence();
      await runner(task, fence);
      await fence();
      await this.prisma.hikPersonDelivery.updateMany({
        where: { id: task.id, leaseOwner: owner, revision: task.revision },
        data: {
          state: 'DELIVERED',
          deliveredRevision: task.revision,
          deliveredPhotoUrl: task.action === 'UPSERT' ? task.photoUrl : null,
          confirmedAt: new Date(),
          lastError: null,
          leaseOwner: null,
          leaseUntil: null,
        },
      });
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : 'Terminal javobini tekshirib bo‘lmadi';
      // Never persist vendor payloads (which can contain employee/biometric details).
      const permanent =
        reason.startsWith('ERROR:') ||
        [400, 401, 403].includes((error as any)?.httpStatus);
      const message =
        reason.startsWith('WAIT:') || reason.startsWith('ERROR:')
          ? reason.slice(0, 240)
          : permanent
            ? 'ERROR:Terminal yoki Gateway amalni rad etdi; sozlamalarni tekshiring'
            : 'WAIT:Terminal javobi tasdiqlanmadi; qayta uriniladi';
      await this.prisma.hikPersonDelivery.updateMany({
        where: { id: task.id, leaseOwner: owner, revision: task.revision },
        data: {
          state:
            reason === 'SKIP:NO_PHOTO'
              ? 'SKIPPED'
              : permanent
                ? 'ERROR'
                : 'WAITING',
          lastError: reason === 'SKIP:NO_PHOTO' ? null : message,
          availableAt: new Date(
            Date.now() +
              Math.min(300_000, 5000 * 2 ** Math.min(task.attempts, 6)),
          ),
          leaseOwner: null,
          leaseUntil: null,
        },
      });
    } finally {
      clearInterval(heartbeat);
      // A newer desired state arrived during I/O: release it without marking it delivered.
      await this.prisma.hikPersonDelivery.updateMany({
        where: {
          id: task.id,
          leaseOwner: owner,
          revision: { not: task.revision },
        },
        data: {
          state: 'WAITING',
          leaseOwner: null,
          leaseUntil: null,
          availableAt: new Date(),
        },
      });
    }
  }

  async status(hospitalId: string, employeeId?: string, page = 1) {
    const where = {
      hospitalId,
      ...(employeeId ? { employeeId } : {}),
      state: { not: 'SKIPPED' },
    };
    const [items, total, groups, terminals, withoutPhoto] = await Promise.all([
      this.prisma.hikPersonDelivery.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * 30,
        take: 30,
        select: {
          id: true,
          terminalId: true,
          employeeId: true,
          employeeNo: true,
          fullName: true,
          action: true,
          state: true,
          revision: true,
          deliveredRevision: true,
          attempts: true,
          lastError: true,
          confirmedAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.hikPersonDelivery.count({ where }),
      this.prisma.hikPersonDelivery.groupBy({
        by: ['state'],
        where,
        _count: true,
      }),
      this.prisma.hikTerminal.findMany({
        where: { hospitalId },
        select: { id: true, name: true, isActive: true },
      }),
      this.prisma.employee.count({
        where: {
          hospitalId,
          ...(employeeId ? { id: employeeId } : {}),
          firedAt: null,
          status: { in: ['ACTIVE', 'ON_LEAVE'] },
          AND: [
            { OR: [{ photoUrl: null }, { photoUrl: '' }] },
            { OR: [{ userId: null }, { user: { status: 'ACTIVE' } }] },
          ],
        },
      }),
    ]);
    return {
      items: items.map((i) => ({
        ...i,
        terminalName:
          terminals.find((t) => t.id === i.terminalId)?.name ??
          'Uzilgan terminal',
      })),
      total,
      withoutPhoto,
      page,
      pageSize: 30,
      counts: Object.fromEntries(groups.map((g) => [g.state, g._count])),
    };
  }
  async retry(id: string, hospitalId: string) {
    const result = await this.prisma.hikPersonDelivery.updateMany({
      where: { id, hospitalId, state: { in: ['ERROR', 'WAITING'] } },
      data: {
        state: 'WAITING',
        availableAt: new Date(),
        lastError: null,
        attempts: 0,
      },
    });
    return { queued: result.count === 1 };
  }
}
