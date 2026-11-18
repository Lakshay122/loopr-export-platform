# Summary

## What I implemented

**Scenario chosen: scheduled CSV reports**, built end to end, with two customers that use the same code but
different settings:

| | Acme (`ws-acme-line1`) | Globex (`ws-globex-qa`) |
| --- | --- | --- |
| Files | One per hour, India time | One per completed inspection session |
| Rows | All results | Only FAIL and REVIEW |
| Columns | Renamed, `PASS→OK` etc., extra fields `operator`, `torque_nm` | Renamed, image links, extra fields `batch`, `defect_area_mm2` |

- **Settings, not code:** columns, names, value changes, customer-specific metadata fields, filters, date format,
  timezone, grouping, late-record window, delivery folder. Checked when saved; every save is a new, immutable
  version; every export remembers its version.
- **Live preview:** the settings screen shows the real file before saving; nothing is delivered.
- **Grouping:** by time window or by session. A customer can switch; the change starts at the next clean
  boundary so no record is missed or sent twice.
- **Late records:** records that arrive after their file was sent go out in a small extra file. Earlier files never change.
- **Large exports:** split into chunks that run in parallel on several workers, read page by page (small memory).
- **Reliability:** PostgreSQL outbox + BullMQ queue, leases, fencing, retries with backoff, a reconciler for lost
  messages, idempotent manual requests and events, atomic file publishing.
- **Observable:** API, CLI (`exports`, `show`) and UI show status, progress per chunk, attempts, errors, row
  counts and the file itself.
- **Failure you can watch:** one setting (`DEMO_CRASH_CHUNK`) makes a worker die mid-export; the export still
  completes with every record exactly once (README → *Watch a crash and the recovery*).
- **Security:** every query is scoped to the caller's tenant; CSV formula-injection protection; field names are
  allow-listed.
- **Tests:** 60 automated tests against real PostgreSQL and Redis, including worker crash, zombie worker,
  crash between publish and commit, lost and duplicate queue messages, retries, late records, schedule switch.
- **UI:** customer-facing screens for overview, reports, settings (form, no JSON), one-time exports and demo tools.

## What I simplified or left out

| Simplified / left out | Why / what the real version needs |
| --- | --- |
| Image export and ERP export | Designed in [docs/other-scenarios.md](docs/other-scenarios.md), not coded (timebox) |
| Login | An `x-tenant-id` header stands in for a verified token |
| Destination | A local folder instead of the customer's S3 / SFTP; no secrets vault |
| Source data | Seeded tables and a Demo tools page instead of the real inspection platform and Kafka |
| Shadow run for breaking format changes | Designed in [docs/format-evolution.md](docs/format-evolution.md); only the schedule switch is built |
| One export config per workspace | Enough for the demo; production allows several |
| Lease without heartbeat | A chunk must finish within the lease; production extends it |
| Metadata filters are not indexed | Fine inside one hour or session; production adds an index |
| No metrics dashboard | Structured logs only |

## What I would do next

1. A second destination (S3 with customer-owned credentials in a vault), to prove the delivery adapter design.
2. The shadow-run process for breaking format changes (draft version, side-by-side files, automatic comparison).
3. Real authentication and per-user roles (who may change settings).
4. Metrics and alerts: export age, failures per tenant, queue depth.
5. Per-tenant fair scheduling so one very large customer cannot slow others.
6. The image export scenario, reusing the same job / task / outbox engine.
