import { EmployeesService } from '../src/employees/employees.service';
/** Isolated LOCAL PostgreSQL: outbox atomicity, ordering, restart and tenant isolation. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { HikPersonQueueService } from '../src/hikvision/hik-person-queue.service';

function statements(sql: string) {
  sql = sql.replace(/--[^\n]*/g, '');
  const parts: string[] = [];
  let start = 0,
    inBody = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.slice(i, i + 2) === '$$') {
      inBody = !inBody;
      i++;
    }
    if (sql[i] === ';' && !inBody) {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(sql.slice(start));
  return parts.filter((s) => s.trim());
}
async function child() {
  const p = new PrismaClient();
  await new HikPersonQueueService(p as any).runNext(async () => {
    process.send?.('claimed');
    setInterval(() => undefined, 1000);
    await new Promise(() => undefined);
  });
}
async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'LOCAL DATABASE ONLY',
  );
  const admin = new PrismaClient();
  const schema = `person_queue_${randomUUID().replaceAll('-', '')}`;
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('schema', schema);
  const p = new PrismaClient({ datasourceUrl: url.toString() });
  const other = new PrismaClient({ datasourceUrl: url.toString() });
  let worker: ReturnType<typeof fork> | undefined;
  const qa = new HikPersonQueueService(p as any),
    qb = new HikPersonQueueService(other as any);
  try {
    for (const sql of [
      `CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE','ON_LEAVE','INACTIVE','FIRED')`,
      `CREATE TYPE "UserStatus" AS ENUM ('ACTIVE','INACTIVE','SUSPENDED')`,
      'CREATE TABLE "User" (id TEXT PRIMARY KEY,status "UserStatus" NOT NULL)',
      'CREATE TABLE "Employee" (id TEXT PRIMARY KEY,"employeeNo" TEXT,"hospitalId" TEXT,"fullName" TEXT,"photoUrl" TEXT,status "EmployeeStatus","firedAt" TIMESTAMP,"userId" TEXT)',
      'CREATE TABLE "HikTerminal" (id TEXT PRIMARY KEY,"hospitalId" TEXT,"isActive" BOOLEAN,"devIndex" TEXT,name TEXT)',
    ])
      await p.$executeRawUnsafe(sql);
    for (const sql of statements(
      readFileSync(
        'prisma/migrations/20261026120000_terminal_employee_delivery/migration.sql',
        'utf8',
      ),
    ))
      await p.$executeRawUnsafe(sql);
    for (const sql of statements(
      readFileSync(
        'prisma/migrations/20261026140000_skip_photoless_terminal_upserts/migration.sql',
        'utf8',
      ),
    ))
      await p.$executeRawUnsafe(sql);
    await p.$executeRawUnsafe(
      `INSERT INTO "HikTerminal" VALUES ('ta','a',true,'da','Terminal A'),('tb','b',true,'db','Terminal B'),('paused','a',false,'dp','Paused')`,
    );
    await p.$executeRawUnsafe(`INSERT INTO "User" VALUES ('ua','ACTIVE')`);
    await p.$executeRawUnsafe(
      `INSERT INTO "Employee" VALUES ('ea','101','a','A','/uploads/a.jpg','ACTIVE',NULL,'ua')`,
    );
    assert.equal(await p.hikPersonDelivery.count(), 2);
    await p.$executeRawUnsafe(
      `INSERT INTO "Employee" VALUES ('no-photo','999','a','No photo',NULL,'ACTIVE',NULL,NULL)`,
    );
    assert.equal(
      await p.hikPersonDelivery.count({ where: { employeeId: 'no-photo' } }),
      0,
    );
    assert.equal((await qa.status('a', 'no-photo')).withoutPhoto, 1);
    await p.$executeRawUnsafe(
      `UPDATE "Employee" SET "photoUrl"='/uploads/new.jpg' WHERE id='no-photo'`,
    );
    assert.equal(
      await p.hikPersonDelivery.count({ where: { employeeId: 'no-photo' } }),
      2,
    );
    await p.$executeRawUnsafe(
      `UPDATE "Employee" SET "photoUrl"=NULL WHERE id='no-photo'`,
    );
    assert.equal(
      await p.hikPersonDelivery.count({
        where: { employeeId: 'no-photo', state: 'SKIPPED' },
      }),
      2,
    );
    assert.equal((await qa.status('a', 'no-photo')).total, 0);
    await p.$executeRawUnsafe(
      `UPDATE "Employee" SET status='INACTIVE' WHERE id='no-photo'`,
    );
    assert.equal(
      await p.hikPersonDelivery.count({
        where: { employeeId: 'no-photo', action: 'BLOCK', state: 'WAITING' },
      }),
      2,
    );
    await p.$executeRawUnsafe(`DELETE FROM "Employee" WHERE id='no-photo'`);
    assert.equal(
      await p.hikPersonDelivery.count({
        where: { employeeId: 'no-photo', action: 'DELETE' },
      }),
      2,
    );
    await p.hikPersonDelivery.deleteMany({ where: { employeeId: 'no-photo' } });
    console.log(
      'PASS no-photo creates no tasks, photo queues, removal skips; block/delete still queued; count is distinct employees',
    );
    console.log(
      'PASS employee creation queues each configured terminal including disabled; other tenant excluded',
    );
    const row = await p.hikPersonDelivery.findFirstOrThrow({
      where: { terminalId: 'ta' },
    });
    await assert.rejects(
      p.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "Employee" SET "fullName"='ROLLBACK' WHERE id='ea'`,
        );
        throw Error('rollback');
      }),
    );
    assert.equal(
      (await p.hikPersonDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .revision,
      1,
    );
    console.log('PASS failed employee transaction rolls back outbox too');
    await p.$executeRawUnsafe(
      `UPDATE "Employee" SET "fullName"='Updated' WHERE id='ea'`,
    );
    assert.equal(
      (await p.hikPersonDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .revision,
      2,
    );
    await p.$executeRawUnsafe(
      `UPDATE "User" SET status='INACTIVE' WHERE id='ua'`,
    );
    assert.equal(
      (await p.hikPersonDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .action,
      'BLOCK',
    );
    await p.$executeRawUnsafe(
      `UPDATE "User" SET status='ACTIVE' WHERE id='ua'`,
    );
    assert.equal(
      (await p.hikPersonDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .action,
      'UPSERT',
    );
    console.log(
      'PASS name update, account block and unblock persist desired terminal state',
    );
    let calls = 0;
    await Promise.all([
      qa.runNext(async () => {
        calls++;
      }),
      qb.runNext(async () => {
        calls++;
      }),
    ]);
    assert.equal(calls, 2); // different terminals, never the same task
    assert.equal(
      await p.hikPersonDelivery.count({ where: { state: 'DELIVERED' } }),
      2,
    );
    console.log(
      'PASS concurrent workers claim distinct tasks and confirm exact revisions',
    );
    await p.$executeRawUnsafe(
      `UPDATE "Employee" SET "fullName"='Before IO' WHERE id='ea'`,
    );
    await qa.runNext(async (_, fence) => {
      await p.$executeRawUnsafe(
        `UPDATE "Employee" SET "fullName"='During IO' WHERE id='ea'`,
      );
      await assert.rejects(fence());
    });
    assert.equal(
      await p.hikPersonDelivery.count({ where: { state: 'DELIVERED' } }),
      0,
    );
    assert.equal(
      await p.hikPersonDelivery.count({ where: { state: 'ACTIVE' } }),
      0,
    );
    console.log(
      'PASS concurrent employee changes cannot be falsely marked delivered',
    );
    await p.hikPersonDelivery.updateMany({
      data: { availableAt: new Date(Date.now() + 60000) },
    });
    await p.hikPersonDelivery.update({
      where: { id: row.id },
      data: { availableAt: new Date(0) },
    });
    await qa.runNext(async () => {
      throw Error('WAIT:Terminal offline');
    });
    const waiting = await p.hikPersonDelivery.findUniqueOrThrow({
      where: { id: row.id },
    });
    assert.equal(waiting.state, 'WAITING');
    assert(waiting.availableAt > new Date());
    assert(waiting.deliveredRevision < waiting.revision);
    await p.hikPersonDelivery.update({
      where: { id: row.id },
      data: { availableAt: new Date(0) },
    });
    await qa.runNext(async () => {
      throw Error('ERROR:Surat rad etildi');
    });
    assert.equal(
      (await p.hikPersonDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .state,
      'ERROR',
    );
    assert.equal((await qa.retry(row.id, 'b')).queued, false);
    assert.equal((await qa.retry(row.id, 'a')).queued, true);
    assert.equal((await qa.status('b')).total, 0);
    console.log(
      'PASS offline retry persists; permanent error visible; retry and listing are tenant-scoped',
    );
    worker = fork(__filename, ['--child'], {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('Child claim timed out')),
        15000,
      );
      worker!.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
      worker!.once('exit', () => {
        clearTimeout(timer);
        reject(Error('Child exited'));
      });
    });
    worker.kill('SIGKILL');
    await new Promise<void>((resolve) => worker!.once('exit', () => resolve()));
    assert.equal(
      (await p.hikPersonDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .state,
      'ACTIVE',
    );
    await p.hikPersonDelivery.update({
      where: { id: row.id },
      data: { leaseUntil: new Date(0) },
    });
    let reclaimed = false;
    await qb.runNext(async () => {
      reclaimed = true;
    });
    assert(reclaimed);
    console.log(
      'PASS SIGKILL leaves durable work; fresh worker reclaims expired lease',
    );
    await p.$executeRawUnsafe(
      `UPDATE "Employee" SET "employeeNo"='102' WHERE id='ea'`,
    );
    assert.equal(
      await p.hikPersonDelivery.count({
        where: { employeeNo: '101', action: 'DELETE' },
      }),
      2,
    );
    assert.equal(
      await p.hikPersonDelivery.count({
        where: { employeeNo: '102', action: 'UPSERT' },
      }),
      2,
    );
    await p.$executeRawUnsafe(`DELETE FROM "Employee" WHERE id='ea'`);
    assert.equal(
      await p.hikPersonDelivery.count({
        where: { employeeNo: '102', action: 'DELETE' },
      }),
      2,
    );
    console.log(
      'PASS identifier change cleans old ID; hard-delete tombstone survives employee removal',
    );
    await p.hikPersonDelivery.deleteMany();
    await p.hikPersonDelivery.createMany({
      data: [
        {
          id: 'speed-1',
          terminalId: 'ta',
          hospitalId: 'a',
          employeeId: 'e1',
          employeeNo: '201',
          fullName: 'One',
          action: 'UPSERT',
        },
        {
          id: 'speed-2',
          terminalId: 'ta',
          hospitalId: 'a',
          employeeId: 'e2',
          employeeNo: '202',
          fullName: 'Two',
          action: 'UPSERT',
        },
        {
          id: 'speed-3',
          availableAt: new Date(Date.now() + 60000),
          terminalId: 'paused',
          hospitalId: 'a',
          employeeId: 'e3',
          employeeNo: '203',
          fullName: 'Three',
          action: 'UPSERT',
        },
      ],
    });
    let release!: () => void;
    let claimed!: () => void;
    const acquired = new Promise<void>((r) => (claimed = r));
    const held = new Promise<void>((r) => (release = r));
    const first = qa.runNext(async () => {
      claimed();
      await held;
    });
    await acquired;
    await p.hikPersonDelivery.update({
      where: { id: 'speed-3' },
      data: { availableAt: new Date(0) },
    });
    let otherTerminal = '';
    try {
      await qb.runNext(async (task) => {
        otherTerminal = task.terminalId;
      });
    } finally {
      release();
      await first;
    }
    assert.equal(
      otherTerminal,
      'paused',
      'busy terminal must not block another terminal or receive concurrent writes',
    );
    await qb.runNext(async (task) => assert.equal(task.id, 'speed-2'));
    console.log(
      'PASS different terminals run concurrently, same terminal remains serial',
    );
    await p.hikPersonDelivery.deleteMany();
    await p.$executeRawUnsafe(
      'CREATE TABLE "Department" (id TEXT PRIMARY KEY,name TEXT)',
    );
    await p.$executeRawUnsafe(
      'CREATE TABLE "Position" (id TEXT PRIMARY KEY,name TEXT)',
    );
    await p.$executeRawUnsafe(
      'ALTER TABLE "Employee" ADD COLUMN "departmentId" TEXT, ADD COLUMN "positionId" TEXT',
    );
    await p.$executeRawUnsafe(
      `INSERT INTO "Department" VALUES ('dept','Therapy')`,
    );
    await p.$executeRawUnsafe(`INSERT INTO "Position" VALUES ('pos','Doctor')`);
    await p.$executeRawUnsafe(
      `INSERT INTO "Employee" VALUES ('filter-photo','401','a','Photo Person','/uploads/filter.jpg','ACTIVE',NULL,NULL,'dept','pos'),('filter-none','402','a','No Photo Person',NULL,'ACTIVE',NULL,NULL,'dept','pos')`,
    );
    const all = await qa.people('a');
    assert.equal(all.counts.ALL, 2);
    assert.equal(all.counts.NO_PHOTO, 1);
    assert.equal(all.counts.DELIVERED, 0);
    assert.equal(all.employees[0].department, 'Therapy');
    assert.equal(all.employees[0].position, 'Doctor');
    const noPhoto = await qa.people('a', undefined, 'NO_PHOTO');
    assert.equal(noPhoto.total, 1);
    assert.equal(noPhoto.employees[0].fullName, 'No Photo Person');
    assert.equal(noPhoto.employees[0].deliveries.length, 0);
    await p.$executeRawUnsafe(
      `UPDATE "HikPersonDelivery" SET state='DELIVERED',"deliveredRevision"=revision WHERE "terminalId"='ta'`,
    );
    assert.equal(
      (await qa.people('a', undefined, 'DELIVERED')).total,
      0,
      'one terminal is not full employee success',
    );
    await p.$executeRawUnsafe(
      `UPDATE "HikPersonDelivery" SET state='ERROR',"lastError"='ERROR:No face' WHERE "terminalId"='paused'`,
    );
    const errors = await qa.people('a', undefined, 'ERROR');
    assert.equal(errors.total, 1);
    assert.equal(
      errors.employees[0].deliveries.find((d) => d.state === 'ERROR')?.photoUrl,
      '/uploads/filter.jpg',
    );
    await p.$executeRawUnsafe(
      `UPDATE "HikPersonDelivery" SET state='DELIVERED',"deliveredRevision"=revision`,
    );
    assert.equal(
      (await qa.people('a', undefined, 'DELIVERED')).total,
      1,
      'two terminals count as one employee',
    );
    const otherTenant = await qa.people('b');
    assert.equal(otherTenant.counts.ALL, 0);
    assert.equal(otherTenant.counts.NO_PHOTO, 0);
    assert.equal(otherTenant.employees.length, 0);
    console.log(
      'PASS employee filters: distinct confirmed success, partial delivery excluded, no-photo metadata, failed photo and tenant isolation',
    );
    const employeeListService: any = new EmployeesService(p as any, {} as any);
    const page = [
      {
        id: 'filter-photo',
        photoUrl: '/uploads/filter.jpg',
        employeeNo: '401',
      },
      { id: 'filter-none', photoUrl: null, employeeNo: '402' },
    ];
    assert.equal(
      (await employeeListService.terminalPhotoStatuses(page)).get(
        'filter-photo',
      ),
      'UNCONFIRMED',
      'missing photo confirmation cannot show a green badge',
    );
    await p.$executeRawUnsafe(
      `UPDATE "HikPersonDelivery" SET "deliveredPhotoUrl"="photoUrl" WHERE "terminalId"='ta'`,
    );
    assert.equal(
      (await employeeListService.terminalPhotoStatuses(page)).get(
        'filter-photo',
      ),
      'UNCONFIRMED',
      'one NULL confirmation must not be ignored by bool_and',
    );
    await p.$executeRawUnsafe(
      `UPDATE "HikPersonDelivery" SET "deliveredPhotoUrl"="photoUrl"`,
    );
    assert.equal(
      (await employeeListService.terminalPhotoStatuses(page)).get(
        'filter-photo',
      ),
      'DELIVERED',
    );
    await p.$executeRawUnsafe(
      `UPDATE "HikPersonDelivery" SET state='WAITING' WHERE "terminalId"='ta'`,
    );
    assert.equal(
      (await employeeListService.terminalPhotoStatuses(page)).get(
        'filter-photo',
      ),
      'WAITING',
    );
    await p.$executeRawUnsafe(
      `UPDATE "HikPersonDelivery" SET state='ERROR' WHERE "terminalId"='ta'`,
    );
    assert.equal(
      (await employeeListService.terminalPhotoStatuses(page)).get(
        'filter-photo',
      ),
      'ERROR',
    );
    await p.$executeRawUnsafe(
      `UPDATE "HikPersonDelivery" SET state='DELIVERED',"deliveredPhotoUrl"='/uploads/old.jpg' WHERE "terminalId"='ta'`,
    );
    assert.equal(
      (await employeeListService.terminalPhotoStatuses(page)).get(
        'filter-photo',
      ),
      'UNCONFIRMED',
      'old confirmed photo cannot confirm the current photo',
    );
    assert.equal((await employeeListService.terminalPhotoStatuses([])).size, 0);
    console.log(
      'PASS list badge aggregate: confirmed current photo only, partial/error/old photo states and empty page',
    );
  } finally {
    worker?.kill('SIGKILL');
    await p.$disconnect();
    await other.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.$disconnect();
  }
}
(process.argv.includes('--child') ? child() : main()).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
