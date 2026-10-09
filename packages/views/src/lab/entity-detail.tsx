import { useState, type ReactNode } from 'react';
import { MapPin, Pencil } from 'lucide-react';
import type { ApiClient, LabEntity, LabWorld } from '@labos-threejs/sdk';
import { Badge } from '@labos-threejs/ui/components/badge';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@labos-threejs/ui/components/tabs';
import { useAppMessage } from '../shell/messages';
import HistoryPanel from './history-panel';
import { Tool } from './view-controls';
import ObservationReading from './observation-reading';
import { readEntityObservations } from './observation-state';

function registeredLocation(world: LabWorld, entity: LabEntity) {
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
}: {
  entity: LabEntity;
  world: LabWorld;
  apiClient: ApiClient;
  operations: ReactNode;
  children: ReactNode;
  editing: boolean;
  onConfigure: () => void;
  connected: boolean;
}) {
  const message = useAppMessage('lab');
  const [tab, setTab] = useState('operations');
  const [recordsOpened, setRecordsOpened] = useState(false);
  const location = registeredLocation(world, entity);
  const readings = readEntityObservations(entity, connected);
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
          {entity.binding ? (
            <span title={entity.binding.source}>{entity.binding.source}</span>
          ) : (
            <span>{message('world.noBinding')}</span>
          )}
        </div>
      </div>
      <Tabs
        value={editing ? 'details' : tab}
        onValueChange={(value) => {
          setTab(String(value));
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
          {operations}
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
          <section className="lab-inspector-section">
            <h3>{message('detail.provenance')}</h3>
            {Object.entries(readings.properties).map(([name, reading]) => (
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
