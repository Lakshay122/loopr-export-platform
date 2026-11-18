# jobs

Everything about export jobs and their tasks.

## Words

- **Job** – one export, one file. Rows are fixed when the job is created. Pinned to one config version.
- **Task** – a piece of a job. `CHUNK` tasks write part of the rows. One `FINALIZE` task joins them.
- **Outbox row** – a note "send task X to the queue", saved in the same transaction as the task change.

## Files

| File               | What it does                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `create-job.ts`    | Inserts job + chunk tasks (READY) + finalize task (WAITING) + outbox rows, in the caller's transaction  |
| `task-state.ts`    | Claim (lease + attempt + 1), mark succeeded (fenced), release finalize, record failure / retry, backoff |
| `selection.ts`     | Builds the record selection of a job from its fixed boundaries and pinned config filters                |
| `manual-export.ts` | One-time exports from the API, idempotent by `requestId`                                                |
| `retry-job.ts`     | Re-runs a FAILED job; keeps succeeded chunks                                                            |
| `job-queries.ts`   | Read helpers for the API                                                                                |
| `job-types.ts`     | Row types and status names                                                                              |

## Task life

```
CHUNK:     READY → RUNNING → SUCCEEDED
                      ├──→ RETRY_WAIT → (claimable after backoff)
                      ├──→ READY       (lease expired, reconciler)
                      └──→ FAILED      (permanent error or no attempts left)
FINALIZE:  WAITING → READY (when every chunk SUCCEEDED) → … same as above
```

## Fencing in one sentence

Each claim adds 1 to `attempt`, and a result is saved only `WHERE attempt = <my attempt> AND status = 'RUNNING'`,
so a worker that lost its lease can never overwrite newer work.

## Why the job row is locked on completion

Two chunks can finish at the same moment. Locking the job row makes them take turns, so exactly one of them
sees "all chunks done" and releases the finalize task.
