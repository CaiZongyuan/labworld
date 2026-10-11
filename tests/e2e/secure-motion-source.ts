import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { launchMotionActor } from '../support/motion-actor';
import {
  processIdentity,
  sameProcess,
  type ProcessIdentity,
} from '../support/server-resources';

/** Owns one real source or slow reader, including parent death and exact cleanup. */
export class OwnedMotionActor {
  private child?: ChildProcess;
  private proof?: ProcessIdentity;
  private creator?: ProcessIdentity;
  private lastProcess?: ProcessIdentity;
  private ledger: string;
  constructor(private role: 'external-source' | 'slow-reader') {
    this.ledger = join(
      process.env.LAB_NODE_EVIDENCE!,
      'secure-' + role + '-' + randomUUID() + '.json',
    );
  }
  stdout = '';
  stderr = '';
  private save(state: string) {
    writeFileSync(
      this.ledger,
      JSON.stringify({
        owner: 'secure-motion-' + this.role,
        creator: this.creator,
        process: this.proof,
        lastProcess: this.lastProcess,
        state,
        consumers:
          state === 'cleaned'
            ? []
            : this.role === 'external-source'
              ? ['outbound Motion WSS', 'outbound Recording WSS']
              : ['slow Viewer WSS'],
      }),
      { mode: 0o600 },
    );
  }
  async start(script: string, args: string[], privateInput: string) {
    this.creator = await processIdentity(process.pid);
    assert(this.creator);
    this.save('launching');
    this.child = launchMotionActor(
      process.env.MOTION_E2E_PYTHON!,
      script,
      args,
      process.env,
    );
    this.child.stdout!.on('data', (chunk) => {
      this.stdout += String(chunk);
      assert(this.stdout.length < 8192);
    });
    this.child.stderr!.on('data', (chunk) => {
      this.stderr += String(chunk);
      assert(this.stderr.length < 8192);
    });
    await once(this.child, 'spawn');
    this.proof = await processIdentity(this.child.pid!);
    assert(this.proof);
    this.save('owned');
    this.child.stdin!.end(privateInput + '\n');
  }
  async stop() {
    if (!this.creator) return;
    const child = this.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const current = await processIdentity(child.pid);
      assert(!current || (this.proof && sameProcess(current, this.proof)));
      const exited = once(child, 'exit');
      if (current) child.kill('SIGTERM');
      const deadline = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      }, 2000);
      try {
        await exited;
      } finally {
        clearTimeout(deadline);
      }
    }
    if (this.proof) assert(!(await processIdentity(this.proof.pid)));
    if (this.proof) this.lastProcess = this.proof;
    this.proof = undefined;
    this.save('cleaned');
  }
}
