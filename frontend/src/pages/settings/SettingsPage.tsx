import { PageHeader } from '../../components/ui';
import { useWorkspace } from '../../workspace';
import { SpecEditor } from './SpecEditor';

/** The customer's export settings as a form, with a live preview. */
export function SettingsPage() {
  const { ws } = useWorkspace();
  return (
    <div className="stack-lg">
      <PageHeader
        title="Settings"
        subtitle="Choose what your CSV file contains. The preview on the right shows the result as you change things."
      />
      <SpecEditor key={ws.workspaceId} />
    </div>
  );
}
