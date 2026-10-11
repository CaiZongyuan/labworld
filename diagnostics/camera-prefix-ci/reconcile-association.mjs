import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const identity = (left, right) =>
  Number.isInteger(left?.pid) &&
  left.pid === right?.pid &&
  typeof (left.token ?? left.start) === 'string' &&
  (left.token ?? left.start) === (right.token ?? right.start);

// Names limit the inventory; exact persisted birth proofs establish ownership.
function ledgers(root, prefix) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => resolve(root, entry.name, 'owned-resources.json'))
    .filter(existsSync)
    .map((path) => ({ path, data: read(path) }));
}

export function reconcileAssociation(
  association,
  launcher,
  root = resolve('.scratch/vnext-m1'),
) {
  const missing = [];
  const launch = launcher.consumers.find(
    (consumer) => consumer.role === 'original-camera-suite',
  );
  if (!launch) {
    missing.push({
      boundary: 'launcher-suite-intent',
      reason:
        'Original suite launch intent unavailable; runtime ownership cannot be established',
    });
    association.unverifiedAssociationLedgers = [
      ...new Set([
        ...(association.unverifiedAssociationLedgers ?? []),
        ...(association.ownedLedgers ?? []),
      ]),
    ];
    association.suiteLedger = null;
    association.browserLedger = null;
    association.serviceLedgers = [];
    association.ownedLedgers = [];
    return (association.finalOwnershipReconciliation = {
      complete: false,
      missing,
      launched: false,
    });
  }
  const expected = [association.command.slice(2)];
  const suites = ledgers(root, 'browser-suite-').filter(
    ({ data }) =>
      identity(data.supervisor, launch) &&
      JSON.stringify(data.profiles) === JSON.stringify(expected),
  );
  if (suites.length !== 1) {
    missing.push({
      boundary: 'suite',
      identity: { pid: launch.pid ?? null, token: launch.token ?? null },
      reason:
        'Exactly one suite ledger with matching birth and original profile args is required',
      matches: suites.length,
    });
    association.unverifiedAssociationLedgers = [
      ...new Set([
        ...(association.unverifiedAssociationLedgers ?? []),
        ...(association.ownedLedgers ?? []),
      ]),
    ];
    association.suiteLedger = null;
    association.browserLedger = null;
    association.serviceLedgers = [];
    association.ownedLedgers = [];
    return (association.finalOwnershipReconciliation = {
      complete: false,
      missing,
      launched: true,
    });
  }
  const suite = suites[0];
  association.suiteLedger = suite.path;
  association.suiteRunId = suite.data.runId;
  association.suiteConsumers = suite.data.consumers;
  const services = ledgers(root, 'lab-word-m1-').filter(
    ({ data }) =>
      data.owner === 'M1 server process harness' &&
      suite.data.consumers.some((consumer) => identity(data.creator, consumer)),
  );
  const browserPaths = [];
  for (const consumer of suite.data.consumers) {
    if (!consumer.pid || !consumer.token) {
      missing.push({
        boundary: 'profile',
        identity: { pid: consumer.pid ?? null, token: consumer.token ?? null },
        reason: 'Profile creation identity is unresolved',
      });
      continue;
    }
    const owned = services.filter(({ data }) =>
      identity(data.creator, consumer),
    );
    const browsers = owned
      .map(({ path }) => resolve(dirname(path), 'browser-owned-resources.json'))
      .filter(existsSync)
      .filter((path) => identity(read(path).supervisor, consumer));
    browserPaths.push(...browsers);
    const index = suite.data.consumers.indexOf(consumer);
    const closurePath = resolve(
      dirname(suite.path),
      `profile-${index}-closure.json`,
    );
    const closure = existsSync(closurePath) ? read(closurePath) : null;
    const closed =
      closure?.cleanupCompleted === true &&
      Array.isArray(closure.serviceLedgers) &&
      closure.serviceLedgers.every((path) =>
        owned.some((entry) => entry.path === resolve(path)),
      ) &&
      (closure.browserLedger === null ||
        (typeof closure.browserLedger === 'string' &&
          browsers.includes(resolve(closure.browserLedger))));
    const graphCovered =
      browsers.length === 1 &&
      read(browsers[0]).serviceLedgers?.length === 2 &&
      read(browsers[0]).serviceLedgers.every((path) =>
        owned.some((entry) => entry.path === resolve(path)),
      );
    if (!closed && !graphCovered)
      missing.push({
        boundary: 'profile-services',
        identity: { pid: consumer.pid, token: consumer.token },
        reason:
          'Neither terminal profile closure nor the complete browser/two-service ownership graph is available',
        serviceLedgers: owned.map((entry) => entry.path),
        browserLedgers: browsers,
      });
  }
  if (browserPaths.length > 1)
    missing.push({
      boundary: 'browser',
      reason:
        'Expected at most one browser supervisor for the original single profile',
      browserPaths,
    });
  association.browserLedger = browserPaths[0] ?? null;
  association.serviceLedgers = services.map((entry) => entry.path);
  association.ownedLedgers = [
    suite.path,
    ...browserPaths,
    ...association.serviceLedgers,
  ];
  association.terminalObservedServices ??= {};
  for (const { path, data } of services)
    association.terminalObservedServices[data.runId] ??= {
      ledger: path,
      runId: data.runId,
      creator: data.creator,
      directoryAtTerminalObservation: data.directory,
      port: data.port,
      processProofs: data.processes,
      inProcessConsumerProofs: data.inProcessConsumers ?? [],
      source:
        'post-stop exact creator-birth reconciliation; does not reconstruct first-seen history',
    };
  const result = {
    complete: missing.length === 0,
    missing,
    launched: true,
    at: new Date().toISOString(),
    source:
      'launcher PID/birth and exact profile args -> suite child births -> service creators/browser supervisor',
  };
  association.finalOwnershipReconciliation = result;
  return result;
}

export function saveAssociation(path, association) {
  writeFileSync(path + '.next', JSON.stringify(association, null, 2) + '\n', {
    mode: 0o600,
  });
  renameSync(path + '.next', path);
}
