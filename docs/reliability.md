# Reliability

This page lists what can go wrong and what the system does in each case.
Every case marked **tested** has an automated test in `backend/tests/integration`.

## 1. What we promise (and what we do not)

**We promise:** every finalized record that belongs to a group is delivered in **exactly one file**
(the original report or one correction file), as long as it arrives within the correction window.
Records that arrive later are **flagged** for a manual backfill, never silently dropped.

**This promise depends on these rules, and the code enforces each one:**

| Rule | How it is enforced |
| --- | --- |
| Finalized records never change, and each has a stable id | Assumption about the source platform ([architecture §1](architecture.md#assumptions-that-shape-the-design)) |
| A job's rows are fixed when it is created | Job stores `range`, `session`, `prev_cutoff`, `cutoff`; chunk boundaries are stored too |
| Ranges never overlap: `prev_cutoff < finalized_at <= cutoff` | One SQL predicate used everywhere (`modules/source/records.ts`) |
| Only one job per group at a time | Partition row is locked; `in_flight_job_id` must be empty; unique `(partition_id, correction_no)` |
| The bookmark moves only after the file is published | `last_cutoff` is updated in the same transaction that marks the job COMPLETED |
| A source write cannot land behind an old cutoff | Cutoff = now − `CUTOFF_SAFETY_SECONDS` (records must be visible within that margin) |
| Same job → same file | Deterministic file name + pinned config version + fixed rows → retry overwrites with identical content |

**We do NOT promise** exactly-once *delivery to an external system*. We give at-least-once processing plus
idempotent results (same file name, same content). Exactly-once business effects in an ERP need help from the
ERP (idempotency keys). See [other-scenarios.md](other-scenarios.md).

## 2. Failure cases

| # | What goes wrong | What the system does | Tested |
| --- | --- | --- | --- |
| 1 | A worker is killed in the middle of a task | The task's lease expires. The reconciler puts it back to READY and re-queues it. Another worker does it. | ✅ |
| 2 | A worker hangs, its task is redone by another worker, then the old worker wakes up | Its save is rejected: the `attempt` number no longer matches (**fencing**). The newer result wins. | ✅ |
| 3 | Crash after the final file is written but before the database commit | The task is retried. It writes the same file again (same name, same content) and commits once. One artifact. | ✅ |
| 4 | The same queue message arrives twice | Only one worker can claim the task. The others get "not claimable" and do nothing. | ✅ |
| 5 | A queue message is lost (e.g. Redis data lost) | The reconciler finds READY tasks with no recent message and sends them again. | ✅ |
| 6 | Dispatcher crashes after sending to Redis but before marking the outbox row | The row is sent again with the same message id; BullMQ ignores the duplicate. | by design |
| 7 | Temporary error (network, storage timeout) | RETRY_WAIT with exponential backoff + jitter. Up to 3 attempts by default. | ✅ |
| 8 | Permanent error (bad data, rejected by destination) | No blind retries: the task and job become FAILED with the error message. | ✅ |
| 9 | A task always crashes its worker ("poison" task) | Lease expiry counts as an attempt. After the last attempt it becomes FAILED, so it cannot loop forever. | ✅ |
| 10 | A group's job FAILED, then late records arrive | No correction starts until the original is fixed (the group is blocked), so nothing is skipped. A manual retry finishes it; then corrections continue. | ✅ |
| 11 | Records arrive late (offline tablet) | An additive correction file with only the new rows. | ✅ |
| 12 | A record's `finalized_at` is exactly on a cutoff | It belongs to the earlier job only (left-open, right-closed range). | ✅ |
| 13 | Records arrive after the correction window | They are written to `late_record_flag` for a manual backfill. | ✅ |
| 14 | Two scheduler instances run at the same time | Partition row lock + unique keys: one job per group. | ✅ |
| 15 | `session.completed` sent twice, or two different events for one session | Ignored by event id, and by the unique partition key. | ✅ |
| 16 | Session completes before all its records are finalized | The group waits a settle delay; records that finalize later go into a correction. | ✅ |
| 17 | Customer edits the config while jobs run | Running jobs keep their pinned version. Corrections of an old group keep the old version. New groups use the new version. | ✅ |
| 18 | The same manual export request is sent twice (double click) | `requestId` is unique per workspace: one job. | ✅ |
| 19 | Scheduler was down for hours | The next tick creates every missed hour (within the correction window) and runs them. | ✅ |
| 20 | A huge export | Chunks of fixed size, keyset paging, bounded memory, parallel workers. | ✅ (many chunks, 3 workers) |
| 21 | One customer starts a giant backfill | Per-workspace running-task cap; other workspaces keep running. | by design |

## 3. Retry rules

- Error types: `PermanentError` → fail now. `TransientError` or unknown error → retry.
- Backoff: `RETRY_BASE_MS × 2^(attempt−1)`, ±25 % jitter, max 5 minutes.
- Attempts: `TASK_MAX_ATTEMPTS` (default 3). A lease expiry counts as an attempt.
- A retry does not block a worker: the task is saved as RETRY_WAIT and an outbox row becomes due later.
- Manual retry (`POST /api/exports/:id/retry`) gives failed tasks a fresh attempt budget. Succeeded chunks are reused.
  The attempt counter keeps going up, so fencing still works.

## 4. Known limits of the prototype

- Lease is 60 s and there is no heartbeat. A chunk or finalize task must finish within the lease; keep `chunkSize` reasonable.
  If it does not, the task is redone (safe, but wasted work). Production: extend the lease with a heartbeat.
- The cutoff safety margin assumes a record becomes visible in the database within `CUTOFF_SAFETY_SECONDS`
  of its `finalized_at`. Production: use a database-assigned commit sequence or a change-data-capture feed.
- Session reopen / record edits after finalization are out of scope. They would need replacement files
  instead of additive corrections.
- The late-record scan checks recent partitions on every tick. Production: drive it from a feed of newly finalized records.
- There is no dead-letter queue; failed tasks stay visible in PostgreSQL with their error.
