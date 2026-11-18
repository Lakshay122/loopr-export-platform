import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * The two demo customers created by `cli.js seed`.
 * There is no login screen: picking a workspace here sets the `x-tenant-id` header (simulated auth).
 */
export interface Workspace {
  tenantId: string;
  workspaceId: string;
  label: string;
  grouping: 'TIME' | 'SESSION';
  description: string;
}

export const WORKSPACES: Workspace[] = [
  {
    tenantId: 'tenant-acme',
    workspaceId: 'ws-acme-line1',
    label: 'Acme · Line 1',
    grouping: 'TIME',
    description: 'One CSV every hour (India time). PASS/FAIL renamed to OK/NG.',
  },
  {
    tenantId: 'tenant-globex',
    workspaceId: 'ws-globex-qa',
    label: 'Globex · QA',
    grouping: 'SESSION',
    description: 'One CSV per inspection session, only FAIL and REVIEW rows.',
  },
];

const STORAGE_KEY = 'loopr.workspace';

function initialWorkspace(): Workspace {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return WORKSPACES.find((w) => w.workspaceId === saved) ?? WORKSPACES[0]!;
  } catch {
    return WORKSPACES[0]!;
  }
}

const WorkspaceContext = createContext<{ ws: Workspace; setWs: (ws: Workspace) => void } | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [ws, setWsState] = useState(initialWorkspace);
  const setWs = (next: Workspace) => {
    setWsState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next.workspaceId);
    } catch {
      // Storage may be blocked; the choice just won't be remembered.
    }
  };
  return <WorkspaceContext.Provider value={{ ws, setWs }}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return value;
}
