# export-config

Customer export settings ("spec"): what to export, how it looks, how records are grouped, and where files go.

## Files

| File                 | What it does                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `spec.ts`            | The allowed settings (Zod schema), defaults, and grouping rules. Rejects anything unknown. |
| `config-service.ts`  | Create, update (new version) and load configs.                                             |
| `preview.ts`         | Shows the first rows a spec would produce, on real data, without delivering.               |
| `grouping-switch.ts` | Schedule changes (hourly ↔ per session): when they start, and the "eras" of each grouping. |

## Rules

- **One config per workspace** in this prototype.
- **Versions never change.** `PUT` saves a new version and makes it current. Jobs keep the version they started with.
- **Settings, not code.** Only listed fields, formats and grouping keys are allowed. No scripts or templates.
- **A grouping change starts at the next clean boundary**, not right away (bucket size, time zone of buckets,
  time ↔ session). The new version stores `effective_from`. Before it, the old grouping keeps running; a session
  that crosses it is split there. So there is no gap and no duplicate (see `docs/format-evolution.md`).
- **One planned change at a time.** Changes whose time windows never line up are refused.

## Example

```ts
const v1 = await createConfig(db, 'ws-1', spec, 'alice');
const v2 = await updateConfig(db, 'ws-1', { ...spec, name: 'new name' }, 'alice'); // version 2
const old = await getConfigVersion(db, 'ws-1', 1); // still readable
```
