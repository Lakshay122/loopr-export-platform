/** Shapes returned by the backend API (see docs/api.md). */

export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type JobTrigger = 'SCHEDULED' | 'CORRECTION' | 'MANUAL';
export type TaskStatus = 'WAITING' | 'READY' | 'RUNNING' | 'RETRY_WAIT' | 'SUCCEEDED' | 'FAILED';

export interface ExportSummary {
  id: string;
  workspaceId: string;
  trigger: JobTrigger;
  status: JobStatus;
  configVersion: number;
  correctionNo: number | null;
  fileName: string;
  rowCount: number | null;
  error: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  sessionId: string | null;
  prevCutoff: string | null;
  cutoff: string;
  requestId: string | null;
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ExportTask {
  id: string;
  kind: 'CHUNK' | 'FINALIZE';
  seq: number;
  status: TaskStatus;
  attempt: number;
  maxAttempts: number;
  rowCount: number | null;
  lastError: string | null;
  runAfter: string | null;
  leaseUntil: string | null;
  workerId: string | null;
  updatedAt: string;
}

export interface ExportDetail extends ExportSummary {
  progress: { chunksTotal: number; chunksDone: number; rowsWritten: number };
  tasks: ExportTask[];
  file: { name: string; rowCount: number; sha256: string; publishedAt: string } | null;
}

export interface ExportConfig {
  workspaceId: string;
  version: number;
  currentVersion: number;
  createdBy: string;
  createdAt: string;
  /** Set on a version that changed the schedule type: when the change starts. */
  effectiveFrom: string | null;
  /** When the current schedule type started (null = from the beginning). In the future = planned. */
  groupingSince: string | null;
  spec: Record<string, unknown>;
}

export interface Preview {
  headers: string[];
  rows: string[][];
  csv: string;
  /** Set when saving would change the schedule type: when the change would start. */
  groupingChangeAt: string | null;
}

export interface ManualExportRequest {
  requestId: string;
  rangeStart: string;
  rangeEnd: string;
  sessionIds?: string[];
  results?: string[];
}

export type EventOutcome = 'partition-created' | 'duplicate-event' | 'already-closed' | 'ignored';

/** A customer-specific metadata key found in a workspace's records. */
export interface MetadataKey {
  key: string;
  example: string;
  seen: number;
  sampled: number;
}

export interface Fields {
  standard: string[];
  metadata: MetadataKey[];
  /** Values that really occur per field, most common first. null = too many to list. */
  values: Record<string, string[] | null>;
  /** The newest record, as stored. */
  sample: SampleRecord | null;
}

export interface SampleRecord {
  record_id: string;
  session_id: string;
  part_serial: string;
  inspection_type: string;
  result: string;
  defect: string | null;
  image_ref: string | null;
  inspected_at: string;
  finalized_at: string;
  metadata: Record<string, unknown>;
}

/** A customer-made group of fields on the settings screen (display only). */
export interface FieldGroup {
  id: string;
  name: string;
  fields: string[];
}
