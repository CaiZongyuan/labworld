import { useMemo, useState } from 'react';
import { CircleAlert, ArrowUpRight, Box } from 'lucide-react';
import type {
  ApiClient,
  LabEntity,
  LabWorld,
  LabRecord,
} from '@labos-threejs/sdk';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@labos-threejs/ui/components/card';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import { Input } from '@labos-threejs/ui/components/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import { useAppMessage } from '../shell/messages';
import ObservationReading from './observation-reading';
import TrendEntry from './trend-entry';
import RecentActivity from './recent-activity';
import {
  operatingDevices,
  registeredRegions,
  type DeviceFacts,
} from './operations-state';

export default function OperationsView({
  world,
  entities,
  apiClient,
  userId,
  view,
  connected,
  refreshToken,
  worldVersion,
  selectedId,
  onSelect,
  onDevices,
  onDirectory,
  onRecords,
  onOpenRecord,
}: {
  world: LabWorld;
  entities: LabEntity[];
  apiClient: ApiClient;
  userId: string;
  view: string;
  connected: boolean;
  refreshToken: string;
  worldVersion: string;
  selectedId?: string;
  onSelect: (id: string) => void;
  onDevices: () => void;
  onDirectory: (archived: boolean) => void;
  onRecords: () => void;
  onOpenRecord: (record: LabRecord) => void;
}) {
  const message = useAppMessage('lab');
  const devices = useMemo(() => operatingDevices(entities), [entities]);
  const regions = useMemo(() => registeredRegions(world), [world]);
  const placed = useMemo(
    () => new Set(world.nodes.map((node) => node.entity_id)),
    [world.nodes],
  );
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [region, setRegion] = useState('');
  const [unplaced, setUnplaced] = useState(false);
  const [sensorId, setSensorId] = useState('');
  const [opened, setOpened] = useState(['overview', 'devices'].includes(view));
  if (!opened && ['overview', 'devices'].includes(view)) setOpened(true);
  const sensors = devices.filter(
    (device) =>
      device.entity.kind === 'sensor' &&
      device.entity.definition_id === 'sensor',
  );
  const sensor =
    sensors.find((device) => device.entity.id === sensorId) ?? sensors[0];
  const choices = [
    ...new Map(
      [...regions.values()].map((entity) => [entity.id, entity]),
    ).values(),
  ];
  const effectiveRegion =
    choices.some((choice) => choice.id === region) || region === 'unregistered'
      ? region
      : '';
  const attention = devices
    .filter((device) => device.attention.length)
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.earliest - b.earliest ||
        a.entity.id.localeCompare(b.entity.id),
    );
  const tasks = new Set(
    devices
      .filter((device) => device.taskActive)
      .map((device) => device.entity.task!.id),
  ).size;
  const counts: [string, number, string][] = [
    ['total', devices.length, ''],
    ['tasks', tasks, 'tasks'],
    [
      'valid',
      devices.filter((device) => device.readings.currentValid).length,
      'valid',
    ],
    ['attention', attention.length, 'attention'],
  ];
  const filtered = devices.filter((device) => {
    const entity = device.entity;
    return (
      (!search ||
        [entity.name, entity.id, entity.configuration.label].some(
          (value) =>
            typeof value === 'string' &&
            value.toLowerCase().includes(search.toLowerCase()),
        )) &&
      (!status ||
        (status === 'tasks'
          ? device.taskActive
          : status === 'valid'
            ? device.readings.currentValid
            : status === 'attention'
              ? device.attention.length > 0
              : device.status === status)) &&
      (!effectiveRegion ||
        (effectiveRegion === 'unregistered'
          ? !regions.has(entity.id)
          : regions.get(entity.id)?.id === effectiveRegion)) &&
      (!unplaced || !placed.has(entity.id))
    );
  });
  if (!opened) return null;
  function table(rows: DeviceFacts[]) {
    return rows.length ? (
      <div className="operations-table-scroll">
        <table className="operations-table">
          <thead>
            <tr>
              <th>{message('operations.device')}</th>
              <th>{message('operations.status')}</th>
              <th>{message('operations.readings')}</th>
              <th>{message('operations.region')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((device) => (
              <tr
                key={device.entity.id}
                aria-selected={selectedId === device.entity.id}
              >
                <td>
                  <Button
                    variant="ghost"
                    className="h-auto whitespace-normal"
                    aria-label={message('world.selectNamed', {
                      name: device.entity.name,
                    })}
                    onClick={() => onSelect(device.entity.id)}
                  >
                    <Box data-icon="inline-start" />
                    {device.entity.name}
                  </Button>
                  <small
                    className="operations-identity"
                    title={device.entity.id}
                  >
                    {device.entity.id}
                  </small>
                  <Badge variant="outline">
                    {message(`world.${device.entity.reality}`)}
                  </Badge>
                  {!placed.has(device.entity.id) ? (
                    <Badge variant="outline">
                      {message('layout.unplaced')}
                    </Badge>
                  ) : null}
                </td>
                <td>
                  <Badge variant="secondary">
                    {message(
                      device.status === 'unbound'
                        ? 'world.noBinding'
                        : `device.${device.status}`,
                    )}
                  </Badge>
                  {device.entity.task ? (
                    <p>
                      {message(`task.${device.entity.task.status}`)} ·{' '}
                      <code>{device.entity.task.id}</code>
                    </p>
                  ) : null}
                  {device.attention.map((fact) => (
                    <p key={`${fact.reason}:${fact.property ?? ''}`}>
                      {message(`operations.reason.${fact.reason}`)}
                      {fact.property ? ` · ${fact.property}` : ''}
                    </p>
                  ))}
                </td>
                <td>
                  {device.readings.keyProperties.length
                    ? device.readings.keyProperties.map((name) => (
                        <ObservationReading
                          key={name}
                          name={name}
                          compact
                          reading={{
                            ...device.readings.properties[name],
                            ...(connected
                              ? {}
                              : { currentValid: false, reason: 'offline' }),
                          }}
                        />
                      ))
                    : message('world.unknown')}
                </td>
                <td>
                  {regions.get(device.entity.id)?.name ??
                    message('operations.unregistered')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            {message(devices.length ? 'assets.noResults' : 'operations.empty')}
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div
      className="operations-view"
      hidden={!['overview', 'devices'].includes(view)}
    >
      <section
        className="operations-summary"
        aria-label={message('operations.summary')}
      >
        {counts.map(([name, count, filter]) => (
          <Button
            key={name}
            variant="outline"
            className="operations-summary-item"
            aria-label={`${message(`operations.${name}`)} ${count}`}
            onClick={() => {
              setStatus(filter);
              onDevices();
            }}
          >
            <span>
              {message(`operations.${name}`)}
              <ArrowUpRight data-icon="inline-end" />
            </span>
            <strong>{count}</strong>
          </Button>
        ))}
      </section>
      <div hidden={view !== 'devices'}>
        <section aria-label={message('operations.directory')}>
          <header className="operations-section-heading">
            <h2>{message('operations.directory')}</h2>
            <span>
              {filtered.length} / {devices.length}
            </span>
          </header>
          <FieldGroup className="operations-filters">
            <Field>
              <FieldLabel htmlFor="operations-search">
                {message('operations.search')}
              </FieldLabel>
              <Input
                id="operations-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="operations-status">
                {message('operations.status')}
              </FieldLabel>
              <NativeSelect
                id="operations-status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <NativeSelectOption value="">
                  {message('assets.all')}
                </NativeSelectOption>
                {[
                  'tasks',
                  'valid',
                  'attention',
                  'running',
                  'stopped',
                  'not_started',
                  'unbound',
                  'interrupted',
                ].map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {message(
                      ['tasks', 'valid', 'attention'].includes(value)
                        ? `operations.${value}`
                        : value === 'unbound'
                          ? 'world.noBinding'
                          : `device.${value}`,
                    )}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="operations-region">
                {message('operations.region')}
              </FieldLabel>
              <NativeSelect
                id="operations-region"
                value={effectiveRegion}
                onChange={(event) => setRegion(event.target.value)}
              >
                <NativeSelectOption value="">
                  {message('assets.all')}
                </NativeSelectOption>
                <NativeSelectOption value="unregistered">
                  {message('operations.unregistered')}
                </NativeSelectOption>
                {choices.map((choice) => (
                  <NativeSelectOption key={choice.id} value={choice.id}>
                    {choice.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <label className="operations-unplaced">
                <input
                  type="checkbox"
                  checked={unplaced}
                  onChange={(event) => setUnplaced(event.target.checked)}
                />
                {message('layout.unplacedOnly')}
              </label>
            </Field>
          </FieldGroup>
          {table(filtered)}
        </section>
      </div>
      <div hidden={view !== 'overview'}>
        <div className="operations-primary">
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{message('operations.deviceRuntime')}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {table(devices.slice(0, 6))}
              <Button
                variant="link"
                onClick={() => {
                  setStatus('');
                  onDevices();
                }}
              >
                {message('operations.allDevices')}
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>
                  {message('operations.attentionTitle')} · {attention.length}
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ol
                className="operations-attention"
                aria-label={message('operations.attentionTitle')}
              >
                {attention.map((device) => (
                  <li key={device.entity.id}>
                    <Button
                      variant="outline"
                      className="h-auto whitespace-normal"
                      onClick={() => onSelect(device.entity.id)}
                    >
                      <CircleAlert data-icon="inline-start" />
                      {device.entity.name}
                    </Button>
                    {device.attention.map((fact) => (
                      <p key={`${fact.reason}:${fact.property ?? ''}`}>
                        {message(`operations.reason.${fact.reason}`)}
                        {fact.property ? ` · ${fact.property}` : ''}
                        {fact.time ? (
                          <time dateTime={fact.time}>{fact.time}</time>
                        ) : null}
                      </p>
                    ))}
                  </li>
                ))}
              </ol>
              {!attention.length ? (
                <p>{message('operations.noAttention')}</p>
              ) : null}
              <p>{message('operations.attentionFacts')}</p>
              {['unbound', 'not_started', 'stopped'].map((value) => (
                <Button
                  key={value}
                  variant="link"
                  onClick={() => {
                    setStatus(value);
                    onDevices();
                  }}
                >
                  {message(
                    value === 'unbound' ? 'world.noBinding' : `device.${value}`,
                  )}{' '}
                  · {devices.filter((device) => device.status === value).length}
                </Button>
              ))}
            </CardContent>
          </Card>
        </div>
        <div className="operations-secondary">
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{message('operations.environment')}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {sensors.length && sensor ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="operations-sensor">
                      {message('operations.sensor')}
                    </FieldLabel>
                    <NativeSelect
                      id="operations-sensor"
                      value={sensor.entity.id}
                      onChange={(event) => setSensorId(event.target.value)}
                    >
                      {sensors.map((device) => (
                        <NativeSelectOption
                          key={device.entity.id}
                          value={device.entity.id}
                        >
                          {device.entity.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Button
                    variant="link"
                    onClick={() => onSelect(sensor.entity.id)}
                  >
                    {message('world.selectNamed', {
                      name: sensor.entity.name,
                    })}
                  </Button>
                  <TrendEntry
                    key={sensor.entity.id}
                    entity={sensor.entity}
                    apiClient={apiClient}
                    userId={userId}
                    worldVersion={`${worldVersion}:${refreshToken}`}
                    visible={view === 'overview' && connected}
                    initialOpen
                  />
                </>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>{message('operations.noSensor')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>
          <RecentActivity
            apiClient={apiClient}
            userId={userId}
            labId={world.lab.id}
            entities={entities}
            visible={view === 'overview'}
            connected={connected}
            refreshToken={refreshToken}
            onOpenRecord={onOpenRecord}
            onOpenRecords={onRecords}
          />
        </div>
      </div>
      <footer className="operations-directory-links">
        <Button variant="link" onClick={() => onDirectory(false)}>
          {message('operations.allObjects')}
        </Button>
        <Button variant="link" onClick={() => onDirectory(true)}>
          {message('lifecycle.archivedDirectory')}
        </Button>
      </footer>
    </div>
  );
}
