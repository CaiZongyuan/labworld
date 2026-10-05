import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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
      if (!consumer.token || token(consumer.pid) !== consumer.token)
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
  let knownMembers = consumer.members ?? [];
  if (consumer.proofJournal) {
    const records = readFileSync(consumer.proofJournal, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    knownMembers = [
      ...knownMembers,
      ...records.filter(
        (record) =>
          record.runId === consumer.runId &&
          record.group === consumer.pid &&
          record.session === consumer.pid,
      ),
    ];
  }
  return actual.some((member) =>
    knownMembers.some(
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
  constructor(path, runId, usesDocker = true) {
    this.path = path;
    this.data = runId
      ? {
          runId,
          usesDocker,
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
    this.data.inventories.push({
      stage,
      ...(this.data.usesDocker
        ? inventory()
        : { at: new Date().toISOString(), docker: 'not-used' }),
    });
    this.save();
  }
  plan(name, purpose) {
    if (this.data.closing)
      throw new Error(
        'Resource supervisor is closing; new acquisition refused',
      );
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
  consumer(pid, role, proofJournal) {
    const consumer = {
      pid,
      role,
      token: token(pid),
      proofJournal,
      runId: this.data.runId,
    };
    consumer.members = members(consumer);
    this.data.consumers.push(consumer);
    this.save();
  }
  async stop(pid, graceMs = 5_000) {
    const consumer = this.data.consumers.find((entry) => entry.pid === pid);
    if (!consumer)
      throw new Error('Cannot signal a process absent from owned ledger');
    if (alive(consumer)) {
      consumer.members = members(consumer);
      this.save();
    }
    const signal = (value) => {
      const actual = members(consumer);
      if (!actual.length) return false;
      if (!ownsGroup(consumer, actual))
        throw new Error(
          'Process group identity cannot be proved; refusing to signal',
        );
      try {
        process.kill(-consumer.pid, value);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      return true;
    };
    if (!signal('SIGTERM')) return;
    const deadline = Date.now() + graceMs;
    while (members(consumer).length && Date.now() < deadline) await delay(25);
    // Re-prove identity before escalation; an ended group may have been replaced.
    signal('SIGKILL');
    const stopped = Date.now() + 1_000;
    while (members(consumer).length && Date.now() < stopped) await delay(25);
    if (members(consumer).length)
      throw new Error('Owned process group did not stop; preserving resources');
  }
  sampleConsumers() {
    let changed = false;
    for (const consumer of this.data.consumers) {
      if (!alive(consumer)) continue;
      const current = members(consumer);
      if (JSON.stringify(current) !== JSON.stringify(consumer.members)) {
        consumer.members = current;
        changed = true;
      }
    }
    if (changed) this.save();
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
    if (entry.actual?.id && entry.actual.id !== actual.id) {
      entry.state = 'retained-id-mismatch';
      this.save();
      throw new Error('Container identity changed; preserving replacement');
    }
    if (this.data.consumers.some((consumer) => members(consumer).length > 0))
      throw new Error('Stop owned consumers before resource cleanup');
    docker(['rm', '-f', '-v', actual.id]);
    entry.state = 'cleaned';
    this.save();
  }
  async recover() {
    if (process.platform !== 'linux')
      throw new Error(
        'M0 process-group recovery is supported on Linux; no resources were reclaimed',
      );
    this.snapshot('recovery-start');
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
      await this.stop(consumer.pid);
    }
    this.reconcile('recovery-before-cleanup');
    for (const container of this.data.containers) this.remove(container.name);
    this.data.state = 'recovered';
    this.snapshot('recovery-end');
  }
}
