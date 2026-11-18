import type { Db } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { conflict } from '../../lib/errors.js';
import { getJob } from './job-queries.js';
import type { ExportJob } from './job-types.js';
import { lockJob, releaseFinalizeIfReady } from './task-state.js';

/**
 * Re-runs a FAILED job on the same pinned config version and the same row boundaries,
 * so the output is the same as if it had worked the first time.
 *
 * Only unfinished tasks run again; succeeded chunks are reused. `attempt` keeps counting
 * up (it is the fencing token), and each failed task gets a fresh attempt budget.
 */
export async function retryJob(db: Db, jobId: string, extraAttempts: number): Promise<ExportJob> {
  await withTransaction(db, async (client) => {
    await lockJob(client, jobId);
    const job = await getJob(client, jobId);
    if (job.status !== 'FAILED') throw conflict(`Only FAILED exports can be retried (status is ${job.status})`);

    await client.query(
      `UPDATE export_task
       SET status = CASE WHEN kind = 'FINALIZE' THEN 'WAITING' ELSE 'READY' END,
           max_attempts = attempt + $2, run_after = NULL, lease_until = NULL, updated_at = now()
       WHERE job_id = $1 AND status IN ('FAILED', 'READY', 'RETRY_WAIT')`,
      [jobId, extraAttempts],
    );
    await client.query(
      `INSERT INTO export_outbox (task_id)
       SELECT id FROM export_task WHERE job_id = $1 AND kind = 'CHUNK' AND status = 'READY'`,
      [jobId],
    );
    await client.query(`UPDATE export_job SET status = 'PENDING', error = NULL, finished_at = NULL WHERE id = $1`, [
      jobId,
    ]);
    await releaseFinalizeIfReady(client, jobId);
  });
  return getJob(db, jobId);
}
