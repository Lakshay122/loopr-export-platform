# Loopr Export Platform

A customer-configurable export platform for a multi-tenant inspection product.
Customers choose **what** to export, **how** it looks, **when** it runs and **where** it goes, through
**settings, not custom code**. The platform does the work in the background, survives crashes, and shows the
status of every export.

- **Designed:** all three scenarios — hourly CSV reports, images to object storage, events to an ERP.
- **Built end to end:** **configurable CSV reports**, with two customers that share the code but have different settings.

---

## Run it

You need **Docker** with Docker Compose. Nothing else. Run all commands from the repository root.

```bash
# 1. Start everything
docker compose up -d --build

# 2. Create the demo customers, inspection records and export settings
docker compose exec api node dist/bin/cli.js seed
```

Wait about 15 seconds, then list Acme's exports:

```bash
docker compose exec api node dist/bin/cli.js exports --workspace ws-acme-line1
```

**You should see:** about four `SCHEDULED` exports, all `COMPLETED`, one for each past hour.
The scheduler created them on its own.

Open the UI at http://localhost:8080 to see the same exports in a browser.

If a port is already in use, change it with `WEB_PORT` (8080), `API_PORT` (3000), `POSTGRES_PORT` (55432) or
`REDIS_PORT` (56379).

## Try the demos

**[docs/demo.md](docs/demo.md)** has six short demos. Each one says what it shows, what to run and what you will see:

1. An hourly report
2. One file per inspection session
3. Same code, different customer settings
4. Late records
5. A one-time export
6. A worker crash and the recovery

## Watch a crash and the recovery

This makes a worker die in the middle of an export. The export still finishes with every record exactly once.

```bash
# 1. Turn on crash mode
DEMO_CRASH_CHUNK=1 TASK_LEASE_SECONDS=15 docker compose up -d worker

# 2. Start an export and follow it
docker compose exec api node dist/bin/cli.js export --workspace ws-acme-line1 --hours 24 --wait

# 3. See the crash in the worker log
docker compose logs worker | grep "worker crashes now"

# 4. Turn crash mode off
docker compose up -d worker
```

**You should see:** the export pauses for about 15 seconds and then ends `COMPLETED`. In the parts table, `chunk 1`
shows `2/3` attempts. Other chunks may show `2/3` too, because they were running in the worker that died.

More detail: [demo 6](docs/demo.md#6-a-worker-crash-and-the-recovery) and
[architecture §5a](docs/architecture.md#5a-the-same-report-with-a-failure).
Other failure cases are covered by automated tests: [docs/reliability.md](docs/reliability.md).

## Run the tests

```bash
docker compose run --rm --build test
```

**You should see:** 60 tests pass, against real PostgreSQL and Redis (in a separate test database).
What each test file proves: [backend/README.md](backend/README.md#tests).

## Clean up

```bash
docker compose down -v   # stops everything and deletes the demo data
```

---

## Where to find what the brief asks for

| The brief asks for | Where |
| --- | --- |
| Short summary: implemented, simplified, next | [SUMMARY.md](SUMMARY.md) |
| Design: architecture, components, data flow, **assumptions** | [docs/architecture.md](docs/architecture.md) (assumptions in §1) |
| How customer-specific behaviour is defined, and when the core must still change | [architecture §4.1](docs/architecture.md#41-settings-not-code) |
| Lifecycle of one export, including a failure | [architecture §5 and §5a](docs/architecture.md#5-one-hourly-report-step-by-step) |
| Decisions, trade-offs and alternatives | [docs/decisions.md](docs/decisions.md) |
| Reliability: guarantees, failure cases, what we do not promise | [docs/reliability.md](docs/reliability.md) |
| The other two scenarios (images, ERP) | [docs/other-scenarios.md](docs/other-scenarios.md) |
| Change over time (format change after six months) | [docs/format-evolution.md](docs/format-evolution.md) |
| Scale, security, operations | [architecture §7–9](docs/architecture.md#7-scale) |
| API | [docs/api.md](docs/api.md) |
| Run it, watch a failure and the recovery, run the tests | this page, above |

Suggested reading order: this page → SUMMARY → architecture → reliability → decisions → format-evolution → other-scenarios.

## The two demo customers (same code, different settings)

| | Acme Motors (`ws-acme-line1`) | Globex Electronics (`ws-globex-qa`) |
| --- | --- | --- |
| Files | One per **hour** (India time) | One per **completed session** |
| Rows | All results | Only `FAIL` and `REVIEW` |
| Columns | Renamed (`RecordID`, `Serial`, `Status`…) | Renamed (`part`, `outcome`, `image_url`…) |
| Values | `PASS→OK`, `FAIL→NG`, `REVIEW→HOLD` | Unchanged |
| Extra fields (metadata) | `operator`, `torque_nm` (only weld checks have it; others get `n/a`) | `batch`, `defect_area_mm2` |
| Dates | ISO with `+05:30` | `dd-MM-yyyy HH:mm:ss` in UTC |

## Implemented, simulated, proposed

| | What |
| --- | --- |
| **Implemented** (real code, tested) | The CSV workflow end to end: settings and immutable versions, live preview, scheduler, session events, chunked jobs, outbox, BullMQ queue, workers with leases, fencing and retries, late-record corrections, one-time exports, schedule switch (hourly ↔ per session), customer-specific metadata fields, tenant isolation, API, UI |
| **Simulated** (stand-ins for this demo) | Inspection data (seeded tables, CLI and the UI's Demo tools), login (`x-tenant-id` header), the destination (a local folder instead of S3 / SFTP), source events (an HTTP endpoint and CLI instead of Kafka / Event Hubs) |
| **Proposed** (design only) | Image export and ERP export, the task router that chooses a handler by export type, the shadow-run process for breaking format changes, real login and a secrets vault, autoscaling, per-tenant fair queues, metrics dashboards |

## What is built, in more detail

| Feature | Read more |
| --- | --- |
| Customer settings (columns, names, value changes, filters, date format, timezone, grouping, delivery), checked when saved, immutable versions | [export-config](backend/src/modules/export-config/README.md) |
| Customer-specific record **metadata**: export any extra field, filter on it, choose a value when it is missing | [D-18](docs/decisions.md#d-18--customer-specific-record-metadata) |
| Grouping by time window or by session; switching starts at the next clean boundary (no gap, no duplicate) | [format-evolution](docs/format-evolution.md#changing-the-schedule-type-built) |
| Late records go into additive correction files | [reliability](docs/reliability.md) |
| Large exports: fixed chunks, keyset paging, parallel workers, per-workspace cap | [jobs](backend/src/modules/jobs/README.md), [worker](backend/src/modules/worker/README.md) |
| Durable work: PostgreSQL outbox + BullMQ, reconciler | [dispatch](backend/src/modules/dispatch/README.md) |
| Crash recovery: leases, fencing, retries with backoff | [reliability](docs/reliability.md) |
| Customer-facing UI: overview, reports, settings form with live preview, demo tools | [frontend/README.md](frontend/README.md) |

## Repository layout

```
.
├── README.md, SUMMARY.md
├── docs/                     # demos, architecture, decisions, reliability, API, other scenarios, format changes
├── docker-compose.yml        # the whole system
├── docker/postgres/init.sql  # creates the test database
├── backend/                  # Node 22 + TypeScript (one image, many processes)
│   ├── src/bin/              # entry points: api, worker, dispatcher, scheduler, migrate, cli
│   ├── src/api/              # HTTP layer (Express)
│   ├── src/modules/          # business modules, each with a short README
│   ├── src/db/migrations/    # SQL schema
│   └── tests/                # unit + integration tests
└── frontend/                 # React UI, served by nginx on port 8080
```
