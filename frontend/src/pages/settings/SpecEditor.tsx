import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../../api/client';
import type { ExportConfig, MetadataKey, Preview, SampleRecord } from '../../api/types';
import { ErrorBox } from '../../components/ui';
import { formatTime } from '../../lib/format';
import { useWorkspace } from '../../workspace';
import { ColumnsEditor } from './ColumnsEditor';
import { MetadataFilters } from './MetadataFilters';
import {
  BUCKETS,
  DATE_FORMATS,
  describePath,
  describeSchedule,
  INSPECTION_TYPES,
  normalize,
  RESULTS,
  timezones,
  type Spec,
} from './spec-model';

type Issue = { path: (string | number)[]; message: string };
type TabId = 'columns' | 'rows' | 'dates' | 'schedule' | 'delivery';

const TABS: { id: TabId; label: string; fields: string[] }[] = [
  { id: 'columns', label: 'Columns', fields: ['columns'] },
  { id: 'rows', label: 'Which records', fields: ['filters'] },
  { id: 'dates', label: 'Dates', fields: ['dateFormat', 'timezone'] },
  { id: 'schedule', label: 'Grouping & schedule', fields: ['grouping', 'correction'] },
  { id: 'delivery', label: 'Delivery', fields: ['name', 'delivery', 'chunkSize'] },
];

/** Waiting times offered in the "Schedule" tab, in seconds. */
const WAIT_OPTIONS = [0, 30, 60, 120, 300, 600, 900, 1800, 3600];
/** How long late records still get an extra file, in hours. */
const LATE_OPTIONS = [24, 48, 72, 168, 336, 720];

/**
 * The export settings as a simple tabbed form. Every change re-runs the preview on the server,
 * which also validates the settings, so the customer sees the effect (or the problem) right away.
 */
export function SpecEditor() {
  const { ws } = useWorkspace();
  const [config, setConfig] = useState<ExportConfig | null>(null);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [tab, setTab] = useState<TabId>('columns');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [metadataKeys, setMetadataKeys] = useState<MetadataKey[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, string[] | null>>({});
  const [sample, setSample] = useState<SampleRecord | null>(null);
  /** Bumped on every (re)load, so editors with local state start fresh after "Discard". */
  const [loads, setLoads] = useState(0);

  const load = async (version?: number) => {
    setError(null);
    setMessage('');
    try {
      const loaded = await api.getConfig(ws, version);
      setConfig(loaded);
      setSpec(normalize(loaded.spec));
      setLoads((n) => n + 1);
    } catch (err) {
      setError(err);
    }
  };

  useEffect(() => {
    void load();
    api.getFields(ws).then((f) => {
      setMetadataKeys(f.metadata);
      setFieldValues(f.values);
      setSample(f.sample);
    }, setError);
    // Runs once: the parent remounts this component (via `key`) when the workspace changes.
  }, []);

  // Live preview, half a second after the last change.
  useEffect(() => {
    if (!spec) return;
    const timer = setTimeout(async () => {
      try {
        setPreview(await api.preview(ws, spec));
        setIssues([]);
      } catch (err) {
        if (err instanceof ApiError && err.status === 400)
          setIssues(err.issues.length ? err.issues : [{ path: [], message: err.message }]);
        else setError(err);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [spec, ws]);

  const dirty = useMemo(
    () => !!config && !!spec && JSON.stringify(normalize(config.spec)) !== JSON.stringify(spec),
    [config, spec],
  );

  if (error && !spec) return <ErrorBox error={error} />;
  if (!config || !spec) return <p className="muted">Loading settings…</p>;

  const set = (patch: Partial<Spec>) => {
    setMessage('');
    setSpec({ ...spec, ...patch });
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const saved = await api.saveConfig(ws, spec);
      setConfig(saved);
      setSpec(normalize(saved.spec));
      setMessage(
        saved.effectiveFrom
          ? `Saved. The new schedule starts ${formatTime(saved.effectiveFrom)}. Until then, files are sent the old way.`
          : 'Saved. The next files use these settings. Files already sent are not changed.',
      );
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) setIssues(err.issues);
      else setError(err);
    } finally {
      setSaving(false);
    }
  };

  const viewingOld = config.version !== config.currentVersion;
  const saved = normalize(config.spec);
  const pendingSince =
    config.groupingSince && new Date(config.groupingSince) > new Date() ? config.groupingSince : null;
  const close = spec.grouping.closeWhen;
  const tabHasIssue = (id: TabId) => {
    const fields = TABS.find((t) => t.id === id)!.fields;
    return issues.some((issue) => fields.includes(String(issue.path[0])));
  };

  return (
    <div className="stack">
      <div className="row spread">
        <p className="muted small">
          Version {config.version} · last saved {formatTime(config.createdAt)} by {config.createdBy}
        </p>
        <label className="inline-label">
          <span className="small muted">History</span>
          <select value={config.version} onChange={(e) => void load(Number(e.target.value))}>
            {Array.from({ length: config.currentVersion }, (_, i) => config.currentVersion - i).map((v) => (
              <option key={v} value={v}>
                Version {v}
                {v === config.currentVersion ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      {viewingOld && (
        <div className="notice notice-warn">
          You are looking at an old version. Saving makes it the current settings again.
        </div>
      )}

      <div className="settings-layout">
        <div className="panel panel-flush">
          <div className="settings-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? 'active' : ''}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {tabHasIssue(t.id) && <span className="tab-alert" title="Needs a fix" />}
              </button>
            ))}
          </div>

          <div className="settings-body">
            {tab === 'columns' && (
              <Section
                title="What goes into the file"
                hint="Tick the data you need and type the column name your system expects."
              >
                <ColumnsEditor
                  key={loads}
                  columns={spec.columns}
                  metadataKeys={metadataKeys}
                  fieldValues={fieldValues}
                  sample={sample}
                  onChange={(columns) => set({ columns })}
                />
              </Section>
            )}

            {tab === 'rows' && (
              <Section title="Which records to include" hint="Pick “All” to send everything.">
                <PillChoice
                  label="Result"
                  options={RESULTS}
                  value={spec.filters.results}
                  onChange={(results) => set({ filters: { ...spec.filters, results } })}
                />
                <PillChoice
                  label="Inspection type"
                  options={INSPECTION_TYPES}
                  value={spec.filters.inspectionTypes}
                  onChange={(inspectionTypes) => set({ filters: { ...spec.filters, inspectionTypes } })}
                />
                <MetadataFilters
                  key={loads}
                  value={spec.filters.metadata}
                  metadataKeys={metadataKeys}
                  onChange={(metadata) => set({ filters: { ...spec.filters, metadata } })}
                />
              </Section>
            )}

            {tab === 'dates' && (
              <Section title="How dates look" hint="Choose the format your system reads.">
                <div className="radio-list">
                  {DATE_FORMATS.map((f) => (
                    <label key={f.value} className={`radio-card ${spec.dateFormat === f.value ? 'selected' : ''}`}>
                      <input
                        type="radio"
                        name="dateFormat"
                        checked={spec.dateFormat === f.value}
                        onChange={() => set({ dateFormat: f.value })}
                      />
                      <span className="grow">{f.label}</span>
                      <span className="mono small muted">{f.example}</span>
                    </label>
                  ))}
                </div>
                <label>
                  Timezone
                  <select value={spec.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                    {timezones(spec.timezone).map((z) => (
                      <option key={z}>{z}</option>
                    ))}
                  </select>
                  {close.type === 'TIME' && (
                    <span className="hint">
                      Your scheduled files are cut in this timezone. A change starts at the next hour that lines up.
                    </span>
                  )}
                </label>
              </Section>
            )}

            {tab === 'schedule' && (
              <>
                <Section
                  title="Group records into files"
                  hint="Choose how records are grouped. Each group becomes one CSV file."
                >
                  {pendingSince && (
                    <div className="notice notice-info small">
                      <strong>Schedule change planned for {formatTime(pendingSince)}.</strong> Until then, files are
                      sent the old way. You can make another schedule change after it starts.
                    </div>
                  )}
                  <ScheduleChoice
                    spec={spec}
                    saved={saved}
                    changeAt={issues.length ? null : (preview?.groupingChangeAt ?? null)}
                    onChange={(grouping) => set({ grouping })}
                  />
                  <DurationSelect
                    label={
                      close.type === 'TIME' ? 'Wait after each period ends' : 'Wait after the session is completed'
                    }
                    hint="Gives slow uploads time to arrive, so they are in the main file."
                    value={close.type === 'TIME' ? close.graceSeconds : close.settleSeconds}
                    options={WAIT_OPTIONS}
                    format={formatWait}
                    onChange={(seconds) =>
                      set({
                        grouping: {
                          ...spec.grouping,
                          closeWhen:
                            close.type === 'TIME'
                              ? { type: 'TIME', graceSeconds: seconds }
                              : { type: 'EVENT', event: 'session.completed', settleSeconds: seconds },
                        },
                      })
                    }
                  />
                </Section>
                <Section title="Records that arrive late">
                  <DurationSelect
                    label="Send an extra file for late records for up to"
                    hint="Records arriving after their file was sent go into a small extra file. Earlier files never change."
                    value={spec.correction.lookbackHours}
                    options={LATE_OPTIONS}
                    format={formatHours}
                    onChange={(lookbackHours) => set({ correction: { lookbackHours } })}
                  />
                </Section>
              </>
            )}

            {tab === 'delivery' && (
              <Section title="Name and delivery">
                <label>
                  Report name
                  <input value={spec.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} />
                  <span className="hint">Shown on the overview page.</span>
                </label>
                <label>
                  Folder
                  <input
                    value={spec.delivery.folder ?? ''}
                    placeholder="default"
                    onChange={(e) => set({ delivery: { type: 'local_folder', folder: e.target.value || undefined } })}
                  />
                  <span className="hint">Where files are dropped. In this demo it is a local folder.</span>
                </label>
                <details className="advanced">
                  <summary>Advanced (for engineers)</summary>
                  <div className="stack-sm top-gap">
                    <label>
                      Records per part
                      <input
                        type="number"
                        className="number"
                        value={spec.chunkSize}
                        min={10}
                        max={50_000}
                        onChange={(e) =>
                          set({ chunkSize: e.target.value === '' ? 10 : Math.trunc(Number(e.target.value)) })
                        }
                      />
                      <span className="hint">Big exports are split into parts that run in parallel.</span>
                    </label>
                    <span className="hint">The settings as stored (read only):</span>
                    <pre className="csv">{JSON.stringify(spec, null, 2)}</pre>
                  </div>
                </details>
              </Section>
            )}
          </div>
        </div>

        <aside className="preview-panel">
          <div className="panel stack-sm">
            <h2>Preview of your file</h2>
            <p className="small muted">{describeSchedule(spec)}</p>

            {issues.length > 0 ? (
              <div className="notice notice-bad">
                <strong>Please fix before saving:</strong>
                <ul>
                  {issues.map((issue, i) => (
                    <li key={i}>
                      <strong>{describePath(issue.path, spec)}:</strong> {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : preview ? (
              <>
                <div className="table-scroll">
                  <table className="preview-table">
                    <thead>
                      <tr>
                        {preview.headers.map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, i) => (
                        <tr key={i}>
                          {row.map((cell, j) => (
                            <td key={j}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                      {preview.rows.length === 0 && (
                        <tr>
                          <td colSpan={preview.headers.length} className="empty">
                            No records match these settings.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="hint">Your {preview.rows.length} newest records. Updates as you change settings.</p>
              </>
            ) : (
              <p className="muted small">Loading preview…</p>
            )}
            <ErrorBox error={error} />
          </div>
        </aside>
      </div>

      {(dirty || viewingOld) && (
        <div className="save-bar">
          <span>
            {issues.length > 0
              ? 'Fix the problems shown in the preview to save.'
              : preview?.groupingChangeAt
                ? `You have unsaved changes. The new schedule would start ${formatTime(preview.groupingChangeAt)}.`
                : 'You have unsaved changes.'}
          </span>
          <div className="row">
            <button className="btn-link" onClick={() => void load()}>
              Discard
            </button>
            <button className="btn btn-primary" onClick={save} disabled={issues.length > 0 || saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
      {message && !dirty && <div className="save-bar save-bar-done">✓ {message}</div>}
    </div>
  );
}

const DEFAULT_GROUPING: Record<'TIME' | 'EVENT', Spec['grouping']> = {
  TIME: { groupBy: ['time_bucket(1h)'], closeWhen: { type: 'TIME', graceSeconds: 300 } },
  EVENT: { groupBy: ['session_id'], closeWhen: { type: 'EVENT', event: 'session.completed', settleSeconds: 60 } },
};

/**
 * The two ways to send files. A change does not start right away: the server plans it for the
 * next clean boundary (e.g. the next full hour) so no record is sent twice or missed.
 */
function ScheduleChoice({
  spec,
  saved,
  changeAt,
  onChange,
}: {
  spec: Spec;
  saved: Spec;
  changeAt: string | null;
  onChange: (grouping: Spec['grouping']) => void;
}) {
  const selected = spec.grouping.closeWhen.type;
  const savedType = saved.grouping.closeWhen.type;
  const bucketLabel = (s: Spec) => BUCKETS.find((b) => b.value === s.grouping.groupBy[0])?.label ?? 'Every hour';

  const pick = (type: 'TIME' | 'EVENT') => {
    if (type === selected) return;
    onChange(type === savedType ? saved.grouping : DEFAULT_GROUPING[type]);
  };

  const options = [
    {
      type: 'TIME' as const,
      title: 'Group by time',
      text:
        selected === 'TIME'
          ? `${bucketLabel(spec)}, in ${spec.timezone} time.`
          : 'One file per time window, e.g. every hour or once a day.',
      example: 'e.g. report_09:00–10:00.csv',
    },
    {
      type: 'EVENT' as const,
      title: 'Group by inspection session',
      text: 'One file per session, sent as soon as the session is completed.',
      example: 'e.g. report_GLX-S-3.csv',
    },
  ];
  const oldWay = savedType === 'TIME' ? `${bucketLabel(saved).toLowerCase()} files` : 'one file per session';

  return (
    <div className="stack-sm">
      <div className="choice-grid" role="radiogroup" aria-label="Group records into files">
        {options.map((o) => (
          <button
            type="button"
            key={o.type}
            role="radio"
            aria-checked={selected === o.type}
            className={`choice-card ${selected === o.type ? 'selected' : ''}`}
            onClick={() => pick(o.type)}
          >
            <span className="row spread">
              <strong>{o.title}</strong>
              {savedType === o.type && <span className="tag">Current</span>}
            </span>
            <span className="small">{o.text}</span>
            <span className="hint">{o.example}</span>
          </button>
        ))}
      </div>

      {selected === 'TIME' && (
        <label>
          Time window (how often a file is sent)
          <select
            className="select-auto"
            value={spec.grouping.groupBy[0]}
            onChange={(e) => onChange({ ...spec.grouping, groupBy: [e.target.value] })}
          >
            {BUCKETS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {changeAt && (
        <div className="notice notice-info small">
          <strong>This change starts {formatTime(changeAt)}.</strong>
          <p>
            Until then you keep getting {oldWay}. A session that is still running at that moment is split there, so
            every record is sent exactly once. Files already sent never change.
          </p>
        </div>
      )}
    </div>
  );
}

function formatWait(seconds: number): string {
  if (seconds === 0) return 'Do not wait';
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} minute${seconds === 60 ? '' : 's'}`;
  return `${Math.round(seconds / 3600)} hour${seconds === 3600 ? '' : 's'}`;
}

function formatHours(hours: number): string {
  if (hours % 24 !== 0) return `${hours} hours`;
  const days = hours / 24;
  return days === 1 ? '1 day' : `${days} days`;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="stack">
      <div>
        <h2>{title}</h2>
        {hint && <p className="muted small">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** "All" or a pick of options, as pill buttons. `undefined` means all. */
function PillChoice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
}) {
  const selected = value ?? [];
  const toggle = (option: string) => {
    const next = selected.includes(option) ? selected.filter((o) => o !== option) : [...selected, option];
    onChange(next.length ? next : undefined);
  };
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="row">
        <button
          type="button"
          className={selected.length === 0 ? 'toggle active' : 'toggle'}
          onClick={() => onChange(undefined)}
        >
          All
        </button>
        {options.map((option) => (
          <button
            type="button"
            key={option}
            className={selected.includes(option) ? 'toggle active' : 'toggle'}
            onClick={() => toggle(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A select of friendly durations; a custom saved value is kept as an extra option. */
function DurationSelect({
  label,
  hint,
  value,
  options,
  format,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  options: number[];
  format: (n: number) => string;
  onChange: (value: number) => void;
}) {
  const all = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <label>
      {label}
      <select className="select-auto" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {all.map((n) => (
          <option key={n} value={n}>
            {format(n)}
          </option>
        ))}
      </select>
      <span className="hint">{hint}</span>
    </label>
  );
}
