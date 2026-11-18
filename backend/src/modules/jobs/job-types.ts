export type JobTrigger = 'SCHEDULED' | 'CORRECTION' | 'MANUAL';
export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type TaskKind = 'CHUNK' | 'FINALIZE';
export type TaskStatus = 'WAITING' | 'READY' | 'RUNNING' | 'RETRY_WAIT' | 'SUCCEEDED' | 'FAILED';

/** Extra narrowing a user can add to a manual export. Columns and format always come from the config. */
export interface ExtraFilters {
  sessionIds?: string[];
  results?: string[];
}

export interface ExportJob {
  id: string;
  tenant_id: string;
  workspace_id: string;
  config_id: string;
  config_version: number;
  trigger: JobTrigger;
  status: JobStatus;
  partition_id: string | null;
  correction_no: number | null;
  range_start: Date | null;
  range_end: Date | null;
  session_id: string | null;
  prev_cutoff: Date | null;
  cutoff: Date;
  extra_filters: ExtraFilters;
  request_id: string | null;
  requested_by: string | null;
  file_name: string;
  row_count: number | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface ExportTask {
  id: string;
  job_id: string;
  kind: TaskKind;
  seq: number;
  status: TaskStatus;
  lower_at: string | null;
  lower_id: string | null;
  upper_at: string | null;
  upper_id: string | null;
  attempt: number;
  max_attempts: number;
  lease_until: Date | null;
  run_after: Date | null;
  worker_id: string | null;
  row_count: number | null;
  last_error: string | null;
  updated_at: Date;
}

/** Task columns, with chunk bounds as text to keep microsecond precision. */
export const TASK_COLUMNS = `
  t.id, t.job_id, t.kind, t.seq, t.status,
  t.lower_at::text AS lower_at, t.lower_id, t.upper_at::text AS upper_at, t.upper_id,
  t.attempt, t.max_attempts, t.lease_until, t.run_after, t.worker_id, t.row_count,
  t.last_error, t.updated_at`;
