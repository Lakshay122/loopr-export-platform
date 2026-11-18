import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { createConfig } from '../modules/export-config/config-service.js';
import type { ExportSpecInput } from '../modules/export-config/spec.js';

/**
 * Demo data. In the real product these tables belong to the existing inspection platform;
 * here we fill them so the export workflow has something to read.
 */

export const DEMO = {
  acme: { tenantId: 'tenant-acme', workspaceId: 'ws-acme-line1', userId: 'alice@acme.test' },
  globex: { tenantId: 'tenant-globex', workspaceId: 'ws-globex-qa', userId: 'bob@globex.test' },
} as const;

/** Customer 1: hourly report in India time, renamed columns, PASS/FAIL mapped to OK/NG. */
export const ACME_HOURLY_SPEC: ExportSpecInput = {
  name: 'Line 1 hourly quality report',
  columns: [
    { field: 'record_id', header: 'RecordID' },
    { field: 'part_serial', header: 'Serial' },
    { field: 'inspection_type', header: 'Check' },
    { field: 'result', header: 'Status', valueMap: { PASS: 'OK', FAIL: 'NG', REVIEW: 'HOLD' } },
    { field: 'defect', header: 'Defect', whenMissing: '-' },
    { field: 'metadata.operator', header: 'Operator' },
    { field: 'metadata.torque_nm', header: 'TorqueNm', whenMissing: 'n/a' },
    { field: 'inspected_at', header: 'InspectedAt' },
  ],
  dateFormat: 'ISO_LOCAL',
  timezone: 'Asia/Kolkata',
  grouping: { groupBy: ['time_bucket(1h)'], closeWhen: { type: 'TIME', graceSeconds: 60 } },
  correction: { lookbackHours: 24 },
  delivery: { type: 'local_folder', folder: 'acme-line1' },
  chunkSize: 50,
};

/** Customer 2: one report per completed session, only FAIL/REVIEW rows, day-first dates, image links. */
export const GLOBEX_SESSION_SPEC: ExportSpecInput = {
  name: 'Per-session defect report',
  columns: [
    { field: 'session_id', header: 'session' },
    { field: 'part_serial', header: 'part' },
    { field: 'result', header: 'outcome' },
    { field: 'defect', header: 'defect_code' },
    { field: 'metadata.batch', header: 'batch' },
    { field: 'metadata.defect_area_mm2', header: 'area_mm2' },
    { field: 'image_ref', header: 'image_url' },
    { field: 'inspected_at', header: 'time' },
  ],
  dateFormat: 'dd-MM-yyyy HH:mm:ss',
  timezone: 'UTC',
  filters: { results: ['FAIL', 'REVIEW'] },
  grouping: { groupBy: ['session_id'], closeWhen: { type: 'EVENT', event: 'session.completed', settleSeconds: 10 } },
  correction: { lookbackHours: 48 },
  delivery: { type: 'local_folder', folder: 'globex-qa' },
  chunkSize: 25,
};

const TYPES = ['surface', 'dimension', 'weld', 'label'];
const DEFECTS = ['scratch', 'dent', 'crack', 'misprint'];

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Customer-specific metadata, as each customer's inspection setup would send it.
 * Acme and Globex have different keys, and some keys exist only on some records.
 */
function demoMetadata(
  workspaceId: string,
  record: { type: string; result: string; inspectedAt: Date },
): Record<string, unknown> {
  if (workspaceId === DEMO.acme.workspaceId) {
    return {
      line: 'L1',
      shift: record.inspectedAt.getUTCHours() < 12 ? 'A' : 'B',
      operator: pick(['op-12', 'op-17', 'op-23']),
      camera: pick(['cam-1', 'cam-2']),
      // Only weld checks measure torque.
      ...(record.type === 'weld' ? { torque_nm: round1(11.5 + Math.random() * 1.5) } : {}),
    };
  }
  if (workspaceId === DEMO.globex.workspaceId) {
    return {
      station: 'QA-2',
      batch: pick(['B-2611-A', 'B-2611-B']),
      inspector: pick(['kim', 'ravi', 'sara']),
      // Only defects have a measured area.
      ...(record.result !== 'PASS' ? { defect_area_mm2: round1(0.5 + Math.random() * 6) } : {}),
    };
  }
  return { source: 'demo' };
}

export interface NewRecord {
  workspaceId: string;
  sessionId: string;
  inspectedAt: Date;
  finalizedAt: Date | null;
}

/** Inserts inspection records with varied results. Returns the new record ids. */
export async function insertRecords(db: Db, records: NewRecord[]): Promise<string[]> {
  const rows = records.map((r) => {
    const id = `rec-${randomUUID().slice(0, 12)}`;
    const roll = Math.random();
    const result = roll < 0.75 ? 'PASS' : roll < 0.92 ? 'FAIL' : 'REVIEW';
    const type = pick(TYPES);
    return {
      id,
      ...r,
      serial: `SN-${Math.floor(100000 + Math.random() * 900000)}`,
      type,
      result,
      defect: result === 'PASS' ? null : pick(DEFECTS),
      metadata: demoMetadata(r.workspaceId, { type, result, inspectedAt: r.inspectedAt }),
      // Public sample images only. Real customer images must never be made public.
      image: `https://picsum.photos/seed/${id}/320/240`,
    };
  });

  await db.query(
    `INSERT INTO inspection_record
       (id, workspace_id, session_id, part_serial, inspection_type, result, defect, image_ref, inspected_at, finalized_at,
        metadata)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                          $9::timestamptz[], $10::timestamptz[], $11::jsonb[])`,
    [
      rows.map((r) => r.id),
      rows.map((r) => r.workspaceId),
      rows.map((r) => r.sessionId),
      rows.map((r) => r.serial),
      rows.map((r) => r.type),
      rows.map((r) => r.result),
      rows.map((r) => r.defect),
      rows.map((r) => r.image),
      rows.map((r) => r.inspectedAt),
      rows.map((r) => r.finalizedAt),
      rows.map((r) => JSON.stringify(r.metadata)),
    ],
  );
  return rows.map((r) => r.id);
}

export async function ensureSession(db: Db, workspaceId: string, sessionId: string, startedAt: Date): Promise<void> {
  await db.query(
    `INSERT INTO inspection_session (id, workspace_id, started_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [sessionId, workspaceId, startedAt],
  );
}

/** Two tenants, one workspace each, recent records, and the two demo configs. Safe to run twice. */
export async function seedDemo(db: Db, now: Date): Promise<{ created: boolean }> {
  const exists = await db.query('SELECT 1 FROM workspace WHERE id = $1', [DEMO.acme.workspaceId]);
  if (exists.rowCount) return { created: false };

  await db.query(`INSERT INTO tenant (id, name) VALUES ($1, 'Acme Motors'), ($2, 'Globex Electronics')`, [
    DEMO.acme.tenantId,
    DEMO.globex.tenantId,
  ]);
  await db.query(`INSERT INTO workspace (id, tenant_id, name) VALUES ($1, $2, 'Acme Line 1'), ($3, $4, 'Globex QA')`, [
    DEMO.acme.workspaceId,
    DEMO.acme.tenantId,
    DEMO.globex.workspaceId,
    DEMO.globex.tenantId,
  ]);

  const hourMs = 3_600_000;

  // Acme: steady stream over the last 4 hours, one session per hour.
  const acmeRecords: NewRecord[] = [];
  for (let h = 4; h >= 1; h--) {
    const sessionId = `ACME-S-${h}`;
    await ensureSession(db, DEMO.acme.workspaceId, sessionId, new Date(now.getTime() - h * hourMs));
    for (let i = 0; i < 80; i++) {
      const inspectedAt = new Date(now.getTime() - h * hourMs + (i / 80) * hourMs);
      acmeRecords.push({
        workspaceId: DEMO.acme.workspaceId,
        sessionId,
        inspectedAt,
        finalizedAt: plusSeconds(inspectedAt, 30),
      });
    }
  }
  await insertRecords(
    db,
    acmeRecords.filter((r) => r.finalizedAt! < now),
  );

  // Globex: three sessions in the last 2 hours. The demo completes them with events.
  const globexRecords: NewRecord[] = [];
  for (const [n, startMinutesAgo] of [
    [1, 120],
    [2, 80],
    [3, 40],
  ] as const) {
    const sessionId = `GLX-S-${n}`;
    const start = new Date(now.getTime() - startMinutesAgo * 60_000);
    await ensureSession(db, DEMO.globex.workspaceId, sessionId, start);
    for (let i = 0; i < 60; i++) {
      const inspectedAt = new Date(start.getTime() + i * 30_000);
      globexRecords.push({
        workspaceId: DEMO.globex.workspaceId,
        sessionId,
        inspectedAt,
        finalizedAt: plusSeconds(inspectedAt, 20),
      });
    }
  }
  await insertRecords(
    db,
    globexRecords.filter((r) => r.finalizedAt! < now),
  );

  // Configs start 4 hours ago so the scheduler has closed hours to export right away.
  const configStart = new Date(now.getTime() - 4 * hourMs);
  await createConfig(db, DEMO.acme.workspaceId, ACME_HOURLY_SPEC, DEMO.acme.userId, configStart);
  await createConfig(db, DEMO.globex.workspaceId, GLOBEX_SESSION_SPEC, DEMO.globex.userId, configStart);
  return { created: true };
}

function plusSeconds(d: Date, s: number): Date {
  return new Date(d.getTime() + s * 1000);
}

export const DemoRecordsSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Use letters, numbers, - and _ only'),
  count: z.number().int().min(1).max(200).default(20),
  /** 0 = inspected now. More = inspected in the past but arriving now (a late record). */
  minutesAgo: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(0),
});

/**
 * Adds finalized records, as the inspection platform would. Used by the UI demo tool and the CLI.
 * Finalized just before the cutoff safety margin, so the next export can pick them up.
 */
export async function addDemoRecords(
  db: Db,
  workspaceId: string,
  input: z.input<typeof DemoRecordsSchema>,
  now: Date,
  cutoffSafetySeconds: number,
): Promise<{ sessionId: string; added: number; inspectedFrom: Date; inspectedTo: Date }> {
  const { sessionId, count, minutesAgo } = DemoRecordsSchema.parse(input);
  const newest = new Date(now.getTime() - minutesAgo * 60_000);
  await ensureSession(db, workspaceId, sessionId, new Date(newest.getTime() - (count - 1) * 1000));
  const ids = await insertRecords(
    db,
    Array.from({ length: count }, (_, i) => ({
      workspaceId,
      sessionId,
      inspectedAt: new Date(newest.getTime() - i * 1000),
      finalizedAt: new Date(now.getTime() - (cutoffSafetySeconds + 1) * 1000),
    })),
  );
  return {
    sessionId,
    added: ids.length,
    inspectedFrom: new Date(newest.getTime() - (count - 1) * 1000),
    inspectedTo: newest,
  };
}
