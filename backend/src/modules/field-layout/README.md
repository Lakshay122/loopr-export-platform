# field-layout

How a workspace groups its fields on the settings screen, e.g. a "Machine data" group with
`metadata.operator` and `metadata.torque_nm`.

- **Display only.** Exports never read it, so it is not versioned like the export settings.
  Column order in the CSV is still set by the export spec.
- **No row = default groups** (Timestamps, Results, Image reference, Identity, Metadata), built by the UI.
- **New fields are never hidden.** Fields in no group are shown by the UI as "new", so a field the
  inspection app starts sending later appears without anyone editing the layout.
- **Rules:** at most 20 groups, a field can be in only one group, field names follow the same rule
  as export columns (a standard field or `metadata.<key>`).

API: `GET` / `PUT /api/workspaces/{id}/field-layout`.
