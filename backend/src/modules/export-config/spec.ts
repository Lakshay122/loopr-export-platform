import { IANAZone } from 'luxon';
import { z } from 'zod';

/**
 * The export "spec" is everything a customer can configure. It is plain data,
 * never code. Anything not listed here is rejected when the config is saved.
 */

/** Source fields a customer may export. Only approved, indexed fields are allowed. */
export const EXPORT_FIELDS = [
  'record_id',
  'session_id',
  'part_serial',
  'inspection_type',
  'result',
  'defect',
  'image_ref',
  'inspected_at',
  'finalized_at',
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];

export const DATE_FIELDS: ReadonlySet<string> = new Set(['inspected_at', 'finalized_at']);

/**
 * Customer-specific extra fields live in the record's `metadata` (keys differ per customer).
 * A column reads one key with `metadata.<key>`; filters use the bare key.
 */
export const METADATA_KEY = /^[A-Za-z0-9_]{1,40}$/;
const METADATA_FIELD = /^metadata\.[A-Za-z0-9_]{1,40}$/;
export type ColumnField = ExportField | `metadata.${string}`;
export const isMetadataField = (field: string): field is `metadata.${string}` => field.startsWith('metadata.');

/** Supported date formats. ISO_UTC is the default. Others use the config timezone. */
export const DATE_FORMATS = [
  'ISO_UTC',
  'ISO_LOCAL',
  'yyyy-MM-dd HH:mm:ss',
  'dd-MM-yyyy HH:mm:ss',
  'dd-MM-yyyy',
] as const;

export const RESULTS = ['PASS', 'FAIL', 'REVIEW'] as const;

/** Bucket sizes must divide a day evenly, so buckets line up with local midnight. */
const TIME_BUCKET_PATTERN = /^time_bucket\((\d+)(m|h)\)$/;

const ColumnSchema = z
  .object({
    field: z.union([
      z.enum(EXPORT_FIELDS),
      z
        .string()
        .regex(METADATA_FIELD, 'Use a known field or metadata.<key> (letters, numbers and _ only)')
        .transform((f) => f as `metadata.${string}`),
    ]),
    header: z.string().trim().min(1).max(64).optional(),
    // Replace values, e.g. { "PASS": "1", "FAIL": "0" }. Not allowed on date fields.
    valueMap: z.record(z.string().max(64), z.string().max(256)).optional(),
    // Written when the record has no value for this field (e.g. a metadata key some records lack).
    whenMissing: z.string().max(64).optional(),
  })
  .strict();

const GroupingSchema = z
  .object({
    groupBy: z.array(z.string()).length(1, 'Prototype supports exactly one groupBy key'),
    closeWhen: z.discriminatedUnion('type', [
      z.object({ type: z.literal('TIME'), graceSeconds: z.number().int().min(0).max(86_400).default(900) }).strict(),
      z
        .object({
          type: z.literal('EVENT'),
          event: z.literal('session.completed'),
          settleSeconds: z.number().int().min(0).max(86_400).default(60),
        })
        .strict(),
    ]),
  })
  .strict();

export const ExportSpecSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    format: z.literal('csv').default('csv'),
    columns: z.array(ColumnSchema).min(1).max(40),
    dateFormat: z.enum(DATE_FORMATS).default('ISO_UTC'),
    timezone: z.string().default('UTC'),
    filters: z
      .object({
        results: z.array(z.enum(RESULTS)).min(1).optional(),
        inspectionTypes: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
        // Only records whose metadata key has one of these values, e.g. { "line": ["L1", "L2"] }.
        metadata: z
          .record(
            z.string().regex(METADATA_KEY, 'Use letters, numbers and _ only'),
            z.array(z.string().min(1).max(128)).min(1).max(50),
          )
          .refine((m) => Object.keys(m).length <= 5, 'At most 5 metadata filters')
          .optional(),
      })
      .strict()
      .default({}),
    grouping: GroupingSchema,
    correction: z
      .object({
        lookbackHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 30)
          .default(168),
      })
      .strict()
      .default({}),
    delivery: z
      .object({
        type: z.literal('local_folder'),
        // A simple folder name under the storage root. Stands in for customer object storage / SFTP.
        folder: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use letters, numbers, - and _ only')
          .optional(),
      })
      .strict()
      .default({ type: 'local_folder' }),
    chunkSize: z.number().int().min(10).max(50_000).default(5000),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (!IANAZone.isValidZone(spec.timezone)) {
      ctx.addIssue({ code: 'custom', path: ['timezone'], message: `Unknown timezone "${spec.timezone}"` });
    }

    const headers = spec.columns.map((c) => c.header ?? c.field);
    const duplicate = headers.find((h, i) => headers.indexOf(h) !== i);
    if (duplicate) {
      ctx.addIssue({ code: 'custom', path: ['columns'], message: `Duplicate column header "${duplicate}"` });
    }

    spec.columns.forEach((c, i) => {
      if (c.valueMap && DATE_FIELDS.has(c.field)) {
        ctx.addIssue({ code: 'custom', path: ['columns', i, 'valueMap'], message: 'Use dateFormat for date fields' });
      }
      if (spec.columns.findIndex((other) => other.field === c.field) !== i) {
        ctx.addIssue({ code: 'custom', path: ['columns', i, 'field'], message: `"${c.field}" is already a column` });
      }
    });

    const grouping = parseGrouping(spec.grouping);
    if (typeof grouping === 'string') {
      ctx.addIssue({ code: 'custom', path: ['grouping'], message: grouping });
    }
  });

export type ExportSpecInput = z.input<typeof ExportSpecSchema>;
export type ExportSpec = z.output<typeof ExportSpecSchema>;

/** Grouping after validation, in a shape the scheduler can use directly. */
export type Grouping =
  { kind: 'TIME'; bucketMinutes: number; graceSeconds: number } | { kind: 'SESSION'; settleSeconds: number };

/** Returns the grouping, or an error message if the combination is not supported. */
function parseGrouping(g: ExportSpec['grouping']): Grouping | string {
  const key = g.groupBy[0] ?? '';

  if (key === 'session_id') {
    if (g.closeWhen.type !== 'EVENT') return 'session_id grouping must close on the session.completed event';
    return { kind: 'SESSION', settleSeconds: g.closeWhen.settleSeconds };
  }

  const match = TIME_BUCKET_PATTERN.exec(key);
  if (match) {
    const minutes = Number(match[1]) * (match[2] === 'h' ? 60 : 1);
    if (minutes < 1 || 1440 % minutes !== 0) return 'time_bucket size must divide 24h evenly (e.g. 15m, 1h, 6h, 24h)';
    if (g.closeWhen.type !== 'TIME') return 'time_bucket grouping must close on TIME';
    return { kind: 'TIME', bucketMinutes: minutes, graceSeconds: g.closeWhen.graceSeconds };
  }

  return `Unsupported groupBy "${key}". Allowed: time_bucket(<n>m|<n>h), session_id`;
}

/** Use only on a spec that already passed validation. */
export function groupingOf(spec: ExportSpec): Grouping {
  const grouping = parseGrouping(spec.grouping);
  if (typeof grouping === 'string') throw new Error(grouping);
  return grouping;
}

export function parseSpec(input: unknown): ExportSpec {
  return ExportSpecSchema.parse(input);
}
