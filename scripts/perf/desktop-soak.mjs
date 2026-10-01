import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../lib/process.mjs';
import { withDesktopStack, runDesktopTests } from '../desktop-stack.mjs';
import { seed as seedFixtures } from './fixtures.mjs';
import { aggregateSoak, growthNotes, soakLine } from './desktop-report.mjs';

/**
 * Desktop soak (`just perf-desktop-soak`): boots a disposable stack the way
 * desktop-smoke does, seeds controlled data through the public interfaces,
 * then drives the real Electron shell over the shared knowledge views while
 * the spec samples renderer RSS, heap, DOM nodes and listeners. The report
 * lands in .scratch/perf/desktop-soak-report.json. Nightly/release report
 * material — never a PR gate, and growth observations never change the exit
 * code (a single soak describes a trend, it does not claim a leak).
 */

const durationSecs = Number(process.env.DESKTOP_SOAK_DURATION_SECS ?? '300');
const warmupSecs = Number(process.env.DESKTOP_SOAK_WARMUP_SECS ?? '15');
const sampleMs = Number(process.env.DESKTOP_SOAK_SAMPLE_MS ?? '2000');
const perfDir = join(root, '.scratch', 'perf');
const samplesPath = join(perfDir, 'desktop-soak-samples.json');
const reportPath = join(perfDir, 'desktop-soak-report.json');

const startedAt = new Date().toISOString();
const gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: root,
})
  .toString()
  .trim();
const desktopPackage = JSON.parse(
  readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'),
);
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));

let manifest;
let primary;
let specError = null;

await withDesktopStack(
  {
    cachePrefix: 'desktop-soak',
    // The browse cycle hammers session/list endpoints far past the local
    // defaults; the observation target is the renderer, not throttling —
    // widen main and fallback limits for this stack only (same reasoning
    // as the controlled load stack).
    extraEnv: {
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_WINDOW_SECS: '60',
      RATE_LIMIT_REGISTRATION: '1000000',
      RATE_LIMIT_AUTHENTICATION: '1000000',
      RATE_LIMIT_RESOURCE: '1000000',
      RATE_LIMIT_REGISTRATION_FALLBACK: '1000000',
      RATE_LIMIT_AUTHENTICATION_FALLBACK: '1000000',
      RATE_LIMIT_RESOURCE_FALLBACK: '1000000',
    },
    seed: async ({ env, webOrigin }) => {
      // fixtures reads this in-process (seeding runs here, not in a
      // child), so it must be set on this process' environment — the
      // origin has to match what this stack's API trusts.
      process.env.PERF_ORIGIN = webOrigin;
      // Controlled data through the public interfaces only; the first
      // seeded user signs into the shell for the whole run.
      manifest = await seedFixtures(env.E2E_API_URL);
      [primary] = JSON.parse(readFileSync(manifest.usersFile, 'utf8'));
    },
  },
  async ({ env, downloadsDir }) => {
    const specEnv = {
      ...env,
      // helpers.ts reads the sign-in credentials under the smoke names;
      // the soak passes the seeded soak user through them.
      DESKTOP_SMOKE_EMAIL: primary.email,
      DESKTOP_SMOKE_PASSWORD: primary.password,
      DESKTOP_SOAK_DURATION_SECS: String(durationSecs),
      DESKTOP_SOAK_WARMUP_SECS: String(warmupSecs),
      DESKTOP_SOAK_SAMPLE_MS: String(sampleMs),
      DESKTOP_SOAK_DOCUMENT_COUNT: String(manifest.docsPerUser),
      DESKTOP_SOAK_SAMPLES_PATH: samplesPath,
      LABOS_THREEJS_DESKTOP_DOWNLOADS_DIR: downloadsDir,
    };
    try {
      runDesktopTests(specEnv, 'tests/desktop/soak.config.ts');
    } catch (error) {
      specError = error;
    }

    // Shape the report whether or not the soak finished: a partial series
    // is still evidence, and the exit code below carries the failure
    // honestly. When Playwright died before the spec could write any
    // samples (a launch or config failure), record the failure in the
    // report instead of masking it with an ENOENT.
    const base = {
      description:
        'desktop renderer resource soak over the shared knowledge views',
      startedAt,
      finishedAt: new Date().toISOString(),
      runVersion: {
        gitSha,
        desktop: desktopPackage.version,
        electron: requireDesktop('electron/package.json').version,
      },
    };
    let notes = [];
    try {
      const collected = JSON.parse(readFileSync(samplesPath, 'utf8'));
      const aggregate = aggregateSoak(collected.samples, collected.sampleMs);
      notes = growthNotes(collected.samples);
      writeFileSync(
        reportPath,
        `${JSON.stringify(
          {
            ...base,
            scenario: {
              warmupSecs: collected.warmupSecs,
              durationSecs: collected.durationSecs,
              sampleMs: collected.sampleMs,
            },
            fixtures: {
              scale: process.env.PERF_SCALE ?? 'sm',
              users: manifest.users,
              documents: manifest.documents,
              attachments: manifest.attachments,
              durationMs: manifest.durationMs,
            },
            aggregate,
            growthNotes: notes,
          },
          null,
          2,
        )}\n`,
      );
      console.log(soakLine(aggregate, notes));
      // The report carries the full raw series; the intermediate samples
      // file has served its purpose once the report exists.
      rmSync(samplesPath, { force: true });
    } catch (shapingError) {
      writeFileSync(
        reportPath,
        `${JSON.stringify(
          { ...base, error: String(specError ?? shapingError) },
          null,
          2,
        )}\n`,
      );
    }
    if (notes.length > 0)
      console.warn(
        'growth observations present — see .scratch/perf/desktop-soak-report.json;' +
          ' rerun to confirm (a single soak is not a leak claim)',
      );
  },
);
if (specError) throw specError;
console.log(`desktop soak report: ${reportPath}`);
