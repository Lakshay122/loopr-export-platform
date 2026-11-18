import type { Db } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import type { TaskPublisher } from '../queue/task-queue.js';

/**
 * Publishes due outbox rows to the queue, then marks them published.
 *
 * If we crash after publishing but before marking, the row is published again on the
 * next run. That is fine: the message id is deterministic (BullMQ ignores the duplicate),
 * and the worker's claim ignores tasks that are not claimable anyway.
 *
 * Several dispatchers can run at once: FOR UPDATE SKIP LOCKED gives each its own rows.
 */
export async function dispatchOutbox(db: Db, publisher: TaskPublisher, batchSize = 200): Promise<number> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<{ id: string; task_id: string }>(
      `SELECT id, task_id FROM export_outbox
       WHERE published_at IS NULL AND available_at <= now()
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    if (rows.length === 0) return 0;

    await publisher.publish(rows.map((r) => ({ taskId: r.task_id, messageId: `${r.task_id}_${r.id}` })));
    await client.query('UPDATE export_outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [
      rows.map((r) => r.id),
    ]);
    return rows.length;
  });
}
