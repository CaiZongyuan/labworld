import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const docker = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
export function inventory() {
  return {
    at: new Date().toISOString(),
    containers: docker(['ps', '-a', '--format', '{{json .}}'])
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse),
    volumes: docker(['volume', 'ls', '--format', '{{json .}}'])
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse),
    networks: docker(['network', 'ls', '--format', '{{json .}}'])
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse),
    disk: docker(['system', 'df', '--format', '{{json .}}'])
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse),
  };
}
function token(pid) {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8')
      .split(') ')[1]
      .split(' ')[19];
  } catch {
    return undefined;
  }
}
function alive(consumer) {
  try {
    process.kill(consumer.pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${consumer.pid}/stat`, 'utf8')
        .split(') ')[1]
        .split(' ');
      if (stat[0] === 'Z') return false;
      if (consumer.token && token(consumer.pid) !== consumer.token)
        return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
}
function members(consumer) {
  if (process.platform !== 'linux') {
    if (alive(consumer)) return [{ pid: consumer.pid, token: consumer.token }];
    return [];
  }
  const result = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        .split(') ')[1]
        .split(' ');
      if (
        stat[0] !== 'Z' &&
        Number(stat[2]) === consumer.pid &&
        Number(stat[3]) === consumer.pid
      )
        result.push({ pid: Number(entry), token: stat[19] });
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
  }
  return result;
}
function ownsGroup(consumer, actual) {
  return actual.some((member) =>
    (consumer.members ?? []).some(
      (known) => known.pid === member.pid && known.token === member.token,
    ),
  );
}
function inspect(name) {
  try {
    const data = JSON.parse(docker(['inspect', name]))[0];
    return {
      id: data.Id,
      labels: data.Config.Labels,
      ports: data.NetworkSettings.Ports,
      mounts: data.Mounts.map(({ Type, Name, Destination }) => ({
        type: Type,
        name: Name,
        destination: Destination,
      })),
    };
  } catch (error) {
    if (/no such object/i.test(String(error.stderr))) return undefined;
    throw error;
  }
}
export class ContractResources {
  constructor(path, runId) {
    this.path = path;
    this.data = runId
      ? {
          runId,
          owner: '#46 developer_m0',
          supervisor: { pid: process.pid, token: token(process.pid) },
          state: 'active',
          containers: [],
          consumers: [],
          inventories: [],
          reconciliations: [],
        }
      : JSON.parse(readFileSync(path, 'utf8'));
    mkdirSync(dirname(path), { recursive: true });
    this.save();
  }
  save() {
    writeFileSync(
      `${this.path}.next`,
      JSON.stringify(this.data, null, 2) + '\n',
      { mode: 0o600 },
    );
    renameSync(`${this.path}.next`, this.path);
  }
  snapshot(stage) {
    this.data.inventories.push({ stage, ...inventory() });
    this.save();
  }
  plan(name, purpose) {
    const labels = {
      'labword.contract.run': this.data.runId,
      'labword.contract.owner': '#46-developer_m0',
    };
    this.data.containers.push({ name, purpose, labels, state: 'planned' });
    this.save();
    return Object.entries(labels).flatMap(([key, value]) => [
      '--label',
      `${key}=${value}`,
    ]);
  }
  started(name) {
    const entry = this.data.containers.find(
      (container) => container.name === name,
    );
    Object.assign(entry, { state: 'running', actual: inspect(name) });
    this.save();
  }
  consumer(pid, role) {
    const consumer = { pid, role, token: token(pid) };
    consumer.members = members(consumer);
    this.data.consumers.push(consumer);
    this.save();
  }
  reconcile(stage) {
    for (const consumer of this.data.consumers) {
      if (alive(consumer)) consumer.members = members(consumer);
    }
    const record = {
      at: new Date().toISOString(),
      stage,
      containers: this.data.containers.map(({ name }) => ({
        name,
        actual: inspect(name),
      })),
      consumers: this.data.consumers.map((consumer) => ({
        ...consumer,
        alive: members(consumer).length > 0,
        actualMembers: members(consumer),
      })),
    };
    this.data.reconciliations.push(record);
    this.save();
    return record;
  }
  remove(name) {
    const entry = this.data.containers.find(
      (container) => container.name === name,
    );
    if (!entry) throw new Error('Container absent from owned ledger');
    const actual = inspect(name);
    if (!actual) {
      if (entry.state !== 'cleaned') entry.state = 'absent';
      this.save();
      return;
    }
    if (
      Object.entries(entry.labels).some(
        ([key, value]) => actual.labels?.[key] !== value,
      )
    ) {
      entry.state = 'retained-label-mismatch';
      this.save();
      throw new Error(`Resource ownership mismatch: ${name}`);
    }
    if (this.data.consumers.some((consumer) => members(consumer).length > 0))
      throw new Error('Stop owned consumers before resource cleanup');
    docker(['rm', '-f', '-v', name]);
    entry.state = 'cleaned';
    this.save();
  }
  async recover(stopConsumer) {
    if (alive(this.data.supervisor))
      throw new Error(
        'Ledger belongs to an active supervisor; recovery refused',
      );
    for (const consumer of this.data.consumers) {
      const actual = members(consumer);
      if (!actual.length) continue;
      if (!ownsGroup(consumer, actual))
        throw new Error(
          'Process group identity cannot be proved; preserve resources for inspection',
        );
      await stopConsumer(consumer.pid);
    }
    this.reconcile('recovery-before-cleanup');
    for (const container of this.data.containers) this.remove(container.name);
    this.data.state = 'recovered';
    this.snapshot('recovery-end');
  }
}
