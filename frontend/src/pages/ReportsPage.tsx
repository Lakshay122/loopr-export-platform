import { useState } from 'react';
import { api } from '../api/client';
import type { JobStatus, JobTrigger } from '../api/types';
import { ReportsTable } from '../components/ReportsTable';
import { Empty, ErrorBox, PageHeader } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { useWorkspace } from '../workspace';

const STATUS_TABS: { value: JobStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'COMPLETED', label: 'Delivered' },
  { value: 'RUNNING', label: 'In progress' },
  { value: 'FAILED', label: 'Failed' },
];

const KINDS: { value: JobTrigger | ''; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'SCHEDULED', label: 'Scheduled reports' },
  { value: 'CORRECTION', label: 'Late records updates' },
  { value: 'MANUAL', label: 'One-time exports' },
];

/** Every report of the selected customer. Refreshes on its own. */
export function ReportsPage() {
  const { ws } = useWorkspace();
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [trigger, setTrigger] = useState<JobTrigger | ''>('');

  const { data, error } = usePolling(
    () => api.listExports(ws, { status: status || undefined, trigger: trigger || undefined }),
    `${ws.workspaceId}|${status}|${trigger}`,
    3000,
  );

  return (
    <div className="stack-lg">
      <PageHeader title="Reports" subtitle="Every file sent to your system. Click a report to see what is inside." />

      <div className="row spread">
        <div className="tabs" role="tablist">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.label}
              role="tab"
              aria-selected={status === tab.value}
              className={status === tab.value ? 'tab active' : 'tab'}
              onClick={() => setStatus(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <select value={trigger} onChange={(e) => setTrigger(e.target.value as JobTrigger | '')}>
          {KINDS.map((k) => (
            <option key={k.label} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </div>

      <ErrorBox error={error} />

      <section className="panel panel-flush">
        {data && data.items.length > 0 && <ReportsTable jobs={data.items} />}
        {data && data.items.length === 0 && <Empty title="No reports match this filter" />}
        {!data && !error && <p className="muted pad">Loading…</p>}
      </section>

      <p className="muted small">
        <strong>Late records update</strong>: when records reach us after their report was sent (for example a tablet
        was offline), we send only those records in a small extra file. Earlier files are never changed.
      </p>
    </div>
  );
}
