import http from 'k6/http';
import { check } from 'k6';
import { sleep } from 'k6';
import {
  BASE_URL,
  call,
  headers,
  listDocuments,
  loginAs,
  scenarioOptions,
  writeSummary,
} from './lib.js';

// The long run: low concurrency, the realistic edit/attachment/export
// journey without registration, for a long configured duration. Its value
// is the trajectory of the samples over time (pool, queue, RSS, error
// rate), which is what the runner stores with the k6 summary.

export const options = scenarioOptions({ vus: 2, duration: '600s' });

export default function () {
  const s = loginAs(__VU);
  if (!s) return;

  const document = call('create', 201, () =>
    http.post(
      `${BASE_URL}/api/v1/knowledge/documents`,
      JSON.stringify({
        title: `soak ${__VU}-${__ITER}`,
        markdown: `# soak\n\nIteration ${__ITER} of the long run.\n`,
      }),
      { headers: headers(s, true) },
    ),
  );
  if (!document) return;
  const id = document.json('id');
  const version = document.json('version');
  call('edit', 200, () =>
    http.put(
      `${BASE_URL}/api/v1/knowledge/documents/${id}`,
      JSON.stringify({
        title: `soak ${__VU}-${__ITER}`,
        markdown: `# soak\n\nIteration ${__ITER}, second revision.\n`,
        version,
      }),
      { headers: headers(s, true) },
    ),
  );

  const page = listDocuments(s);
  if (page) {
    const docs = page.json('data');
    if (docs.length > 0)
      call('get', 200, () =>
        http.get(
          `${BASE_URL}/api/v1/knowledge/documents/${docs[Math.floor(Math.random() * docs.length)].id}`,
          {
            headers: headers(s),
          },
        ),
      );
  }

  const requested = call('export-request', 202, () =>
    http.post(
      `${BASE_URL}/api/v1/knowledge/documents/${id}/exports`,
      JSON.stringify({}),
      {
        headers: headers(s, true),
      },
    ),
  );
  if (requested) {
    // Fire and forget on the export: the soak's job is to watch the queue
    // drain over time, which the runner's sampler records.
    check(requested, { 'export accepted': (r) => r.json('status') !== '' });
  }
  sleep(1);
}

export const handleSummary = writeSummary({
  description:
    'long low-concurrency run watching pool, queue and memory over time',
});
