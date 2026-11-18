# source

Reads inspection records from the existing platform's tables. The export platform never writes to them.

## The selection rule

A job's rows are described by a `Selection`. The most important part is the finalized-time range:

```
prevCutoff < finalized_at <= cutoff
```

- Left side open, right side closed. A record exactly on a cutoff belongs to one job only.
- An original report has no `prevCutoff`. A correction starts at the last published cutoff.
- Only finalized records (`finalized_at` set) are ever exported.

Other parts: workspace, `inspected_at` range, sessions, results and inspection types.

## Functions

| Function          | Used by      | What it does                                                                              |
| ----------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `readPage`        | worker       | Next page in `(inspected_at, id)` order between two cursors (keyset paging, small memory) |
| `chunkBoundaries` | job creation | Splits the selection into chunks of `chunkSize` rows and returns the boundaries           |
| `hasRecords`      | scheduler    | Is there anything new for a correction?                                                   |
| `recordIds`       | scheduler    | Records to flag when they arrive after the lookback                                       |
| `latestRecords`   | preview      | Newest records for the settings preview                                                   |

## Why cursors are text

PostgreSQL stores microseconds; a JavaScript `Date` only keeps milliseconds. Chunk boundaries and paging cursors are
passed as PostgreSQL text so two records 0.4 ms apart are never mixed up.
