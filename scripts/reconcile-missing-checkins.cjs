/** One-off, evidence-only repair. Default mode is a read-only JSON plan.
 * Run inside the backend container. Save the plan outside the container BEFORE
 * applying it. No timestamp inference, webhook replay, payroll writes or notices.
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const prisma = new PrismaClient();
const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const signature = (v) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');

async function plan() {
  const devices = (arg('devices') ?? '').split(',').filter(Boolean);
  const first = arg('start'),
    last = arg('end');
  if (
    !devices.length ||
    !/^\d{4}-\d{2}-\d{2}$/.test(first ?? '') ||
    !/^\d{4}-\d{2}-\d{2}$/.test(last ?? '')
  )
    throw Error(
      'Required: --devices=... --start=YYYY-MM-DD --end=YYYY-MM-DD (Tashkent days)',
    );
  const start = new Date(`${first}T00:00:00+05:00`),
    end = new Date(`${last}T00:00:00+05:00`);
  if (
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    +end < +start ||
    +end - +start > 31 * 86400000
  )
    throw Error('Invalid date range');
  const records = await prisma.attendanceRecord.findMany({
    where: {
      workDate: { gte: start, lte: end },
      status: 'ABSENT',
      checkIn: null,
      checkOut: null,
    },
    include: {
      schedule: { include: { shift: true } },
      employee: { select: { hospitalId: true } },
    },
    orderBy: { id: 'asc' },
  });
  const changes = [],
    skipped = [];
  for (const record of records) {
    const events = await prisma.attendanceEvent.findMany({
      where: {
        employeeId: record.employeeId,
        rawTime: {
          gte: record.workDate,
          lt: new Date(+record.workDate + 86400000),
        },
      },
      orderBy: [{ rawTime: 'asc' }, { id: 'asc' }],
    });
    const exits = events.filter(
      (e) =>
        devices.includes(e.deviceId) &&
        e.eventType === 'CHECK_OUT' &&
        e.recordId === null,
    );
    if (!exits.length) continue;
    if (
      record.schedule?.status !== 'WORKING' ||
      events.some((e) => e.eventType === 'CHECK_IN')
    ) {
      skipped.push({
        recordId: record.id,
        reason: 'Needs individual shift/event review',
      });
      continue;
    }
    // Only original successful face-auth CHECK_OUT events are evidence here.
    const verified = exits.filter((e) => {
      const raw = e.rawPayload?.AccessControllerEvent;
      const rawTime = new Date(e.rawPayload?.dateTime);
      return (
        raw?.attendanceStatus === 'checkOut' &&
        raw.majorEventType === 5 &&
        raw.subEventType === 75 &&
        Math.abs(+rawTime - +e.rawTime) <= 1000
      );
    });
    if (verified.length !== exits.length) {
      skipped.push({
        recordId: record.id,
        reason: 'Original event evidence does not agree',
      });
      continue;
    }
    let target = record,
      kind = 'MISSING_CHECK_IN';
    if (record.schedule.shift?.isOvernight) {
      const previous = await prisma.attendanceRecord.findUnique({
        where: {
          employeeId_workDate: {
            employeeId: record.employeeId,
            workDate: new Date(+record.workDate - 86400000),
          },
        },
        include: {
          schedule: { include: { shift: true } },
          employee: { select: { hospitalId: true } },
        },
      });
      const exit = verified[0].rawTime;
      if (
        previous?.schedule?.status === 'WORKING' &&
        previous.schedule.shift?.isOvernight &&
        +exit <= +previous.expectedCheckOut + 4 * 3600000 &&
        +exit < +record.expectedCheckIn &&
        (!previous.checkIn || +previous.checkIn <= +exit)
      ) {
        target = previous;
        kind = 'OVERNIGHT_EXIT';
      } else kind = 'AMBIGUOUS_SHIFT';
    }
    const { schedule, employee, ...before } = target;
    changes.push({
      before,
      kind,
      shift: schedule?.shift,
      observedRecord: { id: record.id, updatedAt: record.updatedAt },
      hospitalId: employee.hospitalId,
      evidenceIds: verified.map((e) => e.id),
      actualExit: verified[0].rawTime,
      sourceDevice: verified[0].deviceId,
    });
  }
  const result = {
    version: 1,
    createdAt: new Date(),
    scope: { devices, start, end },
    count: changes.length,
    eventCount: changes.reduce((n, c) => n + c.evidenceIds.length, 0),
    skipped,
    changes,
  };
  console.log(JSON.stringify(result));
}

async function apply() {
  const document = JSON.parse(fs.readFileSync(arg('apply'), 'utf8'));
  const expected = Number(arg('expect'));
  if (
    document.version !== 1 ||
    !Number.isInteger(expected) ||
    expected < 1 ||
    document.count !== expected ||
    document.changes.length !== expected ||
    document.skipped.length
  )
    throw Error('Plan count/safety check failed');
  const batch = signature(document);
  const { calcNetWorkMin } = require(
    process.cwd() + '/dist/src/common/utils/shift.util',
  );
  await prisma.$transaction(
    async (tx) => {
      for (const change of document.changes) {
        const old = change.before;
        await tx.$queryRaw`SELECT id FROM "AttendanceRecord" WHERE id = ${old.id} FOR UPDATE`;
        const current = await tx.attendanceRecord.findUnique({
          where: { id: old.id },
        });
        if (
          !current ||
          current.status !== old.status ||
          +current.updatedAt !== +new Date(old.updatedAt)
        )
          throw Error(`Record changed since backup: ${old.id}`);
        if (change.observedRecord.id !== old.id) {
          const observed = await tx.attendanceRecord.findUnique({
            where: { id: change.observedRecord.id },
          });
          if (
            !observed ||
            +observed.updatedAt !== +new Date(change.observedRecord.updatedAt)
          )
            throw Error('Observed day changed');
        }
        const evidence = await tx.attendanceEvent.findMany({
          where: {
            id: { in: change.evidenceIds },
            employeeId: old.employeeId,
            recordId: null,
            eventType: 'CHECK_OUT',
          },
          orderBy: [{ rawTime: 'asc' }, { id: 'asc' }],
        });
        if (
          evidence.length !== change.evidenceIds.length ||
          +evidence[0].rawTime !== +new Date(change.actualExit)
        )
          throw Error('Evidence changed');
        for (const event of evidence) {
          const raw = event.rawPayload?.AccessControllerEvent;
          if (
            !document.scope.devices.includes(event.deviceId) ||
            raw?.attendanceStatus !== 'checkOut' ||
            raw?.majorEventType !== 5 ||
            raw?.subEventType !== 75 ||
            Math.abs(+new Date(event.rawPayload?.dateTime) - +event.rawTime) >
              1000
          )
            throw Error('Unverified original event');
        }
        const exit = new Date(change.actualExit);
        let data;
        if (!current.checkIn) {
          data = {
            status: 'INCOMPLETE',
            checkOut: exit,
            rawCheckOutTime: exit,
            checkOutSource: 'TERMINAL',
            autoCheckOut: false,
            deviceId: change.sourceDevice,
            lateMinutes: 0,
            earlyLeaveMin: 0,
            overtimeMinutes: 0,
            netWorkMin: 0,
          };
          if (change.kind === 'AMBIGUOUS_SHIFT')
            data.note = [
              old.note,
              'Tekshirish kerak: ertalabki CHECK_OUT bor, smena kuni yoki oldingi grafik tasdiqlanmagan. Kirish vaqti kiritilmadi.',
            ]
              .filter(Boolean)
              .join('\n');
        } else if (current.autoCheckOut || !current.checkOut) {
          const sameDay = (d) =>
            new Date(+d + 18000000).toISOString().slice(0, 10);
          const early =
            sameDay(exit) === sameDay(current.expectedCheckOut)
              ? Math.max(
                  0,
                  Math.trunc((+current.expectedCheckOut - +exit) / 60000),
                )
              : 0;
          const overtime =
            sameDay(exit) === sameDay(current.expectedCheckOut)
              ? Math.max(
                  0,
                  Math.trunc((+exit - +current.expectedCheckOut) / 60000),
                )
              : 0;
          const status =
            current.lateMinutes > 0
              ? early > 0
                ? 'LATE_EARLY'
                : 'LATE'
              : early > 0
                ? 'EARLY_LEAVE'
                : 'PRESENT';
          data = {
            checkOut: exit,
            rawCheckOutTime: exit,
            checkOutSource: 'TERMINAL',
            autoCheckOut: false,
            earlyLeaveMin: early,
            overtimeMinutes: overtime,
            netWorkMin: calcNetWorkMin(
              current.checkIn,
              exit,
              current.lunchOut,
              current.lunchIn,
              change.shift?.lunchStart,
              change.shift?.lunchEnd,
            ),
            status,
          };
        }
        // A prior real exit is preserved; extra exit scans are linked as evidence.
        if (data)
          await tx.attendanceRecord.update({ where: { id: old.id }, data });
        await tx.attendanceEvent.updateMany({
          where: { id: { in: change.evidenceIds }, recordId: null },
          data: { recordId: old.id },
        });
        await tx.auditLog.create({
          data: {
            action: 'ATTENDANCE_RECONCILED',
            entity: 'AttendanceRecord',
            entityId: old.id,
            hospitalId: change.hospitalId,
            details: {
              reason:
                'Original CHECK_OUT reconciled; no arrival time inferred.',
              kind: change.kind,
              observedRecordId: change.observedRecord.id,
              batch,
              before: {
                status: old.status,
                checkIn: old.checkIn,
                checkOut: old.checkOut,
              },
              after: {
                status: data?.status ?? old.status,
                checkIn: old.checkIn,
                checkOut: data?.checkOut ?? old.checkOut,
              },
              evidenceIds: change.evidenceIds,
            },
          },
        });
      }
      // Derived weekly counts are rebuilt from facts; approved payroll is untouched.
      await tx.weeklyAttendanceStat.deleteMany({
        where: {
          employeeId: {
            in: [...new Set(document.changes.map((c) => c.before.employeeId))],
          },
          weekStart: { lte: new Date(document.scope.end) },
          weekEnd: {
            gte: new Date(+new Date(document.scope.start) - 86400000),
          },
        },
      });
    },
    { timeout: 60000 },
  );
  const ids = document.changes.map((c) => c.before.id);
  const fixed = await prisma.attendanceRecord.findMany({
    where: { id: { in: ids } },
  });
  if (fixed.length !== expected) throw Error('Unexpected target overlap');
  for (const change of document.changes) {
    const r = fixed.find((r) => r.id === change.before.id);
    if (
      +new Date(r.checkIn ?? 0) !== +new Date(change.before.checkIn ?? 0) ||
      +new Date(r.rawCheckInTime ?? 0) !==
        +new Date(change.before.rawCheckInTime ?? 0)
    )
      throw Error('Arrival time changed');
    if (
      !r.checkIn &&
      (r.status !== 'INCOMPLETE' ||
        r.netWorkMin !== 0 ||
        r.lateMinutes !== 0 ||
        r.earlyLeaveMin !== 0 ||
        r.overtimeMinutes !== 0)
    )
      throw Error('Unknown arrival has calculated work');
  }
  const kinds = {};
  for (const c of document.changes) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
  console.log(
    JSON.stringify({
      reconciledCases: fixed.length,
      kinds,
      incompleteTargetDays: fixed.filter((r) => r.status === 'INCOMPLETE')
        .length,
      arrivalTimesInvented: 0,
      batch,
    }),
  );
}
(async () => (arg('apply') ? apply() : plan()))()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
