import { randomUUID } from 'node:crypto';
import type {
  LabEntity,
  LabWorld,
  PersistentLab,
  DeviceCommand,
  DeviceProgramRun,
} from '../../packages/contracts/src/generated/types.gen';
import { HttpClient, until } from './http';
export async function createLab(client: HttpClient, name = 'Contract Lab') {
  return client.json<PersistentLab>('POST', '/api/v1/lab/labs', { name }, 201);
}
export function entityPath(lab: string, entity: string) {
  return `/api/v1/lab/labs/${lab}/entities/${entity}`;
}
export async function register(
  client: HttpClient,
  lab: string,
  definition = 'light',
  configuration: Record<string, unknown> = {},
) {
  return client.json<LabEntity>(
    'POST',
    `/api/v1/lab/labs/${lab}/entities`,
    {
      name: `Contract ${definition}`,
      definition_id: definition,
      definition_version: '1.0',
      reality: 'simulated',
      configuration,
      representation_id: null,
    },
    201,
  );
}
export const world = (client: HttpClient, lab: string) =>
  client.json<LabWorld>('GET', `/api/v1/lab/labs/${lab}/world`);
export const readEntity = (client: HttpClient, lab: string, id: string) =>
  client.json<LabEntity>('GET', entityPath(lab, id));
export const start = (client: HttpClient, lab: string, id: string) =>
  client.json<DeviceProgramRun>(
    'POST',
    `${entityPath(lab, id)}/program/start`,
    undefined,
    201,
  );
export async function action(
  client: HttpClient,
  lab: string,
  id: string,
  capability: string,
  parameters: Record<string, unknown>,
  key = randomUUID(),
) {
  return client.json<DeviceCommand>(
    'POST',
    `${entityPath(lab, id)}/actions`,
    { capability, parameters },
    202,
    { 'idempotency-key': key },
  );
}
export const settledCommand = (
  client: HttpClient,
  lab: string,
  entity: string,
  id: string,
) =>
  until(
    () =>
      client.json<DeviceCommand>(
        'GET',
        `${entityPath(lab, entity)}/commands/${id}`,
      ),
    (command) => !['accepted', 'executing'].includes(command.status),
  );
