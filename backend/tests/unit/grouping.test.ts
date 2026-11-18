import { describe, expect, it } from 'vitest';
import { nextWindow, partitionFileName, windowContaining } from '../../src/modules/grouping/grouping.js';
import { backoffMs } from '../../src/modules/jobs/task-state.js';

describe('time buckets', () => {
  it('uses local wall-clock hours (Asia/Kolkata hours start at :30 UTC)', () => {
    const w = windowContaining(new Date('2026-11-11T04:45:00Z'), 60, 'Asia/Kolkata');
    expect(w.start.toISOString()).toBe('2026-11-11T04:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-11-11T05:30:00.000Z');
    expect(w.key).toBe('2026-11-11T10:00+05:30');
  });

  it('produces back-to-back windows with no gap or overlap', () => {
    const first = windowContaining(new Date('2026-11-11T23:50:00Z'), 15, 'UTC');
    const second = nextWindow(first, 15, 'UTC');
    expect(second.start.getTime()).toBe(first.end.getTime());
    expect(second.key).toBe('2026-11-12T00:00Z');
  });
});

describe('file names', () => {
  it('are deterministic and mark corrections', () => {
    expect(partitionFileName('2026-11-11T10:00+05:30', 0)).toBe('report_2026-11-11T1000+0530.csv');
    expect(partitionFileName('S-102', 1)).toBe('report_S-102_correction_01.csv');
  });
});

describe('retry backoff', () => {
  it('grows exponentially with jitter and a cap', () => {
    for (let i = 0; i < 50; i++) {
      expect(backoffMs(1, 1000)).toBeGreaterThanOrEqual(750);
      expect(backoffMs(1, 1000)).toBeLessThanOrEqual(1250);
      expect(backoffMs(3, 1000)).toBeGreaterThanOrEqual(3000);
      expect(backoffMs(30, 1000)).toBeLessThanOrEqual(375_000);
    }
  });
});
