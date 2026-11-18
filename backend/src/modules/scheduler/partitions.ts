import type { Db } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { getConfigVersionById } from '../export-config/config-service.js';
import type { ExportSpec } from '../export-config/spec.js';
import { partitionFileName } from '../grouping/grouping.js';
import { createJob } from '../jobs/create-job.js';
import type { ExportJob } from '../jobs/job-types.js';
import { hasRecords, type Selection } from '../source/records.js';

export interface PartitionRow {
  id: string;
  workspace_id: string;
  tenant_id: string;
  config_id: string;
  partition_type: 'TIME' | 'SESSION';
  partition_key: string;
  range_start: Date | null;
  range_end: Date | null;
  session_id: string | null;
  ready_at: Date;
  original_config_version: number | null;
  last_cutoff: Date | null;
  last_correction_no: number;
  in_flight_job_id: string | null;
}

/** Records that belong to a partition between two cutoffs, using the config's filters. */
export function partitionSelection(
  p: PartitionRow,
  spec: ExportSpec,
  prevCutoff: Date | null,
  cutoff: Date,
): Selection {
  return {
    workspaceId: p.workspace_id,
    cutoff,
    prevCutoff,
    rangeStart: p.range_start,
    rangeEnd: p.range_end,
    sessionIds: p.session_id ? [p.session_id] : null,
    results: spec.filters.results ?? null,
    inspectionTypes: spec.filters.inspectionTypes ?? null,
    metadata: spec.filters.metadata ?? null,
  };
}

/**
 * Starts the next export for a partition: the original report (correction 0) or an
 * additive correction with only the records finalized since the last published cutoff.
 *
 * Safety rules (D-08 qualified guarantee):
 * - The partition row is locked, and only one job per partition may be in flight,
 *   so two schedulers can never hand out overlapping cutoff ranges.
 * - The new range is (last_cutoff, cutoff]. last_cutoff only moves when a file is published.
 * - Corrections use the same config version as the original report (D-09).
 * - The (partition_id, correction_no) unique key is a final database-level guard.
 */
export async function startPartitionJob(
  db: Db,
  partitionId: string,
  opts: { now: Date; cutoffSafetySeconds: number; maxAttempts: number },
): Promise<ExportJob | null> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<PartitionRow>(
      `SELECT p.*, w.tenant_id, c.current_version
       FROM export_partition p
       JOIN workspace w ON w.id = p.workspace_id
       JOIN export_config c ON c.id = p.config_id
       WHERE p.id = $1
       FOR UPDATE OF p`,
      [partitionId],
    );
    const p = rows[0] as (PartitionRow & { current_version: number }) | undefined;
    if (!p || p.in_flight_job_id) return null;

    const cutoff = new Date(opts.now.getTime() - opts.cutoffSafetySeconds * 1000);
    if (p.last_cutoff && cutoff <= p.last_cutoff) return null;

    const config = await getConfigVersionById(client, p.config_id, p.original_config_version ?? p.current_version);
    const isOriginal = p.last_cutoff === null;
    // Original reports are always delivered (even empty). Corrections only when there is something new.
    if (!isOriginal && !(await hasRecords(client, partitionSelection(p, config.spec, p.last_cutoff, cutoff)))) {
      return null;
    }

    const correctionNo = p.last_correction_no + 1;
    const job = await createJob(client, {
      tenantId: p.tenant_id,
      config,
      trigger: isOriginal ? 'SCHEDULED' : 'CORRECTION',
      fileName: partitionFileName(p.partition_key, correctionNo),
      cutoff,
      prevCutoff: p.last_cutoff,
      partitionId: p.id,
      correctionNo,
      rangeStart: p.range_start,
      rangeEnd: p.range_end,
      sessionId: p.session_id,
      maxAttempts: opts.maxAttempts,
    });

    await client.query(
      `UPDATE export_partition SET in_flight_job_id = $2, original_config_version = $3 WHERE id = $1`,
      [p.id, job.id, config.version],
    );
    return job;
  });
}
