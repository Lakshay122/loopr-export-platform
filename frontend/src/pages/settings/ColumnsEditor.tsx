import { Fragment, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { MetadataKey, SampleRecord } from '../../api/types';
import { FieldGroups } from './FieldGroups';
import { type Column, DATE_FIELDS, fieldLabel, isMetadataField, metadataKeyOf, RESULTS } from './spec-model';

/**
 * Top: every field a record can have, in the customer's own groups, each with "+ Add".
 * Below: the columns of the file, in order. Type the column name your system expects and
 * drag the handle (⠿) to change the order.
 */
export function ColumnsEditor({
  columns,
  metadataKeys,
  fieldValues,
  sample,
  onChange,
}: {
  columns: Column[];
  metadataKeys: MetadataKey[];
  /** The newest record, shown so the customer sees everything a record contains. */
  sample: SampleRecord | null;
  /** Values that really occur per field (null = too many to list). */
  fieldValues: Record<string, string[] | null>;
  onChange: (columns: Column[]) => void;
}) {
  const used = new Set(columns.map((c) => c.field));
  /** The field being dragged. Rows reorder live while it moves over them. */
  const [dragging, setDragging] = useState<string | null>(null);

  const update = (index: number, patch: Partial<Column>) =>
    onChange(columns.map((c, i) => (i === index ? clean({ ...c, ...patch }) : c)));
  const remove = (index: number) => onChange(columns.filter((_, i) => i !== index));
  const moveTo = (from: number, to: number) => {
    if (from === to || to < 0 || to >= columns.length) return;
    const next = [...columns];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };

  const dragOver = (e: DragEvent, index: number) => {
    if (!dragging) return;
    e.preventDefault();
    const from = columns.findIndex((c) => c.field === dragging);
    if (from !== index) moveTo(from, index);
  };

  return (
    <div className="stack-sm">
      <FieldGroups
        sample={sample}
        metadataKeys={metadataKeys}
        usedFields={used}
        // An extra field's column is named after its key ("batch"), not "metadata.batch".
        onAdd={(field, header) => onChange([...columns, header ? { field, header } : { field }])}
      />
      <h3 className="top-gap">Columns in your file, in this order</h3>
      <div className="col-list">
        <div className="col-head">
          <span />
          <span />
          <span>Data</span>
          <span>Column name in your file</span>
        </div>
        {columns.map((column, i) => (
          <ColumnRow
            key={column.field}
            position={i + 1}
            column={column}
            knownValues={fieldValues[column.field]}
            canRemove={columns.length > 1}
            isDragging={dragging === column.field}
            onRemove={() => remove(i)}
            onChange={(patch) => update(i, patch)}
            onDragStart={() => setDragging(column.field)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => dragOver(e, i)}
            onMove={(by) => moveTo(i, i + by)}
          />
        ))}
      </div>
      <span className="hint">Drag ⠿ to change the order. Untick a column to remove it from the file.</span>
    </div>
  );
}

/** Ids and serial numbers: replacing values makes no sense, and they are never empty. */
const NO_VALUE_OPTIONS = new Set(['record_id', 'part_serial', 'session_id']);
/** Can be empty, but replacing values makes no sense. */
const ONLY_WHEN_EMPTY = new Set(['image_ref']);

function ColumnRow({
  position,
  column,
  knownValues,
  canRemove,
  isDragging,
  onRemove,
  onChange,
  onDragStart,
  onDragEnd,
  onDragOver,
  onMove,
}: {
  position: number;
  column: Column;
  knownValues: string[] | null | undefined;
  canRemove: boolean;
  isDragging: boolean;
  onRemove: () => void;
  onChange: (patch: Partial<Column>) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onMove: (by: -1 | 1) => void;
}) {
  const renames = Object.keys(column.valueMap ?? {}).length;
  const [showValues, setShowValues] = useState(false);
  const extra = isMetadataField(column.field);
  const isDate = DATE_FIELDS.has(column.field);
  const onlyWhenEmpty = ONLY_WHEN_EMPTY.has(column.field);
  const hasOptions = !isDate && !NO_VALUE_OPTIONS.has(column.field);
  const summary =
    [
      renames ? `${renames} value${renames > 1 ? 's' : ''} changed` : '',
      column.whenMissing ? `empty → “${column.whenMissing}”` : '',
    ]
      .filter(Boolean)
      .join(' · ') || (onlyWhenEmpty ? 'If empty' : 'Change values');
  const rowRef = useRef<HTMLDivElement>(null);

  const startDrag = (e: DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', column.field);
    if (rowRef.current) e.dataTransfer.setDragImage(rowRef.current, 20, 20);
    onDragStart();
  };

  // Keyboard users: focus the handle and press the arrow keys.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      onMove(e.key === 'ArrowUp' ? -1 : 1);
    }
  };

  return (
    <div
      ref={rowRef}
      className={isDragging ? 'col-item dragging' : 'col-item'}
      onDragOver={onDragOver}
      onDrop={(e) => e.preventDefault()}
    >
      <div className="col-row">
        <span
          className="drag-handle"
          draggable
          tabIndex={0}
          role="button"
          aria-label={`Move ${fieldLabel(column.field)}. Drag, or use the arrow keys.`}
          title="Drag to reorder"
          onDragStart={startDrag}
          onDragEnd={onDragEnd}
          onKeyDown={onKey}
        >
          ⠿
        </span>
        <input
          type="checkbox"
          checked
          disabled={!canRemove}
          title={canRemove ? 'Remove from the file' : 'A file needs at least one column'}
          onChange={onRemove}
        />
        <span className="col-data">
          <span>
            <span className="muted">{position}.</span> {fieldLabel(column.field)}
            {extra && <span className="tag tag-inline">Extra field</span>}
          </span>
          {isDate && <span className="hint">Uses the date format from “Dates”</span>}
          {hasOptions && (
            <button type="button" className="btn-link link-small" onClick={() => setShowValues(!showValues)}>
              {summary} {showValues ? '▴' : '▾'}
            </button>
          )}
        </span>
        <input
          value={column.header ?? ''}
          placeholder={extra ? metadataKeyOf(column.field) : column.field}
          maxLength={64}
          aria-label={`Column name for ${fieldLabel(column.field)}`}
          onChange={(e) => onChange({ header: e.target.value })}
        />
      </div>
      {showValues && hasOptions && (
        <div className="col-values stack">
          {!onlyWhenEmpty && (
            <ValueRenames
              field={column.field}
              known={column.field === 'result' ? RESULTS : knownValues}
              value={column.valueMap ?? {}}
              onChange={(valueMap) => onChange({ valueMap })}
            />
          )}
          <label className="rename-fixed">
            <span className="small">If a record has no value, write</span>
            <input
              className="input-short"
              value={column.whenMissing ?? ''}
              placeholder="nothing (empty)"
              maxLength={64}
              onChange={(e) => onChange({ whenMissing: e.target.value || undefined })}
            />
          </label>
        </div>
      )}
    </div>
  );
}

/** Drops empty header / empty value map so the saved spec stays tidy. */
function clean(column: Column): Column {
  const result: Column = { field: column.field };
  if (column.header?.trim()) result.header = column.header;
  if (column.valueMap && Object.keys(column.valueMap).length > 0) result.valueMap = column.valueMap;
  if (column.whenMissing) result.whenMissing = column.whenMissing;
  return result;
}

/**
 * "Change values": when we know the values this field really has (e.g. surface, weld), each one
 * gets a box: type the word your system expects. Fields with too many different values (or no
 * data yet) use free "value → new value" pairs instead.
 */
function ValueRenames({
  field,
  known,
  value,
  onChange,
}: {
  field: string;
  known: readonly string[] | null | undefined;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  if (!known || known.length === 0) {
    return (
      <PairsEditor
        value={value}
        onChange={onChange}
        hint={
          known === null
            ? 'This field has many different values. Type a value to replace and what to write instead.'
            : `No ${fieldLabel(field)} values in your records yet. Type a value to replace and what to write instead.`
        }
      />
    );
  }
  return <KnownValueRenames known={known} value={value} onChange={onChange} />;
}

function KnownValueRenames({
  known,
  value,
  onChange,
}: {
  known: readonly string[];
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  // Values the customer added because they expect them later (not in their data yet).
  const [added, setAdded] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const isNew = (v: string) => !known.includes(v);
  // Known values, then values already replaced but not seen recently, then newly added ones.
  const values = [...new Set([...known, ...Object.keys(value), ...added])];

  const set = (from: string, to: string) => {
    const next = { ...value, [from]: to };
    if (!to) delete next[from];
    onChange(next);
  };
  const remove = (v: string) => {
    setAdded(added.filter((a) => a !== v));
    const next = { ...value };
    delete next[v];
    onChange(next);
  };
  const addDraft = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) return;
    setAdded([...added, v]);
    setDraft('');
  };

  return (
    <div className="renames">
      <div className="value-table">
        <span className="value-head">In your data</span>
        <span />
        <span className="value-head">Write in the file</span>
        <span />
        {values.map((v) => (
          <Fragment key={v}>
            <span className="value-from-cell">
              <span className="mono small value-from">{v}</span>
              {isNew(v) && <span className="hint">not seen yet</span>}
            </span>
            <span className="muted">→</span>
            <input
              value={value[v] ?? ''}
              placeholder={`${v} (unchanged)`}
              maxLength={256}
              onChange={(e) => set(v, e.target.value)}
            />
            {isNew(v) ? (
              <button type="button" className="btn-icon" onClick={() => remove(v)} title="Remove">
                ✕
              </button>
            ) : (
              <span />
            )}
          </Fragment>
        ))}
      </div>
      <div className="row">
        <input
          className="mono input-short"
          value={draft}
          placeholder="e.g. corrosion"
          maxLength={64}
          aria-label="A value that is not in your data yet"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addDraft();
            }
          }}
        />
        <button type="button" className="btn btn-small" disabled={!draft.trim()} onClick={addDraft}>
          + Add a value not in your data yet
        </button>
      </div>
      <span className="hint">
        Leave a box empty to keep the value as it is. A value that is not in this list is written unchanged.
      </span>
    </div>
  );
}

function PairsEditor({
  value,
  hint,
  onChange,
}: {
  value: Record<string, string>;
  hint: string;
  onChange: (value: Record<string, string>) => void;
}) {
  // Local rows, so a half-typed pair (empty "from") is not lost while typing.
  const [rows, setRows] = useState<[string, string][]>(() => {
    const entries = Object.entries(value);
    return entries.length ? entries : [['', '']];
  });
  const emit = (next: [string, string][]) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter(([from]) => from.trim() !== '')));
  };

  return (
    <div className="renames">
      <span className="hint">{hint}</span>
      {rows.map(([from, to], i) => (
        <div className="row" key={i}>
          <input
            value={from}
            placeholder="Value in your data"
            maxLength={64}
            onChange={(e) => emit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
          />
          <span>→</span>
          <input
            value={to}
            placeholder="Write instead"
            maxLength={256}
            onChange={(e) => emit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
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
      ))}
      <button type="button" className="btn-link link-small left" onClick={() => setRows([...rows, ['', '']])}>
        + Add another
      </button>
    </div>
  );
}
