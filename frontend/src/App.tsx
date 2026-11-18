import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { DemoPage } from './pages/DemoPage';
import { HowItWorksPage } from './pages/HowItWorksPage';
import { NewExportPage } from './pages/NewExportPage';
import { OverviewPage } from './pages/OverviewPage';
import { ReportDetailPage } from './pages/ReportDetailPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { useWorkspace, WORKSPACES } from './workspace';

export function App() {
  const { ws, setWs } = useWorkspace();

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="logo">L</span> Loopr <span className="brand-sub">Data exports</span>
          </div>
          <nav>
            <NavLink to="/overview">Overview</NavLink>
            <NavLink to="/reports">Reports</NavLink>
            <NavLink to="/settings">Settings</NavLink>
            <NavLink to="/new-export">New export</NavLink>
          </nav>
          <div className="topbar-right">
            <NavLink to="/demo" className="help-link">
              Demo tools
            </NavLink>
            <NavLink to="/how-it-works" className="help-link">
              How it works
            </NavLink>
            <label className="workspace-picker" title="Demo: switches customer (simulated login)">
              <span className="sr-only">Customer</span>
              <select
                value={ws.workspaceId}
                onChange={(e) => setWs(WORKSPACES.find((w) => w.workspaceId === e.target.value)!)}
              >
                {WORKSPACES.map((w) => (
                  <option key={w.workspaceId} value={w.workspaceId}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/reports/:jobId" element={<ReportDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/new-export" element={<NewExportPage />} />
          <Route path="/demo" element={<DemoPage />} />
          <Route path="/how-it-works" element={<HowItWorksPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
