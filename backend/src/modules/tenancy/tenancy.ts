import type { Queryable } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';

/** Who is calling. In production this comes from a verified token, never from the URL. */
export interface Caller {
  tenantId: string;
  userId: string;
}

export interface Workspace {
  id: string;
  tenantId: string;
  name: string;
}

/**
 * Loads a workspace only if it belongs to the caller's tenant.
 * Returns 404 (not 403) for other tenants' workspaces, so we do not reveal that they exist.
 */
export async function requireWorkspace(db: Queryable, caller: Caller, workspaceId: string): Promise<Workspace> {
  const { rows } = await db.query<{ id: string; tenant_id: string; name: string }>(
    'SELECT id, tenant_id, name FROM workspace WHERE id = $1 AND tenant_id = $2',
    [workspaceId, caller.tenantId],
  );
  const row = rows[0];
  if (!row) throw notFound('Workspace not found');
  return { id: row.id, tenantId: row.tenant_id, name: row.name };
}
