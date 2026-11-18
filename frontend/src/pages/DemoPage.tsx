import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorBox, PageHeader } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { formatClock } from '../lib/format';
import { useWorkspace } from '../workspace';
import { BUCKETS, normalize, type Spec } from './settings/spec-model';

const newSessionId = () => `DEMO-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
const newEventId = () => `evt-${crypto.randomUUID().slice(0, 8)}`;

const WHEN = [
  { label: 'Just now', minutes: 0 },
  { label: '30 min ago', minutes: 30 },
  { label: '1 hour ago', minutes: 60 },
  { label: '2 hours ago', minutes: 120 },
];

const OUTCOME_TEXT: Record<string, string> = {
  'partition-created': 'Session finished. Its file will be made shortly.',
  'duplicate-event': 'This exact event was already received, so it was ignored (no duplicate file).',
  'already-closed': 'This session was already finished by an earlier event, so nothing new happens.',
  ignored: 'Ignored: this customer gets scheduled files, so the session’s records go into the scheduled files instead.',
};

type LogLine = { at: Date; text: string };

/**
 * Demo only. In the real product, records and "session finished" events come from the inspection
 * app. Here a reviewer can create them to watch the exports happen.
 */
export function DemoPage() {
  const { ws } = useWorkspace();
  const { data: config, error } = usePolling(() => api.getConfig(ws), ws.workspaceId, 30_000);
  const spec = config ? normalize(config.spec) : null;

  return (
    <div className="stack-lg narrow">
      <PageHeader
        title="Demo tools"
        subtitle="In the real product, inspection records and “session finished” signals come from the inspection app. Here you can create them yourself to watch the exports work. Only for this demo."
      />
      <ErrorBox error={error} />
      {spec && <DemoTools key={ws.workspaceId} spec={spec} />}
    </div>
  );
}

function DemoTools({ spec }: { spec: Spec }) {
  const [sessionId, setSessionId] = useState(newSessionId);
  const [log, setLog] = useState<LogLine[]>([]);
  const add = (text: string) => setLog((cur) => [{ at: new Date(), text }, ...cur].slice(0, 8));
  const isTime = spec.grouping.closeWhen.type === 'TIME';

  return (
    <>
      <Guide spec={spec} />
      <AddRecords sessionId={sessionId} setSessionId={setSessionId} onDone={add} isTime={isTime} />
      <FinishSession sessionId={sessionId} setSessionId={setSessionId} onDone={add} isTime={isTime} />

      {log.length > 0 && (
        <section className="panel stack-sm">
          <div className="panel-head">
            <h2>What happened</h2>
            <Link to="/reports">Open Reports →</Link>
          </div>
          <ul className="activity">
            {log.map((line, i) => (
              <li key={i}>
                <span className="muted mono small">{formatClock(line.at)}</span> {line.text}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Step-by-step test plan for the selected customer's schedule. */
function Guide({ spec }: { spec: Spec }) {
  const close = spec.grouping.closeWhen;
  const bucket = (BUCKETS.find((b) => b.value === spec.grouping.groupBy[0])?.label ?? 'Every hour').toLowerCase();
  return (
    <section className="panel stack-sm">
      <h2>How to test this customer</h2>
      {close.type === 'TIME' ? (
        <ol className="steps">
          <li>
            <strong>Add records “Just now”.</strong> They belong to the current time window ({bucket}, {spec.timezone}{' '}
            time).
          </li>
          <li>
            <strong>Wait for the window to end.</strong> The file is made {close.graceSeconds} seconds after it ends and
            shows up in Reports.
          </li>
          <li>
            <strong>Try late records:</strong> after that file is sent, add records “1 hour ago”. They come as a small{' '}
            <em>Late records update</em> within a few seconds. The earlier file is not changed.
          </li>
        </ol>
      ) : (
        <ol className="steps">
          <li>
            <strong>Add records</strong> to a session (a new session id is filled in for you).
          </li>
          <li>
            <strong>Finish the session.</strong> Its file is made {close.settleSeconds} seconds later and shows up in
            Reports.
          </li>
          <li>
            <strong>Try duplicates:</strong> press “Finish session” again with the same event id. It is ignored, so
            there is still one file.
          </li>
          <li>
            <strong>Try late records:</strong> add more records to the same session after its file was sent. They come
            as a <em>Late records update</em>. The earlier file is not changed.
          </li>
        </ol>
      )}
    </section>
  );
}

function AddRecords({
  sessionId,
  setSessionId,
  onDone,
  isTime,
}: {
  sessionId: string;
  setSessionId: (id: string) => void;
  onDone: (text: string) => void;
  isTime: boolean;
}) {
  const { ws } = useWorkspace();
  const [count, setCount] = useState(20);
  const [minutesAgo, setMinutesAgo] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api.addDemoRecords(ws, { sessionId, count, minutesAgo });
      const when = WHEN.find((w) => w.minutes === minutesAgo)?.label.toLowerCase() ?? `${minutesAgo} min ago`;
      onDone(
        `Added ${result.added} records to session ${result.sessionId}, inspected ${when}.` +
          (minutesAgo > 0 ? ' If that period’s file was already sent, they arrive as a Late records update.' : ''),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel panel-demo stack" onSubmit={submit}>
      <div>
        <span className="tag">Step 1</span>
        <h2 className="top-gap-sm">Add inspection records</h2>
        <p className="muted small">Like parts being inspected on the line. Results are random (mostly PASS).</p>
      </div>
      <div className="grid-2-tight">
        <label>
          Session
          <div className="row">
            <input className="mono grow" value={sessionId} onChange={(e) => setSessionId(e.target.value)} required />
            <button type="button" className="btn btn-small" onClick={() => setSessionId(newSessionId())}>
              New
            </button>
          </div>
        </label>
        <label>
          How many
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[5, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} records
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <span className="field-label">When were they inspected?</span>
        <div className="segmented">
          {WHEN.map((w) => (
            <button
              type="button"
              key={w.minutes}
              className={minutesAgo === w.minutes ? 'active' : ''}
              onClick={() => setMinutesAgo(w.minutes)}
            >
              {w.label}
            </button>
          ))}
        </div>
        <span className="hint">
          {minutesAgo === 0
            ? isTime
              ? 'They go into the file for the current time window.'
              : 'They go into this session’s file when it is finished.'
            : 'They reach us only now, like a tablet that was offline. Good for testing late records.'}
        </span>
      </div>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Adding…' : 'Add records'}
        </button>
      </div>
    </form>
  );
}

function FinishSession({
  sessionId,
  setSessionId,
  onDone,
  isTime,
}: {
  sessionId: string;
  setSessionId: (id: string) => void;
  onDone: (text: string) => void;
  isTime: boolean;
}) {
  const { ws } = useWorkspace();
  const [eventId, setEventId] = useState(newEventId);
  const [error, setError] = useState<unknown>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const { outcome } = await api.completeSession(ws, sessionId, eventId);
      onDone(`${sessionId}: ${OUTCOME_TEXT[outcome] ?? outcome}`);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form className="panel panel-demo stack" onSubmit={send}>
      <div>
        <span className="tag">Step 2</span>
        <h2 className="top-gap-sm">Finish a session</h2>
        <p className="muted small">
          {isTime
            ? 'Only matters for customers with per-session files. This customer gets scheduled files, so it is ignored.'
            : 'Like the operator pressing “Done” in the inspection app. The session’s file is made shortly after.'}
        </p>
      </div>
      <label>
        Session
        <input className="mono" value={sessionId} onChange={(e) => setSessionId(e.target.value)} required />
      </label>
      <details className="advanced">
        <summary>Advanced: event id</summary>
        <div className="row top-gap">
          <input className="mono grow" value={eventId} onChange={(e) => setEventId(e.target.value)} required />
          <button type="button" className="btn btn-small" onClick={() => setEventId(newEventId())}>
            New id
          </button>
        </div>
        <span className="hint">The same event id sent twice is ignored the second time.</span>
      </details>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn btn-primary" type="submit">
          Finish session
        </button>
      </div>
    </form>
  );
}
