import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleSessionCompleted } from '../../src/modules/events/session-events.js';
import { sessionSpec, TestContext } from '../helpers/context.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await TestContext.create();
  await ctx.workspace('ws2', 't2', sessionSpec({ filters: { results: ['FAIL', 'REVIEW'] } }));
});
afterEach(async () => {
  await ctx.close();
});

const complete = (sessionId: string, eventId: string) =>
  handleSessionCompleted(
    ctx.db,
    { eventId, type: 'session.completed', workspaceId: 'ws2', sessionId, occurredAt: ctx.clock.now() },
    ctx.clock,
  );

describe('per-session export (EVENT grouping)', () => {
  it('exports a session once it completes and the settle delay has passed', async () => {
    await ctx.records('ws2', [
      { inspectedAt: '2026-11-11T09:50:00Z', sessionId: 'S-102', result: 'FAIL', id: 'f1' },
      { inspectedAt: '2026-11-11T09:51:00Z', sessionId: 'S-102', result: 'PASS' },
      { inspectedAt: '2026-11-11T09:52:00Z', sessionId: 'S-102', result: 'REVIEW', id: 'v1' },
      { inspectedAt: '2026-11-11T09:53:00Z', sessionId: 'S-200', result: 'FAIL' },
    ]);

    expect(await complete('S-102', 'evt-1')).toBe('partition-created');
    await ctx.tickAndRun();
    expect(await ctx.jobs()).toEqual([]); // still settling (60s)

    ctx.clock.advance(61_000);
    await ctx.tickAndRun();

    const files = await ctx.files('sessions');
    expect([...files.keys()]).toEqual(['report_S-102.csv']);
    expect(files.get('report_S-102.csv')).toEqual(['record_id,session_id,result', 'f1,S-102,FAIL', 'v1,S-102,REVIEW']);
  });

  it('ignores duplicate and replayed completion events', async () => {
    await ctx.records('ws2', [{ inspectedAt: '2026-11-11T09:50:00Z', sessionId: 'S-1', result: 'FAIL' }]);
    expect(await complete('S-1', 'evt-1')).toBe('partition-created');
    expect(await complete('S-1', 'evt-1')).toBe('duplicate-event'); // same event delivered twice
    expect(await complete('S-1', 'evt-2')).toBe('already-closed'); // a second, different event for the same session

    ctx.clock.advance(61_000);
    await Promise.all([ctx.scheduler.tick(), ctx.scheduler.tick()]);
    await ctx.pump();
    expect(await ctx.jobs()).toHaveLength(1);
  });

  it('sends records that finalize after the cutoff as a correction for the session', async () => {
    await ctx.records('ws2', [
      { inspectedAt: '2026-11-11T09:50:00Z', sessionId: 'S-1', result: 'FAIL', id: 'early' },
      // Inspected during the session, but finalized (e.g. after review) long after it closed.
      { inspectedAt: '2026-11-11T09:55:00Z', sessionId: 'S-1', result: 'REVIEW', finalizedAt: null, id: 'slow' },
    ]);
    await complete('S-1', 'evt-1');
    ctx.clock.advance(61_000);
    await ctx.tickAndRun();

    ctx.clock.advance(5_000);
    await ctx.db.query(`UPDATE inspection_record SET finalized_at = $1 WHERE id = 'slow'`, [ctx.clock.now()]);
    ctx.clock.advance(1_000);
    await ctx.tickAndRun();

    const files = await ctx.files('sessions');
    expect(files.get('report_S-1.csv')!.slice(1)).toEqual(['early,S-1,FAIL']);
    expect(files.get('report_S-1_correction_01.csv')!.slice(1)).toEqual(['slow,S-1,REVIEW']);
  });

  it('ignores session events for workspaces that use time grouping', async () => {
    await ctx.workspace('ws-hourly', 't2');
    await ctx.records('ws-hourly', [{ inspectedAt: '2026-11-11T09:50:00Z', sessionId: 'H-1' }]);
    const outcome = await handleSessionCompleted(
      ctx.db,
      {
        eventId: 'evt-x',
        type: 'session.completed',
        workspaceId: 'ws-hourly',
        sessionId: 'H-1',
        occurredAt: ctx.clock.now(),
      },
      ctx.clock,
    );
    expect(outcome).toBe('ignored');
  });
});
