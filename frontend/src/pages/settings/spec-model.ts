/**
 * The export spec as the form edits it, plus friendly labels for every option.
 * The backend is still the judge: it validates the spec on preview and save (backend/src/modules/export-config/spec.ts).
 */

export interface Column {
  /** A standard field, or `metadata.<key>` for a customer-specific extra field. */
  field: string;
  header?: string;
  valueMap?: Record<string, string>;
  /** Written when a record has no value for this field. */
  whenMissing?: string;
}

export type CloseWhen =
  { type: 'TIME'; graceSeconds: number } | { type: 'EVENT'; event: 'session.completed'; settleSeconds: number };

export interface Spec {
  name: string;
  format?: 'csv';
  columns: Column[];
  dateFormat: string;
  timezone: string;
  filters: { results?: string[]; inspectionTypes?: string[]; metadata?: Record<string, string[]> };
  grouping: { groupBy: string[]; closeWhen: CloseWhen };
  correction: { lookbackHours: number };
  delivery: { type: 'local_folder'; folder?: string };
  chunkSize: number;
}

export const FIELDS: { value: string; label: string; example: string }[] = [
  { value: 'record_id', label: 'Record ID', example: 'rec-71bf630c' },
  { value: 'session_id', label: 'Session ID', example: 'GLX-S-2' },
  { value: 'part_serial', label: 'Part serial number', example: 'SN-983324' },
  { value: 'inspection_type', label: 'Inspection type', example: 'surface' },
  { value: 'result', label: 'Result', example: 'PASS / FAIL / REVIEW' },
  { value: 'defect', label: 'Defect code', example: 'scratch' },
  { value: 'image_ref', label: 'Image link', example: 's3://…/img.jpg' },
  { value: 'inspected_at', label: 'Inspected at (date)', example: '2026-11-12 09:30' },
  { value: 'finalized_at', label: 'Finalized at (date)', example: '2026-11-12 09:31' },
];
export const isMetadataField = (field: string) => field.startsWith('metadata.');
export const metadataKeyOf = (field: string) => field.slice('metadata.'.length);
export const fieldLabel = (field: string) =>
  isMetadataField(field) ? metadataKeyOf(field) : (FIELDS.find((f) => f.value === field)?.label ?? field);
/** Same rule as the server: letters, numbers and _ only. */
export const METADATA_KEY = /^[A-Za-z0-9_]{1,40}$/;
export const DATE_FIELDS = new Set(['inspected_at', 'finalized_at']);

export const RESULTS = ['PASS', 'FAIL', 'REVIEW'];
/** Inspection types in the demo data. A real product would load these from the workspace. */
export const INSPECTION_TYPES = ['surface', 'dimension', 'weld', 'label'];

export const DATE_FORMATS: { value: string; label: string; example: string }[] = [
  { value: 'ISO_UTC', label: 'ISO, UTC', example: '2026-11-12T09:30:00.000Z' },
  { value: 'ISO_LOCAL', label: 'ISO, with timezone offset', example: '2026-11-12T15:00:00.000+05:30' },
  { value: 'yyyy-MM-dd HH:mm:ss', label: 'Year first', example: '2026-11-12 15:00:00' },
  { value: 'dd-MM-yyyy HH:mm:ss', label: 'Day first', example: '12-11-2026 15:00:00' },
  { value: 'dd-MM-yyyy', label: 'Day first, date only', example: '12-11-2026' },
];

/** Bucket sizes must divide 24 hours evenly. */
export const BUCKETS: { value: string; label: string }[] = [
  { value: 'time_bucket(15m)', label: 'Every 15 minutes' },
  { value: 'time_bucket(30m)', label: 'Every 30 minutes' },
  { value: 'time_bucket(1h)', label: 'Every hour' },
  { value: 'time_bucket(2h)', label: 'Every 2 hours' },
  { value: 'time_bucket(6h)', label: 'Every 6 hours' },
  { value: 'time_bucket(24h)', label: 'Once a day' },
];

/**
 * Timezones for the picker. The current value is always included: browsers may list an older
 * name (Chrome lists "Asia/Calcutta", the config says "Asia/Kolkata"); the server checks validity.
 */
export function timezones(current: string): string[] {
  let all: string[];
  try {
    all = Intl.supportedValuesOf('timeZone');
  } catch {
    all = ['Asia/Kolkata', 'Europe/Berlin', 'America/New_York'];
  }
  return [...new Set([current, 'UTC', ...all])];
}

/** Fills defaults so every form control has a value. Unknown keys from the server are kept. */
export function normalize(raw: Record<string, unknown>): Spec {
  const spec = raw as Partial<Spec>;
  return {
    ...(raw as object),
    name: spec.name ?? '',
    columns: spec.columns ?? [],
    dateFormat: spec.dateFormat ?? 'ISO_UTC',
    timezone: spec.timezone ?? 'UTC',
    filters: spec.filters ?? {},
    grouping: spec.grouping ?? { groupBy: ['time_bucket(1h)'], closeWhen: { type: 'TIME', graceSeconds: 900 } },
    correction: spec.correction ?? { lookbackHours: 168 },
    delivery: spec.delivery ?? { type: 'local_folder' },
    chunkSize: spec.chunkSize ?? 5000,
  };
}

/** Turns a server error path like ["columns", 3, "header"] into "Column 4 (Status) › header". */
export function describePath(path: (string | number)[], spec: Spec): string {
  if (path.length === 0) return 'Settings';
  const [head, index, ...rest] = path;
  if (head === 'columns' && typeof index === 'number') {
    const column = spec.columns[index];
    const name = column ? (column.header ?? fieldLabel(column.field)) : '';
    return [`Column ${index + 1}${name ? ` (${name})` : ''}`, ...rest].join(' › ');
  }
  const SECTION: Record<string, string> = {
    name: 'Report name',
    columns: 'Columns',
    dateFormat: 'Date format',
    timezone: 'Timezone',
    filters: 'Rows to include',
    grouping: 'When to send',
    correction: 'Late records',
    delivery: 'Delivery',
    chunkSize: 'Chunk size',
  };
  return [SECTION[String(head)] ?? String(head), ...path.slice(1)].join(' › ');
}

/** One plain sentence: when and where files are sent, e.g. "A CSV file every hour (Asia/Kolkata time) …". */
export function describeSchedule(spec: Spec): string {
  const where = spec.delivery.folder ? ` to the folder "${spec.delivery.folder}"` : '';
  const close = spec.grouping.closeWhen;
  if (close.type === 'EVENT') {
    return `A CSV file is sent${where} for each inspection session, ${close.settleSeconds} seconds after the session is completed.`;
  }
  const bucket = BUCKETS.find((b) => b.value === spec.grouping.groupBy[0])?.label.toLowerCase() ?? 'on a schedule';
  return `A CSV file is sent${where} ${bucket} (${spec.timezone} time), ${close.graceSeconds} seconds after each window ends.`;
}
