import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTasks } from '../../src/modules/jobs/job-queries.js';
import { createManualExport } from '../../src/modules/jobs/manual-export.js';
import { hourlySpec, SETTINGS, TestContext } from '../helpers/context.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await TestContext.create();
});
afterEach(async () => {
  await ctx.close();
});

describe('hourly CSV export (TIME grouping)', () => {
  it('exports exactly the finalized records of a closed hour, in chunks, as one file', async () => {
    await ctx.workspace('ws1', 't1', hourlySpec());
    const inHour = await ctx.records(
      'ws1',
      Array.from({ length: 25 }, (_, i) => ({ inspectedAt: new Date(Date.UTC(2026, 10, 11, 10, 1 + 2 * i)) })),
    );
    await ctx.records('ws1', [
      { inspectedAt: '2026-11-11T10:30:30Z', finalizedAt: null }, // not finalized yet
      { inspectedAt: '2026-11-11T11:01:00Z' }, // next hour
    ]);

    // Before end + grace (11:05): nothing happens.
    ctx.clock.set(new Date('2026-11-11T11:04:00Z'));
    expect((await ctx.scheduler.tick()).jobsStarted).toBe(0);

    ctx.clock.set(new Date('2026-11-11T11:06:00Z'));
    await ctx.tickAndRun();

    const [job] = await ctx.jobs();
    expect(job).toMatchObject({
      status: 'COMPLETED',
      trigger: 'SCHEDULED',
      row_count: 25,
      file_name: 'report_2026-11-11T1000Z.csv',
    });

    // 25 rows with chunkSize 10 => 3 chunk tasks + 1 finalize.
    const tasks = await listTasks(ctx.db, job!.id);
    expect(tasks.filter((t) => t.kind === 'CHUNK')).toHaveLength(3);
    expect(tasks.every((t) => t.status === 'SUCCEEDED')).toBe(true);

    const files = await ctx.files('out');
    const lines = files.get('report_2026-11-11T1000Z.csv')!;
    expect(lines[0]).toBe('record_id,result,inspected_at');
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(inHour); // sorted, complete, no duplicates

    // Staging chunks are cleaned up after publication.
    expect(existsSync(path.join(ctx.storageDir, 'staging', job!.id))).toBe(false);
  });

  it('delivers an empty report (header only) for an hour with no records', async () => {
    await ctx.workspace('ws1', 't1', hourlySpec());
    ctx.clock.set(new Date('2026-11-11T11:06:00Z'));
    await ctx.tickAndRun();

    const [job] = await ctx.jobs();
    expect(job).toMatchObject({ status: 'COMPLETED', row_count: 0 });
    expect((await ctx.files('out')).get(job!.file_name)).toEqual(['record_id,result,inspected_at']);
  });

  it('applies config filters and creates every missed hour after downtime', async () => {
    await ctx.workspace('ws1', 't1', hourlySpec({ filters: { results: ['FAIL'] } }));
    await ctx.records('ws1', [
      { inspectedAt: '2026-11-11T10:10:00Z', result: 'FAIL', id: 'fail-1' },
      { inspectedAt: '2026-11-11T10:20:00Z', result: 'PASS' },
      { inspectedAt: '2026-11-11T12:10:00Z', result: 'FAIL', id: 'fail-2' },
    ]);

    // Scheduler was "down" for 3 hours: one tick catches up all closed hours.
    ctx.clock.set(new Date('2026-11-11T13:10:00Z'));
    await ctx.tickAndRun();

    expect((await ctx.jobs()).map((j) => j.file_name)).toEqual([
      'report_2026-11-11T1000Z.csv',
      'report_2026-11-11T1100Z.csv',
      'report_2026-11-11T1200Z.csv',
    ]);
    expect((await ctx.exportedIds('out')).sort()).toEqual(['fail-1', 'fail-2']);
  });

  it('a manual export of the same hour is a separate copy and does not change the hourly file', async () => {
    await ctx.workspace('ws1', 't1', hourlySpec());
    await ctx.records('ws1', [
      { inspectedAt: '2026-11-11T10:10:00Z', id: 'm1' },
      { inspectedAt: '2026-11-11T10:20:00Z', id: 'm2', result: 'FAIL' },
    ]);

    // During the hour, someone downloads "last hour" by hand.
    ctx.clock.set(new Date('2026-11-11T10:30:00Z'));
    await createManualExport(
      ctx.db,
      { tenantId: 't1', userId: 'alice' },
      { id: 'ws1', tenantId: 't1', name: 'ws1' },
      {
        requestId: 'req-1',
        rangeStart: new Date('2026-11-11T09:30:00Z'),
        rangeEnd: new Date('2026-11-11T10:30:00Z'),
        results: ['FAIL'],
      },
      { clock: ctx.clock, ...SETTINGS },
    );
    await ctx.pump();

    ctx.clock.set(new Date('2026-11-11T11:06:00Z'));
    await ctx.tickAndRun();
    ctx.clock.set(new Date('2026-11-11T12:06:00Z'));
    await ctx.tickAndRun();

    const files = await ctx.files('out');
    const manual = [...files.keys()].find((n) => n.startsWith('manual_'))!;
    expect(
      files
        .get(manual)!
        .slice(1)
        .map((l) => l.split(',')[0]),
    ).toEqual(['m2']);
    // The hourly file is complete, as if the manual export never happened, and no correction was made.
    expect(
      files
        .get('report_2026-11-11T1000Z.csv')!
        .slice(1)
        .map((l) => l.split(',')[0]),
    ).toEqual(['m1', 'm2']);
    expect((await ctx.jobs()).map((j) => j.trigger).sort()).toEqual(['MANUAL', 'SCHEDULED', 'SCHEDULED']);
  });

  it('exports customer-specific metadata and filters on it', async () => {
    await ctx.workspace(
      'ws1',
      't1',
      hourlySpec({
        columns: [
          { field: 'record_id' },
          { field: 'metadata.operator', header: 'Operator' },
          { field: 'metadata.torque_nm', header: 'Torque', whenMissing: 'n/a' },
        ],
        filters: { metadata: { line: ['L1'] } },
      }),
    );
    await ctx.records('ws1', [
      { inspectedAt: '2026-11-11T10:10:00Z', id: 'w1', metadata: { line: 'L1', operator: 'op-12', torque_nm: 12.4 } },
      { inspectedAt: '2026-11-11T10:20:00Z', id: 's1', metadata: { line: 'L1', operator: 'op-17' } }, // no torque
      { inspectedAt: '2026-11-11T10:30:00Z', id: 'x1', metadata: { line: 'L2', operator: 'op-99' } }, // other line
      { inspectedAt: '2026-11-11T10:40:00Z', id: 'n1' }, // no metadata at all
    ]);

    ctx.clock.set(new Date('2026-11-11T11:06:00Z'));
    await ctx.tickAndRun();

    expect((await ctx.files('out')).get('report_2026-11-11T1000Z.csv')).toEqual([
      'record_id,Operator,Torque',
      'w1,op-12,12.4',
      's1,op-17,n/a',
    ]);
  });
});
