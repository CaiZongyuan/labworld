// Paste into the Console of the authenticated, same-origin Lab page.
// These functions read bounded pages and one sealed segment. Delete is a separate explicit call.
const recordingUUID = (value) => {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value))
    throw new Error('Use a Lab or Recording UUID.');
  return value;
};
const recordingHash = async (bytes) =>
  'sha256:' +
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
async function recordingReadBytes(response, maximum) {
  if (!response.ok)
    throw new Error(`Recording request failed: ${response.status}`);
  if (!response.body) throw new Error('Recording response has no body.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > maximum - size)
        throw new Error('Recording response exceeds its read limit.');
      size += value.byteLength;
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

globalThis.inspectRecording = async function inspectRecording(
  labId,
  recordingId,
) {
  const path = `/api/v1/lab/labs/${recordingUUID(labId)}/recordings/${recordingUUID(recordingId)}`;
  const read = async (suffix, maximum = 256 * 1024) =>
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await recordingReadBytes(await fetch(path + suffix), maximum),
      ),
    );
  const metadata = await read('');
  const manifest = await read('/manifest', 2 * 1024 * 1024);
  const segments = await read('/segments?limit=5');
  const events = await read('/events?limit=5');
  const segment = segments.data.find((item) => item.sealed);
  const records = [];
  if (segment) {
    if (
      !Number.isInteger(segment.size) ||
      segment.size < 36 ||
      segment.size > 1024 * 1024
    )
      throw new Error('Select a sealed segment within the 1 MiB read limit.');
    const bytes = await recordingReadBytes(
      await fetch(path + `/segments/${segment.id}`),
      segment.size,
    );
    if (
      bytes.byteLength !== segment.size ||
      (await recordingHash(bytes)) !== segment.sha256
    )
      throw new Error('Segment bytes do not match their size and SHA-256.');
    // LWF record: u32 little-endian JSON length, 32-byte SHA-256, exact UTF-8 JSON.
    let offset = 0;
    while (offset < bytes.byteLength && records.length < 16) {
      if (bytes.byteLength - offset < 36)
        throw new Error('Truncated segment record.');
      const size = new DataView(bytes.buffer).getUint32(offset, true);
      if (
        size < 1 ||
        size > 128 * 1024 ||
        size > bytes.byteLength - offset - 36
      )
        throw new Error('Invalid segment record.');
      const payload = bytes.subarray(offset + 36, offset + 36 + size);
      const expected =
        'sha256:' +
        Array.from(bytes.subarray(offset + 4, offset + 36), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
      if ((await recordingHash(payload)) !== expected)
        throw new Error('Record SHA-256 does not match.');
      records.push(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)),
      );
      offset += 36 + size;
    }
  }
  const result = {
    recording_id: metadata.id,
    session_id: metadata.session_id,
    status: metadata.status,
    integrity: metadata.integrity,
    reason: metadata.reason,
    prefix: metadata.prefix,
    manifest: {
      snapshot_hash: manifest.snapshot_hash,
      captured_entities: manifest.capture_entity_ids.length,
      physics_entities: manifest.physics_entity_ids.length,
      versions: manifest.versions,
    },
    segments: segments.data,
    next_segments_cursor: segments.next_cursor,
    events: events.data,
    next_events_cursor: events.next_cursor,
    verified_segment_id: segment?.id ?? null,
    first_record: records[0] ?? null,
    source_header:
      records.find((record) => record.kind === 'source.header')?.data
        .source_header ?? null,
    inspected_records: records.map(({ ordinal, kind }) => ({ ordinal, kind })),
  };
  console.log(result);
  return result;
};

globalThis.deleteRecording = async function deleteRecording(
  labId,
  recordingId,
) {
  const identity = await fetch('/api/v1/auth/session');
  if (!identity.ok) throw new Error('Sign in before deleting a Recording.');
  const { csrf_token: csrf } = await identity.json();
  const path = `/api/v1/lab/labs/${recordingUUID(labId)}/recordings/${recordingUUID(recordingId)}`;
  const response = await fetch(path, {
    method: 'DELETE',
    headers: { 'x-csrf-token': csrf },
  });
  if (!response.ok)
    throw new Error(`Recording deletion refused: ${response.status}`);
  console.log({ deleted_recording_id: recordingId, status: response.status });
};
