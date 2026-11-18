import type { Db, DbClient, Queryable } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { TASK_COLUMNS, type ExportTask } from './job-types.js';

/**
 * Task state changes (D-11). PostgreSQL is the source of truth; the queue only says
 * "look at task X". Every change here is safe to run twice.
 *
 *   READY ──claim──▶ RUNNING ──▶ SUCCEEDED
 *                       │  └──▶ RETRY_WAIT ──(time passes)──▶ claimable again
 *                       └────▶ FAILED (permanent error or no attempts left)
 *
 * Fencing: each claim increments `attempt`. Completion only counts if the attempt
 * still matches, so a slow "zombie" worker cannot overwrite a newer attempt.
 */

export type ClaimResult = { kind: 'claimed'; task: ExportTask } | { kind: 'not-claimable' } | { kind: 'throttled' };

export async function claimTask(
  db: Db,
  taskId: string,
  workerId: string,
  opts: { leaseSeconds: number; workspaceMaxRunning: number },
): Promise<ClaimResult> {
  return withTransaction(db, async (client) => {
    const candidate = await client.query<{ workspace_id: string }>(
      `SELECT j.workspace_id
       FROM export_task t JOIN export_job j ON j.id = t.job_id
       WHERE t.id = $1
         AND j.status IN ('PENDING', 'RUNNING')
         AND (t.status = 'READY' OR (t.status = 'RETRY_WAIT' AND t.run_after <= now()))
       FOR UPDATE OF t SKIP LOCKED`,
      [taskId],
    );
    const workspaceId = candidate.rows[0]?.workspace_id;
    if (!workspaceId) return { kind: 'not-claimable' };

    // Simple per-workspace cap so one big export cannot use every worker.
    const running = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM export_task t JOIN export_job j ON j.id = t.job_id
       WHERE j.workspace_id = $1 AND t.status = 'RUNNING'`,
      [workspaceId],
    );
    if ((running.rows[0]?.n ?? 0) >= opts.workspaceMaxRunning) {
      await client.query(
        `INSERT INTO export_outbox (task_id, available_at) VALUES ($1, now() + interval '2 seconds')`,
        [taskId],
      );
      return { kind: 'throttled' };
    }

    const claimed = await client.query<ExportTask>(
      `UPDATE export_task t
       SET status = 'RUNNING', attempt = attempt + 1, worker_id = $2, run_after = NULL,
           lease_until = now() + make_interval(secs => $3), updated_at = now()
       WHERE t.id = $1
       RETURNING ${TASK_COLUMNS}`,
      [taskId, workerId, opts.leaseSeconds],
    );
    const task = claimed.rows[0]!;
    await client.query(
      `UPDATE export_job SET status = 'RUNNING', started_at = now() WHERE id = $1 AND status = 'PENDING'`,
      [task.job_id],
    );
    return { kind: 'claimed', task };
  });
}

/** Locks the job row. Serialises completions of the same job so "all chunks done" is checked safely. */
export async function lockJob(client: DbClient, jobId: string): Promise<void> {
  await client.query('SELECT 1 FROM export_job WHERE id = $1 FOR UPDATE', [jobId]);
}

/** Marks the task SUCCEEDED if this worker still owns the attempt. Returns false for a stale worker. */
export async function markSucceeded(client: DbClient, task: ExportTask, rowCount: number | null): Promise<boolean> {
  const result = await client.query(
    `UPDATE export_task
     SET status = 'SUCCEEDED', row_count = $3, lease_until = NULL, last_error = NULL, updated_at = now()
     WHERE id = $1 AND attempt = $2 AND status = 'RUNNING'`,
    [task.id, task.attempt, rowCount],
  );
  return result.rowCount === 1;
}

/** If every chunk of the job has succeeded, makes FINALIZE ready and queues it. */
export async function releaseFinalizeIfReady(client: DbClient, jobId: string): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE export_task SET status = 'READY', updated_at = now()
     WHERE job_id = $1 AND kind = 'FINALIZE' AND status = 'WAITING'
       AND NOT EXISTS (
         SELECT 1 FROM export_task c WHERE c.job_id = $1 AND c.kind = 'CHUNK' AND c.status <> 'SUCCEEDED')
     RETURNING id`,
    [jobId],
  );
  const finalizeId = rows[0]?.id;
  if (finalizeId) await client.query('INSERT INTO export_outbox (task_id) VALUES ($1)', [finalizeId]);
  return Boolean(finalizeId);
}

/**
 * Records a failed attempt. Retries with exponential backoff while attempts remain,
 * otherwise marks the task and its job FAILED. Returns the new status, or null if stale.
 */
export async function recordFailure(
  db: Db,
  task: ExportTask,
  error: { message: string; permanent: boolean },
  retryBaseMs: number,
): Promise<'RETRY_WAIT' | 'FAILED' | null> {
  return withTransaction(db, async (client) => {
    await lockJob(client, task.job_id);
    const giveUp = error.permanent || task.attempt >= task.max_attempts;

    if (giveUp) {
      const updated = await client.query(
        `UPDATE export_task SET status = 'FAILED', last_error = $3, lease_until = NULL, updated_at = now()
         WHERE id = $1 AND attempt = $2 AND status = 'RUNNING'`,
        [task.id, task.attempt, error.message],
      );
      if (updated.rowCount !== 1) return null;
      await failJob(client, task.job_id, `Task ${task.kind} #${task.seq} failed: ${error.message}`);
      return 'FAILED';
    }

    const delayMs = backoffMs(task.attempt, retryBaseMs);
    const updated = await client.query<{ run_after: Date }>(
      `UPDATE export_task
       SET status = 'RETRY_WAIT', last_error = $3, lease_until = NULL, updated_at = now(),
           run_after = now() + make_interval(secs => $4)
       WHERE id = $1 AND attempt = $2 AND status = 'RUNNING'
       RETURNING run_after`,
      [task.id, task.attempt, error.message, delayMs / 1000],
    );
    const runAfter = updated.rows[0]?.run_after;
    if (!runAfter) return null;
    // The retry is queued now but only published when it is due.
    await client.query('INSERT INTO export_outbox (task_id, available_at) VALUES ($1, $2)', [task.id, runAfter]);
    return 'RETRY_WAIT';
  });
}

export async function failJob(db: Queryable, jobId: string, message: string): Promise<void> {
  await db.query(
    `UPDATE export_job SET status = 'FAILED', error = $2, finished_at = now()
     WHERE id = $1 AND status IN ('PENDING', 'RUNNING')`,
    [jobId, message],
  );
}

/** Exponential backoff with jitter: base, 2x base, 4x base ... capped at 5 minutes. */
export function backoffMs(attempt: number, baseMs: number): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 300_000);
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}
