import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import type { JobStatus } from '../api/types';
import { STATUS_LABEL } from '../lib/format';

/** Small shared pieces used by every screen. */

const STATUS_TONE: Record<string, string> = {
  COMPLETED: 'good',
  SUCCEEDED: 'good',
  RUNNING: 'info',
  RETRY_WAIT: 'warn',
  FAILED: 'bad',
};

/** Customer-facing status: a coloured dot and a plain word. */
export function StatusPill({ status }: { status: JobStatus }) {
  return (
    <span className={`pill pill-${STATUS_TONE[status] ?? 'muted'}`}>
      <span className="dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Technical status (task states), used only inside "Technical details". */
export function TechStatus({ status }: { status: string }) {
  return (
    <span className={`tech tech-${STATUS_TONE[status] ?? 'muted'}`}>{status.replace('_', ' ').toLowerCase()}</span>
  );
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const issues = error instanceof ApiError ? error.issues : [];
  const offline = error instanceof TypeError || (error instanceof ApiError && error.status >= 502);
  return (
    <div className="notice notice-bad">
      <strong>{offline ? 'We can’t reach the server right now.' : message}</strong>
      {offline && <p>Check that the backend is running (`docker compose up -d`), then try again.</p>}
      {issues.length > 0 && (
        <ul>
          {issues.map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
