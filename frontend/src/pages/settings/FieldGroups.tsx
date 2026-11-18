import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { FieldGroup, MetadataKey, SampleRecord } from '../../api/types';
import { ErrorBox } from '../../components/ui';
import { formatTime } from '../../lib/format';
import { useWorkspace } from '../../workspace';
import { DATE_FIELDS, FIELDS, fieldLabel, isMetadataField, METADATA_KEY, metadataKeyOf } from './spec-model';

const UNGROUPED = '__ungrouped';
const newId = () => `g-${crypto.randomUUID().slice(0, 8)}`;

/** Used until the customer makes their own groups. Every metadata key starts in "Metadata". */
function defaultGroups(metadataFields: string[]): FieldGroup[] {
  return [
    { id: 'timestamps', name: 'Timestamps', fields: ['inspected_at', 'finalized_at'] },
    { id: 'results', name: 'Results', fields: ['result', 'inspection_type', 'defect'] },
    { id: 'image', name: 'Image reference', fields: ['image_ref'] },
    { id: 'identity', name: 'Identity', fields: ['record_id', 'session_id', 'part_serial'] },
    { id: 'metadata', name: 'Metadata', fields: metadataFields },
  ];
}

const show = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/**
 * All fields a record can have, in groups the customer makes themselves: create, rename and
 * delete groups, and drag any field into any group. Fields in no group (for example a field the
 * inspection app just started sending) appear under "New fields", so nothing is ever hidden.
 * The layout is saved on the server for the whole customer. It only organises this list:
 * the CSV columns and their order are set below.
 */
export function FieldGroups({
  sample,
  metadataKeys,
  usedFields,
  onAdd,
}: {
  sample: SampleRecord | null;
  metadataKeys: MetadataKey[];
  usedFields: Set<string>;
  onAdd: (field: string, header?: string) => void;
}) {
  const { ws } = useWorkspace();
  /** undefined = loading, null = the customer has not made their own groups yet. */
  const [saved, setSaved] = useState<FieldGroup[] | null | undefined>(undefined);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<unknown>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [focusGroup, setFocusGroup] = useState<string | null>(null);
  const pending = useRef<FieldGroup[] | null>(null);

  useEffect(() => {
    api.getFieldLayout(ws).then((layout) => setSaved(layout.groups), setError);
  }, [ws]);

  // Save half a second after the last change.
  useEffect(() => {
    if (status !== 'saving' || !pending.current) return;
    const groups = pending.current;
    const timer = setTimeout(async () => {
      try {
        await api.saveFieldLayout(ws, { groups });
        setStatus('saved');
        setError(null);
      } catch (err) {
        setError(err);
        setStatus('idle');
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [status, saved, ws]);

  // Every field we know of: standard ones, keys seen in recent records, keys of the sample,
  // and metadata columns already in the file (a field "added by name" before any record has it).
  const metadataFields = [
    ...new Set([
      ...metadataKeys.map((m) => `metadata.${m.key}`),
      ...Object.keys(sample?.metadata ?? {}).map((k) => `metadata.${k}`),
      ...[...usedFields].filter(isMetadataField),
    ]),
  ];
  const allFields = [...FIELDS.map((f) => f.value), ...metadataFields];
  const groups = saved ?? defaultGroups(metadataFields);
  const grouped = new Set(groups.flatMap((g) => g.fields));
  const ungrouped = allFields.filter((f) => !grouped.has(f));

  if (saved === undefined && !error) return <p className="muted small">Loading fields…</p>;

  const change = (next: FieldGroup[]) => {
    pending.current = next;
    setSaved(next);
    setStatus('saving');
  };

  /** Moves a field into a group (before `before`, or at the end). UNGROUPED takes it out of every group. */
  const moveField = (field: string, groupId: string, before?: string) => {
    const next = groups.map((g) => ({ ...g, fields: g.fields.filter((f) => f !== field) }));
    if (groupId !== UNGROUPED) {
      const target = next.find((g) => g.id === groupId)!;
      const at = before ? target.fields.indexOf(before) : -1;
      if (at >= 0) target.fields.splice(at, 0, field);
      else target.fields.push(field);
    }
    change(next);
  };

  const addGroup = () => {
    const id = newId();
    change([...groups, { id, name: 'New group', fields: [] }]);
    setFocusGroup(id);
  };
  const renameGroup = (id: string, name: string) => change(groups.map((g) => (g.id === id ? { ...g, name } : g)));
  const deleteGroup = (id: string) => change(groups.filter((g) => g.id !== id));

  const onDrop = (e: DragEvent, groupId: string, before?: string) => {
    e.preventDefault();
    e.stopPropagation();
    const field = e.dataTransfer.getData('text/plain');
    if (field && allFields.includes(field)) moveField(field, groupId, before);
    setDragging(null);
    setDropTarget(null);
  };
  const dropZone = (groupId: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      setDropTarget(groupId);
    },
    onDragLeave: () => setDropTarget((t) => (t === groupId ? null : t)),
    onDrop: (e: DragEvent) => onDrop(e, groupId),
  });

  const valueOf = (field: string): string => {
    if (isMetadataField(field)) {
      const key = metadataKeyOf(field);
      if (sample && key in (sample.metadata ?? {})) return show(sample.metadata[key]);
      const known = metadataKeys.find((m) => m.key === key);
      return known ? `not on this record · e.g. ${known.example}` : 'no records have it yet';
    }
    if (!sample) return '—';
    const raw = sample[field as keyof SampleRecord];
    return DATE_FIELDS.has(field) ? formatTime(String(raw)) : show(raw);
  };

  const item = (field: string, groupId: string, isNew = false) => (
    <div
      key={field}
      className={`field-item ${dragging === field ? 'dragging' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', field);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(field);
      }}
      onDragEnd={() => {
        setDragging(null);
        setDropTarget(null);
      }}
      onDragOver={(e) => dragging && e.preventDefault()}
      onDrop={(e) => onDrop(e, groupId, field)}
    >
      <span className="drag-handle" aria-hidden>
        ⠿
      </span>
      <div className="field-text">
        <span className="small">
          {fieldLabel(field)}
          {isNew && <span className="tag tag-inline">new</span>}
        </span>
        <span className="mono small muted field-value" title={valueOf(field)}>
          {valueOf(field)}
        </span>
      </div>
      <select
        className="move-select"
        value=""
        aria-label={`Move ${fieldLabel(field)} to a group`}
        title="Move to a group"
        onChange={(e) => e.target.value && moveField(field, e.target.value)}
      >
        <option value="">⋯</option>
        {groups
          .filter((g) => g.id !== groupId)
          .map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        {groupId !== UNGROUPED && <option value={UNGROUPED}>No group</option>}
      </select>
      {usedFields.has(field) ? (
        <span className="anatomy-in">✓ in file</span>
      ) : (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => onAdd(field, isMetadataField(field) ? metadataKeyOf(field) : undefined)}
        >
          + Add
        </button>
      )}
    </div>
  );

  return (
    <section className="anatomy">
      <div className="row spread">
        <div>
          <h3>What a record contains</h3>
          <p className="hint">
            {sample ? `Values from your newest record (session ${sample.session_id}). ` : ''}
            Make your own groups and drag any field into any group. Groups only organise this list; they do not change
            your file.
          </p>
        </div>
        <span className="hint nowrap">
          {status === 'saving'
            ? 'Saving…'
            : status === 'saved'
              ? '✓ Groups saved'
              : saved === null
                ? 'Default groups'
                : ''}
        </span>
      </div>
      <ErrorBox error={error} />

      {ungrouped.length > 0 && (
        <div className={`anatomy-group anatomy-new ${dropTarget === UNGROUPED ? 'drop' : ''}`} {...dropZone(UNGROUPED)}>
          <span className="anatomy-title">
            New fields <span className="hint">· not in a group yet. Drag them into a group.</span>
          </span>
          {ungrouped.map((f) => item(f, UNGROUPED, isMetadataField(f)))}
        </div>
      )}

      <div className="anatomy-grid">
        {groups.map((group) => (
          <div
            key={group.id}
            className={`anatomy-group ${dropTarget === group.id ? 'drop' : ''}`}
            {...dropZone(group.id)}
          >
            <div className="group-head">
              <input
                className="group-name"
                value={group.name}
                maxLength={40}
                aria-label="Group name"
                autoFocus={focusGroup === group.id}
                onFocus={(e) => focusGroup === group.id && e.target.select()}
                onChange={(e) => renameGroup(group.id, e.target.value)}
                onBlur={(e) => !e.target.value.trim() && renameGroup(group.id, 'Unnamed group')}
              />
              <button
                type="button"
                className="btn-icon"
                title={group.fields.length ? 'Delete group (its fields move to “New fields”)' : 'Delete group'}
                onClick={() => deleteGroup(group.id)}
              >
                ✕
              </button>
            </div>
            {group.fields.filter((f) => allFields.includes(f)).map((f) => item(f, group.id))}
            {group.fields.length === 0 && <span className="hint drop-hint">Drop fields here</span>}
          </div>
        ))}
      </div>

      <div className="row spread">
        <div className="row">
          <button type="button" className="btn btn-small" onClick={addGroup} disabled={groups.length >= 20}>
            + New group
          </button>
          {saved !== null && (
            <button type="button" className="btn-link link-small" onClick={() => change(defaultGroups(metadataFields))}>
              Reset to default groups
            </button>
          )}
        </div>
        <AddByName used={new Set(allFields)} onAdd={(key) => onAdd(`metadata.${key}`, key)} />
      </div>
    </section>
  );
}

/** For a field the inspection app will send later: adds it to the file now. */
function AddByName({ used, onAdd }: { used: Set<string>; onAdd: (key: string) => void }) {
  const [key, setKey] = useState('');
  const valid = METADATA_KEY.test(key) && !used.has(`metadata.${key}`);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onAdd(key);
    setKey('');
  };
  return (
    <div className="row" title="For a field your inspection app will send later. Letters, numbers and _ only.">
      <input
        className="mono input-short"
        value={key}
        placeholder="new_field_name"
        maxLength={40}
        aria-label="Extra field name"
        onChange={(e) => setKey(e.target.value.trim())}
        onKeyDown={(e) => e.key === 'Enter' && submit(e)}
      />
      <button type="button" className="btn btn-small" disabled={!valid} onClick={submit}>
        + Add field by name
      </button>
    </div>
  );
}
