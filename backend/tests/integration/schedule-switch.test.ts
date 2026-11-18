import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateConfig } from '../../src/modules/export-config/config-service.js';
import { handleSessionCompleted } from '../../src/modules/events/session-events.js';
import { hourlySpec, TestContext } from '../helpers/context.js';

/**
 * Changing the schedule type (hourly <-> per session). The change starts at the next full
 * hour; every record must land in exactly one file, with no gap and no duplicate.
 */
let ctx: TestContext;
beforeEach(async () => {
  ctx = await TestContext.create();
});
afterEach(async () => {
  await ctx.close();
});

const PER_SESSION = {
  groupBy: ['session_id'],
  closeWhen: { type: 'EVENT' as const, event: 'session.completed' as const, settleSeconds: 60 },
};
const HOURLY = { groupBy: ['time_bucket(1h)'], closeWhen: { type: 'TIME' as const, graceSeconds: 300 } };

const complete = (sessionId: string) =>
  handleSessionCompleted(
    ctx.db,
    {
      eventId: `evt-${sessionId}`,
      type: 'session.completed',
      workspaceId: 'ws',
      sessionId,
      occurredAt: ctx.clock.now(),
    },
    ctx.clock,
  );

const at = (iso: string) => ctx.clock.set(new Date(iso));

describe('changing the schedule type', () => {
  it('hourly -> per session: the current hour finishes as an hourly file, sessions take over after it', async () => {
    await ctx.workspace('ws', 't', hourlySpec());
    await ctx.records('ws', [
      { inspectedAt: '2026-11-11T10:10:00Z', sessionId: 'S-A', id: 'a1' },
      { inspectedAt: '2026-11-11T10:50:00Z', sessionId: 'S-B', id: 'b1' }, // session crosses the switch
      { inspectedAt: '2026-11-11T11:10:00Z', sessionId: 'S-B', id: 'b2' },
      { inspectedAt: '2026-11-11T11:20:00Z', sessionId: 'S-C', id: 'c1' },
    ]);

    at('2026-11-11T10:20:00Z');
    const v2 = await updateConfig(ctx.db, 'ws', hourlySpec({ grouping: PER_SESSION }), 'tester', ctx.clock.now());
    expect(v2.effectiveFrom?.toISOString()).toBe('2026-11-11T11:00:00.000Z');

    at('2026-11-11T10:30:00Z');
    expect(await complete('S-A')).toBe('ignored'); // still hourly until 11:00

    at('2026-11-11T11:30:00Z');
    expect(await complete('S-B')).toBe('partition-created');
    expect(await complete('S-C')).toBe('partition-created');

    at('2026-11-11T12:30:00Z');
    await ctx.tickAndRun();

    const files = await ctx.files('out');
    expect([...files.keys()]).toEqual(['report_2026-11-11T1000Z.csv', 'report_S-B.csv', 'report_S-C.csv']);
    expect(
      files
        .get('report_2026-11-11T1000Z.csv')!
        .slice(1)
        .map((l) => l.split(',')[0]),
    ).toEqual(['a1', 'b1']);
    expect(
      files
        .get('report_S-B.csv')!
        .slice(1)
        .map((l) => l.split(',')[0]),
    ).toEqual(['b2']);
    expect((await ctx.exportedIds('out')).sort()).toEqual(['a1', 'b1', 'b2', 'c1']); // each exactly once
  });

  it('per session -> hourly: open sessions keep their records from before the switch, hours take the rest', async () => {
    await ctx.workspace('ws', 't', hourlySpec({ grouping: PER_SESSION }));
    await ctx.records('ws', [
      { inspectedAt: '2026-11-11T10:30:00Z', sessionId: 'S-X', id: 'x1' }, // session crosses the switch
      { inspectedAt: '2026-11-11T11:15:00Z', sessionId: 'S-X', id: 'x2' },
      { inspectedAt: '2026-11-11T11:20:00Z', sessionId: 'S-Z', id: 'z1' }, // starts after the switch
    ]);

    at('2026-11-11T10:20:00Z');
    const v2 = await updateConfig(ctx.db, 'ws', hourlySpec({ grouping: HOURLY }), 'tester', ctx.clock.now());
    expect(v2.effectiveFrom?.toISOString()).toBe('2026-11-11T11:00:00.000Z');

    at('2026-11-11T11:30:00Z');
    expect(await complete('S-X')).toBe('partition-created');
    expect(await complete('S-Z')).toBe('ignored'); // belongs to the hourly files now

    at('2026-11-11T12:06:00Z');
    await ctx.tickAndRun();

    const files = await ctx.files('out');
    expect([...files.keys()]).toEqual(['report_2026-11-11T1100Z.csv', 'report_S-X.csv']);
    expect(
      files
        .get('report_S-X.csv')!
        .slice(1)
        .map((l) => l.split(',')[0]),
    ).toEqual(['x1']);
    expect((await ctx.exportedIds('out')).sort()).toEqual(['x1', 'x2', 'z1']); // no hourly file for 10:00, no gap
  });
});
