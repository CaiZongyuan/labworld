import {
  mkdirSync,
  writeFileSync,
  linkSync,
  readFileSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** A private, persistent development key keeps queued mail readable across restarts. */
export function developmentMailKey(directory) {
  const secrets = join(directory, '.secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const destination = join(secrets, 'development-mail-key');
  const temporary = join(secrets, `mail-key-${randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temporary, randomBytes(32).toString('hex'), {
      flag: 'wx',
      mode: 0o600,
    });
    created = true;
    try {
      linkSync(temporary, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } finally {
    if (created) rmSync(temporary);
  }
  const stat = lstatSync(destination);
  if (
    !stat.isFile() ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  )
    throw new Error('Development mail key must be a private regular file');
  const key = readFileSync(destination, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(key))
    throw new Error(
      'Development mail key is invalid; restore its original protected value',
    );
  return key;
}
