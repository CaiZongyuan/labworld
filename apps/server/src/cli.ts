import { parseArgs } from 'node:util';
import { backup, restore } from './operations.ts';
import { configuration } from './config.ts';
const { values, positionals } = parseArgs({
  options: { output: { type: 'string' }, archive: { type: 'string' } },
  allowPositionals: true,
});
try {
  const config = configuration();
  if (positionals.length !== 1)
    throw new Error('Use backup --output or restore --archive');
  if (positionals[0] === 'backup' && values.output)
    console.log(JSON.stringify(await backup(config.directory, values.output)));
  else if (positionals[0] === 'restore' && values.archive)
    console.log(
      JSON.stringify(await restore(config.directory, values.archive)),
    );
  else throw new Error('Use backup --output or restore --archive');
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        code: 'operations.failed',
        message: error instanceof Error ? error.message : 'Operation failed',
      },
    }),
  );
  process.exitCode = 1;
}
