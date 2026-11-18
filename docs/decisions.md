# Design decisions

Each decision has: the question, what was chosen, why, and the cost.
Numbers are stable ids used in code comments; gaps are decisions that were merged into others while planning.

---

### D-01 · One export config per workspace (prototype only)

- **Chose:** each workspace has at most one active export config.
- **Why:** keeps the time-boxed prototype focused on correctness and reliability.
- **Cost:** one workspace cannot run, for example, an hourly CSV and an ERP feed at the same time.
  The two demo configs use two workspaces.
- **Later:** allow many configs per workspace (one-to-many). The engine does not need to change.

### D-02 · Exports run in the background

- **Chose:** an API call creates a job and returns `202` at once. Workers do the work.
- **Why:** big exports can take hours; an HTTP request should not wait for them.
- **Cost:** you need status tracking and polling.

### D-04 · One-time and ongoing exports share the same engine

- **Chose:** manual (one-time), scheduled (hourly) and event-driven (session completed) exports all become the
  same kind of job. *What* data is chosen is separate from *when* the job starts.
- **Why:** one engine to test and operate.

### D-05 · Shared engine + specialised strategies

- **Chose:** a shared lifecycle (config → job → tasks → status). Each export type (CSV, images, ERP) has its own
  processing strategy. We do not force one "read → transform → write" algorithm on all of them.
- **Why:** a CSV is assembled from chunks; images are copied one by one; ERP messages are sent one by one with rate limits.
  Their units of work and their "done" rules are different.
- **Settings, not code:** common variations are settings. Customer-written scripts are not allowed (security).

### D-06 / D-10 / D-17 · PostgreSQL is the truth, BullMQ is the messenger

- **Chose:** BullMQ on Redis is the only queue. PostgreSQL stores all job and task state.
  A transactional **outbox** in PostgreSQL bridges the two. A reconciler repairs anything stuck.
- **Why:** a queue alone loses state on crashes and cannot answer "what is the status?". A database alone
  does not show horizontal work distribution well. Together: durable state + many parallel workers.
- **Rejected:** Kafka as the task queue (no per-message retry delay or lease; it fits event intake for ERP instead);
  a database-only queue (simpler to run, but retries, delays and fan-out to many workers would be custom code
  that a mature queue already provides).
- **Cost:** two systems to run, and messages can be duplicated (handled by idempotent claims).

### D-07 · CSV holds an image link, not the image

- **Chose:** a column with the image reference. No ZIP bundles of images in the prototype.
- **Why:** focus on the core workflow. Image copying is its own scenario (see [other-scenarios.md](other-scenarios.md)).
- **Care:** demo links are public sample images. Real customer images must stay private (signed links in production).

### D-08 · Event-time groups + additive correction files

- **Question:** which records go in the 10:00 report if some 10:00 records arrive at 11:30?
- **Options:** (A) export at 11:00 and lose late ones; (B) wait a grace period, still lose very late ones;
  (C) group by arrival time, so a report mixes hours; **(D) group by inspection time + correction files**.
- **Chose D**, with additive corrections: `report_10:00.csv`, then `report_10:00_correction_01.csv` with only the late rows.
- **Why:** reports match what customers expect (the 10:00 hour), and nothing is lost or duplicated.
- **Cost:** customers must also load correction files; more files and more tests.
  A correction window (lookback) limits how long we look back; later records are flagged.

### D-09 · Immutable config versions, jobs pinned to a version

- **Chose:** every edit is a new version. A job stores its version. Corrections use the version of their group's original report.
- **Why:** retries produce identical files, and all files of one group have the same columns.
- **Cost:** old versions are kept (small).

### D-11 · Job and task states, leases and fencing

- Job: `PENDING → RUNNING → COMPLETED | FAILED`. A worker crash does not fail a job.
- Task: `READY → RUNNING → SUCCEEDED | RETRY_WAIT | FAILED`. Finalize waits in `WAITING`.
- A claim gives a **lease** (60 s) and increments **attempt**. Results are saved only if the attempt still matches.
- See [reliability.md](reliability.md).

### D-12 · Entities and manual exports

- Entities: `export_config`, `export_config_version`, `export_partition`, `export_job`, `export_task`,
  `export_outbox`, `export_artifact`, `late_record_flag`.
- Manual exports are jobs with trigger `MANUAL`. They may only **narrow** the data (time range, sessions, results).
  Columns and format always come from the config. They are snapshots and do not create corrections.
- A client `requestId` makes double submits safe.

### D-13 · Grouping is a setting

- **Chose:** `grouping.groupBy` + `grouping.closeWhen`. Prototype keys: `time_bucket(…)` and `session_id`.
  Closing rules: `TIME` (window end + grace) and `EVENT` (`session.completed` + settle delay).
- **Why:** hourly and per-session reports use the same code path. Same idea as windows in Kafka Streams / Flink / Beam.
- **Guardrails:** allow-list of fields, checked when saved, no rule language. A grouping change
  (e.g. hourly → per session) starts at the next clean boundary, never in the middle of a group, so there is no
  gap or duplicate (see [format-evolution.md](format-evolution.md#changing-the-schedule-type-built)).
- **Session completed is only a signal**, not proof that all records are final. Late ones go into corrections.

### D-14 · API

See [api.md](api.md). The tenant comes from the caller identity, never from the URL. Other tenants' data returns 404.

### D-15 · Scale, isolation, security, operations

Planned for the prototype and built: keyset paging, chunk cleanup, per-workspace task cap, tenant scoping,
CSV formula escaping, structured logs. Design only: read replicas, per-tenant fair queues, row-level security,
Key Vault secrets, audit log, metrics dashboards. See [architecture.md](architecture.md#7-scale).

### D-16 · Changing the file format after six months

- **Built:** immutable versions, preview, and a self-service **schedule switch** that starts at the next clean
  boundary (no gap, no duplicate).
- **Design only:** the shadow run for breaking format changes (draft version, side-by-side files, automatic
  comparison, cutover, rollback).
- See [format-evolution.md](format-evolution.md).

### D-17 · Technology

| Choice | Why |
| --- | --- |
| Node 22 + TypeScript | Familiar stack, strong typing, good PostgreSQL/Redis libraries |
| Express 5 + Zod | Simple HTTP layer; Zod validates both requests and customer settings |
| PostgreSQL 16 | Transactions, row locks (`FOR UPDATE SKIP LOCKED`), JSONB for specs |
| Redis + BullMQ | Mature job queue for Node, many consumers, deterministic job ids |
| Luxon | Correct timezone math for time buckets and date formats |
| Vitest | Fast tests; integration tests use real PostgreSQL and Redis |
| Docker Compose | One command runs everything, including tests |

### D-18 · Customer-specific record metadata

- **Problem:** records carry extra fields that differ per customer (line, operator, batch, torque…), and not every
  record has every field. A fixed column list cannot cover them, and adding a database column per customer
  would mean customer-specific code.
- **Chose:** one `metadata` JSONB bag per record. A column reads a key with `metadata.<key>`; filters can
  require values (`filters.metadata`); `whenMissing` fills records without the key. Numbers and booleans are
  written as text, objects and lists as JSON.
- **Why:** new customer fields need no code change and no migration. The settings screen discovers keys from the
  customer's own records, so nobody types JSON.
- **Guardrails:** key names are limited to letters, numbers and `_`, and passed to SQL as parameters (never
  pasted into SQL). At most 5 metadata filters.
- **Field groups:** customers make their own groups of fields ("Machine data": operator, torque) on the
  settings screen and drag any field into any group. Stored per workspace in `field_layout`, separate from the
  versioned export spec, because it never changes a file. Fields in no group are shown as "new", so a field the
  inspection app starts sending later is never hidden.
- **Limits / next:** metadata filters are not indexed (fine inside one time window or session; production would
  add a GIN index or promote hot keys to real columns). No type-specific formatting (e.g. decimals) yet; that
  would be a new `format` option on a column.
