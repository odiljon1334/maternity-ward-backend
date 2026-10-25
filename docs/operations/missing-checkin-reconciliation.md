# CHECK_OUT without a known arrival

## Cause and behavior

An explicit terminal CHECK_OUT arriving before an AttendanceRecord existed was
saved in AttendanceEvent, then ignored by dispatch. The nightly absence cron
later created ABSENT. A second route changed an already-created ABSENT to
PRESENT on checkout despite checkIn remaining null. Neither route could establish
an arrival time.

INCOMPLETE now means an observed exit with no confirmed arrival. Store the exact
terminal exit, keep both arrival fields null and all derived minutes zero. It
counts as neither confirmed presence nor absence. Payroll calculation and draft
approval require review first; approved and paid payroll are never changed by
reconciliation. The attendance list has a dedicated filter, and exports use `?`.
A later real check-in earlier than the exit can resolve the record. An arrival
after the exit requires individual review rather than reversing the timestamps.

Explicit morning exits check yesterday's WORKING overnight schedule even when
today has a schedule. A late-exit window ends four hours after the prior shift's
expected end and before today's shift starts. The workDate follows the selected
shift; an actual terminal exit may replace an AUTO exit, but an existing real
exit is preserved. No arrival is synthesized.

## Historical repair

`scripts/reconcile-missing-checkins.cjs` defaults to a read-only JSON plan.
Run it inside a backend container with explicit Tashkent dates and device IDs:

```bash
node /tmp/reconcile-missing-checkins.cjs --devices=DEVICE_IDS --start=2026-10-21 --end=2026-10-25
```

Save the complete plan with mode 0600 outside the container before applying.
The plan contains the original records, exact event IDs and target classification.
Apply with `--apply=/tmp/plan.json --expect=EXPECTED_COUNT`. It locks targets,
rejects changed snapshots and changed evidence, updates event associations,
records an audit entry per case and invalidates derived weekly caches. It does
not replay webhooks, send notifications or edit payroll. Raw event payloads and
all original arrival timestamps are preserved. Re-running the planner is safe.

The 2026-10-26 plan examined 89 cases / 108 original successful face-auth exits
from the ten online devices for 21–25 October:

- 71 days with no arrival: INCOMPLETE, exact first exit, zero derived minutes.
- 14 exits attributable to the previous overnight shift: target that shift,
  preserving its real arrival and any existing real exit.
- 4 cases lacking a consistent prior schedule: INCOMPLETE with an explicit
  note that the work day requires review, rather than guessing a shift.

For the overnight cases, the new calendar day's ABSENT may remain correct;
a morning exit does not establish attendance for that evening's scheduled shift.

Test with `npm run test:attendance-reconciliation` against LOCAL PostgreSQL only.
It creates and drops an isolated schema and verifies day, overnight AUTO,
overnight real-exit, overnight missing-arrival and ambiguous-shift cases, exact
arrival preservation, raw payload preservation, audit entries and idempotence.

## Terminal face-upload errors

HTTP 400 / statusCode 6 (`Content Error`) / errorCode 1610612791 /
`SubpicAnalysisModelingError` is a face analysis/modeling rejection. An empty
errorMsg does not mean success. It does not establish which individual quality
check failed, and repeating the unchanged image is not a network retry fix.

Metadata inspection found 14 of the 18 rejected originals only 108–201 pixels
wide. The other four were larger; dimensions alone cannot establish their
specific problem. Re-photo or capture directly on the device, with one clear,
front-facing, well-lit face. Enlarging a thumbnail cannot recover facial detail.

The installed models are DS-K1T671M and DS-K1T343MFWX. Hikvision's K1T671 manual
lists JPG/JPEG, at least 640×480 and 60–200 KB for its documented import workflow;
these are model/workflow-specific guidance, not a guarantee every ISAPI upload
meeting those numbers will be accepted:
https://us-legacy.hikvision.com/en/system/files_force/manual/k1t671_user_manual.pdf?download=1

K1T343 manual (the documented client import workflow specifies JPG ≤200 KB):
https://assets.hikvision.com/prd/public/all/doc/m000048815/UD24342B-B_Baseline_DS-K1T343-Series-Face-Recognition-Terminal_User-Manual_V1.0_20221128.PDF

Bulk sync compresses faces before addFacePicture(compressed=true); therefore
its existing `original → compressed` log can show equal sizes. That line is
not the size comparison with the original uploaded profile file.
