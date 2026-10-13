import { createHash } from 'node:crypto';

export const sceneHashAlgorithm = 'labworld-scene-f64hex-v1';

export function digestTypedSceneValue(value) {
  function utf8hex(text) {
    if (!text.isWellFormed())
      throw new TypeError('Invalid Unicode scalar string');
    return Buffer.from(text, 'utf8').toString('hex');
  }
  function encode(item) {
    if (item === null) return ['null'];
    if (typeof item === 'boolean') return ['bool', String(item)];
    if (typeof item === 'string') return ['str', utf8hex(item)];
    if (typeof item === 'number') {
      if (
        !Number.isFinite(item) ||
        (Number.isInteger(item) && !Number.isSafeInteger(item))
      ) {
        throw new TypeError('Invalid finite safe number');
      }
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleBE(item === 0 ? 0 : item);
      return ['num', bytes.toString('hex')];
    }
    if (Array.isArray(item)) return ['array', item.map(encode)];
    if (
      typeof item === 'object' &&
      Object.getPrototypeOf(item) === Object.prototype
    ) {
      const entries = Object.entries(item).map(([key, entry]) => [
        utf8hex(key),
        encode(entry),
      ]);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return ['object', entries];
    }
    throw new TypeError('Invalid scene value');
  }
  return (
    'sha256:' +
    createHash('sha256')
      .update(sceneHashAlgorithm + '\0', 'ascii')
      .update(JSON.stringify(encode(value)), 'ascii')
      .digest('hex')
  );
}

export function sceneDigestOracle(manifest) {
  if (manifest.scene_hash_algorithm !== sceneHashAlgorithm) {
    throw new TypeError('Unsupported scene hash algorithm');
  }
  return digestTypedSceneValue(
    Object.fromEntries(
      Object.entries(manifest).filter(
        ([key]) =>
          !['scene_hash', 'source_id', 'initial_state', 'provenance'].includes(
            key,
          ),
      ),
    ),
  );
}
