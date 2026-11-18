import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcile } from '../../src/modules/dispatch/reconciler.js';
import { listTasks } from '../../src/modules/jobs/job-queries.js';
import { retryJob } from '../../src/modules/jobs/retry-job.js';
import { claimTask } from '../../src/modules/jobs/task-state.js';
import { PermanentError, TransientError } from '../../src/lib/errors.js';
import { hourlySpec, SETTINGS, TestContext } from '../helpers/context.js';

let ctx: TestContext;
let expectedIds: string[];

/** One closed hour with 25 records (3 chunks), and its job created but not run. */
beforeEach(async () => {
  ctx = await TestContext.create();
  await ctx.workspace('ws1', 't1', hourlySpec());
  expectedIds = await ctx.records(
    'ws1',
    Array.from({ length: 25 }, (_, i) => ({ inspectedAt: new Date(Date.UTC(2026, 10, 11, 10, 1 + 2 * i)) })),
  );
  ctx.clock.set(new Date('2026-11-11T11:06:00Z'));
  await ctx.scheduler.tick();
});
afterEach(async () => {
  await ctx.close();
});

async function onlyJob() {
  const jobs = await ctx.jobs();
  expect(jobs).toHaveLength(1);
  return jobs[0]!;
}

async function expireLeases() {
  await ctx.db.query(`UPDATE export_task SET lease_until = now() - interval '1 second' WHERE status = 'RUNNING'`);
}

async function chunkTask(seq: number) {
  const job = await onlyJob();
  return (await listTasks(ctx.db, job.id)).find((t) => t.kind === 'CHUNK' && t.seq === seq)!;
}

async function expectCompleteAndCorrect() {
  const job = await onlyJob();
  expect(job).toMatchObject({ status: 'COMPLETED', row_count: 25 });
  expect(await ctx.exportedIds('out')).toEqual(expectedIds);
  const artifacts = await ctx.db.query('SELECT count(*)::int AS n FROM export_artifact');
  expect(artifacts.rows[0].n).toBe(1);
}

describe('crash recovery', () => {
  it('a worker that dies mid-task: the lease expires and another worker finishes', async () => {
    const task = await chunkTask(0);
    const claim = await claimTask(ctx.db, task.id, 'worker-that-dies', SETTINGS);
    expect(claim.kind).toBe('claimed');
    // ...the worker process is killed here; nothing else is written.

    await expireLeases();
    const result = await reconcile(ctx.db, { staleSeconds: 30 });
    expect(result.expiredLeases).toBe(1);

    await ctx.pump();
    await expectCompleteAndCorrect();
    expect((await chunkTask(0)).attempt).toBe(2);
  });

  it('a slow "zombie" worker cannot overwrite the result of a newer attempt (fencing)', async () => {
    const task = await chunkTask(0);
    const zombie = ctx.runner('zombie', {
      afterWrite: async (t) => {
        if (t.id !== task.id) return;
        // While the zombie is stuck, its lease expires and a healthy worker redoes the chunk.
        await expireLeases();
        await reconcile(ctx.db, { staleSeconds: 30 });
        await ctx.runner('healthy').run(task.id);
      },
    });

    expect(await zombie.run(task.id)).toBe('stale');

    await ctx.pump();
    await expectCompleteAndCorrect();
    const after = await chunkTask(0);
    expect(after).toMatchObject({ status: 'SUCCEEDED', attempt: 2, worker_id: 'healthy' });
  });

  it('a failure after the file is published but before the commit: the retry republishes the same file once', async () => {
    let failedOnce = false;
    const flaky = ctx.runner('flaky', {
      afterWrite: async (t) => {
        if (t.kind === 'FINALIZE' && !failedOnce) {
          failedOnce = true;
          throw new TransientError('connection lost before commit');
        }
      },
    });

    await ctx.pump(flaky);
    expect((await onlyJob()).status).toBe('RUNNING'); // file exists, but not committed

    await ctx.pump(flaky, { dueNow: true });
    await expectCompleteAndCorrect();
    expect([...(await ctx.files('out')).keys()]).toEqual(['report_2026-11-11T1000Z.csv']);
  });

  it('a lost queue message is re-sent by the reconciler', async () => {
    // Outbox says "published" but the message never reached a worker (e.g. Redis lost it).
    await ctx.db.query(`UPDATE export_outbox SET published_at = now() - interval '1 minute'`);
    await ctx.db.query(`UPDATE export_task SET updated_at = now() - interval '1 minute'`);
    await ctx.pump();
    expect((await onlyJob()).status).toBe('PENDING');

    const result = await reconcile(ctx.db, { staleSeconds: 30 });
    expect(result.requeued).toBe(3);
    await ctx.pump();
    await expectCompleteAndCorrect();
  });

  it('duplicate messages for the same task run it only once', async () => {
    const task = await chunkTask(0);
    const outcomes = await Promise.all([
      ctx.runner('a').run(task.id),
      ctx.runner('b').run(task.id),
      ctx.runner('c').run(task.id),
    ]);
    expect(outcomes.filter((o) => o === 'succeeded')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'not-claimable')).toHaveLength(2);
    expect((await chunkTask(0)).attempt).toBe(1);
  });
});

describe('retries and failures', () => {
  it('retries a transient error with backoff, then succeeds', async () => {
    let failures = 0;
    const runner = ctx.runner(
      'w',
      {
        afterWrite: async (t) => {
          if (t.kind === 'CHUNK' && t.seq === 1 && failures++ < 2) throw new TransientError('storage timeout');
        },
      },
      { retryBaseMs: 60_000 },
    );

    await ctx.pump(runner);
    const waiting = await chunkTask(1);
    expect(waiting).toMatchObject({ status: 'RETRY_WAIT', attempt: 1, last_error: 'storage timeout' });
    expect(waiting.run_after!.getTime()).toBeGreaterThan(Date.now() + 30_000); // backoff, not a hot loop
    expect((await onlyJob()).status).toBe('RUNNING');

    await ctx.pump(runner, { dueNow: true });
    await expectCompleteAndCorrect();
    expect((await chunkTask(1)).attempt).toBe(3);
  });

  it('fails fast on a permanent error, blocks the partition, and a manual retry finishes it', async () => {
    let broken = true;
    const runner = ctx.runner('w', {
      afterWrite: async (t) => {
        if (broken && t.kind === 'CHUNK' && t.seq === 2) throw new PermanentError('destination rejected the data');
      },
    });
    await ctx.pump(runner);

    const failed = await onlyJob();
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatch(/destination rejected the data/);
    expect((await chunkTask(2)).attempt).toBe(1); // no blind retries

    // A late record arrives: no correction may start while the original is unresolved.
    await ctx.records('ws1', [{ inspectedAt: '2026-11-11T10:59:00Z', finalizedAt: '2026-11-11T11:10:00Z' }]);
    ctx.clock.set(new Date('2026-11-11T11:15:00Z'));
    expect((await ctx.scheduler.tick()).correctionsStarted).toBe(0);

    broken = false;
    await retryJob(ctx.db, failed.id, 3);
    await ctx.pump(runner);
    await expectCompleteAndCorrect();

    const partition = await ctx.db.query('SELECT last_cutoff, in_flight_job_id FROM export_partition');
    expect(partition.rows[0]).toEqual({ last_cutoff: new Date('2026-11-11T11:06:00Z'), in_flight_job_id: null });
  });

  it('stops after max attempts', async () => {
    const runner = ctx.runner('w', {
      afterWrite: async (t) => {
        if (t.kind === 'CHUNK' && t.seq === 0) throw new Error('always broken');
      },
    });
    await ctx.pump(runner, { dueNow: true });

    expect(await chunkTask(0)).toMatchObject({ status: 'FAILED', attempt: 3 });
    expect((await onlyJob()).status).toBe('FAILED');
  });

  it('a task that keeps killing its worker (lease expiry) fails after max attempts', async () => {
    const task = await chunkTask(0);
    for (let i = 0; i < SETTINGS.maxAttempts; i++) {
      expect((await claimTask(ctx.db, task.id, `dies-${i}`, SETTINGS)).kind).toBe('claimed');
      await expireLeases();
      await reconcile(ctx.db, { staleSeconds: 30 });
    }
    expect(await chunkTask(0)).toMatchObject({ status: 'FAILED', attempt: 3 });
    expect((await onlyJob()).status).toBe('FAILED');
  });
});

describe('concurrency', () => {
  it('parallel scheduler ticks create one job per partition', async () => {
    ctx.clock.set(new Date('2026-11-11T15:06:00Z'));
    await Promise.all(Array.from({ length: 5 }, () => ctx.scheduler.tick()));
    const jobs = await ctx.jobs();
    expect(jobs.map((j) => j.file_name)).toEqual([
      'report_2026-11-11T1000Z.csv',
      'report_2026-11-11T1100Z.csv',
      'report_2026-11-11T1200Z.csv',
      'report_2026-11-11T1300Z.csv',
      'report_2026-11-11T1400Z.csv',
    ]);
  });
});
