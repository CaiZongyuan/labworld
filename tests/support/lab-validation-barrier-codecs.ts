export {
  CodecUnavailable,
  decodeBasis,
  decodeDraco,
  decodeImage,
  decodeMeshopt,
} from '../../packages/server/src/platform/codecs.ts';
import { validGlbStructure as actual } from '../../packages/server/src/platform/codecs.ts';
const release = new Promise<void>((resolve) => {
  process.once('owned-release-validator', resolve);
});
export async function validGlbStructure(bytes: Uint8Array) {
  process.send?.({ stage: 'validator-admitted' });
  await release;
  return actual(bytes);
}
