import { createServer } from 'node:http';
process.on('SIGTERM', () => {});
createServer((_request, response) => response.end('alive')).listen(
  Number(process.argv[2]),
  '127.0.0.1',
);
