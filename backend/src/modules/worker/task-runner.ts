import type { Db, DbClient } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { errorMessage, isPermanent } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { headerLine, recordLine } from '../csv/csv-format.js';
import { getConfigVersionById } from '../export-config/config-service.js';
import type { ExportSpec } from '../export-config/spec.js';
import { getJob } from '../jobs/job-queries.js';
import type { ExportJob, ExportTask } from '../jobs/job-types.js';
import { selectionForJob } from '../jobs/selection.js';
import { claimTask, lockJob, markSucceeded, recordFailure, releaseFinalizeIfReady } from '../jobs/task-state.js';
import { readPage, type Cursor } from '../source/records.js';
import type { LocalStorage } from '../storage/local-storage.js';

const PAGE_SIZE = 500;

export interface TaskRunnerSettings {
  leaseSeconds: number;
  workspaceMaxRunning: number;
  retryBaseMs: number;
}

/**
 * Test seam: lets tests simulate a crash or an error after the file is written
 * but before the database commit — the most dangerous moment.
 */
export interface FaultHooks {
  afterWrite?: (task: ExportTask) => Promise<void>;
}

export type RunOutcome = 'not-claimable' | 'throttled' | 'succeeded' | 'stale' | 'RETRY_WAIT' | 'FAILED';

/**
 * Runs one task end to end: claim → do the work → commit the result (fenced).
 * It never throws for task errors; the outcome is stored in PostgreSQL.
 */
export class TaskRunner {
  constructor(
    private readonly deps: {
      db: Db;
      storage: LocalStorage;
      workerId: string;
      settings: TaskRunnerSettings;
      logger: Logger;
      faults?: FaultHooks;
    },
  ) {}

  async run(taskId: string): Promise<RunOutcome> {
    const { db, workerId, settings } = this.deps;
    const claim = await claimTask(db, taskId, workerId, {
      leaseSeconds: settings.leaseSeconds,
      workspaceMaxRunning: settings.workspaceMaxRunning,
    });
    if (claim.kind !== 'claimed') return claim.kind;

    const task = claim.task;
    const log = this.deps.logger.child({ taskId: task.id, jobId: task.job_id, kind: task.kind, attempt: task.attempt });

    try {
      const job = await getJob(db, task.job_id);
      const { spec } = await getConfigVersionById(db, job.config_id, job.config_version);
      const committed =
        task.kind === 'CHUNK' ? await this.runChunk(task, job, spec) : await this.runFinalize(task, job, spec);
      if (!committed) {
        log.warn('Result discarded: a newer attempt owns this task');
        return 'stale';
      }
      log.info('Task succeeded');
      return 'succeeded';
    } catch (err) {
      const message = errorMessage(err);
      const outcome = await recordFailure(db, task, { message, permanent: isPermanent(err) }, settings.retryBaseMs);
      log.warn({ err: message, outcome }, 'Task attempt failed');
      return outcome ?? 'stale';
    }
  }

  /** Reads the chunk's fixed key range page by page and writes a staged chunk file. */
  private async runChunk(task: ExportTask, job: ExportJob, spec: ExportSpec): Promise<boolean> {
    const { db, storage, faults } = this.deps;
    const selection = selectionForJob(job, spec);
    const upTo: Cursor | null = task.upper_at && task.upper_id ? { at: task.upper_at, id: task.upper_id } : null;
    let rowCount = 0;

    async function* lines(): AsyncGenerator<string> {
      let after: Cursor | null = task.lower_at && task.lower_id ? { at: task.lower_at, id: task.lower_id } : null;
      for (;;) {
        const page = await readPage(db, selection, { after, upTo }, PAGE_SIZE);
        for (const record of page.records) {
          rowCount++;
          yield recordLine(record, spec);
        }
        if (page.records.length < PAGE_SIZE || !page.last) return;
        after = page.last;
      }
    }

    await storage.writeChunk(job.id, task.seq, lines());
    await faults?.afterWrite?.(task);

    return withTransaction(db, async (client) => {
      await lockJob(client, job.id);
      if (!(await markSucceeded(client, task, rowCount))) return false;
      await releaseFinalizeIfReady(client, job.id);
      return true;
    });
  }

  /** Joins all chunks into the final file, publishes it, then commits the outcome. */
  private async runFinalize(task: ExportTask, job: ExportJob, spec: ExportSpec): Promise<boolean> {
    const { db, storage, faults } = this.deps;
    const chunks = await db.query<{ n: number; rows: number }>(
      `SELECT count(*)::int AS n, COALESCE(sum(row_count), 0)::int AS rows
       FROM export_task WHERE job_id = $1 AND kind = 'CHUNK' AND status = 'SUCCEEDED'`,
      [job.id],
    );
    const { n: chunkCount, rows: rowCount } = chunks.rows[0]!;

    const published = await storage.publish({
      jobId: job.id,
      folder: spec.delivery.folder ?? job.workspace_id,
      fileName: job.file_name,
      header: headerLine(spec),
      chunkCount,
    });
    await faults?.afterWrite?.(task);

    const committed = await withTransaction(db, async (client) => {
      await lockJob(client, job.id);
      if (!(await markSucceeded(client, task, rowCount))) return false;
      await completeJob(client, job, { ...published, rowCount });
      return true;
    });

    if (committed) await storage.removeStaging(job.id);
    return committed;
  }
}

/**
 * Marks the job COMPLETED and, for scheduled/correction jobs, moves the partition
 * bookmark forward. This is the only place the bookmark moves, and only after the
 * file is published, so a crash can never skip records.
 */
async function completeJob(
  client: DbClient,
  job: ExportJob,
  file: { location: string; sha256: string; rowCount: number },
): Promise<void> {
  await client.query(
    `INSERT INTO export_artifact (job_id, file_name, location, row_count, sha256)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id) DO UPDATE SET location = EXCLUDED.location, row_count = EXCLUDED.row_count, sha256 = EXCLUDED.sha256`,
    [job.id, job.file_name, file.location, file.rowCount, file.sha256],
  );
  await client.query(
    `UPDATE export_job SET status = 'COMPLETED', row_count = $2, error = NULL, finished_at = now() WHERE id = $1`,
    [job.id, file.rowCount],
  );
  if (job.partition_id) {
    await client.query(
      `UPDATE export_partition
       SET last_cutoff = $3, last_correction_no = $4, in_flight_job_id = NULL
       WHERE id = $1 AND in_flight_job_id = $2`,
      [job.partition_id, job.id, job.cutoff, job.correction_no],
    );
  }
}
