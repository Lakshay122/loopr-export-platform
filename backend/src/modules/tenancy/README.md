# tenancy

`requireWorkspace(db, caller, workspaceId)` loads a workspace **only if it belongs to the caller's tenant**.

- The tenant always comes from the caller (simulated `x-tenant-id` header; production: a verified token).
  It is never read from the URL or the request body.
- A workspace of another tenant returns **404**, not 403, so we do not reveal that it exists.
- Exports are loaded with `getJobForTenant`, which applies the same rule.

Production extra (design only): PostgreSQL row-level security as a second safety layer.
