import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ExportSummary } from '../api/types';
import { kindLabel, periodLabel, timeAgo } from '../lib/format';
import { useWorkspace } from '../workspace';
import { StatusPill } from './ui';

/** The list of reports with a download button on each delivered one. Click a row for details. */
export function ReportsTable({ jobs }: { jobs: ExportSummary[] }) {
  const { ws } = useWorkspace();
  const navigate = useNavigate();
  const [downloading, setDownloading] = useState<string | null>(null);

  const download = async (job: ExportSummary) => {
    setDownloading(job.id);
    try {
      await api.downloadFile(ws, job.id, job.fileName);
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="table-wrap">
      <table className="reports">
        <thead>
          <tr>
            <th>Report</th>
            <th>Type</th>
            <th>Status</th>
            <th className="num">Rows</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="clickable" onClick={() => navigate(`/reports/${job.id}`)}>
              <td>
                <Link to={`/reports/${job.id}`} className="strong-link" onClick={(e) => e.stopPropagation()}>
                  {periodLabel(job)}
                </Link>
              </td>
              <td className="muted">{kindLabel(job)}</td>
              <td>
                <StatusPill status={job.status} />
              </td>
              <td className="num">{job.rowCount?.toLocaleString() ?? '—'}</td>
              <td className="muted">{timeAgo(job.finishedAt ?? job.createdAt)}</td>
              <td className="actions">
                {job.status === 'COMPLETED' && (
                  <button
                    className="btn btn-small"
                    disabled={downloading === job.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void download(job);
                    }}
                  >
                    {downloading === job.id ? 'Downloading…' : 'Download'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
