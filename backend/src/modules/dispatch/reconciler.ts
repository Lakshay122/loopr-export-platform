import type { Db } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { failJob, lockJob, releaseFinalizeIfReady } from '../jobs/task-state.js';

export interface ReconcileResult {
  expiredLeases: number;
  failedByLease: number;
  requeued: number;
  finalizeReleased: number;
}

/**
 * Repairs work that got stuck. Runs every few seconds; every step is safe to repeat.
 *
 * 1. Expired leases: a worker took a task and then died (or hung). The task goes back
 *    to READY — or FAILED if it has used all attempts, so a "poison" task cannot loop forever.
 * 2. Lost messages: a READY task that has been waiting too long without any pending
 *    outbox row (for example Redis lost the message) gets a new outbox row.
 * 3. Safety net: if all chunks succeeded but FINALIZE is still WAITING, release it.
 */
export async function reconcile(db: Db, opts: { staleSeconds: number }): Promise<ReconcileResult> {
  const leases = await withTransaction(db, async (client) => {
    const { rows } = await client.query<{ id: string; job_id: string; status: string; kind: string; seq: number }>(
      `WITH expired AS (
         SELECT id FROM export_task
         WHERE status = 'RUNNING' AND lease_until < now()
         FOR UPDATE SKIP LOCKED
       )
       UPDATE export_task t
       SET status = CASE WHEN t.attempt >= t.max_attempts THEN 'FAILED' ELSE 'READY' END,
           last_error = 'Lease expired: the worker stopped or took too long',
           lease_until = NULL, worker_id = NULL, updated_at = now()
       FROM expired
       WHERE t.id = expired.id
       RETURNING t.id, t.job_id, t.status, t.kind, t.seq`,
    );
    for (const task of rows) {
      if (task.status === 'READY') {
        await client.query('INSERT INTO export_outbox (task_id) VALUES ($1)', [task.id]);
      } else {
        await failJob(client, task.job_id, `Task ${task.kind} #${task.seq} failed: lease expired on the last attempt`);
      }
    }
    return { expired: rows.length, failed: rows.filter((r) => r.status === 'FAILED').length };
  });

  const requeued = await db.query(
    `INSERT INTO export_outbox (task_id)
     SELECT t.id FROM export_task t JOIN export_job j ON j.id = t.job_id
     WHERE j.status IN ('PENDING', 'RUNNING')
       AND (
         (t.status = 'READY' AND t.updated_at < now() - make_interval(secs => $1))
         OR (t.status = 'RETRY_WAIT' AND t.run_after < now() - make_interval(secs => $1))
       )
       AND NOT EXISTS (
         SELECT 1 FROM export_outbox o
         WHERE o.task_id = t.id
           AND (o.published_at IS NULL OR o.published_at > now() - make_interval(secs => $1))
       )`,
    [opts.staleSeconds],
  );

  const waiting = await db.query<{ job_id: string }>(
    `SELECT DISTINCT t.job_id FROM export_task t JOIN export_job j ON j.id = t.job_id
     WHERE t.kind = 'FINALIZE' AND t.status = 'WAITING' AND j.status IN ('PENDING', 'RUNNING')`,
  );
  let finalizeReleased = 0;
  for (const { job_id } of waiting.rows) {
    const released = await withTransaction(db, async (client) => {
      await lockJob(client, job_id);
      return releaseFinalizeIfReady(client, job_id);
    });
    if (released) finalizeReleased++;
  }

  return {
    expiredLeases: leases.expired,
    failedByLease: leases.failed,
    requeued: requeued.rowCount ?? 0,
    finalizeReleased,
  };
}
