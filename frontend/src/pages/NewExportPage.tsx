import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorBox, PageHeader } from '../components/ui';
import { useWorkspace } from '../workspace';

/** <input type="datetime-local"> works in local time; the API wants ISO timestamps. */
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const newRequestId = () => `ui-${crypto.randomUUID().slice(0, 8)}`;

const PRESETS = [
  { label: 'Last hour', hours: 1 },
  { label: 'Last 24 hours', hours: 24 },
  { label: 'Last 7 days', hours: 24 * 7 },
];

/** Start a one-time export. */
export function NewExportPage() {
  const { ws } = useWorkspace();
  return (
    <div className="stack-lg narrow">
      <PageHeader
        title="New export"
        subtitle="Get a one-time CSV for any time period, for example to fill a gap or re-check old data. It uses your current settings and does not change your regular reports."
      />
      <ManualExportForm key={ws.workspaceId} />
      <p className="muted small">
        Testing the demo? Use <Link to="/demo">Demo tools</Link> to add inspection records or finish a session.
      </p>
    </div>
  );
}

function ManualExportForm() {
  const { ws } = useWorkspace();
  const navigate = useNavigate();
  const [preset, setPreset] = useState<number | null>(24);
  const [start, setStart] = useState(() => toLocalInput(new Date(Date.now() - 24 * 3_600_000)));
  const [end, setEnd] = useState(() => toLocalInput(new Date()));
  const [results, setResults] = useState<string[]>([]);
  const [sessions, setSessions] = useState('');
  const [requestId, setRequestId] = useState(newRequestId);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const applyPreset = (hours: number) => {
    setPreset(hours);
    setStart(toLocalInput(new Date(Date.now() - hours * 3_600_000)));
    setEnd(toLocalInput(new Date()));
  };

  const toggle = (r: string) => setResults((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const sessionIds = sessions
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const job = await api.startManualExport(ws, {
        requestId,
        rangeStart: new Date(start).toISOString(),
        rangeEnd: new Date(end).toISOString(),
        results: results.length ? results : undefined,
        sessionIds: sessionIds.length ? sessionIds : undefined,
      });
      navigate(`/reports/${job.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="panel stack" onSubmit={submit}>
      <div className="field">
        <span className="field-label">Time period</span>
        <div className="segmented">
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.label}
              className={preset === p.hours ? 'active' : ''}
              onClick={() => applyPreset(p.hours)}
            >
              {p.label}
            </button>
          ))}
          <button type="button" className={preset === null ? 'active' : ''} onClick={() => setPreset(null)}>
            Custom
          </button>
        </div>
        {preset === null && (
          <div className="grid-2-tight">
            <label>
              From
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
            </label>
            <label>
              To
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </label>
          </div>
        )}
        <span className="hint">Up to 31 days. Based on when the inspection happened.</span>
      </div>

      <div className="field">
        <span className="field-label">Only these results (optional)</span>
        <div className="row">
          {['PASS', 'FAIL', 'REVIEW'].map((r) => (
            <button
              type="button"
              key={r}
              className={results.includes(r) ? 'toggle active' : 'toggle'}
              onClick={() => toggle(r)}
            >
              {r}
            </button>
          ))}
        </div>
        <span className="hint">Leave all off to include every result your settings allow.</span>
      </div>

      <label>
        Only these sessions (optional)
        <input value={sessions} onChange={(e) => setSessions(e.target.value)} placeholder="e.g. GLX-S-1, GLX-S-2" />
      </label>

      <details className="advanced">
        <summary>Advanced</summary>
        <label className="top-gap">
          Request id
          <div className="row">
            <input className="mono grow" value={requestId} onChange={(e) => setRequestId(e.target.value)} required />
            <button type="button" className="btn btn-small" onClick={() => setRequestId(newRequestId())}>
              New id
            </button>
          </div>
          <span className="hint">
            Protects against double clicks: sending the same request id again opens the same export instead of making a
            second one.
          </span>
        </label>
      </details>

      <ErrorBox error={error} />
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Starting…' : 'Start export'}
        </button>
      </div>
    </form>
  );
}
