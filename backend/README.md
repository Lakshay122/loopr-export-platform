# Backend

Node 22 + TypeScript. One codebase and one Docker image, started as different processes:

| Process | Entry point | Job |
| --- | --- | --- |
| API | `src/bin/api.ts` | HTTP API (settings, exports, status, files, events) |
| Scheduler | `src/bin/scheduler.ts` | Every 10 s: closes groups, starts original and correction jobs |
| Dispatcher | `src/bin/dispatcher.ts` | Every 0.5 s: outbox → BullMQ. Every 5 s: reconciler |
| Worker | `src/bin/worker.ts` | Runs tasks from BullMQ. Run as many as you like |
| Migrate | `src/bin/migrate.ts` | Applies SQL migrations once |
| CLI | `src/bin/cli.ts` | Demo helpers: `seed`, `tick`, `add-records`, `add-late`, `complete-session`, `export`, `exports`, `show` (run it without arguments for help) |

## Code map

```
src/
├── bin/            process entry points + shared startup (runtime.ts)
├── api/            Express app, simulated auth, error handling, response shapes
├── config/env.ts   all settings from environment variables (validated)
├── db/             pool, transactions, migration runner, SQL migrations
├── lib/            errors, clock, logger
├── demo/           demo tenants, records and the two customer configs
└── modules/
    ├── export-config/  customer settings: schema, versions, preview, schedule switch
    ├── source/         reading inspection records (selection, paging, chunk boundaries)
    ├── csv/            turning records into CSV lines
    ├── grouping/       time buckets and file names
    ├── jobs/           creating jobs and tasks, task state machine, manual exports, retry
    ├── worker/         running one task (chunk or finalize)
    ├── dispatch/       outbox dispatcher and reconciler
    ├── queue/          queue interface and BullMQ adapter
    ├── scheduler/      when exports run, corrections, late flags
    ├── events/         session.completed handling
    ├── field-layout/   customer-made groups of fields for the settings screen (display only)
    ├── storage/        staging chunks and publishing files
    └── tenancy/        tenant/workspace access checks
```

Each module folder has a short README.

**Dependency rule:** `bin` → `api` → `modules` → `db`/`lib`. Modules do not import from `api` or `bin`.

## Running locally without Docker for the app

```bash
docker compose up -d postgres redis      # from the repo root
cd backend
npm install
export DATABASE_URL=postgres://loopr:loopr@localhost:55432/loopr REDIS_URL=redis://localhost:56379
npm run migrate
npm run cli -- seed
npm run dev:api        # and in other terminals:
npm run dev:dispatcher
npm run dev:scheduler
npm run dev:worker
```

## Tests

```bash
# Inside Docker (what CI would run):
docker compose run --rm --build test

# Or from your machine, against the Docker PostgreSQL/Redis:
docker compose up -d postgres redis
cd backend && npm test
```

Tests use the separate `loopr_test` database. The schema is rebuilt at the start of every run.

| File | What it proves |
| --- | --- |
| `tests/unit/spec.test.ts` | Settings are validated; bad fields, timezones and grouping combos are rejected |
| `tests/unit/csv-format.test.ts` | Renames, value maps, metadata fields, missing values, date formats, CSV quoting, formula-injection escaping |
| `tests/unit/grouping.test.ts` | Timezone-aware buckets with no gaps, deterministic file names, backoff |
| `tests/unit/grouping-switch.test.ts` | When a schedule change starts (next clean boundary); windows that never line up are refused |
| `tests/integration/hourly-export.test.ts` | A closed hour is exported in chunks as one correct file; empty hours; filters (incl. metadata); catch-up after downtime; a manual export does not touch hourly files |
| `tests/integration/corrections.test.ts` | Late records → correction files; cutoff ties; version pinning; lookback flags; **every record exactly once** (randomised) |
| `tests/integration/session-export.test.ts` | Per-session export, settle delay, duplicate events, late finalization |
| `tests/integration/schedule-switch.test.ts` | Hourly → per session and back: every record in exactly one file across the switch |
| `tests/integration/recovery.test.ts` | Killed worker, zombie worker (fencing), crash before commit, lost message, duplicate messages, retries, permanent failure + manual retry, poison task, parallel schedulers |
| `tests/integration/api.test.ts` | Versions, validation errors, preview, schedule-change planning, field discovery, field groups, demo endpoint off by default, tenant isolation (404), idempotent manual exports, download |
| `tests/integration/bullmq-e2e.test.ts` | Real outbox → BullMQ → 3 consumers path, with duplicate publishing |

Most integration tests run the task runner in-process (`TestContext.pump`) to control timing exactly.
`bullmq-e2e.test.ts` uses the real queue.

## Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://loopr:loopr@localhost:5432/loopr` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Redis for BullMQ |
| `STORAGE_DIR` | `./data` | Staging + published files |
| `API_PORT` | `3000` | |
| `WORKER_CONCURRENCY` | `4` | Tasks one worker process runs at once |
| `TASK_LEASE_SECONDS` | `60` | How long a claimed task is owned before it may be taken over |
| `TASK_MAX_ATTEMPTS` | `3` | Attempts per task (a lease expiry counts) |
| `RETRY_BASE_MS` | `2000` | First retry delay; doubles each attempt |
| `WORKSPACE_MAX_RUNNING_TASKS` | `4` | Fairness cap per workspace |
| `DISPATCH_INTERVAL_MS` | `500` | Outbox publishing interval |
| `RECONCILE_INTERVAL_MS` | `5000` | Reconciler interval |
| `RECONCILE_STALE_SECONDS` | `30` | A READY task with no message for this long is re-sent |
| `SCHEDULER_INTERVAL_MS` | `10000` | Scheduler interval |
| `CUTOFF_SAFETY_SECONDS` | `5` | Records finalized in the last N seconds wait for the next export |
| `LOG_LEVEL` | `info` | pino log level |
| `DEMO_TOOLS` | `false` | Demo only: enables the API endpoint that adds fake records (set to `true` in docker-compose) |
| `DEMO_CRASH_CHUNK` | unset | Demo only: the worker exits abruptly on the first attempt of this chunk number (see the root README) |

## Adding a migration

Add the next file, e.g. `src/db/migrations/005_<name>.sql`. Files run once, in name order, inside a transaction.
