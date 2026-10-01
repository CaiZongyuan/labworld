import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { freePort } from './process.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Serves the built documentation dist the way the static host does:
// everything lives under the configured base, directory URLs come from an
// index.html, cleanUrls drops the .html extension, and a miss falls back
// to the built 404 page. The public-site browser journeys run against
// this server instead of the application stack.
export async function serveDocs(dist, base) {
  const port = await freePort();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith(base)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('outside the configured base');
      return;
    }
    let withoutBase = pathname.slice(base.length);
    if (withoutBase === '') withoutBase = 'index.html';
    else if (withoutBase.endsWith('/')) withoutBase += 'index.html';
    let file = join(dist, withoutBase);
    let status = 200;
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const candidate = join(dist, `${withoutBase.replace(/\/$/, '')}.html`);
      file = existsSync(candidate) ? candidate : join(dist, '404.html');
      status = 404;
    }
    const body = readFileSync(file);
    res.writeHead(status, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  });
  await new Promise((ready) => server.listen(port, '127.0.0.1', ready));
  const origin = `http://127.0.0.1:${port}`;
  return { origin, url: origin + base, close: () => server.close() };
}
