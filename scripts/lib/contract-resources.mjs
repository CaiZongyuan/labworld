import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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
  if (!Number.isInteger(consumer.pid) || consumer.pid < 1) return false;
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
  if (!Number.isInteger(consumer.pid) || consumer.pid < 1) return [];
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
function markerMatches(consumer, member) {
  if (!consumer.marker || token(member.pid) !== member.token) return false;
  try {
    // Compare only; neither the complete environment nor its other values are retained.
    const environment = readFileSync(`/proc/${member.pid}/environ`)
      .toString()
      .split('\0');
    return (
      environment.includes(`CONTRACT_RUN_ID=${consumer.runId}`) &&
      environment.includes(`CONTRACT_CONSUMER_MARKER=${consumer.marker}`) &&
      token(member.pid) === member.token
    );
  } catch {
    return false;
  }
}
function ownsGroup(consumer, actual) {
  if (consumer.marker)
    return (
      actual.length > 0 &&
      actual.every((member) => markerMatches(consumer, member))
    );
  // Recover older ledgers only when they have independently recorded process identities.
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
function discoverIntent(consumer) {
  const groups = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        .split(') ')[1]
        .split(' ');
      if (stat[0] === 'Z' || stat[2] !== stat[3]) continue;
      const member = { pid: Number(entry), token: stat[19] };
      if (!markerMatches(consumer, member)) continue;
      const group = Number(stat[2]);
      groups.set(group, [...(groups.get(group) ?? []), member]);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
  }
  if (groups.size > 1)
    throw new Error(
      'Consumer intent has multiple unrecorded groups; preserving resources',
    );
  if (groups.size === 0 && consumer.state !== 'not-started')
    throw new Error(
      'Unfinished consumer creation has no proved process identity; preserve resources and retry recovery',
    );
  if (groups.size === 1) {
    const [pid, proof] = [...groups][0];
    Object.assign(consumer, {
      pid,
      token: token(pid),
      members: proof,
      state: 'discovered',
    });
  }
}
function validateLedger(data) {
  if (
    !data ||
    !/^[A-Za-z0-9-]+$/.test(data.runId) ||
    typeof data.owner !== 'string' ||
    !data.owner.trim() ||
    !Array.isArray(data.containers) ||
    !Array.isArray(data.consumers) ||
    !Number.isInteger(data.supervisor?.pid) ||
    !/^\d+$/.test(data.supervisor?.token)
  ) {
    throw new Error('Invalid owned resource ledger; no resources were changed');
  }
  const markers = new Set();
  for (const consumer of data.consumers) {
    if (consumer.marker !== undefined) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          consumer.marker,
        ) ||
        consumer.runId !== data.runId ||
        markers.has(consumer.marker)
      )
        throw new Error(
          'Invalid consumer creation proof; no resources were changed',
        );
      markers.add(consumer.marker);
    }
  }
  if (data.usesDocker || data.containers.length)
    throw new Error(
      'Historical Docker resources are unsupported and preserved',
    );
}
export class ContractResources {
  constructor(path, runId, usesDocker = false) {
    this.path = path;
    this.data = runId
      ? {
          runId,
          usesDocker,
          owner: 'Lab Word owned Node process supervisor',
          supervisor: { pid: process.pid, token: token(process.pid) },
          state: 'active',
          containers: [],
          consumers: [],
          inventories: [],
          reconciliations: [],
        }
      : JSON.parse(readFileSync(path, 'utf8'));
    validateLedger(this.data);
    if (runId) {
      mkdirSync(dirname(path), { recursive: true });
      this.save();
    }
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
      at: new Date().toISOString(),
      docker: 'not-used',
    });
    this.save();
  }
  planConsumer(role, proofJournal) {
    if (this.data.closing)
      throw new Error('Resource supervisor is closing; new consumers refused');
    const consumer = {
      id: randomUUID(),
      marker: randomUUID(),
      role,
      proofJournal,
      runId: this.data.runId,
      state: 'planned',
      members: [],
    };
    this.data.consumers.push(consumer);
    this.save();
    return consumer;
  }
  launchedConsumer(id, pid) {
    const consumer = this.data.consumers.find((entry) => entry.id === id);
    Object.assign(consumer, { pid, token: token(pid), state: 'running' });
    consumer.members = members(consumer);
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
  reconcile(stage) {
    for (const consumer of this.data.consumers) {
      if (alive(consumer)) consumer.members = members(consumer);
    }
    const record = {
      at: new Date().toISOString(),
      stage,
      containers: [],
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
  async recover() {
    validateLedger(this.data);
    if (process.platform !== 'linux')
      throw new Error(
        'Owned process-group recovery is supported on Linux; no resources were reclaimed',
      );
    if (alive(this.data.supervisor))
      throw new Error(
        'Ledger belongs to an active supervisor; recovery refused',
      );
    this.snapshot('recovery-start');
    try {
      for (const consumer of this.data.consumers)
        if (!consumer.pid) discoverIntent(consumer);
      this.save();
      for (const consumer of this.data.consumers) {
        const actual = members(consumer);
        if (!actual.length) continue;
        if (!ownsGroup(consumer, actual))
          throw new Error(
            'Process group identity cannot be proved; preserve resources for inspection',
          );
        await this.stop(consumer.pid);
      }
      this.data.state = 'recovered';
    } catch (error) {
      this.data.state = 'recovery-failed';
      throw error;
    } finally {
      this.reconcile('recovery-end');
      this.snapshot('recovery-end');
    }
  }
}
