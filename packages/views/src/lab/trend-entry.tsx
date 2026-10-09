import { lazy, Suspense, useState } from 'react';
import { ChartLine } from 'lucide-react';
import type { ApiClient, LabEntity } from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Skeleton } from '@labos-threejs/ui/components/skeleton';
import { useAppMessage } from '../shell/messages';

const EntityTrends = lazy(() => import('./entity-trends'));

export default function TrendEntry(props: {
  entity: LabEntity;
  apiClient: ApiClient;
  userId: string;
  worldVersion: string;
  visible: boolean;
  initialOpen?: boolean;
  initialRange?: string;
}) {
  const message = useAppMessage('lab');
  const [open, setOpen] = useState(props.initialOpen ?? false);
  if (!['sensor', 'centrifuge'].includes(props.entity.definition_id))
    return null;
  return (
    <section className="lab-inspector-section">
      <Button
        variant="outline"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChartLine data-icon="inline-start" />
        {message(open ? 'trend.hide' : 'trend.open')}
      </Button>
      {open ? (
        <Suspense fallback={<Skeleton className="h-56" />}>
          <EntityTrends {...props} />
        </Suspense>
      ) : null}
    </section>
  );
}
