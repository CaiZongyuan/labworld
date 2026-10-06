import * as actual from '../../packages/server/src/platform/codecs.ts';
export {
  CodecUnavailable,
  decodeBasis,
  decodeDraco,
  decodeImage,
  decodeMeshopt,
} from '../../packages/server/src/platform/codecs.ts';
let admitted = 0;
export async function validGlbStructure(bytes: Uint8Array) {
  admitted++;
  if (admitted === 2) process.emit('owned-codec-pair-admitted');
  return actual.validGlbStructure(bytes);
}
