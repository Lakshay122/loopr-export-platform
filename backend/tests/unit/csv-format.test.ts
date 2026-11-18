import { describe, expect, it } from 'vitest';
import { escapeCsvValue, formatRecord, headerLine } from '../../src/modules/csv/csv-format.js';
import { parseSpec } from '../../src/modules/export-config/spec.js';
import type { SourceRecord } from '../../src/modules/source/records.js';
import { hourlySpec } from '../helpers/context.js';

const record: SourceRecord = {
  record_id: 'r1',
  session_id: 'S-1',
  part_serial: 'SN-1',
  inspection_type: 'surface',
  result: 'FAIL',
  defect: null,
  image_ref: null,
  inspected_at: new Date('2026-11-11T04:45:10Z'),
  finalized_at: new Date('2026-11-11T04:45:20Z'),
  metadata: { operator: 'op-12', torque_nm: 12.4, ok: true, tags: ['a', 'b'] },
};

describe('CSV formatting', () => {
  it('renames headers, maps values, formats dates in the config timezone', () => {
    const spec = parseSpec(
      hourlySpec({
        columns: [
          { field: 'record_id', header: 'ID' },
          { field: 'result', header: 'Status', valueMap: { PASS: '1', FAIL: '0' } },
          { field: 'defect' },
          { field: 'inspected_at', header: 'When' },
        ],
        dateFormat: 'dd-MM-yyyy HH:mm:ss',
        timezone: 'Asia/Kolkata',
      }),
    );
    expect(headerLine(spec)).toBe('ID,Status,defect,When\n');
    expect(formatRecord(record, spec)).toEqual(['r1', '0', '', '11-11-2026 10:15:10']);
  });

  it('formats ISO dates in UTC by default', () => {
    const spec = parseSpec(hourlySpec());
    expect(formatRecord(record, spec)).toEqual(['r1', 'FAIL', '2026-11-11T04:45:10Z']);
  });

  it('quotes special characters and neutralises spreadsheet formulas', () => {
    expect(escapeCsvValue('plain')).toBe('plain');
    expect(escapeCsvValue('a,b')).toBe('"a,b"');
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvValue('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(escapeCsvValue('+1')).toBe("'+1");
    expect(escapeCsvValue('@SUM(A1)')).toBe("'@SUM(A1)");
    // Data that only looks risky stays as it is: negative numbers and a lone "-".
    expect(escapeCsvValue('-12.5')).toBe('-12.5');
    expect(escapeCsvValue('-')).toBe('-');
    expect(escapeCsvValue('-1+2')).toBe("'-1+2");
    expect(escapeCsvValue('-A1')).toBe("'-A1");
  });

  it('exports customer-specific metadata fields, with a value for records that lack them', () => {
    const spec = parseSpec(
      hourlySpec({
        columns: [
          { field: 'metadata.operator', header: 'Operator', valueMap: { 'op-12': 'Asha' } },
          { field: 'metadata.torque_nm', header: 'Torque' },
          { field: 'metadata.ok' },
          { field: 'metadata.tags' },
          { field: 'metadata.camera', header: 'Camera', whenMissing: 'n/a' },
          { field: 'defect', whenMissing: 'none' },
        ],
      }),
    );
    expect(headerLine(spec)).toBe('Operator,Torque,metadata.ok,metadata.tags,Camera,defect\n');
    expect(formatRecord(record, spec)).toEqual(['Asha', '12.4', 'true', '["a","b"]', 'n/a', 'none']);
  });

  it('writes a value that has no replacement unchanged (e.g. a new defect code that appears later)', () => {
    const spec = parseSpec(
      hourlySpec({ columns: [{ field: 'inspection_type', valueMap: { weld: 'WLD', corrosion: 'COR' } }] }),
    );
    expect(formatRecord(record, spec)).toEqual(['surface']);
    expect(formatRecord({ ...record, inspection_type: 'corrosion' }, spec)).toEqual(['COR']);
  });
});
