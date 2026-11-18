import { describe, expect, it } from 'vitest';
import { switchTime } from '../../src/modules/export-config/grouping-switch.js';
import { parseSpec } from '../../src/modules/export-config/spec.js';

const spec = (timezone: string, groupBy: string) =>
  parseSpec({
    name: 't',
    columns: [{ field: 'record_id' }],
    timezone,
    grouping:
      groupBy === 'session_id'
        ? { groupBy: [groupBy], closeWhen: { type: 'EVENT', event: 'session.completed' } }
        : { groupBy: [groupBy], closeWhen: { type: 'TIME' } },
  });

const now = new Date('2026-11-11T04:45:00Z');

describe('when a schedule change starts', () => {
  it('hourly -> per session: at the end of the current local hour', () => {
    expect(switchTime(spec('Asia/Kolkata', 'time_bucket(1h)'), spec('Asia/Kolkata', 'session_id'), now)).toEqual(
      new Date('2026-11-11T05:30:00Z'),
    );
  });

  it('per session -> hourly: at the start of the next local hour', () => {
    expect(switchTime(spec('UTC', 'session_id'), spec('Asia/Kolkata', 'time_bucket(1h)'), now)).toEqual(
      new Date('2026-11-11T05:30:00Z'),
    );
  });

  it('bucket size change: at the first boundary both share', () => {
    expect(switchTime(spec('UTC', 'time_bucket(1h)'), spec('UTC', 'time_bucket(6h)'), now)).toEqual(
      new Date('2026-11-11T06:00:00Z'),
    );
  });

  it('refuses windows that never line up', () => {
    expect(() => switchTime(spec('UTC', 'time_bucket(1h)'), spec('Asia/Kolkata', 'time_bucket(1h)'), now)).toThrow(
      /never line up/,
    );
  });
});
