import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { ReportsTable } from '../components/ReportsTable';
import { Empty, ErrorBox, PageHeader } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { formatTime, plural, timeAgo } from '../lib/format';
import { useWorkspace } from '../workspace';
import { describeSchedule, fieldLabel, normalize } from './settings/spec-model';

const DAY_MS = 86_400_000;

/** Home screen: what this customer's export does, how it is going, and the latest files. */
export function OverviewPage() {
  const { ws } = useWorkspace();
  const { data, error } = usePolling(
    async () => {
      const [config, exports] = await Promise.all([api.getConfig(ws), api.listExports(ws, {})]);
      return {
        spec: normalize(config.spec),
        version: config.version,
        groupingSince: config.groupingSince,
        jobs: exports.items,
      };
    },
    ws.workspaceId,
    5000,
  );

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Loading…</p>;

  const { spec, jobs, groupingSince } = data;
  const plannedChange = groupingSince && new Date(groupingSince) > new Date() ? groupingSince : null;
  const recent = jobs.filter((j) => Date.now() - new Date(j.createdAt).getTime() < DAY_MS);
  const delivered = recent.filter((j) => j.status === 'COMPLETED');
  const failed = jobs.filter((j) => j.status === 'FAILED');
  const running = jobs.filter((j) => j.status === 'RUNNING' || j.status === 'PENDING');
  const lastDelivered = jobs.find((j) => j.status === 'COMPLETED');
  const rows = delivered.reduce((sum, j) => sum + (j.rowCount ?? 0), 0);
  const results = spec.filters.results;

  return (
    <div className="stack-lg">
      <PageHeader
        title={spec.name}
        subtitle={describeSchedule(spec)}
        actions={
          <>
            <Link to="/settings" className="btn">
              Edit settings
            </Link>
            <Link to="/new-export" className="btn btn-primary">
              New export
            </Link>
          </>
        }
      />

      {plannedChange && (
        <div className="notice notice-info">
          <strong>Schedule change planned for {formatTime(plannedChange)}.</strong> From then on:{' '}
          {describeSchedule(spec)} Until then, files are sent the old way.
        </div>
      )}

      {failed.length > 0 && (
        <div className="notice notice-bad row spread">
          <span>
            <strong>{plural(failed.length, 'report')} could not be delivered.</strong> Open it to see why and try again.
          </span>
          <Link to={`/reports/${failed[0]!.id}`} className="btn btn-small">
            View
          </Link>
        </div>
      )}

      <div className="stats">
        <Stat label="Last delivery" value={timeAgo(lastDelivered?.finishedAt)} />
        <Stat label="Files delivered (24 h)" value={delivered.length.toLocaleString()} />
        <Stat label="Rows delivered (24 h)" value={rows.toLocaleString()} />
        <Stat label="In progress" value={running.length.toLocaleString()} />
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>What is in each file</h2>
          <Link to="/settings">Change</Link>
        </div>
        <div className="chips">
          {spec.columns.map((c) => (
            <span key={c.field} className="chip" title={fieldLabel(c.field)}>
              {c.header ?? c.field}
            </span>
          ))}
        </div>
        <p className="muted small">
          {results ? `Only ${results.join(', ')} results.` : 'All results.'}{' '}
          {spec.filters.inspectionTypes
            ? `Inspection types: ${spec.filters.inspectionTypes.join(', ')}.`
            : 'All inspection types.'}{' '}
          Records that arrive late (up to {spec.correction.lookbackHours} h) are sent as a small extra file.
        </p>
      </section>

      <section className="panel panel-flush">
        <div className="panel-head">
          <h2>Latest reports</h2>
          <Link to="/reports">View all</Link>
        </div>
        {jobs.length > 0 ? (
          <ReportsTable jobs={jobs.slice(0, 6)} />
        ) : (
          <Empty title="No reports yet">
            The first file appears when the first {spec.grouping.closeWhen.type === 'TIME' ? 'time window' : 'session'}{' '}
            closes.
          </Empty>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
