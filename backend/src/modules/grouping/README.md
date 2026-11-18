# grouping

Small helpers for groups ("partitions").

- `windowContaining(instant, bucketMinutes, timezone)` – the time bucket an instant falls in.
  Buckets follow **local wall-clock time**: an hourly bucket in `Asia/Kolkata` runs 10:00–11:00 IST, which is
  04:30–05:30 UTC. Bucket sizes must divide 24 hours so buckets line up with local midnight.
- `nextWindow(window, …)` – the next bucket, starting exactly where the last one ended (no gaps, no overlaps).
- `partitionFileName(key, correctionNo)` – deterministic names:
  `report_2026-11-11T1000+0530.csv`, `report_S-102_correction_01.csv`.
- `manualFileName(jobId, createdAt)` – `manual_20261111T100000Z_6f1c2a3b.csv`.

Deterministic names matter: a retry writes the **same** file name, so it replaces instead of duplicating.

Note: on days with a daylight-saving change, a bucket is measured in real minutes. India has no DST.
