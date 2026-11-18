import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateConfig } from '../../src/modules/export-config/config-service.js';
import { hourlySpec, TestContext } from '../helpers/context.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await TestContext.create();
  await ctx.workspace('ws1', 't1', hourlySpec());
});
afterEach(async () => {
  await ctx.close();
});

const at = (iso: string) => new Date(iso);

describe('late records and additive corrections (D-08)', () => {
  it('puts a late record in a correction file that contains only the new rows', async () => {
    await ctx.records('ws1', [{ inspectedAt: '2026-11-11T10:10:00Z', id: 'on-time' }]);
    ctx.clock.set(at('2026-11-11T11:06:00Z'));
    await ctx.tickAndRun();

    // An offline tablet uploads a 10:20 inspection at 11:30.
    await ctx.records('ws1', [
      { inspectedAt: '2026-11-11T10:20:00Z', finalizedAt: '2026-11-11T11:30:00Z', id: 'late-1' },
    ]);
    ctx.clock.set(at('2026-11-11T11:31:00Z'));
    await ctx.tickAndRun();

    // Nothing new: no empty correction files.
    ctx.clock.set(at('2026-11-11T11:40:00Z'));
    await ctx.tickAndRun();

    const files = await ctx.files('out');
    expect([...files.keys()]).toEqual(['report_2026-11-11T1000Z.csv', 'report_2026-11-11T1000Z_correction_01.csv']);
    expect(
      files
        .get('report_2026-11-11T1000Z_correction_01.csv')!
        .slice(1)
        .map((l) => l.split(',')[0]),
    ).toEqual(['late-1']);
    expect((await ctx.jobs()).map((j) => [j.trigger, j.correction_no])).toEqual([
      ['SCHEDULED', 0],
      ['CORRECTION', 1],
    ]);
  });

  it('assigns a record exactly on the cutoff to one file only (left-open, right-closed)', async () => {
    const cutoff = '2026-11-11T11:06:00Z';
    await ctx.records('ws1', [{ inspectedAt: '2026-11-11T10:10:00Z', finalizedAt: cutoff, id: 'on-cutoff' }]);
    ctx.clock.set(at(cutoff));
    await ctx.tickAndRun();

    await ctx.records('ws1', [
      { inspectedAt: '2026-11-11T10:11:00Z', finalizedAt: '2026-11-11T11:06:00.001Z', id: 'just-after' },
    ]);
    ctx.clock.set(at('2026-11-11T11:10:00Z'));
    await ctx.tickAndRun();

    const files = await ctx.files('out');
    expect(
      files
        .get('report_2026-11-11T1000Z.csv')!
        .slice(1)
        .map((l) => l.split(',')[0]),
    ).toEqual(['on-cutoff']);
    expect(
      files
        .get('report_2026-11-11T1000Z_correction_01.csv')!
        .slice(1)
        .map((l) => l.split(',')[0]),
    ).toEqual(['just-after']);
  });

  it('keeps corrections on the config version of the original report (D-09)', async () => {
    await ctx.records('ws1', [{ inspectedAt: '2026-11-11T10:10:00Z' }]);
    ctx.clock.set(at('2026-11-11T11:06:00Z'));
    await ctx.tickAndRun();

    // Customer adds a column (v2). New hours use v2; the 10:00 correction stays on v1.
    await updateConfig(
      ctx.db,
      'ws1',
      hourlySpec({ columns: [{ field: 'record_id' }, { field: 'result' }, { field: 'part_serial' }] }),
      'tester',
    );
    await ctx.records('ws1', [
      { inspectedAt: '2026-11-11T10:30:00Z', finalizedAt: '2026-11-11T11:20:00Z' },
      { inspectedAt: '2026-11-11T11:30:00Z' },
    ]);
    ctx.clock.set(at('2026-11-11T12:06:00Z'));
    await ctx.tickAndRun();

    const files = await ctx.files('out');
    expect(files.get('report_2026-11-11T1000Z_correction_01.csv')![0]).toBe('record_id,result,inspected_at');
    expect(files.get('report_2026-11-11T1100Z.csv')![0]).toBe('record_id,result,part_serial');
    const versions = Object.fromEntries((await ctx.jobs()).map((j) => [j.file_name, j.config_version]));
    expect(versions).toEqual({
      'report_2026-11-11T1000Z.csv': 1,
      'report_2026-11-11T1000Z_correction_01.csv': 1,
      'report_2026-11-11T1100Z.csv': 2,
    });
  });

  it('flags records that arrive after the lookback instead of exporting them', async () => {
    ctx.clock.set(at('2026-11-11T11:06:00Z'));
    await ctx.tickAndRun();

    // 30 hours later (lookback is 24h) a record for 10:00 shows up.
    ctx.clock.set(at('2026-11-12T17:00:00Z'));
    await ctx.records('ws1', [
      { inspectedAt: '2026-11-11T10:45:00Z', finalizedAt: '2026-11-12T16:59:00Z', id: 'too-late' },
    ]);
    const result = await ctx.scheduler.tick();

    expect(result.lateRecordsFlagged).toBe(1);
    expect((await ctx.jobs()).filter((j) => j.trigger === 'CORRECTION')).toEqual([]);
    const flags = await ctx.db.query('SELECT record_id FROM late_record_flag');
    expect(flags.rows).toEqual([{ record_id: 'too-late' }]);
  });

  it('exports every eligible record exactly once across originals and corrections', async () => {
    // Random arrivals (on time and late) mixed with scheduler ticks over 6 hours.
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const expected: string[] = [];
    let now = at('2026-11-11T10:00:00Z').getTime();

    for (let step = 0; step < 36; step++) {
      now += 10 * 60_000;
      for (let i = 0; i < 3; i++) {
        const inspected = now - Math.floor(random() * 3 * 3_600_000); // up to 3h late
        if (inspected < at('2026-11-11T10:00:00Z').getTime()) continue;
        const ids = await ctx.records('ws1', [{ inspectedAt: new Date(inspected), finalizedAt: new Date(now - 1000) }]);
        expected.push(...ids);
      }
      ctx.clock.set(new Date(now));
      await ctx.tickAndRun();
    }
    // Let the last hours close and their corrections run.
    ctx.clock.set(new Date(now + 2 * 3_600_000));
    await ctx.tickAndRun();

    const exported = await ctx.exportedIds('out');
    expect(new Set(exported).size).toBe(exported.length); // no duplicates
    expect(exported.sort()).toEqual(expected.sort()); // nothing lost
    expect((await ctx.jobs()).some((j) => j.trigger === 'CORRECTION')).toBe(true);
  });
});
