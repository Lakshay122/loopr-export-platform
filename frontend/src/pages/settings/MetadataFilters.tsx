import { useState } from 'react';
import type { MetadataKey } from '../../api/types';

type Row = { key: string; values: string };

const toRows = (value: Record<string, string[]> | undefined): Row[] =>
  Object.entries(value ?? {}).map(([key, values]) => ({ key, values: values.join(', ') }));

/**
 * Filters on customer-specific extra fields, e.g. "line is L1 or L2".
 * Values are typed as a comma-separated list; a row without a field or values is ignored.
 */
export function MetadataFilters({
  value,
  metadataKeys,
  onChange,
}: {
  value: Record<string, string[]> | undefined;
  metadataKeys: MetadataKey[];
  onChange: (value: Record<string, string[]> | undefined) => void;
}) {
  // Local rows, so half-typed values are not lost while typing.
  const [rows, setRows] = useState<Row[]>(() => toRows(value));

  const emit = (next: Row[]) => {
    setRows(next);
    const entries = next
      .map(
        ({ key, values }) =>
          [
            key,
            values
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean),
          ] as const,
      )
      .filter(([key, values]) => key && values.length > 0);
    onChange(entries.length ? Object.fromEntries(entries) : undefined);
  };
  const update = (i: number, patch: Partial<Row>) => emit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="field">
      <span className="field-label">Extra fields</span>
      {rows.length === 0 && (
        <span className="hint">No filter: records are included whatever their extra fields say.</span>
      )}
      {rows.map((row, i) => {
        const known = metadataKeys.find((m) => m.key === row.key);
        const options = metadataKeys.map((m) => m.key);
        if (row.key && !options.includes(row.key)) options.push(row.key);
        return (
          <div className="row filter-row" key={i}>
            <select value={row.key} onChange={(e) => update(i, { key: e.target.value })} aria-label="Extra field">
              <option value="">Choose a field…</option>
              {options
                .filter((k) => k === row.key || !rows.some((r) => r.key === k))
                .map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
            </select>
            <span className="small muted">is one of</span>
            <input
              className="grow"
              value={row.values}
              placeholder={known ? `e.g. ${known.example}` : 'value1, value2'}
              onChange={(e) => update(i, { values: e.target.value })}
              aria-label="Allowed values, separated by commas"
            />
            <button
              type="button"
              className="btn-icon"
              onClick={() => emit(rows.filter((_, j) => j !== i))}
              title="Remove"
            >
              ✕
            </button>
          </div>
        );
      })}
      {rows.length < 5 && (
        <button
          type="button"
          className="btn-link link-small left"
          onClick={() => setRows([...rows, { key: '', values: '' }])}
        >
          + Filter on an extra field
        </button>
      )}
    </div>
  );
}
