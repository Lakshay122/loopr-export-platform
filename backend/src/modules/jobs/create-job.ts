import { randomUUID } from 'node:crypto';
import type { DbClient } from '../../db/pool.js';
import type { ConfigVersion } from '../export-config/config-service.js';
import { chunkBoundaries, type Cursor } from '../source/records.js';
import type { ExportJob, ExtraFilters, JobTrigger } from './job-types.js';
import { selectionForJob } from './selection.js';

export interface NewJob {
  id?: string;
  tenantId: string;
  config: ConfigVersion;
  trigger: JobTrigger;
  fileName: string | ((jobId: string) => string);
  cutoff: Date;
  prevCutoff?: Date | null;
  partitionId?: string | null;
  correctionNo?: number | null;
  rangeStart?: Date | null;
  rangeEnd?: Date | null;
  sessionId?: string | null;
  extraFilters?: ExtraFilters;
  requestId?: string | null;
  requestedBy?: string | null;
  maxAttempts: number;
}

/**
 * Creates a job, its tasks and the outbox rows in the caller's transaction.
 *
 * - Chunk ranges are fixed now, so every retry reads exactly the same rows.
 * - CHUNK tasks start READY and get an outbox row (dispatched to BullMQ later).
 * - The FINALIZE task starts WAITING until every chunk has succeeded.
 * - Because everything is in one transaction, a crash can never leave a job
 *   without tasks, or tasks that are never sent to the queue.
 */
export async function createJob(client: DbClient, input: NewJob): Promise<ExportJob> {
  const id = input.id ?? randomUUID();
  const fileName = typeof input.fileName === 'function' ? input.fileName(id) : input.fileName;

  const { rows } = await client.query<ExportJob>(
    `INSERT INTO export_job (
       id, tenant_id, workspace_id, config_id, config_version, trigger, status,
       partition_id, correction_no, range_start, range_end, session_id,
       prev_cutoff, cutoff, extra_filters, request_id, requested_by, file_name)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      id,
      input.tenantId,
      input.config.workspaceId,
      input.config.configId,
      input.config.version,
      input.trigger,
      input.partitionId ?? null,
      input.correctionNo ?? null,
      input.rangeStart ?? null,
      input.rangeEnd ?? null,
      input.sessionId ?? null,
      input.prevCutoff ?? null,
      input.cutoff,
      input.extraFilters ?? {},
      input.requestId ?? null,
      input.requestedBy ?? null,
      fileName,
    ],
  );
  const job = rows[0]!;

  const boundaries = await chunkBoundaries(
    client,
    selectionForJob(job, input.config.spec),
    input.config.spec.chunkSize,
  );
  await insertTasks(client, job.id, boundaries, input.maxAttempts);
  return job;
}

/** n boundaries make n + 1 chunks: (start, b1], (b1, b2], ..., (bn, end). */
async function insertTasks(client: DbClient, jobId: string, boundaries: Cursor[], maxAttempts: number): Promise<void> {
  const bounds: Array<Cursor | null> = [null, ...boundaries, null];
  const chunks = bounds.slice(0, -1).map((lower, seq) => ({ seq, lower, upper: bounds[seq + 1] ?? null }));

  await client.query(
    `WITH chunk AS (
       INSERT INTO export_task (job_id, kind, seq, status, lower_at, lower_id, upper_at, upper_id, max_attempts)
       SELECT $1, 'CHUNK', c.seq, 'READY', c.lower_at::timestamptz, c.lower_id, c.upper_at::timestamptz, c.upper_id, $2
       FROM unnest($3::int[], $4::text[], $5::text[], $6::text[], $7::text[])
            AS c(seq, lower_at, lower_id, upper_at, upper_id)
       RETURNING id
     )
     INSERT INTO export_outbox (task_id) SELECT id FROM chunk`,
    [
      jobId,
      maxAttempts,
      chunks.map((c) => c.seq),
      chunks.map((c) => c.lower?.at ?? null),
      chunks.map((c) => c.lower?.id ?? null),
      chunks.map((c) => c.upper?.at ?? null),
      chunks.map((c) => c.upper?.id ?? null),
    ],
  );

  await client.query(
    `INSERT INTO export_task (job_id, kind, seq, status, max_attempts) VALUES ($1, 'FINALIZE', 0, 'WAITING', $2)`,
    [jobId, maxAttempts],
  );
}
