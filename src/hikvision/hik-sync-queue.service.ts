import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import type { HikSyncJob } from './hikvision.service';

export const SYNC_LEASE_MS = 60_000;
export const SYNC_MAX_ATTEMPTS = 5;
type Runner = (job: HikSyncJob, assertLease: () => void) => Promise<void>;

@Injectable()
export class HikSyncQueueService {
  private readonly logger = new Logger(HikSyncQueueService.name);
  private timer?: ReturnType<typeof setInterval>;
  private active: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly prisma: PrismaService) {}

  async enqueue(job: HikSyncJob): Promise<HikSyncJob> {
    try {
      const record = await this.prisma.hikSyncTask.create({
        data: {
          id: job.id,
          hospitalId: job.hospitalId,
          snapshot: this.json(job),
        },
      });
      return record.snapshot as unknown as HikSyncJob;
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      const running = await this.prisma.hikSyncTask.findFirst({
        where: {
          hospitalId: job.hospitalId,
          state: { in: ['WAITING', 'ACTIVE'] },
        },
      });
      if (!running) throw error;
      return running.snapshot as unknown as HikSyncJob;
    }
  }

  async latest(hospitalId: string): Promise<HikSyncJob | null> {
    const row = await this.prisma.hikSyncTask.findFirst({
      where: { hospitalId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return row ? (row.snapshot as unknown as HikSyncJob) : null;
  }

  start(runner: Runner) {
    if (this.timer) return;
    this.stopping = false;
    const poll = () => {
      if (this.active || this.stopping) return;
      this.active = this.runNext(runner)
        .catch(() =>
          this.logger.error(
            'Terminal sync navbatini tekshirish amalga oshmadi',
          ),
        )
        .finally(() => {
          this.active = null;
        });
    };
    this.timer = setInterval(poll, 3000);
    this.timer.unref();
    poll();
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  /** Claim is one atomic PostgreSQL statement. Expired ACTIVE tasks are reclaimable. */
  async runNext(runner: Runner): Promise<void> {
    const owner = randomUUID();
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; snapshot: unknown; attempts: number }>
    >`
      UPDATE "HikSyncTask" SET "state" = 'ACTIVE', "leaseOwner" = ${owner},
        "leaseUntil" = (now() AT TIME ZONE 'UTC') + interval '60 seconds', "attempts" = "attempts" + 1, "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "id" = (
        SELECT "id" FROM "HikSyncTask"
        WHERE ("state" = 'WAITING' AND "availableAt" <= (now() AT TIME ZONE 'UTC'))
          OR ("state" = 'ACTIVE' AND "leaseUntil" < (now() AT TIME ZONE 'UTC'))
        ORDER BY "availableAt", "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
      ) RETURNING "id", "snapshot", "attempts"`;
    const row = rows[0];
    if (!row) return;
    const previous = row.snapshot as HikSyncJob;
    // Re-read terminal inventory on every attempt; already-uploaded users/faces are skipped.
    const job: HikSyncJob = {
      ...previous,
      state: 'RUNNING',
      total: 0,
      withoutPhoto: 0,
      units: 0,
      done: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      errorsTruncated: 0,
      perTerminal: [],
      finishedAt: null,
      retryable: false,
      attempt: row.attempts,
      queuePhase: 'ACTIVE',
      message:
        row.attempts > 1
          ? 'Uzilgan vazifa qayta tekshirilib davom ettirilmoqda'
          : null,
    };
    let deadline = Date.now() + SYNC_LEASE_MS;
    let lost = false;
    let executing = true;
    const assertLease = () => {
      if (!executing || lost || this.stopping || Date.now() >= deadline)
        throw new Error('SYNC_LEASE_LOST');
    };
    const where = () => ({
      id: row.id,
      state: 'ACTIVE',
      leaseOwner: owner,
      leaseUntil: { gt: new Date() },
    });
    let renewing: Promise<void> | null = null;
    const renew = async () => {
      const until = new Date(Date.now() + SYNC_LEASE_MS);
      const count = await this.prisma.hikSyncTask.updateMany({
        where: where(),
        data: {
          snapshot: this.json(job),
          leaseUntil: until,
        },
      });
      if (count.count !== 1) throw new Error('SYNC_LEASE_LOST');
      deadline = until.getTime();
    };
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = renew()
        .catch(() => {
          lost = true;
        })
        .finally(() => {
          renewing = null;
        });
    }, 5000);
    heartbeat.unref();
    let state = 'DONE';
    let availableAt = new Date();
    try {
      await renew();
      assertLease();
      if (row.attempts > SYNC_MAX_ATTEMPTS)
        throw new Error('SYNC_ATTEMPTS_EXHAUSTED');
      await runner(job, assertLease);
      assertLease();
      if (job.retryable && job.failed > 0)
        throw new Error('SYNC_TRANSIENT_FAILURE');
      job.state = 'DONE';
      job.finishedAt = new Date().toISOString();
      job.queuePhase = 'DONE';
    } catch {
      if (lost || this.stopping || Date.now() >= deadline) return;
      if (row.attempts < SYNC_MAX_ATTEMPTS) {
        state = 'WAITING';
        availableAt = new Date(
          Date.now() + Math.min(900_000, 30_000 * 2 ** (row.attempts - 1)),
        );
        job.state = 'RUNNING';
        job.queuePhase = 'WAITING';
        job.finishedAt = null;
        job.message = 'Aloqa tiklangach vazifa avtomatik qayta bajariladi';
      } else {
        state = 'FAILED';
        job.state = 'FAILED';
        job.queuePhase = 'FAILED';
        job.finishedAt = new Date().toISOString();
        job.message =
          '5 urinishdan keyin vazifa to‘xtadi. Aloqani tekshirib qayta boshlang.';
      }
    } finally {
      executing = false;
      clearInterval(heartbeat);
      await renewing;
    }
    if (lost || this.stopping || Date.now() >= deadline) return;
    await this.prisma.hikSyncTask.updateMany({
      where: where(),
      data: {
        state,
        snapshot: this.json(job),
        availableAt,
        leaseOwner: null,
        leaseUntil: null,
      },
    });
  }

  private json(job: HikSyncJob): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(job));
  }
}
