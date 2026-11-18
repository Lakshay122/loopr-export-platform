import type { Db } from '../../db/pool.js';
import type { Clock } from '../../lib/clock.js';
import type { Logger } from '../../lib/logger.js';
import { listCurrentConfigs, type ConfigVersion } from '../export-config/config-service.js';
import { groupingEras, type GroupingEra } from '../export-config/grouping-switch.js';
import { nextWindow, windowContaining } from '../grouping/grouping.js';
import { recordIds } from '../source/records.js';
import { partitionSelection, startPartitionJob, type PartitionRow } from './partitions.js';

export interface SchedulerSettings {
  cutoffSafetySeconds: number;
  maxAttempts: number;
}

export interface TickResult {
  partitionsCreated: number;
  jobsStarted: number;
  correctionsStarted: number;
  lateRecordsFlagged: number;
}

const BATCH = 200;

/**
 * Decides WHEN exports run. One tick:
 *  1. Creates hourly (TIME) partitions whose window has closed (end + grace has passed).
 *     SESSION partitions are created by the session.completed event handler instead.
 *     After a schedule change, the old hourly era keeps going until its end (grouping-switch.ts).
 *  2. Starts the original export for every ready partition.
 *  3. Starts correction exports for partitions that received late records (within lookback).
 *  4. Flags late records that arrived after the lookback ended (manual backfill needed).
 *
 * Every step is idempotent and safe if several schedulers run at the same time.
 */
export class Scheduler {
  constructor(private readonly deps: { db: Db; clock: Clock; settings: SchedulerSettings; logger: Logger }) {}

  async tick(): Promise<TickResult> {
    const now = this.deps.clock.now();
    const configs = await listCurrentConfigs(this.deps.db);

    let partitionsCreated = 0;
    for (const config of configs) {
      for (const era of await groupingEras(this.deps.db, config.configId)) {
        if (era.grouping.kind === 'TIME') partitionsCreated += await this.createTimePartitions(config, era, now);
      }
    }

    const jobsStarted = await this.startEach(
      `SELECT id FROM export_partition
       WHERE last_cutoff IS NULL AND in_flight_job_id IS NULL AND ready_at <= $1
       ORDER BY ready_at LIMIT ${BATCH}`,
      now,
    );

    const correctionsStarted = await this.startEach(
      `SELECT p.id FROM export_partition p
       JOIN export_config_version v ON v.config_id = p.config_id AND v.version = p.original_config_version
       WHERE p.last_cutoff IS NOT NULL AND p.in_flight_job_id IS NULL
         AND p.ready_at + make_interval(hours => (v.spec->'correction'->>'lookbackHours')::int) > $1
       ORDER BY p.ready_at`,
      now,
    );

    const lateRecordsFlagged = await this.flagBeyondLookback(now);

    const result = { partitionsCreated, jobsStarted, correctionsStarted, lateRecordsFlagged };
    if (partitionsCreated || jobsStarted || correctionsStarted || lateRecordsFlagged) {
      this.deps.logger.info(result, 'Scheduler tick');
    }
    return result;
  }

  /**
   * Creates every closed time window of one hourly era since the last one, bounded by the
   * lookback and by the era's end (when the schedule was changed to something else).
   */
  private async createTimePartitions(config: ConfigVersion, era: GroupingEra, now: Date): Promise<number> {
    if (era.grouping.kind !== 'TIME') return 0;
    const { bucketMinutes, graceSeconds } = era.grouping;
    const timezone = era.spec.timezone;

    const { db } = this.deps;
    const latest = await db.query<{ last_end: Date | null }>(
      `SELECT max(range_end) AS last_end FROM export_partition
       WHERE config_id = $1 AND partition_type = 'TIME'
         AND ($2::timestamptz IS NULL OR range_end > $2) AND ($3::timestamptz IS NULL OR range_end <= $3)`,
      [config.configId, era.from, era.to],
    );
    const lookbackStart = new Date(now.getTime() - config.spec.correction.lookbackHours * 3_600_000);
    const from = latest.rows[0]?.last_end ?? maxDate(era.from ?? config.configCreatedAt, lookbackStart);

    let created = 0;
    let window = windowContaining(from, bucketMinutes, timezone);
    while (window.end.getTime() + graceSeconds * 1000 <= now.getTime() && (!era.to || window.end <= era.to)) {
      const readyAt = new Date(window.end.getTime() + graceSeconds * 1000);
      const inserted = await db.query(
        `INSERT INTO export_partition
           (workspace_id, config_id, partition_type, partition_key, range_start, range_end, ready_at)
         VALUES ($1, $2, 'TIME', $3, $4, $5, $6)
         ON CONFLICT (config_id, partition_key) DO NOTHING`,
        [config.workspaceId, config.configId, window.key, window.start, window.end, readyAt],
      );
      created += inserted.rowCount ?? 0;
      window = nextWindow(window, bucketMinutes, timezone);
    }
    return created;
  }

  private async startEach(sql: string, now: Date): Promise<number> {
    const { db, settings } = this.deps;
    const { rows } = await db.query<{ id: string }>(sql, [now]);
    let started = 0;
    for (const { id } of rows) {
      const job = await startPartitionJob(db, id, { now, ...settings });
      if (job) {
        started++;
        this.deps.logger.info(
          { jobId: job.id, workspaceId: job.workspace_id, trigger: job.trigger, file: job.file_name },
          'Export job created',
        );
      }
    }
    return started;
  }

  /**
   * Records that arrived after the lookback ended are never exported automatically; flag them.
   * Prototype: checks the most recently expired partitions. Production would use a late-record feed.
   */
  private async flagBeyondLookback(now: Date): Promise<number> {
    const { db } = this.deps;
    const { rows } = await db.query<PartitionRow & { spec: ConfigVersion['spec'] }>(
      `SELECT p.*, v.spec FROM export_partition p
       JOIN export_config_version v ON v.config_id = p.config_id AND v.version = p.original_config_version
       WHERE p.last_cutoff IS NOT NULL AND p.in_flight_job_id IS NULL
         AND p.ready_at + make_interval(hours => (v.spec->'correction'->>'lookbackHours')::int) <= $1
       ORDER BY p.ready_at DESC LIMIT ${BATCH}`,
      [now],
    );

    let flagged = 0;
    for (const p of rows) {
      const ids = await recordIds(db, partitionSelection(p, p.spec, p.last_cutoff, now), 1000);
      if (ids.length === 0) continue;
      const inserted = await db.query(
        `INSERT INTO late_record_flag (record_id, partition_id)
         SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING`,
        [ids, p.id],
      );
      flagged += inserted.rowCount ?? 0;
    }
    if (flagged) this.deps.logger.warn({ flagged }, 'Late records beyond lookback flagged for manual backfill');
    return flagged;
  }
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}
