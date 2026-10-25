/** Runs against an isolated local PostgreSQL schema; never touches application tables. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { HikSyncQueueService } from '../src/hikvision/hik-sync-queue.service';
import type { HikSyncJob } from '../src/hikvision/hikvision.service';

const makeJob = (hospitalId: string): HikSyncJob => ({
  id: randomUUID(),
  hospitalId,
  state: 'RUNNING',
  queuePhase: 'WAITING',
  attempt: 0,
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
  startedAt: new Date().toISOString(),
  finishedAt: null,
  message: null,
});

async function child() {
  const p = new PrismaClient();
  const queue = new HikSyncQueueService(p as any);
  await queue.runNext(async (job) => {
    job.message = 'persisted-before-crash';
    job.done = 1;
    // Allow one real heartbeat to persist progress before the parent SIGKILLs us.
    setInterval(() => undefined, 1000); // Keep child alive until an actual SIGKILL.
    setTimeout(() => process.send?.('checkpoint-ready'), 6000);
    await new Promise(() => undefined);
  });
}

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'LOCAL DATABASE ONLY',
  );
  const schema = `hik_queue_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new PrismaClient();
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('schema', schema);
  const scopedUrl = url.toString();
  let first = new PrismaClient({ datasourceUrl: scopedUrl });
  const second = new PrismaClient({ datasourceUrl: scopedUrl });
  const qa = new HikSyncQueueService(first as any);
  const qb = new HikSyncQueueService(second as any);
  let worker: ReturnType<typeof fork> | undefined;
  try {
    const sql = readFileSync(
      'prisma/migrations/20261026050000_durable_hik_sync_queue/migration.sql',
      'utf8',
    );
    for (const statement of sql
      .replace(/--[^\n]*/g, '')
      .split(';')
      .filter((s) => s.trim()))
      await first.$executeRawUnsafe(statement);
    const [a, b] = await Promise.all([
      qa.enqueue(makeJob('tenant-a')),
      qb.enqueue(makeJob('tenant-a')),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(await first.hikSyncTask.count(), 1);
    console.log('PASS concurrent tenant enqueue deduplicated');

    await first.$disconnect();
    first = new PrismaClient({ datasourceUrl: scopedUrl });
    assert.equal((await qb.latest('tenant-a'))?.id, a.id);
    console.log('PASS pending task survives client/process replacement');

    worker = fork(__filename, ['--crash-child'], {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      env: { ...process.env, DATABASE_URL: scopedUrl },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Child checkpoint timeout')),
        20000,
      );
      worker!.once('message', (m) => {
        if (m === 'checkpoint-ready') {
          clearTimeout(timer);
          resolve();
        }
      });
      worker!.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Child exited before checkpoint'));
      });
    });
    let otherWorkerRan = false;
    await qb.runNext(async () => {
      otherWorkerRan = true;
    });
    assert.equal(otherWorkerRan, false);
    assert.equal(
      (await qb.latest('tenant-a'))?.message,
      'persisted-before-crash',
    );
    console.log(
      'PASS active lease excludes another worker and persists progress',
    );
    const died = new Promise((resolve) => worker!.once('exit', resolve));
    assert(worker.kill('SIGKILL'));
    await died;
    worker = undefined;
    // Advance only this test task's lease instead of waiting 60 seconds.
    await second.hikSyncTask.update({
      where: { id: a.id },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    await qb.runNext(async (job) => {
      assert.equal(job.id, a.id);
      assert.equal(job.attempt, 2);
      job.done = 3;
    });
    assert.equal((await qb.latest('tenant-a'))?.state, 'DONE');
    assert.equal((await qb.latest('tenant-a'))?.done, 3);
    console.log(
      'PASS SIGKILL task recovered by another worker with same job ID',
    );

    const retry = await qb.enqueue(makeJob('tenant-retry'));
    await qb.runNext(async () => {
      throw new Error('temporary failure');
    });
    const pending = await second.hikSyncTask.findUniqueOrThrow({
      where: { id: retry.id },
    });
    assert.equal(pending.state, 'WAITING');
    assert(pending.availableAt.getTime() > Date.now());
    assert.equal((await qb.latest('tenant-retry'))?.state, 'RUNNING');
    await second.hikSyncTask.update({
      where: { id: retry.id },
      data: { availableAt: new Date(Date.now() - 1000) },
    });
    await qb.runNext(async (job) => {
      assert.equal(job.attempt, 2);
    });
    assert.equal((await qb.latest('tenant-retry'))?.state, 'DONE');
    console.log('PASS transient failure retry scheduled and completed durably');

    const fence = await qb.enqueue(makeJob('tenant-fence'));
    let release!: () => void;
    let entered!: () => void;
    const signal = new Promise<void>((r) => {
      entered = r;
    });
    const stale = qb.runNext(async (job) => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      job.created = 999;
    });
    await signal;
    await second.hikSyncTask.update({
      where: { id: fence.id },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    await new HikSyncQueueService(second as any).runNext(async (job) => {
      job.created = 7;
    });
    release();
    await stale;
    assert.equal((await qb.latest('tenant-fence'))?.created, 7);
    console.log('PASS stale lease owner cannot overwrite recovered result');

    const exhausted = await qb.enqueue(makeJob('tenant-exhausted'));
    await second.hikSyncTask.update({
      where: { id: exhausted.id },
      data: { attempts: 4 },
    });
    await qb.runNext(async () => {
      throw new Error('last failure');
    });
    assert.equal((await qb.latest('tenant-exhausted'))?.state, 'FAILED');
    console.log('PASS bounded retries end in durable FAILED state');
  } finally {
    worker?.kill('SIGKILL');
    await first.$disconnect();
    await second.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.$disconnect();
  }
}
(process.argv.includes('--crash-child') ? child() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
