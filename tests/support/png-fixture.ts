export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function corruptPngPixelStream(original: Buffer) {
  const bad = Buffer.from(original);
  for (let offset = 8; offset < bad.length;) {
    const length = bad.readUInt32BE(offset),
      type = bad.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT' && length > 2) {
      bad[offset + 10] = 0xff; // Reserved DEFLATE block type after the zlib header.
      bad.writeUInt32BE(
        crc32(bad.subarray(offset + 4, offset + 8 + length)),
        offset + 8 + length,
      );
      return bad;
    }
    offset += 12 + length;
  }
  throw new Error('PNG fixture has no pixel stream');
}
