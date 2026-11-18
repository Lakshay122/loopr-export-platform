# Frontend

A small React + Vite app to **see and understand** the export process. It only calls the backend API
([docs/api.md](../docs/api.md)); there is no business logic here.

## Run it

With Docker (part of the normal stack):

```bash
docker compose up -d --build      # UI on http://localhost:8080
```

Without Docker, while the API runs on port 3000:

```bash
npm install
npm run dev                       # http://localhost:5173
```

In both cases `/api` and `/internal` are forwarded to the API (nginx in Docker, the Vite proxy in dev),
so the browser talks to one address and no CORS setup is needed.

## Screens

Written for the **customer**: plain words, no internal terms. Engineering details are kept in a
collapsed "Technical details" section and on the "How it works" page.

| Screen | What it shows |
| --- | --- |
| **Overview** (home) | What this customer's export does, in one sentence ("A CSV file is sent every hour…"), the columns in each file, numbers for the last 24 hours, a warning if a report failed, and the latest reports with a Download button. |
| **Reports** | Every file sent: the period or session it covers, type (scheduled report, late records update, one-time export), status (Waiting, In progress, Delivered, Failed), rows, Download. Tabs filter by status. Refreshes every 3 s. |
| **Report detail** | A plain summary (when, how many rows, what the file contains), a table preview of the file, Download, and "Try again" if it failed. A progress bar while it is being made. "Technical details" (closed by default) shows the cutoff window, settings version, SHA-256 and every task with its attempts and worker. |
| **Settings** | Five simple tabs, no JSON: **Columns** (starts with *What a record contains*: every field with a real value, in groups the customer makes (create, rename, delete groups, drag any field into any group; new fields appear by themselves as "new"), each with "+ Add"; then tick standard data or the customer's own extra fields found in their records, type the column name, drag to reorder, change values like `FAIL → Rejected` by picking from the values found in the customer's data, choose what to write when a value is missing), **Which records** (All / PASS / FAIL / REVIEW pills, plus filters on extra fields like `line is L1`), **Dates** (pick a format from examples), **Grouping & schedule** (group by time or by inspection session, how often, plain wait times; a change shows when it starts), **Delivery** (name, folder). A live preview of the file sits on the right, and a save bar appears only when something changed. |
| **New export** | A one-time CSV: quick time presets (last hour / 24 hours / 7 days / custom), optional result and session filters. The request id (protection against double clicks) is under "Advanced". |
| **Demo tools** | Demo only. Adds fake inspection records (now, or in the past to test late records) and sends "session finished", with step-by-step guidance for the selected customer. Calls an API endpoint that exists only when `DEMO_TOOLS=true`. |
| **How it works** | Behind the scenes, for engineers and reviewers: the pipeline step by step, how the cutoff decides which records go in a file, and what happens on each failure. |

## Customer picker = simulated login

The picker at the top right chooses one of the two demo customers. It sets the `x-tenant-id` header on
every request. A real product would use a login and a token instead.

The server is still the judge: the form only helps the customer, and every preview and save is
validated by the backend (`backend/src/modules/export-config/spec.ts`).

## Code layout

```
src/
├── main.tsx              # React root + router
├── App.tsx               # top bar, customer picker, routes
├── workspace.tsx         # the 2 demo customers + context
├── api/                  # typed fetch client and response types
├── hooks/usePolling.ts   # load now, then refresh on a timer
├── components/           # status pill, progress bar, error box, reports table
├── lib/                  # friendly labels and dates (format.ts), CSV parsing for the file preview
├── pages/                # one file per screen
│   └── settings/         # settings form: SpecEditor, ColumnsEditor, spec-model (labels, defaults)
└── styles.css            # light black-and-white theme
```

Commands: `npm run build` (typecheck + build), `npm run typecheck`, `npm run format`.
