import type { Queryable } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { TASK_COLUMNS, type ExportJob, type ExportTask, type JobStatus, type JobTrigger } from './job-types.js';

export async function getJob(db: Queryable, jobId: string): Promise<ExportJob> {
  const { rows } = await db.query<ExportJob>('SELECT * FROM export_job WHERE id = $1', [jobId]);
  if (!rows[0]) throw notFound('Export not found');
  return rows[0];
}

/** Loads a job only if it belongs to the tenant (404 otherwise). */
export async function getJobForTenant(db: Queryable, tenantId: string, jobId: string): Promise<ExportJob> {
  const { rows } = await db.query<ExportJob>('SELECT * FROM export_job WHERE id = $1 AND tenant_id = $2', [
    jobId,
    tenantId,
  ]);
  if (!rows[0]) throw notFound('Export not found');
  return rows[0];
}

export async function listTasks(db: Queryable, jobId: string): Promise<ExportTask[]> {
  const { rows } = await db.query<ExportTask>(
    `SELECT ${TASK_COLUMNS} FROM export_task t WHERE t.job_id = $1 ORDER BY t.kind, t.seq`,
    [jobId],
  );
  return rows;
}

export interface JobArtifact {
  file_name: string;
  location: string;
  row_count: number;
  sha256: string;
  created_at: Date;
}

export async function getArtifact(db: Queryable, jobId: string): Promise<JobArtifact | null> {
  const { rows } = await db.query<JobArtifact>(
    'SELECT file_name, location, row_count, sha256, created_at FROM export_artifact WHERE job_id = $1',
    [jobId],
  );
  return rows[0] ?? null;
}

export interface JobListFilter {
  status?: JobStatus;
  trigger?: JobTrigger;
  limit?: number;
}

export async function listJobs(db: Queryable, workspaceId: string, filter: JobListFilter = {}): Promise<ExportJob[]> {
  const { rows } = await db.query<ExportJob>(
    `SELECT * FROM export_job
     WHERE workspace_id = $1
       AND ($2::text IS NULL OR status = $2)
       AND ($3::text IS NULL OR trigger = $3)
     ORDER BY created_at DESC
     LIMIT $4`,
    [workspaceId, filter.status ?? null, filter.trigger ?? null, filter.limit ?? 50],
  );
  return rows;
}
