import type { Db, Queryable } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { conflict, notFound } from '../../lib/errors.js';
import { planGroupingChange } from './grouping-switch.js';
import { parseSpec, type ExportSpec } from './spec.js';

export interface ConfigVersion {
  configId: string;
  workspaceId: string;
  version: number;
  currentVersion: number;
  spec: ExportSpec;
  createdBy: string;
  createdAt: Date;
  configCreatedAt: Date;
  /** Set when this version changes the schedule type: the moment the new grouping starts. */
  effectiveFrom: Date | null;
}

interface VersionRow {
  config_id: string;
  workspace_id: string;
  version: number;
  current_version: number;
  spec: ExportSpec;
  created_by: string;
  created_at: Date;
  config_created_at: Date;
  effective_from: Date | null;
}

const SELECT_VERSION = `
  SELECT c.id AS config_id, c.workspace_id, v.version, c.current_version, v.spec,
         v.created_by, v.created_at, c.created_at AS config_created_at, v.effective_from
  FROM export_config c
  JOIN export_config_version v ON v.config_id = c.id`;

function toConfigVersion(row: VersionRow): ConfigVersion {
  return {
    configId: row.config_id,
    workspaceId: row.workspace_id,
    version: row.version,
    currentVersion: row.current_version,
    spec: row.spec,
    createdBy: row.created_by,
    createdAt: row.created_at,
    configCreatedAt: row.config_created_at,
    effectiveFrom: row.effective_from,
  };
}

/**
 * Creates the workspace's export config as version 1.
 * `createdAt` lets the seed/demo backdate the schedule start; it defaults to now.
 */
export async function createConfig(
  db: Db,
  workspaceId: string,
  specInput: unknown,
  userId: string,
  createdAt: Date = new Date(),
): Promise<ConfigVersion> {
  const spec = parseSpec(specInput);
  return withTransaction(db, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO export_config (workspace_id, current_version, created_at, updated_at)
       VALUES ($1, 1, $2, $2)
       ON CONFLICT (workspace_id) DO NOTHING
       RETURNING id`,
      [workspaceId, createdAt],
    );
    const configId = inserted.rows[0]?.id;
    if (!configId) throw conflict('This workspace already has an export config. Use PUT to change it.');

    await client.query(
      `INSERT INTO export_config_version (config_id, version, spec, created_by, created_at) VALUES ($1, 1, $2, $3, $4)`,
      [configId, spec, userId, createdAt],
    );
    return getConfigVersion(client, workspaceId);
  });
}

/**
 * Saves a new immutable version and makes it current. Old versions are never changed.
 * A schedule change (grouping) does not start right away but at the next clean boundary,
 * stored as effective_from (see grouping-switch.ts).
 */
export async function updateConfig(
  db: Db,
  workspaceId: string,
  specInput: unknown,
  userId: string,
  now: Date = new Date(),
): Promise<ConfigVersion> {
  const spec = parseSpec(specInput);
  return withTransaction(db, async (client) => {
    const locked = await client.query<{ id: string; current_version: number }>(
      'SELECT id, current_version FROM export_config WHERE workspace_id = $1 FOR UPDATE',
      [workspaceId],
    );
    const config = locked.rows[0];
    if (!config) throw notFound('This workspace has no export config yet. Use POST to create it.');

    const current = await getConfigVersion(client, workspaceId, config.current_version);
    const effectiveFrom = await planGroupingChange(client, config.id, current.spec, spec, now);

    const next = config.current_version + 1;
    await client.query(
      `INSERT INTO export_config_version (config_id, version, spec, created_by, effective_from)
       VALUES ($1, $2, $3, $4, $5)`,
      [config.id, next, spec, userId, effectiveFrom],
    );
    await client.query('UPDATE export_config SET current_version = $2, updated_at = now() WHERE id = $1', [
      config.id,
      next,
    ]);
    return getConfigVersion(client, workspaceId);
  });
}

/** Loads the current version, or a specific one. */
export async function getConfigVersion(db: Queryable, workspaceId: string, version?: number): Promise<ConfigVersion> {
  const { rows } = await db.query<VersionRow>(
    `${SELECT_VERSION}
     WHERE c.workspace_id = $1 AND v.version = COALESCE($2, c.current_version)`,
    [workspaceId, version ?? null],
  );
  const row = rows[0];
  if (!row) throw notFound(version ? `Config version ${version} not found` : 'This workspace has no export config');
  return toConfigVersion(row);
}

/** Loads a version by config id. Used by jobs, which pin a version (D-09). */
export async function getConfigVersionById(db: Queryable, configId: string, version: number): Promise<ConfigVersion> {
  const { rows } = await db.query<VersionRow>(`${SELECT_VERSION} WHERE c.id = $1 AND v.version = $2`, [
    configId,
    version,
  ]);
  const row = rows[0];
  if (!row) throw notFound(`Config ${configId} version ${version} not found`);
  return toConfigVersion(row);
}

/** Current versions of all configs. Used by the scheduler. */
export async function listCurrentConfigs(db: Queryable): Promise<ConfigVersion[]> {
  const { rows } = await db.query<VersionRow>(`${SELECT_VERSION} WHERE v.version = c.current_version ORDER BY c.id`);
  return rows.map(toConfigVersion);
}
