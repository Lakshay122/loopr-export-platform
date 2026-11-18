# scheduler

Decides **when** exports run. `Scheduler.tick()` runs every 10 seconds and does four things:

1. **Create time groups.** For each time-bucket config, create a partition for every bucket that has closed
   (bucket end + grace has passed). After downtime it catches up on every missed bucket (within the lookback).
   Session groups are created by the `session.completed` handler instead (see `events`).
   After a schedule change, the old time grouping keeps creating windows up to the switch moment, and the new one
   starts there ("eras", see `export-config/grouping-switch.ts`).
2. **Start original exports** for ready partitions that have never been exported.
3. **Start corrections** for partitions inside the lookback window that have new records since their last cutoff.
4. **Flag late records** for partitions past the lookback (written to `late_record_flag`, for a manual backfill).

## `startPartitionJob` – the safe part

In one transaction:

- Lock the partition row. If a job is already in flight for it → stop.
- `cutoff = now − CUTOFF_SAFETY_SECONDS`. The new job reads `(last_cutoff, cutoff]`.
- Original (`correction_no = 0`): always created, even if empty, so the customer gets a file for every hour.
  Correction (`correction_no ≥ 1`): only if there are new records.
- Use the config version of the group's first report, so all files of one group have the same columns.
- Create the job (tasks + outbox) and set `in_flight_job_id`.

The bookmark `last_cutoff` is **not** moved here. It moves only when the file is published (in the worker).
If the job fails, the group stays blocked until it is retried, so later records are never skipped.

Many schedulers may run at once. The row lock, `in_flight_job_id` and the unique `(partition_id, correction_no)`
key make sure only one job is created per step.
