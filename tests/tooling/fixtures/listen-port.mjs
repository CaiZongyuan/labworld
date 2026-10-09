import { createServer } from 'node:http';
process.on('SIGTERM', () => {
  if (!process.argv.includes('--ignore-term')) process.exit(0);
});
createServer((_request, response) => response.end('alive')).listen(
  Number(process.argv[2]),
  process.env.LISTEN_HOST ?? '127.0.0.1',
);
