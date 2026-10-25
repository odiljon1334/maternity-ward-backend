require('dotenv/config');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw Error('LOCAL database only');
const schema = `attendance_repair_test_${randomUUID().replaceAll('-', '')}`;
url.searchParams.set('schema', schema);
const env = { ...process.env, DATABASE_URL: url.toString() };
const p = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-repair-'));
const date = (s) => new Date(s + '+05:00');
const run = (args) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['scripts/reconcile-missing-checkins.cjs', ...args],
      { env, encoding: 'utf8' },
    ),
  );
(async () => {
  execFileSync('node_modules/.bin/prisma', ['db', 'push', '--skip-generate'], {
    env,
    stdio: 'pipe',
  });
  const h = await p.hospital.create({
    data: { name: 'Integration', code: randomUUID() },
  });
  const dep = await p.department.create({
    data: { name: 'Integration', code: 'TEST', hospitalId: h.id },
  });
  const pos = await p.position.create({
    data: { name: 'Integration', hospitalId: h.id },
  });
  const day = await p.shiftTemplate.create({
    data: {
      hospitalId: h.id,
      name: 'Day',
      type: 'DAYTIME',
      startTime: '08:00',
      endTime: '17:00',
      durationH: 9,
    },
  });
  const night = await p.shiftTemplate.create({
    data: {
      hospitalId: h.id,
      name: 'Night',
      type: 'NIGHTTIME',
      startTime: '20:00',
      endTime: '08:00',
      durationH: 12,
      isOvernight: true,
    },
  });
  const expected = [];
  for (const kind of [
    'missing',
    'overnight-auto',
    'ambiguous',
    'overnight-real',
    'overnight-missing',
  ]) {
    const e = await p.employee.create({
      data: {
        fullName: 'Integration',
        gender: 'MALE',
        baseSalary: 0,
        hospitalId: h.id,
        departmentId: dep.id,
        positionId: pos.id,
      },
    });
    const sch = await p.schedule.create({
      data: {
        employeeId: e.id,
        date: date('2026-10-21T00:00:00'),
        shiftId: kind === 'missing' ? day.id : night.id,
      },
    });
    const observed = await p.attendanceRecord.create({
      data: {
        employeeId: e.id,
        scheduleId: sch.id,
        workDate: sch.date,
        expectedCheckIn: date(
          `2026-10-21T${kind === 'missing' ? '08' : '20'}:00:00`,
        ),
        expectedCheckOut: date(
          `2026-10-${kind === 'missing' ? '21T17' : '22T08'}:00:00`,
        ),
        status: 'ABSENT',
      },
    });
    let target = observed;
    if (kind.startsWith('overnight')) {
      const previous = await p.schedule.create({
        data: {
          employeeId: e.id,
          date: date('2026-10-20T00:00:00'),
          shiftId: night.id,
        },
      });
      target = await p.attendanceRecord.create({
        data: {
          employeeId: e.id,
          scheduleId: previous.id,
          workDate: previous.date,
          expectedCheckIn: date('2026-10-20T20:00:00'),
          expectedCheckOut: date('2026-10-21T08:00:00'),
          status: kind === 'overnight-missing' ? 'ABSENT' : 'PRESENT',
          checkIn:
            kind === 'overnight-missing' ? null : date('2026-10-20T20:01:00'),
          checkOut:
            kind === 'overnight-missing' ? null : date('2026-10-21T08:00:00'),
          autoCheckOut: kind === 'overnight-auto',
        },
      });
    }
    const rawTime = date(
      `2026-10-21T${kind === 'missing' ? '17:03' : '08:05'}:00`,
    );
    const event = await p.attendanceEvent.create({
      data: {
        employeeId: e.id,
        eventType: 'CHECK_OUT',
        deviceId: 'fixture',
        rawTime,
        rawPayload: {
          dateTime: rawTime.toISOString(),
          AccessControllerEvent: {
            attendanceStatus: 'checkOut',
            majorEventType: 5,
            subEventType: 75,
          },
        },
      },
    });
    expected.push({ kind, target, observed, event });
  }
  const args = ['--devices=fixture', '--start=2026-10-21', '--end=2026-10-21'];
  const plan = run(args);
  assert.equal(plan.count, 5);
  assert.equal(plan.skipped.length, 0);
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan), { mode: 0o600 });
  const result = run([`--apply=${file}`, '--expect=5']);
  assert.equal(result.reconciledCases, 5);
  for (const x of expected) {
    const fixed = await p.attendanceRecord.findUnique({
      where: { id: x.target.id },
    });
    assert.equal(fixed.checkIn?.toISOString(), x.target.checkIn?.toISOString());
    assert.equal(
      fixed.rawCheckInTime?.toISOString(),
      x.target.rawCheckInTime?.toISOString(),
    );
    if (!x.target.checkIn) {
      assert.equal(fixed.status, 'INCOMPLETE');
      assert.equal(fixed.netWorkMin, 0);
    }
    if (x.kind === 'overnight-auto') {
      assert.equal(fixed.checkOut.toISOString(), x.event.rawTime.toISOString());
      assert.equal(fixed.autoCheckOut, false);
    }
    if (x.kind === 'overnight-real')
      assert.equal(
        fixed.checkOut.toISOString(),
        x.target.checkOut.toISOString(),
      );
    const event = await p.attendanceEvent.findUnique({
      where: { id: x.event.id },
    });
    assert.equal(event.recordId, x.target.id);
    assert.deepEqual(event.rawPayload, x.event.rawPayload);
    if (x.target.id !== x.observed.id) {
      const untouched = await p.attendanceRecord.findUnique({
        where: { id: x.observed.id },
      });
      assert.equal(untouched.status, 'ABSENT');
      assert.equal(untouched.checkIn, null);
    }
  }
  assert.equal(await p.auditLog.count(), 5);
  assert.equal(run(args).count, 0);
  assert.equal(await p.payrollRecord.count(), 0);
  console.log(
    'PASS: 5 real PostgreSQL repair cases; overnight routing, exact timestamps, no invented arrival, original raw events, audit trail and idempotence',
  );
})()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await p.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await p.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  });
