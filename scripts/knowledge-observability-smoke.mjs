import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { withTestPostgres } from './lib/postgres.mjs';
import { withTestRustfs } from './lib/rustfs.mjs';
import { freePort, launch, root, run, stop, waitFor } from './lib/process.mjs';
import {
  observabilityCompose,
  observabilityEnv,
  startObservability,
} from './lib/observability.mjs';

// Milestone protocol smoke: real application processes, storage, and all five
// observation services. No browser or shared development data is involved.
run('cargo', ['build', '--locked', '--workspace', '--bins'], {
  ...process.env,
  CARGO_BUILD_JOBS: '4',
});
const directory = mkdtempSync(join(root, '.scratch/observe-smoke-'));
let stage = 'startup';
async function eventually(action, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (value) return value;
    } catch {
      /* bounded startup/ingestion wait */
    }
    await delay(250);
  }
  throw new SmokeFailure(`Timed out: ${label}`);
}
class SmokeFailure extends Error {}
function ensure(value, message) {
  if (!value) throw new SmokeFailure(message);
}
async function json(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Observation query failed');
  return response.json();
}
try {
  await withTestPostgres(async ({ url }) =>
    withTestRustfs(async ({ env: storage }) => {
      const ports = await Promise.all(
        Array.from({ length: 7 }, () => freePort()),
      );
      ensure(
        new Set(ports).size === ports.length,
        'Could not reserve distinct smoke ports',
      );
      const [
        apiPort,
        workerPort,
        otelPort,
        tempoPort,
        lokiPort,
        promPort,
        grafanaPort,
      ] = ports;
      const env = observabilityEnv({
        ...process.env,
        ...storage,
        COMPOSE_PROJECT_NAME: `labos-threejs-observe-${process.pid}`,
        TELEMETRY_HTTP_PORT: String(otelPort),
        TEMPO_PORT: String(tempoPort),
        LOKI_PORT: String(lokiPort),
        PROMETHEUS_PORT: String(promPort),
        GRAFANA_PORT: String(grafanaPort),
        TELEMETRY_ENDPOINT: `http://127.0.0.1:${otelPort}`,
        TELEMETRY_LOG_DIRECTORY: join(directory, 'logs'),
        TELEMETRY_METRICS_INTERVAL_MS: '1000',
        DATABASE_URL: url,
        APP_BIND: `127.0.0.1:${apiPort}`,
        WORKER_BIND: `127.0.0.1:${workerPort}`,
        APP_ORIGIN: `http://127.0.0.1:${apiPort}`,
        RUST_LOG: 'trace',
        MAIL_SMTP_HOST: '',
        CACHE_REDIS_URL: '',
        RATE_LIMIT_REDIS_URL: '',
        JOB_SHUTDOWN_SECS: '2',
        JOB_HEARTBEAT_SECS: '2',
        JOB_LEASE_SECS: '10',
      });
      let api, worker;
      try {
        await startObservability(env);
        run(resolve(root, 'target/debug/migrate'), [], env);
        run(resolve(root, 'target/debug/bootstrap-storage'), [], env);
        api = launch(resolve(root, 'target/debug/labos-threejs-api'), [], env);
        worker = launch(
          resolve(root, 'target/debug/labos-threejs-worker'),
          [],
          env,
        );
        await Promise.all([
          waitFor(`${env.APP_ORIGIN}/health/ready`, api),
          waitFor(`http://${env.WORKER_BIND}/health/ready`, worker),
        ]);
        let cookie, csrf;
        async function request(path, method = 'GET', body) {
          const response = await fetch(`${env.APP_ORIGIN}${path}`, {
            method,
            headers: {
              origin: env.APP_ORIGIN,
              'content-type': 'application/json',
              ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}),
              'idempotency-key': randomUUID(),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          });
          ensure(
            response.ok,
            `Application request failed with status ${response.status}`,
          );
          const result =
            response.status === 204 ? undefined : await response.json();
          if (response.headers.has('set-cookie')) {
            cookie = response.headers.get('set-cookie').split(';')[0];
            csrf = result?.csrf_token;
          }
          return {
            body: result,
            trace: response.headers.get('x-trace-id'),
            request: response.headers.get('x-request-id'),
          };
        }
        stage = 'export';
        const secret = `observe-private-${randomUUID()}`;
        const actor = (
          await request('/api/v1/auth/register', 'POST', {
            email: 'observer@example.test',
            password: secret,
          })
        ).body.user.id;
        const document = (
          await request('/api/v1/knowledge/documents', 'POST', {
            title: 'Trace walkthrough',
            markdown: secret,
          })
        ).body;
        const path = `/api/v1/knowledge/documents/${document.id}`;
        const bytes = Buffer.from(secret);
        const upload = (
          await request(`${path}/uploads`, 'POST', {
            file_name: 'notes.txt',
            content_type: 'text/plain',
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          })
        ).body;
        const put = await fetch(upload.upload.url, {
          method: 'PUT',
          headers: upload.upload.headers,
          body: bytes,
          signal: AbortSignal.timeout(10_000),
        });
        ensure(put.ok, 'Attachment transfer failed');
        await request(
          `${path}/uploads/${upload.upload_id}/complete`,
          'POST',
          {},
        );
        const exported = await request(`${path}/exports`, 'POST', {});
        ensure(
          /^[a-f0-9]{32}$/.test(exported.trace),
          'Export must return a real trace ID',
        );
        const exportPath = `${path}/exports/${exported.body.id}`;
        await eventually(
          async () => (await request(exportPath)).body.status === 'succeeded',
          'export completion',
        );
        const download = (await request(`${exportPath}/download`)).body;
        const zip = await fetch(download.url, {
          signal: AbortSignal.timeout(10_000),
        });
        ensure(zip.ok, 'Export download failed');
        const archive = unzipSync(new Uint8Array(await zip.arrayBuffer()));
        ensure(
          strFromU8(archive['document.md']) === secret,
          'Exported Markdown was not preserved',
        );
        stage = 'failure-path';
        await stop(worker, 15_000);
        worker = undefined;
        const failed = await request(`${path}/exports`, 'POST', {});
        await request('/api/v1/auth/logout', 'POST', {});
        await request('/api/v1/auth/login', 'POST', {
          email: 'observer@example.test',
          password: secret,
        });
        worker = launch(
          resolve(root, 'target/debug/labos-threejs-worker'),
          [],
          env,
        );
        await waitFor(`http://${env.WORKER_BIND}/health/ready`, worker);
        const failure = await eventually(async () => {
          const result = (await request(`${path}/exports/${failed.body.id}`))
            .body;
          return result.status === 'failed' ? result : undefined;
        }, 'revoked-session export failure');
        ensure(
          failure.last_error === 'knowledge.export_credential_revoked',
          'Export failure must retain a safe actionable code',
        );

        stage = 'tempo';
        const trace = await eventually(async () => {
          const result = await json(
            `http://127.0.0.1:${tempoPort}/api/traces/${exported.trace}`,
          );
          const spans = (result.batches ?? result.resourceSpans ?? []).flatMap(
            (batch) =>
              (batch.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
          );
          return spans.some((span) => span.name === 'job.attempt') &&
            spans.some((span) => span.name === 'storage.operation')
            ? { result, spans }
            : undefined;
        }, 'complete distributed trace in Tempo');
        const attrs = (span) =>
          Object.fromEntries(
            (span.attributes ?? []).map((item) => [
              item.key,
              item.value?.stringValue ?? item.value?.intValue,
            ]),
          );
        const job = trace.spans.find((span) => span.name === 'job.attempt');
        ensure(attrs(job).actor_id === actor, 'Job actor association missing');
        ensure(
          attrs(job).correlation_id === exported.request,
          'Job correlation missing',
        );
        stage = 'loki';
        const logs = await eventually(async () => {
          const query = `{service_name=~"labos-threejs-api|labos-threejs-worker"} |= "${exported.trace}"`;
          const result = await json(
            `http://127.0.0.1:${lokiPort}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&limit=100`,
          );
          return result.data?.result?.some(
            (stream) => stream.stream.service_name === 'labos-threejs-worker',
          ) &&
            result.data.result.some(
              (stream) => stream.stream.service_name === 'labos-threejs-api',
            )
            ? result
            : undefined;
        }, 'API and Worker logs in Loki');
        stage = 'prometheus';
        const metrics = await eventually(async () => {
          const result = await json(
            `http://127.0.0.1:${promPort}/api/v1/query?query=${encodeURIComponent('labos_threejs_jobs_attempts_total{kind="knowledge.export",outcome="succeeded"}')}`,
          );
          return result.data?.result?.length ? result : undefined;
        }, 'completed job metric in Prometheus');
        await eventually(async () => {
          const query = `{service_name="labos-threejs-worker"} |= "${failed.trace}" |= "knowledge.export_credential_revoked"`;
          const result = await json(
            `http://127.0.0.1:${lokiPort}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&limit=100`,
          );
          return result.data?.result?.length;
        }, 'safe failure diagnostic in Loki');
        stage = 'grafana';
        const dashboard = await json(
          `http://127.0.0.1:${grafanaPort}/api/dashboards/uid/labos-threejs-overview`,
        );
        ensure(
          dashboard.dashboard?.panels?.length === 5,
          'Grafana dashboard was not provisioned',
        );
        stage = 'audit';
        const audit = (
          await request(
            `/api/v1/audit-events?correlation_id=${exported.request}`,
          )
        ).body;
        ensure(
          audit.data.some(
            (row) =>
              row.job_id === attrs(job).job_id &&
              row.trace_id === exported.trace,
          ),
          'Audit trace/Job association missing',
        );
        await Promise.all([stop(api, 15_000), stop(worker, 15_000)]);
        api = undefined;
        worker = undefined;
        stage = 'privacy';
        const rawLogs = readdirSync(env.TELEMETRY_LOG_DIRECTORY)
          .map((file) =>
            readFileSync(join(env.TELEMETRY_LOG_DIRECTORY, file), 'utf8'),
          )
          .join('\n');
        const observed =
          JSON.stringify({ trace: trace.result, logs, metrics, audit }) +
          rawLogs;
        for (const value of [
          secret,
          upload.upload.url,
          download.url,
          cookie,
          csrf,
        ])
          ensure(
            !observed.includes(value),
            'Private material entered observation output',
          );
        const evidence = {
          sourceRef: process.env.DOCS_SOURCE_REF ?? 'working-tree',
          traceId: exported.trace,
          failedTraceId: failed.trace,
          requestId: exported.request,
          jobId: attrs(job).job_id,
          services: ['collector', 'prometheus', 'loki', 'tempo', 'grafana'],
          checks: [
            'real-export-content',
            'distributed-trace',
            'api-worker-logs',
            'job-metric',
            'grafana-dashboard',
            'audit-association',
            'revoked-session-failure-diagnostic',
            'secret-absence',
          ],
        };
        writeFileSync(
          join(root, '.scratch/t19-observability-evidence.json'),
          JSON.stringify(evidence, null, 2) + '\n',
        );
        console.log(
          'Real export, distributed trace, logs, metrics, dashboard and Audit verified. Safe evidence: .scratch/t19-observability-evidence.json',
        );
      } finally {
        await Promise.all([stop(api, 15_000), stop(worker, 15_000)]);
        observabilityCompose(['down', '--volumes', '--remove-orphans'], env);
      }
    }),
  );
} catch (error) {
  // No raw fetch/SDK error can expose a signed URL, captured body or credential.
  console.error(
    `Observability smoke failed during ${stage}${error instanceof SmokeFailure ? `: ${error.message}` : '.'}`,
  );
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
