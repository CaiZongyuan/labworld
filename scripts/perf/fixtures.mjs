import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../lib/process.mjs';

// Seeds the knowledge example's dataset for the load scenarios — entirely
// through the public HTTP interfaces (register → create documents → upload
// attachments → request exports), never by writing to the database. Scale
// is configurable so the same script produces a smoke-sized or a larger
// dataset; the seeded counts travel into the report's fixture metadata.

const SCALE = {
  sm: { users: 6, docsPerUser: 8, attachmentsPerDoc: 0.25, attachmentKiB: 64 },
  md: {
    users: 20,
    docsPerUser: 30,
    attachmentsPerDoc: 0.25,
    attachmentKiB: 128,
  },
  lg: {
    users: 50,
    docsPerUser: 60,
    attachmentsPerDoc: 0.25,
    attachmentKiB: 256,
  },
};

export function scale() {
  const preset = SCALE[process.env.PERF_SCALE ?? 'sm'] ?? SCALE.sm;
  return {
    users: Number(process.env.PERF_USERS ?? preset.users),
    docsPerUser: Number(process.env.PERF_DOCS_PER_USER ?? preset.docsPerUser),
    attachmentsPerDoc: preset.attachmentsPerDoc,
    attachmentKiB: preset.attachmentKiB,
  };
}

// The origin header must match a trusted app origin (the API rejects
// others with auth.origin). The controlled load stack pins its app origin
// to the default; other stacks (the desktop soak) override it. Read
// lazily: callers that override PERF_ORIGIN do so after this module is
// imported (ESM evaluates module state first).
const origin = () => process.env.PERF_ORIGIN ?? 'http://127.0.0.1:5173';

function markdown(index) {
  // Realistic reading weight: headings, paragraphs, lists — a few KiB each,
  // deterministic per index so runs are comparable.
  const paragraphs = Array.from(
    { length: 8 },
    (_, p) =>
      `## 第 ${p + 1} 节\n\n文档 ${index} 的第 ${p + 1} 段正文。这段文字为负载场景提供稳定的读取体积，` +
      `内容本身没有含义，长度与真实文档相当，重复若干句以凑齐千字节量级。`.repeat(
        3,
      ),
  );
  return `# 负载样本文档 ${index}\n\n${paragraphs.join('\n\n')}\n`;
}

class Client {
  constructor(baseURL) {
    this.baseURL = baseURL;
    this.cookie = null;
    this.csrf = null;
  }

  async fetch(method, path, body, headers = {}) {
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers: {
        origin: origin(),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...headers,
      },
      body:
        body === undefined
          ? undefined
          : body instanceof Buffer
            ? body
            : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `${method} ${path} failed: ${response.status} ${await response.text().then((t) => t.slice(0, 300))}`,
      );
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    return response;
  }

  async json(method, path, body, headers = {}) {
    const response = await this.fetch(method, path, body, headers);
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : null;
  }

  idempotent() {
    return { 'idempotency-key': randomUUID() };
  }
}

async function register(baseURL, index) {
  const client = new Client(baseURL);
  const email = `perf-user-${process.pid}-${index}@perf.example.test`;
  const session = await client.json('POST', '/api/v1/auth/register', {
    email,
    password: 'a-long-perf-password',
  });
  client.csrf = session.csrf_token;
  return { client, email, userId: session.user.id };
}

async function uploadAttachment(client, documentId, sizeKiB) {
  const body = Buffer.alloc(sizeKiB * 1024, 0x70);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const capability = await client.json(
    'POST',
    `/api/v1/knowledge/documents/${documentId}/uploads`,
    {
      file_name: `perf-${documentId.slice(0, 8)}.bin`,
      content_type: 'application/octet-stream',
      size: body.length,
      sha256,
    },
    client.idempotent(),
  );
  const put = await fetch(capability.upload.url, {
    method: capability.upload.method,
    headers: capability.upload.headers,
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!put.ok) throw new Error(`presigned upload failed: ${put.status}`);
  const file = await client.json(
    'POST',
    `/api/v1/knowledge/documents/${documentId}/uploads/${capability.upload_id}/complete`,
  );
  return file.id;
}

// Seeds and writes the user list k6 logs in with (cookies are NOT carried
// over: the scenario login is part of the measured behavior). The example
// guard lives in run-scenario.mjs, the only entry point — it exits before
// this module is ever imported.
export async function seed(baseURL) {
  const shape = scale();
  const started = Date.now();
  const users = [];
  let documents = 0;
  let attachments = 0;

  console.log(
    `[fixtures] seeding ${shape.users} users × ${shape.docsPerUser} documents (scale ${process.env.PERF_SCALE ?? 'sm'})...`,
  );
  for (let u = 0; u < shape.users; u += 1) {
    const { client, email } = await register(baseURL, u);
    const docIds = [];
    for (let d = 0; d < shape.docsPerUser; d += 1) {
      const document = await client.json(
        'POST',
        '/api/v1/knowledge/documents',
        { title: `负载样本 ${u}-${d}`, markdown: markdown(d) },
        client.idempotent(),
      );
      docIds.push(document.id);
      documents += 1;
      if (d % Math.round(1 / shape.attachmentsPerDoc) === 0) {
        await uploadAttachment(client, document.id, shape.attachmentKiB);
        attachments += 1;
      }
    }
    users.push({ email, password: 'a-long-perf-password', docIds });
    process.stdout.write(`[fixtures] user ${u + 1}/${shape.users}\r`);
  }
  process.stdout.write('\n');

  const fixtureDir = join(root, '.scratch', 'perf');
  mkdirSync(fixtureDir, { recursive: true });
  const usersPath = join(fixtureDir, 'fixtures-users.json');
  writeFileSync(usersPath, `${JSON.stringify(users, null, 2)}\n`);
  const manifest = {
    seededAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    baseURL,
    ...shape,
    documents,
    attachments,
    usersFile: usersPath,
  };
  writeFileSync(
    join(fixtureDir, 'fixtures.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `[fixtures] ${documents} documents, ${attachments} attachments in ${(manifest.durationMs / 1000).toFixed(1)}s; users file: ${usersPath}`,
  );
  return manifest;
}
