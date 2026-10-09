import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import { Button } from '@labos-threejs/ui/components/button';
import { Skeleton } from '@labos-threejs/ui/components/skeleton';
import { Box } from 'lucide-react';
import { useAppMessage } from '../shell/messages';
import WorldView from './world-view';
import {
  WorkbenchProvider,
  useLabWorkbench,
  type WorkbenchProps,
} from './workbench-context';

function CurrentSpace() {
  const { labId, labs, invalidLink, viewUnavailable, openSpace } =
    useLabWorkbench();
  const message = useAppMessage('lab');
  if (invalidLink || viewUnavailable)
    return (
      <section className="flex flex-col gap-4 p-6">
        <Alert>
          <AlertDescription>
            {message(
              invalidLink
                ? 'workbench.invalidLink'
                : 'workbench.viewUnavailable',
            )}
          </AlertDescription>
        </Alert>
        <Button className="w-fit" onClick={openSpace}>
          <Box data-icon="inline-start" />
          {message('workbench.openSpace')}
        </Button>
      </section>
    );
  if (labs.isPending && !labId) return <Skeleton className="m-6 h-40" />;
  return <WorldView key={labId} />;
}

export default function Workbench(props: WorkbenchProps) {
  return (
    <WorkbenchProvider {...props}>
      <CurrentSpace />
    </WorkbenchProvider>
  );
}
