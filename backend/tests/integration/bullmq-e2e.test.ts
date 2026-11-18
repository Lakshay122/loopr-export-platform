import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchOutbox } from '../../src/modules/dispatch/outbox-dispatcher.js';
import { BullMqConsumer, BullMqPublisher } from '../../src/modules/queue/bullmq-queue.js';
import { hourlySpec, TestContext } from '../helpers/context.js';
import { TEST_REDIS_URL } from '../helpers/env.js';

/**
 * The real path: PostgreSQL outbox → dispatcher → BullMQ (Redis) → several consumers → PostgreSQL.
 * Uses its own queue name so it never touches a running demo stack.
 */
let ctx: TestContext;
let publisher: BullMqPublisher;
let consumers: BullMqConsumer[];
const queueName = `export-tasks-test-${randomUUID().slice(0, 8)}`;

beforeEach(async () => {
  ctx = await TestContext.create();
  publisher = new BullMqPublisher(TEST_REDIS_URL, queueName);
  // Three "worker processes", each with its own task runner.
  consumers = ['w1', 'w2', 'w3'].map(
    (id) => new BullMqConsumer(TEST_REDIS_URL, (taskId) => ctx.runner(id).run(taskId), 2, queueName),
  );
});
afterEach(async () => {
  await Promise.all(consumers.map((c) => c.close()));
  await publisher.close();
  await ctx.close();
});

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting');
    await dispatchOutbox(ctx.db, publisher); // keep the dispatcher loop going
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('BullMQ end to end', () => {
  it('distributes chunk tasks across workers and completes the export', async () => {
    await ctx.workspace('ws1', 't1', hourlySpec({ chunkSize: 10 }));
    const ids = await ctx.records(
      'ws1',
      Array.from({ length: 95 }, (_, i) => ({ inspectedAt: new Date(Date.UTC(2026, 10, 11, 10, 0, 30 * i)) })),
    );
    ctx.clock.set(new Date('2026-11-11T11:06:00Z'));
    await ctx.scheduler.tick();

    // Publish the same outbox rows twice to prove duplicates are harmless.
    await dispatchOutbox(ctx.db, publisher);
    await ctx.db.query('UPDATE export_outbox SET published_at = NULL');

    const job = await waitFor(async () => {
      const [j] = await ctx.jobs();
      return j?.status === 'COMPLETED' ? j : undefined;
    });

    expect(job.row_count).toBe(95);
    expect(await ctx.exportedIds('out')).toEqual(ids);
    const workers = await ctx.db.query<{ n: number }>(
      `SELECT count(DISTINCT worker_id)::int AS n FROM export_task WHERE kind = 'CHUNK'`,
    );
    expect(workers.rows[0]!.n).toBeGreaterThan(1);
    const attempts = await ctx.db.query<{ max: number }>('SELECT max(attempt)::int AS max FROM export_task');
    expect(attempts.rows[0]!.max).toBe(1);
  });
});
