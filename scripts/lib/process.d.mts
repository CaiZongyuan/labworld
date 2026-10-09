import type { ChildProcess } from 'node:child_process';

export const root: string;
export function developmentEnv(): NodeJS.ProcessEnv;
export function run(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): void;
export function launch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess;
export function stop(
  child: ChildProcess | undefined,
  graceMs?: number,
): Promise<void>;
export function freePort(): Promise<number>;
export function waitFor(
  url: string,
  child?: ChildProcess,
  timeoutMs?: number,
): Promise<void>;
