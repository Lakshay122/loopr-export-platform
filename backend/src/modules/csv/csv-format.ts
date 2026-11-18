import { DateTime } from 'luxon';
import { DATE_FIELDS, isMetadataField, type ExportSpec } from '../export-config/spec.js';
import type { SourceRecord } from '../source/records.js';

/** Turns source records into CSV lines using a customer's spec. Pure functions, no I/O. */

export function headerLine(spec: ExportSpec): string {
  return toCsvLine(spec.columns.map((c) => c.header ?? c.field));
}

export function recordLine(record: SourceRecord, spec: ExportSpec): string {
  return toCsvLine(formatRecord(record, spec));
}

export function formatRecord(record: SourceRecord, spec: ExportSpec): string[] {
  return spec.columns.map((column) => {
    const raw = fieldValue(record, column.field);
    if (raw === null || raw === '') return column.whenMissing ?? '';
    if (raw instanceof Date) return formatDate(raw, spec);
    return column.valueMap?.[raw] ?? raw;
  });
}

function fieldValue(record: SourceRecord, field: ExportSpec['columns'][number]['field']): string | Date | null {
  if (isMetadataField(field)) return metadataValue(record.metadata?.[field.slice('metadata.'.length)]);
  const value = record[field as keyof SourceRecord];
  if (DATE_FIELDS.has(field)) return (value as Date | null) ?? null;
  return value === null || value === undefined ? null : String(value);
}

/** Metadata values can be any JSON: numbers and booleans as text, objects and lists as JSON. */
function metadataValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function formatDate(date: Date, spec: Pick<ExportSpec, 'dateFormat' | 'timezone'>): string {
  const dt = DateTime.fromJSDate(date);
  switch (spec.dateFormat) {
    case 'ISO_UTC':
      return dt.toUTC().toISO({ suppressMilliseconds: true }) ?? '';
    case 'ISO_LOCAL':
      return dt.setZone(spec.timezone).toISO({ suppressMilliseconds: true }) ?? '';
    default:
      return dt.setZone(spec.timezone).toFormat(spec.dateFormat);
  }
}

/**
 * Joins values into one CSV line (RFC 4180 quoting).
 * Values that start with = + - @ (or tab / carriage return) get a leading ' so
 * spreadsheet apps do not run them as formulas ("CSV injection"). Exception: negative
 * numbers (-12.5) and a lone "-" stay unchanged, so numeric data is not corrupted.
 */
export function toCsvLine(values: string[]): string {
  return values.map(escapeCsvValue).join(',') + '\n';
}

const FORMULA_START = /^[=+\-@\t\r]/;
/** Negative numbers and a lone "-" are data, not formulas, so they are written as they are. */
const PLAIN_VALUE = /^(-|-?\d+(\.\d+)?)$/;

export function escapeCsvValue(value: string): string {
  const safe = FORMULA_START.test(value) && !PLAIN_VALUE.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
