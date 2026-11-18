import type { Workspace } from '../workspace';
import type {
  EventOutcome,
  ExportConfig,
  ExportDetail,
  ExportSummary,
  FieldGroup,
  Fields,
  JobStatus,
  JobTrigger,
  ManualExportRequest,
  Preview,
} from './types';

/** An error from the API, with the validation issues if there are any. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: { path: (string | number)[]; message: string }[] = [],
  ) {
    super(message);
  }
}

async function request<T>(ws: Workspace, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      // Simulated login: the backend reads the tenant from this header, never from the URL.
      'x-tenant-id': ws.tenantId,
      'x-user-id': 'ui-user',
      ...init.headers,
    },
  });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText, body?.issues);
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  listExports: (ws: Workspace, filters: { status?: JobStatus; trigger?: JobTrigger }) => {
    const query = new URLSearchParams({ limit: '100' });
    if (filters.status) query.set('status', filters.status);
    if (filters.trigger) query.set('trigger', filters.trigger);
    return request<{ items: ExportSummary[] }>(ws, `/api/workspaces/${ws.workspaceId}/exports?${query}`);
  },

  getExport: (ws: Workspace, jobId: string) => request<ExportDetail>(ws, `/api/exports/${jobId}`),

  retryExport: (ws: Workspace, jobId: string) => request<ExportSummary>(ws, `/api/exports/${jobId}/retry`, post({})),

  startManualExport: (ws: Workspace, body: ManualExportRequest) =>
    request<ExportSummary>(ws, `/api/workspaces/${ws.workspaceId}/exports`, post(body)),

  getConfig: (ws: Workspace, version?: number) =>
    request<ExportConfig>(ws, `/api/workspaces/${ws.workspaceId}/export-config${version ? `?version=${version}` : ''}`),

  saveConfig: (ws: Workspace, spec: unknown) =>
    request<ExportConfig>(ws, `/api/workspaces/${ws.workspaceId}/export-config`, {
      method: 'PUT',
      body: JSON.stringify(spec),
    }),

  /** Standard fields plus the metadata keys this customer's records really have. */
  getFields: (ws: Workspace) => request<Fields>(ws, `/api/workspaces/${ws.workspaceId}/fields`),

  /** The customer's own field groups. `groups: null` = not made yet (use the default groups). */
  getFieldLayout: (ws: Workspace) =>
    request<{ groups: FieldGroup[] | null }>(ws, `/api/workspaces/${ws.workspaceId}/field-layout`),

  saveFieldLayout: (ws: Workspace, layout: { groups: FieldGroup[] }) =>
    request<{ groups: FieldGroup[] }>(ws, `/api/workspaces/${ws.workspaceId}/field-layout`, {
      method: 'PUT',
      body: JSON.stringify(layout),
    }),

  preview: (ws: Workspace, spec: unknown) =>
    request<Preview>(ws, `/api/workspaces/${ws.workspaceId}/export-config/preview`, post(spec)),

  /** Simulates the inspection platform saying "this session is finished". */
  completeSession: (ws: Workspace, sessionId: string, eventId: string) =>
    request<{ outcome: EventOutcome }>(
      ws,
      '/internal/events',
      post({
        eventId,
        type: 'session.completed',
        workspaceId: ws.workspaceId,
        sessionId,
        occurredAt: new Date().toISOString(),
      }),
    ),

  /** Demo only: adds fake inspection records, as the inspection app would. */
  addDemoRecords: (ws: Workspace, body: { sessionId: string; count: number; minutesAgo: number }) =>
    request<{ sessionId: string; added: number; inspectedFrom: string; inspectedTo: string }>(
      ws,
      `/api/workspaces/${ws.workspaceId}/demo/records`,
      post(body),
    ),

  /** The file is downloaded with the tenant header, then handed to the browser as a blob. */
  downloadFile: async (ws: Workspace, jobId: string, fileName: string) => {
    const res = await fetch(`/api/exports/${jobId}/file`, { headers: { 'x-tenant-id': ws.tenantId } });
    if (!res.ok) throw new ApiError(res.status, 'Download failed');
    const url = URL.createObjectURL(await res.blob());
    const link = Object.assign(document.createElement('a'), { href: url, download: fileName });
    link.click();
    URL.revokeObjectURL(url);
  },

  fileText: async (ws: Workspace, jobId: string) => {
    const res = await fetch(`/api/exports/${jobId}/file`, { headers: { 'x-tenant-id': ws.tenantId } });
    if (!res.ok) throw new ApiError(res.status, 'Could not load the file');
    return res.text();
  },
};
