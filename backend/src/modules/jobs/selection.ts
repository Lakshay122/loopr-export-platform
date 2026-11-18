import type { ExportSpec } from '../export-config/spec.js';
import type { Selection } from '../source/records.js';
import type { ExportJob } from './job-types.js';

/**
 * Builds the record selection for a job from the job's fixed boundaries plus the
 * filters of its pinned config version. Manual filters can only narrow the config filters.
 */
export function selectionForJob(job: ExportJob, spec: ExportSpec): Selection {
  return {
    workspaceId: job.workspace_id,
    cutoff: job.cutoff,
    prevCutoff: job.prev_cutoff,
    rangeStart: job.range_start,
    rangeEnd: job.range_end,
    sessionIds: job.session_id ? [job.session_id] : (job.extra_filters.sessionIds ?? null),
    results: narrow(spec.filters.results, job.extra_filters.results),
    inspectionTypes: spec.filters.inspectionTypes ?? null,
    metadata: spec.filters.metadata ?? null,
  };
}

/** Intersection of two optional allow-lists. Undefined means "no limit". */
export function narrow(configured?: readonly string[], requested?: readonly string[]): string[] | null {
  if (!configured) return requested ? [...requested] : null;
  if (!requested) return [...configured];
  return configured.filter((v) => requested.includes(v));
}
