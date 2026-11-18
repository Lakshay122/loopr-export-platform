-- How a workspace groups its fields on the settings screen ("Timestamps", "Machine data", ...).
-- Only a display layout: it never changes what an export contains, so it is not versioned
-- like export_config. One row per workspace; no row means "use the default groups".
CREATE TABLE field_layout (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspace(id),
  groups        JSONB NOT NULL,
  updated_by    TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
