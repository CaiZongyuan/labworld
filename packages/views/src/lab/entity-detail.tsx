import { useState, type ReactNode } from 'react';
import { MapPin, Pencil, X } from 'lucide-react';
import type {
  ApiClient,
  LabEntity,
  LabWorld,
  LabRecord,
} from '@labos-threejs/sdk';
import { Badge } from '@labos-threejs/ui/components/badge';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@labos-threejs/ui/components/tabs';
import { useAppMessage } from '../shell/messages';
import HistoryPanel from './history-panel';
import RecordDetails from './record-details';
import ObservationReading from './observation-reading';
import { readEntityObservations } from './observation-state';
import { Tool } from './view-controls';
import TrendEntry from './trend-entry';

function locationOf(world: LabWorld, entity: LabEntity) {
  const names: string[] = [];
  const visited = new Set([entity.id]);
  let child = entity.id;
  while (true) {
    const relation = world.relationships.find(
      (entry) =>
        (entry.kind === 'located_in' && entry.source_id === child) ||
        (entry.kind === 'contains' && entry.target_id === child),
    );
    if (!relation) break;
    const parent =
      relation.kind === 'located_in' ? relation.target_id : relation.source_id;
    if (visited.has(parent)) break;
    visited.add(parent);
    const container = world.entities.find((entry) => entry.id === parent);
    if (!container) break;
    names.unshift(container.name);
    child = parent;
  }
  return names.join(' / ');
}

export default function EntityDetail({
  entity,
  world,
  apiClient,
  operations,
  children,
  editing,
  onConfigure,
  connected,
  originalRecord,
  onCloseOriginalRecord,
  visible,
  userId,
}: {
  entity: LabEntity;
  world: LabWorld;
  apiClient: ApiClient;
  operations: (readingDetails: ReactNode) => ReactNode;
  children: ReactNode;
  editing: boolean;
  onConfigure: () => void;
  connected: boolean;
  originalRecord?: LabRecord;
  onCloseOriginalRecord?: () => void;
  visible: boolean;
  userId: string;
}) {
  const message = useAppMessage('lab');
  const [tab, setTab] = useState('operations');
  const [recordsOpened, setRecordsOpened] = useState(false);
  const location = locationOf(world, entity);
  return (
    <div className="entity-detail">
      <div className="entity-detail-identity">
        <div className="lab-section-heading">
          <h3 title={entity.name}>{entity.name}</h3>
          <Tool
            icon={Pencil}
            label={message('world.configure')}
            onClick={onConfigure}
            disabled={!connected}
          />
        </div>
        <p
          className="entity-detail-location"
          title={location || message('detail.noLocation')}
        >
          <MapPin aria-hidden="true" />
          {location || message('detail.noLocation')}
        </p>
        <div className="entity-detail-tags">
          <Badge variant="outline">{message(`world.${entity.reality}`)}</Badge>
          <span>{entity.binding?.source ?? message('world.noBinding')}</span>
        </div>
      </div>
      <Tabs
        value={editing || originalRecord ? 'details' : tab}
        onValueChange={(value) => {
          setTab(String(value));
          if (value !== 'details') onCloseOriginalRecord?.();
          if (value === 'records') setRecordsOpened(true);
        }}
      >
        {!editing ? (
          <TabsList
            className="entity-detail-tabs"
            aria-label={message('detail.views')}
          >
            <TabsTrigger value="operations">
              {message('detail.operations')}
            </TabsTrigger>
            <TabsTrigger value="records">
              {message('detail.records')}
            </TabsTrigger>
            <TabsTrigger value="details">
              {message('detail.details')}
            </TabsTrigger>
          </TabsList>
        ) : null}
        <TabsContent value="operations" keepMounted>
          {operations(
            <TrendEntry
              entity={entity}
              apiClient={apiClient}
              userId={userId}
              worldVersion={world.version}
              visible={visible && !editing && tab === 'operations'}
              connected={connected}
            />,
          )}
        </TabsContent>
        <TabsContent value="records" keepMounted>
          {recordsOpened ? (
            <HistoryPanel
              labId={entity.lab_id}
              entities={[entity]}
              selectedId={entity.id}
              apiClient={apiClient}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="details" keepMounted>
          {originalRecord ? (
            <section className="lab-inspector-section">
              {onCloseOriginalRecord ? (
                <Tool
                  icon={X}
                  label={message('records.closeOriginal')}
                  onClick={onCloseOriginalRecord}
                />
              ) : null}
              <RecordDetails record={originalRecord} />
            </section>
          ) : null}
          {entity.task || entity.task_result ? (
            <section
              className="lab-inspector-section"
              aria-label={message('detail.taskIdentities')}
            >
              <h3>{message('detail.taskIdentities')}</h3>
              <dl className="world-properties">
                <dt>Task</dt>
                <dd>{entity.task?.id ?? message('detail.noTask')}</dd>
                <dt>{message('detail.taskRun')}</dt>
                <dd>{entity.task?.run_id ?? '-'}</dd>
                <dt>{message('detail.taskStatus')}</dt>
                <dd>
                  {entity.task
                    ? message(`task.${entity.task.status}`)
                    : message('detail.noTask')}
                </dd>
                <dt>Command</dt>
                <dd>{entity.task?.command_id ?? '-'}</dd>
                <dt>{message('task.result')}</dt>
                <dd>
                  {entity.task_result?.id ??
                    entity.task?.result_id ??
                    message('detail.noResult')}
                </dd>
                <dt>{message('detail.resultTask')}</dt>
                <dd>{entity.task_result?.task_id ?? '-'}</dd>
                <dt>{message('task.resultStatus')}</dt>
                <dd>
                  {entity.task_result
                    ? message(`task.${entity.task_result.status}`)
                    : message('detail.noResult')}
                </dd>
                <dt>{message('detail.endedAt')}</dt>
                <dd>
                  {entity.task_result?.ended_at ?? entity.task?.ended_at ?? '-'}
                </dd>
                <dt>{message('task.reason')}</dt>
                <dd>
                  {entity.task_result?.reason
                    ? message(`task.reason.${entity.task_result.reason}`)
                    : '-'}
                </dd>
                <dt>{message('detail.fixedParameters')}</dt>
                <dd>
                  {entity.task ? JSON.stringify(entity.task.parameters) : '-'}
                </dd>
              </dl>
            </section>
          ) : null}
          <section className="lab-inspector-section">
            <h3>{message('detail.provenance')}</h3>
            {Object.entries(
              readEntityObservations(entity, connected).properties,
            ).map(([name, reading]) => (
              <ObservationReading
                key={name}
                name={name}
                reading={reading}
                expanded
              />
            ))}
          </section>
          {children}
        </TabsContent>
      </Tabs>
    </div>
  );
}
