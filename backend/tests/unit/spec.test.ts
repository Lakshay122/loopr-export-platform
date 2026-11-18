import { describe, expect, it } from 'vitest';
import { ExportSpecSchema, groupingOf, parseSpec } from '../../src/modules/export-config/spec.js';
import { hourlySpec, sessionSpec } from '../helpers/context.js';

function issues(input: unknown): string[] {
  const result = ExportSpecSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe('export spec validation', () => {
  it('accepts the two demo shapes and fills defaults', () => {
    const hourly = parseSpec(hourlySpec());
    expect(hourly.dateFormat).toBe('ISO_UTC');
    expect(groupingOf(hourly)).toEqual({ kind: 'TIME', bucketMinutes: 60, graceSeconds: 300 });

    const session = parseSpec(sessionSpec());
    expect(groupingOf(session)).toEqual({ kind: 'SESSION', settleSeconds: 60 });
  });

  it('rejects unknown fields, keys and timezones', () => {
    expect(issues(hourlySpec({ columns: [{ field: 'password' as never }] }))).not.toEqual([]);
    expect(issues({ ...hourlySpec(), script: 'rm -rf /' })).not.toEqual([]);
    expect(issues(hourlySpec({ timezone: 'Mars/Base' }))).toContain('Unknown timezone "Mars/Base"');
  });

  it('accepts metadata columns and filters, but only with safe key names', () => {
    expect(
      issues(
        hourlySpec({
          columns: [{ field: 'record_id' }, { field: 'metadata.operator', whenMissing: 'n/a' }],
          filters: { metadata: { line: ['L1', 'L2'] } },
        }),
      ),
    ).toEqual([]);
    expect(issues(hourlySpec({ columns: [{ field: 'metadata.' }] }))).not.toEqual([]);
    expect(issues(hourlySpec({ columns: [{ field: "metadata.x'); drop table" }] }))).not.toEqual([]);
    expect(issues(hourlySpec({ filters: { metadata: { 'a b': ['x'] } } }))).not.toEqual([]);
    expect(
      issues(
        hourlySpec({
          columns: [
            { field: 'metadata.line', header: 'A' },
            { field: 'metadata.line', header: 'B' },
          ],
        }),
      ),
    ).toContain('"metadata.line" is already a column');
  });

  it('rejects duplicate headers and value maps on dates', () => {
    expect(
      issues(
        hourlySpec({
          columns: [
            { field: 'result', header: 'X' },
            { field: 'defect', header: 'X' },
          ],
        }),
      ),
    ).toContain('Duplicate column header "X"');
    expect(issues(hourlySpec({ columns: [{ field: 'inspected_at', valueMap: { a: 'b' } }] }))).toContain(
      'Use dateFormat for date fields',
    );
  });

  it('only allows supported grouping combinations', () => {
    const bad = (groupBy: string, closeWhen: object) =>
      issues(hourlySpec({ grouping: { groupBy: [groupBy], closeWhen } as never }));
    expect(bad('time_bucket(7m)', { type: 'TIME' })[0]).toMatch(/divide 24h/);
    expect(bad('time_bucket(1h)', { type: 'EVENT', event: 'session.completed' })[0]).toMatch(/must close on TIME/);
    expect(bad('session_id', { type: 'TIME' })[0]).toMatch(/session.completed/);
    expect(bad('part_serial', { type: 'TIME' })[0]).toMatch(/Unsupported groupBy/);
    expect(bad('time_bucket(15m)', { type: 'TIME' })).toEqual([]);
  });
});
