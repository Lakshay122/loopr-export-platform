# Demo guide

Six short demos. Each one says what it shows, what to run and what you will see.

**Before you start:** follow [Run it](../README.md#run-it) in the README, so the system is running and the demo data
is loaded. Run the demos in order, from the repository root.

The two demo customers are **Acme** (one file per hour) and **Globex** (one file per inspection session).
File names, ids and times will differ on your machine.

## 1. An hourly report

**What it shows:** the scheduler creates a report for each finished hour, without anyone starting it.

```bash
docker compose exec api node dist/bin/cli.js exports --workspace ws-acme-line1
```

**You will see:** about four exports of type `SCHEDULED`, all `COMPLETED`, with names like
`report_2026-11-18T1300+0530.csv`.

## 2. One file per inspection session

**What it shows:** Globex gets a file when a session finishes. If the same "session finished" event arrives twice,
only one file is made.

Send the same event twice:

```bash
docker compose exec api node dist/bin/cli.js complete-session --workspace ws-globex-qa --session GLX-S-2 --event-id evt-2
docker compose exec api node dist/bin/cli.js complete-session --workspace ws-globex-qa --session GLX-S-2 --event-id evt-2
```

**You will see:** `partition-created` the first time and `duplicate-event` the second time.

Wait about 15 seconds, then list Globex's exports:

```bash
docker compose exec api node dist/bin/cli.js exports --workspace ws-globex-qa
```

**You will see:** one `COMPLETED` export, `report_GLX-S-2.csv`.

## 3. Same code, different customer settings

**What it shows:** two customers get different files from the same code. Only their settings differ.

```bash
docker compose exec api sh -c 'head -3 $(ls /data/exports/acme-line1/report_*.csv | head -1)'
docker compose exec api sh -c 'head -3 /data/exports/globex-qa/report_GLX-S-2.csv'
```

**You will see:**

| | Acme | Globex |
| --- | --- | --- |
| Columns | `RecordID,Serial,Check,Status,…` | `session,part,outcome,defect_code,…` |
| Results | Changed to `OK`, `NG`, `HOLD` | Kept as `FAIL`, `REVIEW` |
| Dates | `2026-11-18T11:33:28.631+05:30` | `18-11-2026 08:43:58` |

To try your own change, open http://localhost:8080, go to **Settings**, and watch the live preview.

## 4. Late records

**What it shows:** records that arrive after their file was sent go out in a small extra file.
The file already sent does not change.

Add 2 records that were inspected 90 minutes ago, as if a tablet had been offline:

```bash
docker compose exec api node dist/bin/cli.js add-late --workspace ws-acme-line1 --minutes-ago 90 --count 2
```

Wait about 15 seconds, then list Acme's exports:

```bash
docker compose exec api node dist/bin/cli.js exports --workspace ws-acme-line1
```

**You will see:** a new `CORRECTION` export with 2 rows, named like `report_2026-11-18T1400+0530_correction_01.csv`.

## 5. A one-time export

**What it shows:** a customer can ask for a file at any time, and follow its progress.

```bash
docker compose exec api node dist/bin/cli.js export --workspace ws-acme-line1 --hours 24 --wait
```

**You will see:** progress lines, then status `COMPLETED`, the row count, the file and a table of its parts.
Each part shows `1/3` attempts. Note the **Rows** value and the **SHA-256** value for the next demo.

## 6. A worker crash and the recovery

**What it shows:** if a worker dies in the middle of an export, the export still finishes.
No record is lost or written twice.

Turn on crash mode. A worker will now stop suddenly on chunk 1, after writing its data and before saving that it
finished. The short lease makes the recovery quick to watch.

```bash
DEMO_CRASH_CHUNK=1 TASK_LEASE_SECONDS=15 docker compose up -d worker
```

Run the same export as in demo 5:

```bash
docker compose exec api node dist/bin/cli.js export --workspace ws-acme-line1 --hours 24 --wait
```

**You will see:**

- Progress stops for about 15 seconds, then continues, and the export ends `COMPLETED`.
- `chunk 1` shows `2/3` attempts: it was done again after the crash.
- Other chunks may show `2/3` too, because they were running in the worker that died.
- **Rows** and **SHA-256** match demo 5 if no new records arrived in between. It is the same file content.

See the crash in the worker log:

```bash
docker compose logs worker | grep "worker crashes now"
```

Turn crash mode off:

```bash
docker compose up -d worker
```

**Why it works:** see [architecture §5a](architecture.md#5a-the-same-report-with-a-failure).

## When you are done

```bash
docker compose down -v   # stops everything and deletes the demo data
```
