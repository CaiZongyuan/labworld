import http from 'k6/http';
import { check } from 'k6';
import crypto from 'k6/crypto';
import { sleep } from 'k6';
import {
  BASE_URL,
  ORIGIN,
  businessErrors,
  call,
  classify,
  headers,
  idempotencyKey,
  listDocuments,
  scenarioOptions,
  sessionFrom,
  writeSummary,
} from './lib.js';

// The realistic user trajectory of spec §17.3, end to end through the
// public interfaces: register → login → create → edit (with a version
// conflict) → attachment upload/download → export request → wait for the
// worker → export download → notifications. Each iteration is one fresh
// user, so the concurrency stays low while every subsystem is exercised.

export const options = scenarioOptions({ vus: 2, duration: '60s' });

const ATTACHMENT_BYTES = 32 * 1024;

function registerAndLogin() {
  const email = `traj-${idempotencyKey()}@perf.example.test`;
  const registered = call('register', 201, () =>
    http.post(
      `${BASE_URL}/api/v1/auth/register`,
      JSON.stringify({ email, password: 'a-long-perf-password' }),
      { headers: { origin: ORIGIN, 'content-type': 'application/json' } },
    ),
  );
  if (!registered) return null;
  // The register response already carries the session, so the VU can start
  // its journey immediately; the login that follows is part of the journey
  // itself (a returning user), not a prerequisite.
  const session = sessionFrom(registered, []);
  call('login', 200, () =>
    http.post(
      `${BASE_URL}/api/v1/auth/login`,
      JSON.stringify({ email, password: 'a-long-perf-password' }),
      { headers: { origin: ORIGIN, 'content-type': 'application/json' } },
    ),
  );
  return session;
}

function upload(s, documentId, body) {
  const sha256 = crypto.sha256(body, 'hex');
  // k6's randomBytes returns an ArrayBuffer: byteLength, not length. A
  // sizeless upload-start would fail validation as invalid JSON.
  const size = body.byteLength ?? body.length;
  const capability = call('upload-start', 201, () =>
    http.post(
      `${BASE_URL}/api/v1/knowledge/documents/${documentId}/uploads`,
      JSON.stringify({
        file_name: 'trajectory.bin',
        content_type: 'application/octet-stream',
        size,
        sha256,
      }),
      { headers: headers(s, true) },
    ),
  );
  if (!capability) return null;
  const put = http.put(capability.json('upload.url'), body, {
    headers: capability.json('upload.headers'),
  });
  check(put, { 'presigned put 200': (r) => r.status === 200 });
  return call('upload-complete', 200, () =>
    http.post(
      `${BASE_URL}/api/v1/knowledge/documents/${documentId}/uploads/${capability.json('upload_id')}/complete`,
      JSON.stringify({}),
      { headers: headers(s) },
    ),
  );
}

function pollExport(s, documentId, exportId) {
  for (let i = 0; i < 60; i += 1) {
    const response = http.get(
      `${BASE_URL}/api/v1/knowledge/documents/${documentId}/exports/${exportId}`,
      { headers: headers(s) },
    );
    if (response.status !== 200) {
      classify(response);
      return null;
    }
    const status = response.json('status');
    if (status === 'succeeded') return response.json();
    if (status === 'failed' || status === 'expired') {
      businessErrors.add(1);
      return null;
    }
    sleep(0.5);
  }
  return null;
}

export default function () {
  const s = registerAndLogin();
  if (!s) return;

  const document = call('create', 201, () =>
    http.post(
      `${BASE_URL}/api/v1/knowledge/documents`,
      JSON.stringify({
        title: `trajectory ${__VU}-${__ITER}`,
        markdown: `# trajectory\n\nIteration ${__ITER} of the realistic user journey.\n`,
      }),
      { headers: headers(s, true) },
    ),
  );
  if (!document) return;
  const id = document.json('id');
  const version = document.json('version');

  // The edit conflict is part of the real trajectory: an editor who lost a
  // race sees 409, re-reads and retries with the current version. The 409
  // is the expected outcome here, so it is checked but deliberately not
  // classified — an intended conflict must not inflate business_errors.
  const conflict = http.put(
    `${BASE_URL}/api/v1/knowledge/documents/${id}`,
    JSON.stringify({
      title: `trajectory ${__VU}-${__ITER}`,
      markdown: 'stale',
      version: version + 99,
    }),
    { headers: headers(s, true) },
  );
  check(conflict, { 'edit conflict 409': (r) => r.status === 409 });
  call('edit', 200, () =>
    http.put(
      `${BASE_URL}/api/v1/knowledge/documents/${id}`,
      JSON.stringify({
        title: `trajectory ${__VU}-${__ITER}`,
        markdown: `# trajectory\n\nIteration ${__ITER}, second revision.\n`,
        version,
      }),
      { headers: headers(s, true) },
    ),
  );

  const file = upload(s, id, crypto.randomBytes(ATTACHMENT_BYTES));
  if (file) {
    const download = call('attachment-url', 200, () =>
      http.get(
        `${BASE_URL}/api/v1/knowledge/documents/${id}/attachments/${file.json('id')}/download`,
        { headers: headers(s) },
      ),
    );
    if (download) {
      const bytes = http.get(download.json('url'), {
        headers: download.json('headers'),
      });
      check(bytes, { 'attachment bytes 200': (r) => r.status === 200 });
    }
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
    const finished = pollExport(s, id, requested.json('id'));
    if (finished && finished.can_download) {
      const download = call('export-url', 200, () =>
        http.get(
          `${BASE_URL}/api/v1/knowledge/documents/${id}/exports/${finished.id}/download`,
          {
            headers: headers(s),
          },
        ),
      );
      if (download) {
        const zip = http.get(download.json('url'), {
          headers: download.json('headers'),
        });
        check(zip, { 'export bytes 200': (r) => r.status === 200 });
      }
    }
  }

  call('notifications', 200, () =>
    http.get(`${BASE_URL}/api/v1/notifications`, { headers: headers(s) }),
  );
  // The journey closes with a plain list, the way a user returns to the
  // workspace; spec §17.2 names the list alongside the writes.
  listDocuments(s);
}

export const handleSummary = writeSummary({
  description:
    'full user journey: register, edit with conflict, attachments, export via worker, notifications',
});
