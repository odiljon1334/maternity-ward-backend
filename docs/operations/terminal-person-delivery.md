# Durable employee delivery

Employee create/name/photo/ID/hospital/status changes, hard deletes (including bulk deletes), and linked User status changes enqueue terminal work in the same PostgreSQL transaction via migration-defined outbox triggers. Relevant changes only: salary and unrelated profile changes do not resend biometric data. Missing employee numbers are generated on creation. All configured terminals, including temporarily disabled ones, retain desired work. Newly attached/reenabled terminals enqueue their inventory. Migration does not automatically resend the whole existing installation.

`HikPersonDelivery` stores the latest desired revision for each terminal/employee number. Successive unsent changes coalesce; this is a delivery state ledger, not an immutable history of every profile edit. Delete tombstones have no Employee FK and survive removal of the source employee. Changing an employee number or hospital queues removal of the old identity. Tenant ID is checked at the API boundary and in all queries/retry updates.

WAITING is durable and retries indefinitely with capped exponential backoff. ACTIVE is claimed atomically with `FOR UPDATE SKIP LOCKED`, a 90-second owner lease and 20-second renewals. Process crashes are reclaimed after expiry. Revision fencing prevents an old result from confirming a newer profile. Deletes and blocks have priority. Permanent vendor rejection/profile file errors are ERROR and visible for manual retry; a new profile change automatically queues a new revision.

BLOCK removes the person (and their device credentials) from the terminal, but preserves the StaffPlus employee/profile. Unblocking enqueues the current name and stored face again. An offline terminal cannot enforce a block until communication resumes; the UI explicitly says pending. Deleting a terminal attachment does not erase its physical inventory. Removing a terminal attachment leaves its delivery ledger visible as an unattached terminal.

UPSERT uses UserInfo/SetUp and face FDSetUp rather than deleting an old face first. Invalid/new rejected photos do not deliberately remove the existing face. HTTP success alone is insufficient: the worker checks vendor status codes, then searches the exact employee number and confirms name/face presence. The face revision confirmation combines the successful upload acknowledgement and face presence readback; it is not a byte-for-byte remote photograph comparison. DELETE/BLOCK are only confirmed once an exact-ID search shows absence. Photo-less active profiles never enqueue UPSERT work. Legacy photo-less UPSERT rows are revision-fenced as SKIPPED and excluded from delivery lists and error counts. The API reports the number of active employees without a profile photo separately (not per terminal). Uploading a photo queues a fresh revision. BLOCK and DELETE remain eligible without photos. A worker-side preflight prevents even read requests to a terminal for a photo-less UPSERT. No attendance event is replayed or modified.

Bulk Sync now enqueues current database desired states; it does not run an independent stale inventory writer that could re-add blocked/deleted employees. Its completion means enqueue completion. Actual per-terminal delivery is shown in the separate panel in settings, hospital terminals and employee edit cards. Existing employees without delivery rows show an explicit untracked message; run Sync to establish the initial ledger.

Endpoints (terminal-management roles, tenant scoped):
- GET `/api/v1/hikvision/person-deliveries/:hospitalId?employeeId=...&page=1` (30 rows, state counts).
- POST `/api/v1/hikvision/person-deliveries/:hospitalId/:id/retry` (only WAITING/ERROR, cannot hijack ACTIVE).

Verification:
- `node -r ts-node/register/transpile-only test/hik-person-queue.integration.ts` uses a disposable LOCAL PostgreSQL schema. Covers atomic rollback, disabled-terminal retention, tenant boundaries, account block/unblock, revision races, concurrent claims, real SIGKILL/reclaim, renumbering and hard-delete tombstones.
- `npm test -- --runInBand hik-person-delivery.spec hikvision.sync.spec hikvision.status.spec` covers remote acknowledgements/readback, face preservation, idempotent deletes, missing photos and stale fences.

Rollout: build both images, take DB backup, run `prisma migrate deploy` before swapping backend replicas, then deploy frontend. Additive table/triggers permit rollback to the old image while preserving queued work, but its legacy direct writers lack the new guarantees. Keep table/triggers when rolling back. The worker never persists vendor payloads, photos or secrets in its UI errors.

## Throughput and status UI

The worker drains ready tasks immediately with at most three concurrent deliveries per process. Claim transactions lock the terminal row and recheck active leases in a fresh statement, keeping one active delivery per terminal across replicas. Network I/O never holds a database transaction. An unchanged previously confirmed photo, name and access validity is read back once without rewriting the person or recompressing the photo. Changes still require write acknowledgement and readback.

The terminal modal has one live summary. `summary=true` omits employee rows and terminal-name queries; details load only on demand. Polling stops when no WAITING/ACTIVE tasks remain. Missing-photo counts appear once.
