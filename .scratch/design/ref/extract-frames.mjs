import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(
  new URL('../DilumSanjaya-2106426962738880879-01.mp4', import.meta.url),
);
const output = fileURLToPath(new URL('./', import.meta.url));
const sourceSize = statSync(source).size;
const frames = [
  {
    file: '01-spatial-overview.png',
    seconds: 1.2,
    focus: '场景主工作面与边缘信息区',
  },
  {
    file: '02-object-detail.png',
    seconds: 19.3,
    focus: '选中对象与上下文详情',
  },
  {
    file: '03-task-summary.png',
    seconds: 25.3,
    focus: '底部任务阶段与对象状态',
  },
  {
    file: '04-context-switcher.png',
    seconds: 31.3,
    focus: '场景切换与对象目录',
  },
  {
    file: '05-overview-distance.png',
    seconds: 49.4,
    focus: '拉远取景与空间结构',
  },
  {
    file: '06-selected-object-path.png',
    seconds: 55.4,
    focus: '选中对象强调与位置关系',
  },
];
const server = createServer((request, response) => {
  if (request.url !== '/reference.mp4') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      '<html><body><video muted preload="auto" src="/reference.mp4"></video></body></html>',
    );
    return;
  }
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]);
    const end = range[2]
      ? Math.min(Number(range[2]), sourceSize - 1)
      : sourceSize - 1;
    response.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${sourceSize}`,
      'Content-Length': end - start + 1,
    });
    createReadStream(source, { start, end }).pipe(response);
  } else {
    response.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': sourceSize,
    });
    createReadStream(source).pipe(response);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(
    () => document.querySelector('video').readyState >= 2,
  );
  const metadata = await page.evaluate(() => {
    const video = document.querySelector('video');
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      durationSeconds: video.duration,
    };
  });
  mkdirSync(output, { recursive: true });
  for (const frame of frames) {
    const encoded = await page.evaluate(async (seconds) => {
      const video = document.querySelector('video');
      await new Promise((resolve) => {
        video.addEventListener('seeked', resolve, { once: true });
        video.currentTime = seconds;
      });
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    }, frame.seconds);
    const bytes = Buffer.from(encoded, 'base64');
    writeFileSync(`${output}${frame.file}`, bytes);
    frame.bytes = bytes.length;
    frame.sha256 = createHash('sha256').update(bytes).digest('hex');
    console.log(`${frame.file} @ ${frame.seconds}s (${bytes.length} bytes)`);
  }
  writeFileSync(
    `${output}manifest.json`,
    JSON.stringify(
      {
        source: 'DilumSanjaya-2106426962738880879-01.mp4',
        sourceSha256: createHash('sha256')
          .update(readFileSync(source))
          .digest('hex'),
        ...metadata,
        frames,
        processing:
          'Full uncropped video frames at native resolution. No overlays or content edits.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
