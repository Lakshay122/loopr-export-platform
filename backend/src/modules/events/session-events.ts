import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import type { Clock } from '../../lib/clock.js';
import { badRequest } from '../../lib/errors.js';
import { getConfigVersion } from '../export-config/config-service.js';
import { groupingEras } from '../export-config/grouping-switch.js';

/** A session.completed event from the inspection platform (e.g. via Kafka / Event Hubs in production). */
export const SessionCompletedSchema = z.object({
  eventId: z.string().min(1).max(200),
  type: z.literal('session.completed'),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  occurredAt: z.coerce.date(),
});
export type SessionCompletedEvent = z.infer<typeof SessionCompletedSchema>;

export type EventOutcome = 'partition-created' | 'duplicate-event' | 'already-closed' | 'ignored';

/**
 * Closes the session's export group (D-13, EVENT closing rule).
 *
 * "Session completed" is a readiness signal, not proof that every record is finalized.
 * So the group becomes ready only after a settle delay; records that finalize later
 * go into additive correction files (handled by the scheduler).
 *
 * Duplicates are ignored twice over: by event id, and by the unique partition key.
 */
export async function handleSessionCompleted(
  db: Db,
  event: SessionCompletedEvent,
  clock: Clock,
): Promise<EventOutcome> {
  return withTransaction(db, async (client) => {
    const seen = await client.query(
      `INSERT INTO processed_event (event_id, event_type) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [event.eventId, event.type],
    );
    if (seen.rowCount === 0) return 'duplicate-event';

    const session = await client.query<{ started_at: Date }>(
      'SELECT started_at FROM inspection_session WHERE id = $1 AND workspace_id = $2',
      [event.sessionId, event.workspaceId],
    );
    const startedAt = session.rows[0]?.started_at;
    if (!startedAt) throw badRequest('Unknown session for this workspace');

    const config = await getConfigVersion(client, event.workspaceId).catch(() => null);
    if (!config) return 'ignored';

    // Which per-session era does this session belong to? After a schedule change the session
    // only covers the part of the era it overlaps: [from, to). See grouping-switch.ts.
    const eras = await groupingEras(client, config.configId);
    const era = eras.find(
      (e) => e.grouping.kind === 'SESSION' && (!e.from || event.occurredAt >= e.from) && (!e.to || startedAt < e.to),
    );
    if (!era || era.grouping.kind !== 'SESSION') return 'ignored';

    // Use the later of event time and receive time, so an old replayed event still waits to settle.
    const base = Math.max(event.occurredAt.getTime(), clock.now().getTime());
    const readyAt = new Date(base + era.grouping.settleSeconds * 1000);

    const inserted = await client.query(
      `INSERT INTO export_partition
         (workspace_id, config_id, partition_type, partition_key, session_id, range_start, range_end,
          ready_at, closed_by_event_id)
       VALUES ($1, $2, 'SESSION', $3, $3, $4, $5, $6, $7)
       ON CONFLICT (config_id, partition_key) DO NOTHING`,
      [event.workspaceId, config.configId, event.sessionId, era.from, era.to, readyAt, event.eventId],
    );
    return inserted.rowCount === 1 ? 'partition-created' : 'already-closed';
  });
}
