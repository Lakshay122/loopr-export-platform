import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { createPool, type Db } from '../../src/db/pool.js';
import { fixedClock } from '../../src/lib/clock.js';
import { createConfig } from '../../src/modules/export-config/config-service.js';
import type { ExportSpecInput } from '../../src/modules/export-config/spec.js';
import { Scheduler } from '../../src/modules/scheduler/scheduler.js';
import { LocalStorage } from '../../src/modules/storage/local-storage.js';
import { TaskRunner, type FaultHooks } from '../../src/modules/worker/task-runner.js';
import { TEST_DATABASE_URL } from './env.js';

export const silentLogger = pino({ level: 'silent' });

const TABLES = [
  'field_layout',
  'late_record_flag',
  'processed_event',
  'export_artifact',
  'export_outbox',
  'export_task',
  'export_partition',
  'export_job',
  'export_config_version',
  'export_config',
  'inspection_record',
  'inspection_session',
  'workspace',
  'tenant',
];

export const SETTINGS = {
  cutoffSafetySeconds: 0,
  maxAttempts: 3,
  leaseSeconds: 30,
  workspaceMaxRunning: 100,
  retryBaseMs: 10,
};

/**
 * Everything an integration test needs: a real PostgreSQL database, a temp storage
 * folder, a controllable clock, a scheduler and task runners.
 */
export class TestContext {
  readonly clock = fixedClock(new Date('2026-11-11T10:00:00Z'));
  readonly scheduler: Scheduler;
  private recordSeq = 0;

  private constructor(
    readonly db: Db,
    readonly storageDir: string,
    readonly storage: LocalStorage,
  ) {
    this.scheduler = new Scheduler({ db, clock: this.clock, logger: silentLogger, settings: SETTINGS });
  }

  static async create(): Promise<TestContext> {
    const db = createPool(TEST_DATABASE_URL);
    await db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    const dir = await mkdtemp(path.join(tmpdir(), 'loopr-export-test-'));
    return new TestContext(db, dir, new LocalStorage(dir));
  }

  async close(): Promise<void> {
    await this.db.end();
    await rm(this.storageDir, { recursive: true, force: true });
  }

  runner(workerId = 'test-worker', faults?: FaultHooks, settings: Partial<typeof SETTINGS> = {}): TaskRunner {
    return new TaskRunner({
      db: this.db,
      storage: this.storage,
      workerId,
      logger: silentLogger,
      settings: { ...SETTINGS, ...settings },
      faults,
    });
  }

  /** Creates a tenant + workspace (+ optional config created at the current test time). */
  async workspace(id: string, tenantId = `tenant-${id}`, spec?: ExportSpecInput): Promise<void> {
    await this.db.query('INSERT INTO tenant (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [tenantId]);
    await this.db.query('INSERT INTO workspace (id, tenant_id, name) VALUES ($1, $2, $1)', [id, tenantId]);
    if (spec) await createConfig(this.db, id, spec, 'tester', this.clock.now());
  }

  /** Inserts records. Defaults: session S-1, result PASS, finalized at inspected_at + 1s. */
  async records(
    workspaceId: string,
    items: Array<{
      inspectedAt: string | Date;
      finalizedAt?: string | Date | null;
      sessionId?: string;
      result?: string;
      id?: string;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const item of items) {
      const id = item.id ?? `r${String(++this.recordSeq).padStart(4, '0')}`;
      const sessionId = item.sessionId ?? 'S-1';
      const inspectedAt = new Date(item.inspectedAt);
      const finalizedAt = item.finalizedAt === undefined ? new Date(inspectedAt.getTime() + 1000) : item.finalizedAt;
      await this.db.query(
        `INSERT INTO inspection_session (id, workspace_id, started_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [sessionId, workspaceId, inspectedAt],
      );
      await this.db.query(
        `INSERT INTO inspection_record (id, workspace_id, session_id, part_serial, inspection_type, result, inspected_at, finalized_at, metadata)
         VALUES ($1, $2, $3, $4, 'surface', $5, $6, $7, $8)`,
        [
          id,
          workspaceId,
          sessionId,
          `SN-${id}`,
          item.result ?? 'PASS',
          inspectedAt,
          finalizedAt ? new Date(finalizedAt) : null,
          JSON.stringify(item.metadata ?? {}),
        ],
      );
      ids.push(id);
    }
    return ids;
  }

  /**
   * Plays the role of dispatcher + queue + worker, in-process: takes due outbox rows
   * and runs their tasks until nothing is left. `dueNow` also releases delayed retries.
   */
  async pump(runner = this.runner(), opts: { dueNow?: boolean } = {}): Promise<void> {
    for (let round = 0; round < 500; round++) {
      if (opts.dueNow) await this.makeRetriesDue();
      const { rows } = await this.db.query<{ task_id: string }>(
        `UPDATE export_outbox SET published_at = now()
         WHERE id IN (SELECT id FROM export_outbox WHERE published_at IS NULL AND available_at <= now())
         RETURNING task_id`,
      );
      if (rows.length === 0) return;
      for (const { task_id } of rows) await runner.run(task_id);
    }
    throw new Error('pump did not settle');
  }

  async makeRetriesDue(): Promise<void> {
    await this.db.query(`UPDATE export_task SET run_after = now() WHERE status = 'RETRY_WAIT'`);
    await this.db.query(`UPDATE export_outbox SET available_at = now() WHERE published_at IS NULL`);
  }

  /** Tick the scheduler and run everything it started. */
  async tickAndRun(): Promise<void> {
    await this.scheduler.tick();
    await this.pump();
  }

  async jobs(workspaceId?: string) {
    const { rows } = await this.db.query<{
      id: string;
      status: string;
      trigger: string;
      file_name: string;
      row_count: number | null;
      correction_no: number | null;
      config_version: number;
      error: string | null;
    }>(
      `SELECT id, status, trigger, file_name, row_count, correction_no, config_version, error
       FROM export_job WHERE ($1::text IS NULL OR workspace_id = $1) ORDER BY created_at, file_name`,
      [workspaceId ?? null],
    );
    return rows;
  }

  /** Published files of a delivery folder: name -> lines. */
  async files(folder: string): Promise<Map<string, string[]>> {
    const dir = path.join(this.storageDir, 'exports', folder);
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.csv')).sort();
    const result = new Map<string, string[]>();
    for (const name of names) {
      const text = await readFile(path.join(dir, name), 'utf8');
      result.set(name, text.split('\n').filter(Boolean));
    }
    return result;
  }

  /** Record ids (first column) of every data row across all files in a folder. */
  async exportedIds(folder: string): Promise<string[]> {
    const ids: string[] = [];
    for (const lines of (await this.files(folder)).values()) ids.push(...lines.slice(1).map((l) => l.split(',')[0]!));
    return ids;
  }
}

/** A small config used by most tests: hourly UTC buckets, record id first. */
export function hourlySpec(overrides: Partial<ExportSpecInput> = {}): ExportSpecInput {
  return {
    name: 'test hourly',
    columns: [{ field: 'record_id' }, { field: 'result' }, { field: 'inspected_at' }],
    timezone: 'UTC',
    grouping: { groupBy: ['time_bucket(1h)'], closeWhen: { type: 'TIME', graceSeconds: 300 } },
    correction: { lookbackHours: 24 },
    delivery: { type: 'local_folder', folder: 'out' },
    chunkSize: 10,
    ...overrides,
  };
}

export function sessionSpec(overrides: Partial<ExportSpecInput> = {}): ExportSpecInput {
  return {
    name: 'test per session',
    columns: [{ field: 'record_id' }, { field: 'session_id' }, { field: 'result' }],
    grouping: { groupBy: ['session_id'], closeWhen: { type: 'EVENT', event: 'session.completed', settleSeconds: 60 } },
    correction: { lookbackHours: 24 },
    delivery: { type: 'local_folder', folder: 'sessions' },
    chunkSize: 10,
    ...overrides,
  };
}
