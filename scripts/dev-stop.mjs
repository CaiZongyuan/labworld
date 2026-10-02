#!/usr/bin/env node
// Stop this worktree's API, Worker and Vite listeners left by a dev run.
// Other projects and Docker data services are always left untouched.
import { setTimeout as delay } from 'node:timers/promises';
import {
  devPortTargets,
  isPortListening,
  isWorktreeDevProcess,
  listeningPids,
  signalPid,
} from './lib/dev-ports.mjs';
import { developmentEnv, root } from './lib/process.mjs';

const targets = devPortTargets(developmentEnv());
const byPort = await listeningPids(targets.map((target) => target.port));
const stopping = [];
let failed = false;
let held = false;

for (const target of targets) {
  const pids = [...byPort.get(target.port)];
  if (pids.length === 0 && !(await isPortListening(target.host, target.port)))
    continue;
  held = true;
  const owned = [];
  for (const pid of pids) {
    if (await isWorktreeDevProcess(pid, target, root)) owned.push(pid);
  }
  if (owned.length < pids.length || owned.length === 0) {
    failed = true;
    console.error(
      `${target.name} port ${target.port}: another project, Docker, or an unrecognized process owns a listener; left untouched.`,
    );
  }
  if (owned.length === 0) continue;
  for (const pid of owned) signalPid(pid, 'SIGTERM');
  stopping.push({ ...target, pids: owned });
  console.log(
    `${target.name} port ${target.port}: stopping pid ${owned.join(', ')}.`,
  );
}

if (!held) {
  console.log(
    `Dev ports (${targets.map((target) => target.port).join(', ')}) are free — nothing to stop.`,
  );
}

if (!(await waitUntilFree(stopping, 5_000))) {
  const survivors = stopping.filter((entry) => entry.busy);
  const current = await listeningPids(survivors.map((entry) => entry.port));
  for (const entry of survivors) {
    for (const pid of entry.pids) {
      // A replacement listener may have taken the port after TERM. Only
      // escalate the original process, and recheck its worktree ownership.
      if (
        current.get(entry.port).has(pid) &&
        (await isWorktreeDevProcess(pid, entry, root))
      )
        signalPid(pid, 'SIGKILL');
    }
  }
  await waitUntilFree(survivors, 2_000);
}

for (const entry of stopping) {
  if (entry.busy) {
    failed = true;
    console.error(
      `${entry.name} port ${entry.port}: still in use; inspect the remaining listener.`,
    );
  } else {
    console.log(`${entry.name} port ${entry.port}: freed.`);
  }
}
process.exitCode = failed ? 1 : 0;

async function waitUntilFree(entries, budgetMs) {
  const deadline = performance.now() + budgetMs;
  do {
    for (const entry of entries) {
      entry.busy = await isPortListening(entry.host, entry.port, 250);
    }
    if (!entries.some((entry) => entry.busy)) return true;
    await delay(100);
  } while (performance.now() < deadline);
  return false;
}
