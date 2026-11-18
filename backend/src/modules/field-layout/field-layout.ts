import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';
import { EXPORT_FIELDS } from '../export-config/spec.js';

/**
 * Customer-defined groups of fields for the settings screen, e.g. "Machine data": operator,
 * torque_nm. Display only: exports never read it. Fields not in any group are shown by the
 * UI as "new", so a field the inspection app starts sending later is never hidden.
 */

const FieldName = z.union([
  z.enum(EXPORT_FIELDS),
  z.string().regex(/^metadata\.[A-Za-z0-9_]{1,40}$/, 'Use a known field or metadata.<key>'),
]);

export const FieldLayoutSchema = z
  .object({
    groups: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
            name: z.string().trim().min(1, 'Give the group a name').max(40),
            fields: z.array(FieldName).max(200),
          })
          .strict(),
      )
      .max(20, 'At most 20 groups'),
  })
  .strict()
  .superRefine((layout, ctx) => {
    const seen = new Set<string>();
    layout.groups.forEach((group, g) =>
      group.fields.forEach((field, f) => {
        if (seen.has(field)) {
          ctx.addIssue({ code: 'custom', path: ['groups', g, 'fields', f], message: `"${field}" is in two groups` });
        }
        seen.add(field);
      }),
    );
    const ids = layout.groups.map((g) => g.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', path: ['groups'], message: 'Duplicate group id' });
  });

export type FieldLayout = z.infer<typeof FieldLayoutSchema>;

export interface StoredFieldLayout extends FieldLayout {
  updatedBy: string | null;
  updatedAt: Date | null;
}

/** The saved layout, or `groups: null` when the workspace still uses the default groups. */
export async function getFieldLayout(
  db: Queryable,
  workspaceId: string,
): Promise<{ groups: FieldLayout['groups'] | null; updatedBy: string | null; updatedAt: Date | null }> {
  const { rows } = await db.query<{ groups: FieldLayout['groups']; updated_by: string; updated_at: Date }>(
    'SELECT groups, updated_by, updated_at FROM field_layout WHERE workspace_id = $1',
    [workspaceId],
  );
  const row = rows[0];
  return row
    ? { groups: row.groups, updatedBy: row.updated_by, updatedAt: row.updated_at }
    : { groups: null, updatedBy: null, updatedAt: null };
}

/** Saves (replaces) the layout. Last write wins: it is a display preference, not export settings. */
export async function saveFieldLayout(
  db: Queryable,
  workspaceId: string,
  input: unknown,
  userId: string,
): Promise<StoredFieldLayout> {
  const layout = FieldLayoutSchema.parse(input);
  const { rows } = await db.query<{ updated_at: Date }>(
    `INSERT INTO field_layout (workspace_id, groups, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (workspace_id) DO UPDATE SET groups = EXCLUDED.groups, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING updated_at`,
    [workspaceId, JSON.stringify(layout.groups), userId],
  );
  return { ...layout, updatedBy: userId, updatedAt: rows[0]!.updated_at };
}
