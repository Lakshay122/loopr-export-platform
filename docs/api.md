# API

Base URL: `http://localhost:3000`. All `/api` calls need these headers:

| Header | Meaning |
| --- | --- |
| `x-tenant-id` | The caller's tenant. **Simulated login.** In production this comes from a verified token. |
| `x-user-id` | Who made the change (stored on configs and manual exports). |

Errors look like `{ "error": "message", "issues": [...] }`. Another tenant's workspace or export returns `404`.

## Export settings

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/workspaces/{id}/export-config` | Current config. Add `?version=n` for an old version. `groupingSince` says when the current schedule type started (in the future = planned). |
| `POST` | `/api/workspaces/{id}/export-config` | Create the config (version 1). `409` if one exists. |
| `PUT` | `/api/workspaces/{id}/export-config` | Save a new version. Old versions stay unchanged. A schedule change gets `effectiveFrom`: the next clean boundary where it starts. |
| `GET` | `/api/workspaces/{id}/fields` | Standard fields, plus the metadata keys found in this workspace's newest 1 000 records (with an example value and how often each appears), and `values`: the values each field really takes (up to 20, else `null`). |
| `GET` / `PUT` | `/api/workspaces/{id}/field-layout` | The customer's own groups of fields for the settings screen: `{ "groups": [{ "id", "name", "fields": [...] }] }`. Display only, never changes an export. `groups: null` = default groups. |
| `POST` | `/api/workspaces/{id}/export-config/preview` | Check a spec and return the first rows it would produce. Delivers nothing. `groupingChangeAt` says when a schedule change would start. |

### The spec

```json
{
  "name": "Line 1 hourly quality report",
  "columns": [
    { "field": "record_id", "header": "RecordID" },
    { "field": "result", "header": "Status", "valueMap": { "PASS": "OK", "FAIL": "NG" } },
    { "field": "metadata.torque_nm", "header": "TorqueNm", "whenMissing": "n/a" },
    { "field": "inspected_at", "header": "InspectedAt" }
  ],
  "dateFormat": "ISO_LOCAL",
  "timezone": "Asia/Kolkata",
  "filters": { "results": ["PASS", "FAIL"], "inspectionTypes": ["surface"], "metadata": { "line": ["L1"] } },
  "grouping": { "groupBy": ["time_bucket(1h)"], "closeWhen": { "type": "TIME", "graceSeconds": 900 } },
  "correction": { "lookbackHours": 168 },
  "delivery": { "type": "local_folder", "folder": "acme-line1" },
  "chunkSize": 5000
}
```

| Key | Allowed values |
| --- | --- |
| `columns[].field` | `record_id`, `session_id`, `part_serial`, `inspection_type`, `result`, `defect`, `image_ref`, `inspected_at`, `finalized_at`, or `metadata.<key>` for a customer-specific extra field (key: letters, numbers, `_`) |
| `columns[].header` | Any name up to 64 characters (must be unique) |
| `columns[].valueMap` | Replace values, e.g. `{ "PASS": "1" }`. Not for date fields. |
| `columns[].whenMissing` | Written when a record has no value (e.g. a metadata key only some records have). Default: empty. |
| `filters.metadata` | Up to 5 extra fields, each with allowed values, e.g. `{ "line": ["L1", "L2"] }` |
| `dateFormat` | `ISO_UTC` (default), `ISO_LOCAL`, `yyyy-MM-dd HH:mm:ss`, `dd-MM-yyyy HH:mm:ss`, `dd-MM-yyyy` |
| `timezone` | Any IANA timezone, e.g. `Asia/Kolkata` |
| `grouping.groupBy` | `["time_bucket(<n>m)"]` or `["time_bucket(<n>h)"]` (must divide 24h), or `["session_id"]` |
| `grouping.closeWhen` | `{ "type": "TIME", "graceSeconds": 900 }` for time buckets; `{ "type": "EVENT", "event": "session.completed", "settleSeconds": 60 }` for sessions |
| `correction.lookbackHours` | 1–720. How long late records still create correction files. |
| `chunkSize` | 10–50 000 rows per chunk task |

## Exports

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/workspaces/{id}/exports` | Start a manual export. Returns `202` + the job. Same `requestId` again returns the same job (`200`). |
| `GET` | `/api/workspaces/{id}/exports` | List exports. Filters: `?status=`, `?trigger=SCHEDULED\|CORRECTION\|MANUAL`, `?limit=` |
| `GET` | `/api/exports/{jobId}` | Status, chunk progress, attempts, errors, file info |
| `POST` | `/api/exports/{jobId}/retry` | Re-run a `FAILED` export on its pinned config version |
| `GET` | `/api/exports/{jobId}/file` | Download the CSV |

### Manual export request

```json
{
  "requestId": "ui-2026-11-12-001",
  "rangeStart": "2026-11-11T00:00:00Z",
  "rangeEnd": "2026-11-12T00:00:00Z",
  "sessionIds": ["S-102"],
  "results": ["FAIL"]
}
```

`sessionIds` and `results` are optional and can only narrow what the config allows. Range: at most 31 days.

### Export detail (example)

```json
{
  "id": "6f1c…",
  "trigger": "CORRECTION",
  "status": "COMPLETED",
  "configVersion": 1,
  "correctionNo": 1,
  "fileName": "report_2026-11-11T1000+0530_correction_01.csv",
  "rowCount": 2,
  "prevCutoff": "2026-11-11T05:34:55.000Z",
  "cutoff": "2026-11-11T06:01:10.000Z",
  "progress": { "chunksTotal": 1, "chunksDone": 1, "rowsWritten": 2 },
  "tasks": [
    { "kind": "CHUNK", "seq": 0, "status": "SUCCEEDED", "attempt": 1, "maxAttempts": 3, "workerId": "worker-2-1" },
    { "kind": "FINALIZE", "seq": 0, "status": "SUCCEEDED", "attempt": 1, "maxAttempts": 3 }
  ],
  "file": { "name": "report_…_correction_01.csv", "rowCount": 2, "sha256": "9c1e…" }
}
```

## Internal

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/internal/events` | Receive a source event. Production: a Kafka / Event Hubs consumer instead. |
| `POST` | `/api/workspaces/{id}/demo/records` | **Demo only** (`DEMO_TOOLS=true`, set in docker-compose). Add fake records: `{ "sessionId", "count", "minutesAgo" }`. |
| `GET` | `/health` | Liveness check |

```json
{ "eventId": "evt-123", "type": "session.completed", "workspaceId": "ws-globex-qa",
  "sessionId": "GLX-S-2", "occurredAt": "2026-11-11T10:00:00Z" }
```

Response: `{ "outcome": "partition-created" | "duplicate-event" | "already-closed" | "ignored" }`.
