import assert from 'node:assert/strict';

// Independent expected denial vocabulary. An extra private field must fail;
// the production control parser is deliberately not the oracle.
const publicDenials: Record<string, readonly string[]> = {
  unauthorized: ['Motion admission failed', 'Motion admission timed out'],
  mapping_mismatch: ['Scene hash mismatch'],
  invalid_message: ['Send one bounded motion HELLO'],
  limit_exceeded: ['Viewer capacity reached'],
};
const publicCloseReasons = ['', ...Object.keys(publicDenials)];
export function denialEvidence(
  binaryBytes: number,
  texts: readonly unknown[],
  closeReason = '',
) {
  let metadataMessages = 0;
  for (const text of texts) {
    if (!text || typeof text !== 'object' || Array.isArray(text)) {
      metadataMessages++;
      continue;
    }
    const value = text as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(',') !== 'code,message,type' ||
      value.type !== 'motion.error' ||
      typeof value.code !== 'string' ||
      typeof value.message !== 'string' ||
      Buffer.byteLength(value.message) > 256 ||
      !Object.hasOwn(publicDenials, value.code) ||
      !publicDenials[value.code]?.includes(value.message)
    )
      metadataMessages++;
  }
  return {
    binaryBytes,
    textMessages: texts.length,
    metadataMessages,
    unsafeCloseReasons: publicCloseReasons.includes(closeReason) ? 0 : 1,
  };
}
export function assertPrivateDenial(
  binaryBytes: number,
  texts: readonly unknown[],
  closeReason = '',
) {
  const observed = denialEvidence(binaryBytes, texts, closeReason);
  assert.equal(
    observed.binaryBytes,
    0,
    'Denied peer received binary experiment bytes',
  );
  assert.equal(
    observed.metadataMessages,
    0,
    'Denied peer received an unsafe text payload',
  );
  assert.equal(
    observed.unsafeCloseReasons,
    0,
    'Denied peer received an unsafe close reason',
  );
  return observed;
}
