import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Response, Request, ConsoleMessage } from '@playwright/test';
import { lab334State, assertLab334Seal } from '../support/lab334-observation';
import { boundedBrowserFact } from './lab-browser-facts';

/** One original-case observer; no HTTP/model/callback/value replacement. */
export async function lab334Probe() {
  const enabled = process.env.LAB334_DIAGNOSTIC === 'true';
  const caseNonce = randomUUID(),
    salt = randomUUID();
  const health = lab334State({
    caseNonce,
    pageId: 'runner',
    instanceId: randomUUID(),
    role: 'runner',
  });
  if (enabled)
    health.run(() =>
      console.log(
        JSON.stringify({
          event: 'lab334.observer.owner',
          caseNonce,
          ownerPid: process.pid,
          runId: process.env.CONTRACT_RUN_ID,
        }),
      ),
    );
  const watched: {
    page: Page;
    pageId: string;
    role: string;
    off: () => void;
  }[] = [];
  let captured = false;
  const hash = (value: string) =>
    createHash('sha256')
      .update(salt + value)
      .digest('hex');
  async function watch(page: Page, role: string) {
    if (!enabled) return;
    const pageId = randomUUID();
    try {
      const code = `(() => { const state = (${lab334State.toString()})({caseNonce:${JSON.stringify(caseNonce)},pageId:${JSON.stringify(pageId)},role:${JSON.stringify(role)},instanceId:crypto.randomUUID()}); globalThis[Symbol.for('lab-word.lab334-observer')]=row=>state.record(row); globalThis[Symbol.for('lab-word.lab334-state')]=state; })()`;
      await page.addInitScript(code);
      const resource = (url: string) => {
        const path = new URL(url).pathname;
        return path.includes('/decoders/')
          ? 'decoder'
          : /^\/api\/v1\/lab\/assets\/[0-9a-f-]+\/download$/.test(path)
            ? 'download'
            : path.startsWith('/objects/')
              ? 'object'
              : path.endsWith('/world')
                ? 'world'
                : null;
      };
      const response = (reply: Response) =>
        health.run(() => {
          const kind = resource(reply.url());
          if (kind)
            health.record({
              producer: 'response',
              stage: 'response',
              asset:
                new URL(reply.url()).pathname.match(
                  /\/assets\/([0-9a-f-]{36})\/download$/,
                )?.[1] ?? new URL(reply.url()).pathname,
              node: role,
              appearance: kind,
              status: reply.status(),
            });
        });
      const failed = (request: Request) =>
        health.run(() => {
          const kind = resource(request.url());
          if (kind)
            health.record({
              producer: 'requestfailed',
              stage: 'request-failed',
              asset:
                new URL(request.url()).pathname.match(
                  /\/assets\/([0-9a-f-]{36})\/download$/,
                )?.[1] ?? new URL(request.url()).pathname,
              node: role,
              appearance: kind,
            });
        });
      const pageerror = (cause: Error) =>
        health.run(() =>
          health.record({
            producer: 'pageerror',
            stage: 'page-error',
            asset: role,
            category: [
              'Error',
              'TypeError',
              'RangeError',
              'SyntaxError',
            ].includes(cause.name)
              ? cause.name
              : 'OtherError',
          }),
        );
      const consoleError = (message: ConsoleMessage) =>
        health.run(() => {
          if (message.type() === 'error')
            health.record({
              producer: 'console',
              stage: 'console-error',
              asset: role,
            });
        });
      page.on('response', response);
      page.on('requestfailed', failed);
      page.on('pageerror', pageerror);
      page.on('console', consoleError);
      watched.push({
        page,
        pageId,
        role,
        off: () => {
          page.off('response', response);
          page.off('requestfailed', failed);
          page.off('pageerror', pageerror);
          page.off('console', consoleError);
        },
      });
    } catch {
      health.invalidate();
    }
  }
  async function capture(error?: unknown) {
    if (!enabled || captured) return;
    captured = true;
    try {
      const requestId = randomUUID(),
        requestedAt = Date.now();
      const browserLedger = JSON.parse(
        readFileSync(
          join(process.env.LAB_NODE_EVIDENCE!, 'browser-owned-resources.json'),
          'utf8',
        ),
      );
      if (browserLedger.runId !== process.env.CONTRACT_RUN_ID)
        throw new Error('Wrong owned browser run');
      const views = await Promise.all(
        watched.map(async ({ page, pageId, role }) => {
          const result = await boundedBrowserFact(() =>
            page.evaluate((nonce) => {
              const state = (
                globalThis as typeof globalThis & {
                  [key: symbol]: ReturnType<typeof lab334State> | undefined;
                }
              )[Symbol.for('lab-word.lab334-state')];
              const root = document.querySelector('.world-page');
              return {
                seal: state?.seal(nonce),
                dom: {
                  at: Date.now(),
                  rootPresent: !!root,
                  renderErrorCount: root
                    ? root.querySelectorAll('.world-render-error').length
                    : null,
                  canvasCount: root?.querySelectorAll('canvas').length ?? 0,
                  loadingCount:
                    root?.querySelectorAll('.lab-loading').length ?? 0,
                  busy: root?.getAttribute('aria-busy') ?? null,
                  webglAvailable: typeof WebGL2RenderingContext !== 'undefined',
                },
              };
            }, requestId),
          );
          if (result.status !== 'ack' || !result.value.seal) {
            health.invalidate();
            return { role, available: false, category: result.status };
          }
          const seal = assertLab334Seal(result.value.seal, {
            requestId,
            caseNonce,
            pageId,
            requestedAt,
            receivedAt: Date.now(),
          });
          const identities = (seal.identities as string[]).map(hash);
          return { role, ...seal, identities, dom: result.value.dom };
        }),
      );
      const runner = health.seal(requestId);
      runner.identities = (runner.identities as string[]).map(hash);
      const directory = join(
        process.env.LAB_NODE_EVIDENCE!,
        'lab334-' + caseNonce,
      );
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const owners = [...views, { ...runner, role: 'runner' }];
      for (const owner of owners) {
        const rows = (owner as { rows?: unknown[] }).rows ?? [];
        const journal =
          rows
            .map((row) => {
              const tuple = JSON.stringify(row);
              if (Buffer.byteLength(tuple) > 16384)
                throw new Error('Tuple overflow');
              return tuple;
            })
            .join('\n') + '\n';
        if (Buffer.byteLength(journal) > 1024 * 1024)
          throw new Error('Journal overflow');
        writeFileSync(join(directory, String(owner.role) + '.jsonl'), journal, {
          mode: 0o600,
        });
        (owner as { rows?: unknown[] }).rows = rows.slice(-32);
        if (Buffer.byteLength(JSON.stringify(owner)) > 16384)
          throw new Error('Owner tuple overflow');
      }
      const failureLocations =
        error instanceof Error
          ? [...(error.stack ?? '').matchAll(/(lab\.spec\.ts):(\d+):(\d+)/g)]
              .slice(0, 4)
              .map((match) => ({
                file: match[1],
                line: Number(match[2]),
                column: Number(match[3]),
              }))
          : [];
      const report = {
        caseNonce,
        requestId,
        requestedAt,
        capturedAt: Date.now(),
        nodeOwner: { pid: process.pid, runId: browserLedger.runId },
        observerHealth: health.status(),
        originalError: error !== undefined,
        failureLocations,
        rawTextRetained: false,
        owners,
      };
      const data = JSON.stringify(report);
      if (Buffer.byteLength(data) > 65536) throw new Error('Report overflow');
      const path = join(directory, 'sealed-window.json');
      writeFileSync(path + '.next', data + '\n', { mode: 0o600 });
      renameSync(path + '.next', path);
      for (const { page, role } of watched) {
        try {
          await page
            .locator('.lab-viewport')
            .screenshot({ path: join(directory, role + '.png'), timeout: 250 });
        } catch {
          /* Screenshot availability never changes predicate. */
        }
      }
    } catch {
      health.invalidate();
    }
    try {
      console.log(
        JSON.stringify({
          event: 'lab334.observer.sealed',
          caseNonce,
          ownerPid: process.pid,
          health: health.status(),
        }),
      );
    } catch {
      health.invalidate();
    }
  }
  async function dispose() {
    try {
      for (const owner of watched) {
        owner.off();
        await boundedBrowserFact(() =>
          owner.page.evaluate(() => {
            delete (globalThis as { [key: symbol]: unknown })[
              Symbol.for('lab-word.lab334-observer')
            ];
            delete (globalThis as { [key: symbol]: unknown })[
              Symbol.for('lab-word.lab334-state')
            ];
          }),
        );
      }
    } catch {
      health.invalidate();
    }
  }
  return { watch, capture, dispose };
}
