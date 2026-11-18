import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { ExportDetail } from '../api/types';
import { ErrorBox, PageHeader, ProgressBar, StatusPill, TechStatus } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { parseCsv } from '../lib/csv';
import { duration, formatTime, kindLabel, periodLabel, plural } from '../lib/format';
import { useWorkspace } from '../workspace';

const isActive = (job: ExportDetail | null) => !job || job.status === 'PENDING' || job.status === 'RUNNING';
const PREVIEW_ROWS = 25;

/** One report: a plain summary first, a look inside the file, and technical details for engineers. */
export function ReportDetailPage() {
  const { jobId = '' } = useParams();
  const { ws } = useWorkspace();
  const [actionError, setActionError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);

  // Refresh every second while the report is being made; stop once it is finished.
  const {
    data: job,
    error,
    refresh,
  } = usePolling(() => api.getExport(ws, jobId), `${ws.workspaceId}|${jobId}`, 1000, isActive);

  const retry = async () => {
    setActionError(null);
    setRetrying(true);
    try {
      await api.retryExport(ws, jobId);
      await refresh();
    } catch (err) {
      setActionError(err);
    } finally {
      setRetrying(false);
    }
  };

  if (error && !job) return <ErrorBox error={error} />;
  if (!job) return <p className="muted">Loading…</p>;

  return (
    <div className="stack-lg">
      <Link to="/reports" className="back">
        ← Reports
      </Link>
      <PageHeader
        title={periodLabel(job)}
        subtitle={
          <span className="row">
            <StatusPill status={job.status} />
            <span>{kindLabel(job)}</span>
          </span>
        }
        actions={
          <>
            {job.status === 'FAILED' && (
              <button className="btn btn-primary" onClick={retry} disabled={retrying}>
                {retrying ? 'Starting…' : 'Try again'}
              </button>
            )}
            {job.file && (
              <button
                className="btn btn-primary"
                onClick={() => api.downloadFile(ws, job.id, job.fileName).catch(setActionError)}
              >
                Download CSV
              </button>
            )}
          </>
        }
      />

      <ErrorBox error={actionError} />
      <Summary job={job} />
      {job.file && <FilePreview jobId={job.id} />}
      <TechnicalDetails job={job} />
    </div>
  );
}

/** One or two sentences that say what happened, in plain words. */
function Summary({ job }: { job: ExportDetail }) {
  const { chunksDone, chunksTotal } = job.progress;

  if (job.status === 'FAILED') {
    return (
      <div className="notice notice-bad">
        <strong>This report could not be delivered.</strong>
        <p>Reason: {job.error ?? 'unknown error'}</p>
        <p className="small">
          “Try again” continues where it stopped. Parts that were already finished are kept, and the file will look
          exactly as it would have the first time.
        </p>
      </div>
    );
  }

  if (job.status !== 'COMPLETED') {
    return (
      <section className="panel">
        <h2>{job.status === 'PENDING' ? 'Waiting to start…' : 'Preparing your file…'}</h2>
        <p className="muted">
          Big reports are made in parts at the same time. {chunksDone} of {chunksTotal} parts are done.
        </p>
        <ProgressBar done={chunksDone} total={chunksTotal} />
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="facts-grid">
        <Fact label="Delivered" value={formatTime(job.finishedAt)} />
        <Fact label="Rows" value={(job.rowCount ?? 0).toLocaleString()} />
        <Fact label="Took" value={duration(job.startedAt, job.finishedAt)} />
        <Fact label="File name" value={<span className="mono">{job.fileName}</span>} />
      </div>
      <p className="muted small top-gap">{explainContents(job)}</p>
    </section>
  );
}

function explainContents(job: ExportDetail): string {
  const rows = plural(job.rowCount ?? 0, 'record');
  if (job.trigger === 'CORRECTION') {
    return `This file adds ${rows} that reached us after the earlier report for this ${job.sessionId ? 'session' : 'period'} was sent. The earlier file was not changed.`;
  }
  if (job.trigger === 'MANUAL') {
    return `A one-time export of ${rows}, requested by ${job.requestedBy ?? 'a user'}.`;
  }
  return `Contains ${rows} that were finished when this report was made. Records that arrive later are sent in a separate “late records update”.`;
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className="fact-value">{value}</div>
    </div>
  );
}

/** Shows the first rows of the delivered file as a table. */
function FilePreview({ jobId }: { jobId: string }) {
  const { ws } = useWorkspace();
  const [rows, setRows] = useState<string[][] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .fileText(ws, jobId)
      .then((text) => setRows(parseCsv(text)))
      .catch(setError);
  }, [ws, jobId]);

  if (error) return <ErrorBox error={error} />;
  if (!rows) return null;
  const [header = [], ...body] = rows;

  return (
    <section className="panel panel-flush">
      <div className="panel-head">
        <h2>What is in the file</h2>
        <span className="muted small">
          {body.length > PREVIEW_ROWS ? `First ${PREVIEW_ROWS} of ${body.length} rows` : plural(body.length, 'row')}
        </span>
      </div>
      {body.length === 0 ? (
        <p className="muted pad">
          This file has only the header row: no matching records in this {header.length ? 'period' : 'file'}.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {header.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.slice(0, PREVIEW_ROWS).map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Everything an engineer needs: cutoff window, config version, checksum, and each task's attempts. */
function TechnicalDetails({ job }: { job: ExportDetail }) {
  const tasks = [...job.tasks.filter((t) => t.kind === 'CHUNK'), ...job.tasks.filter((t) => t.kind === 'FINALIZE')];
  const retries = job.tasks.reduce((sum, t) => sum + Math.max(0, t.attempt - 1), 0);

  return (
    <details className="panel tech-details">
      <summary>
        Technical details{' '}
        <span className="muted small">
          · {plural(job.progress.chunksTotal, 'part')} ·{' '}
          {retries === 0 ? 'no retries' : retries === 1 ? '1 retry' : `${retries} retries`}
        </span>
      </summary>
      <div className="stack top-gap">
        <dl className="facts">
          <dt>Settings version</dt>
          <dd>v{job.configVersion} (kept even if settings change later)</dd>
          <dt>Records finalized</dt>
          <dd>
            after {job.prevCutoff ? formatTime(job.prevCutoff, true) : 'the start (first file of this group)'} and up to{' '}
            {formatTime(job.cutoff, true)} (cutoff)
          </dd>
          {job.rangeStart && (
            <>
              <dt>Inspected between</dt>
              <dd>
                {formatTime(job.rangeStart, true)} and {formatTime(job.rangeEnd, true)}
              </dd>
            </>
          )}
          {job.requestId && (
            <>
              <dt>Request id</dt>
              <dd className="mono">{job.requestId}</dd>
            </>
          )}
          {job.file && (
            <>
              <dt>SHA-256</dt>
              <dd className="mono break">{job.file.sha256}</dd>
            </>
          )}
          <dt>Report id</dt>
          <dd className="mono">{job.id}</dd>
        </dl>

        <div className="table-wrap bordered">
          <table className="data">
            <thead>
              <tr>
                <th>Task</th>
                <th>State</th>
                <th className="num">Attempt</th>
                <th className="num">Rows</th>
                <th>Worker</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td>{t.kind === 'CHUNK' ? `Part ${t.seq + 1}` : 'Join + publish'}</td>
                  <td>
                    <TechStatus status={t.status} />
                  </td>
                  <td className={`num ${t.attempt > 1 ? 'warn-text' : ''}`}>
                    {t.attempt} / {t.maxAttempts}
                  </td>
                  <td className="num">{t.rowCount ?? '—'}</td>
                  <td className="mono small">{t.workerId ?? '—'}</td>
                  <td className="small bad-text">{t.lastError ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Each part is claimed by a worker with a time-limited lease. If a worker stops, the lease runs out and another
          worker redoes only that part; the attempt number goes up. “Join + publish” waits for all parts, then writes
          the final file in one step, so a half-written file is never visible.
        </p>
      </div>
    </details>
  );
}
