import type { ConfigVersion } from '../modules/export-config/config-service.js';
import type { JobArtifact } from '../modules/jobs/job-queries.js';
import type { ExportJob, ExportTask } from '../modules/jobs/job-types.js';

/** Response shapes. Internal column names stay inside the server. */

/** `groupingSince`: when the current schedule type started (null = from the beginning). In the future = planned. */
export function configDto(c: ConfigVersion, groupingSince: Date | null = null) {
  return {
    workspaceId: c.workspaceId,
    version: c.version,
    currentVersion: c.currentVersion,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    effectiveFrom: c.effectiveFrom,
    groupingSince,
    spec: c.spec,
  };
}

export function jobSummaryDto(job: ExportJob) {
  return {
    id: job.id,
    workspaceId: job.workspace_id,
    trigger: job.trigger,
    status: job.status,
    configVersion: job.config_version,
    correctionNo: job.correction_no,
    fileName: job.file_name,
    rowCount: job.row_count,
    error: job.error,
    rangeStart: job.range_start,
    rangeEnd: job.range_end,
    sessionId: job.session_id,
    prevCutoff: job.prev_cutoff,
    cutoff: job.cutoff,
    requestId: job.request_id,
    requestedBy: job.requested_by,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

export function jobDetailDto(job: ExportJob, tasks: ExportTask[], artifact: JobArtifact | null) {
  const chunks = tasks.filter((t) => t.kind === 'CHUNK');
  return {
    ...jobSummaryDto(job),
    progress: {
      chunksTotal: chunks.length,
      chunksDone: chunks.filter((t) => t.status === 'SUCCEEDED').length,
      rowsWritten: chunks.reduce((sum, t) => sum + (t.row_count ?? 0), 0),
    },
    tasks: tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      seq: t.seq,
      status: t.status,
      attempt: t.attempt,
      maxAttempts: t.max_attempts,
      rowCount: t.row_count,
      lastError: t.last_error,
      runAfter: t.run_after,
      leaseUntil: t.lease_until,
      workerId: t.worker_id,
      updatedAt: t.updated_at,
    })),
    file: artifact
      ? {
          name: artifact.file_name,
          rowCount: artifact.row_count,
          sha256: artifact.sha256,
          publishedAt: artifact.created_at,
        }
      : null,
  };
}
