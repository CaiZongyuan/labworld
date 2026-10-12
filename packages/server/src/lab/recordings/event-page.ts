import {
  decodeRecordingPacket,
  parseSourceEvent,
  parseRobotSourceEvent,
} from '../../../../contracts/src/recording/index.ts';
import { journalDigest, type JournalRecord } from './journal.ts';

type Position = {
  recording_id: string;
  ordinal: string;
  index: number;
  scan?: string;
  lookup?: {
    commit: string;
    batch: string;
    scan: string;
    prepare: string | null;
  };
  legacy?: { commit: string; prepare: string | null };
};
export type EventWindow = {
  records: JournalRecord[];
  more: boolean;
  at: (ordinal: string) => Promise<JournalRecord | undefined>;
};
const unsigned = (value: unknown) =>
  typeof value === 'string' && /^\d+$/.test(value);
export function eventPosition(value: unknown, id: string): Position {
  const p = value as Position;
  if (
    !p ||
    p.recording_id !== id ||
    !unsigned(p.ordinal) ||
    !Number.isInteger(p.index) ||
    p.index < -1 ||
    (p.scan !== undefined && !unsigned(p.scan)) ||
    (p.lookup &&
      (!unsigned(p.lookup.commit) ||
        !unsigned(p.lookup.scan) ||
        typeof p.lookup.batch !== 'string' ||
        p.lookup.batch.length > 256 ||
        (p.lookup.prepare !== null && !unsigned(p.lookup.prepare)))) ||
    (p.legacy &&
      (!unsigned(p.legacy.commit) ||
        (p.legacy.prepare !== null && !unsigned(p.legacy.prepare))))
  )
    throw new Error('recording_invalid_cursor');
  return { ...p, ordinal: BigInt(p.ordinal).toString(), scan: p.scan ?? '0' };
}
const token = (p: Position) => {
  const raw = Buffer.from(JSON.stringify(p)).toString('base64url');
  if (raw.length > 2048) throw new Error('recording_invalid_cursor');
  return raw;
};
function businessCommit(record: JournalRecord, prepare?: JournalRecord) {
  if (
    Array.isArray(record.data.events) &&
    journalDigest(Buffer.from(JSON.stringify(record.data.events))) ===
      record.data.sha256
  )
    return record.data.events as Record<string, unknown>[];
  if (
    prepare?.kind === 'business.prepare' &&
    prepare.data.batch_id === record.data.batch_id &&
    prepare.data.sha256 === record.data.sha256 &&
    Array.isArray(prepare.data.events)
  )
    return prepare.data.events as Record<string, unknown>[];
  return [];
}

/** One segment scan; old commit payloads use bounded, cursor-backed lookback. */
export async function recordingEventPage(
  id: string,
  position: Position,
  limit: number,
  window: (after: string, points: string[]) => Promise<EventWindow>,
  checkDeadline: () => void,
) {
  const p = {
    ...position,
    lookup: position.lookup ? { ...position.lookup } : undefined,
  };
  const data: Record<string, unknown>[] = [];
  let bytes = 0;
  const result = (more: boolean) => ({
    data,
    next_cursor: more ? token(p) : null,
  });
  const append = (record: JournalRecord, events: Record<string, unknown>[]) => {
    for (let index = 0; index < events.length; index++) {
      if (
        BigInt(record.ordinal) < BigInt(p.ordinal) ||
        (BigInt(record.ordinal) === BigInt(p.ordinal) && index <= p.index)
      )
        continue;
      const entry = { ordinal: record.ordinal, ...events[index] };
      const size = Buffer.byteLength(JSON.stringify(entry));
      // Reserve the bounded cursor/envelope so the whole page stays <=256KiB.
      if (data.length >= limit || bytes + size > 256 * 1024 - 4096)
        return false;
      data.push(entry);
      bytes += size;
      p.ordinal = record.ordinal;
      p.index = index;
    }
    p.scan = record.ordinal;
    p.legacy = undefined;
    return true;
  };
  if (p.lookup) {
    const lookup = p.lookup;
    const part = await window(lookup.scan, [
      lookup.commit,
      ...(lookup.prepare ? [lookup.prepare] : []),
    ]);
    let done = !part.more;
    for (const record of part.records) {
      checkDeadline();
      if (BigInt(record.ordinal) >= BigInt(lookup.commit)) {
        done = true;
        break;
      }
      // Hash source bytes even during old-prefix lookback; never skip by kind1.
      if (record.kind === 'source.packet')
        await decodeRecordingPacket(
          Buffer.from(String(record.data.packet_base64), 'base64'),
        );
      if (record.data.batch_id === lookup.batch) {
        if (record.kind === 'business.prepare') lookup.prepare = record.ordinal;
        if (
          record.kind === 'business.abort' ||
          record.kind === 'business.commit'
        )
          lookup.prepare = null;
      }
      lookup.scan = record.ordinal;
    }
    if (!done) return result(true);
    const commit =
      part.records.find((r) => r.ordinal === lookup.commit) ??
      (await part.at(lookup.commit));
    if (
      !commit ||
      commit.kind !== 'business.commit' ||
      String(commit.data.batch_id) !== lookup.batch
    )
      throw new Error('recording_event_changed');
    const prepare = lookup.prepare
      ? (part.records.find((r) => r.ordinal === lookup.prepare) ??
        (await part.at(lookup.prepare)))
      : undefined;
    p.lookup = undefined;
    p.legacy = { commit: commit.ordinal, prepare: lookup.prepare };
    if (!append(commit, businessCommit(commit, prepare))) return result(true);
    // Advance the normal scan next time; no second unbounded segment walk.
    return result(true);
  }
  const part = await window(
    p.scan!,
    p.legacy?.prepare ? [p.legacy.prepare] : [],
  );
  const prepared = new Map<string, JournalRecord>();
  for (const record of part.records) {
    checkDeadline();
    let events: Record<string, unknown>[] = [];
    if (record.kind === 'business.prepare')
      prepared.set(String(record.data.batch_id), record);
    else if (record.kind === 'business.abort')
      prepared.delete(String(record.data.batch_id));
    else if (record.kind === 'business.commit') {
      let prepare = prepared.get(String(record.data.batch_id));
      if (!prepare && p.legacy?.commit === record.ordinal && p.legacy.prepare)
        prepare = await part.at(p.legacy.prepare);
      if (
        !(
          Array.isArray(record.data.events) &&
          journalDigest(Buffer.from(JSON.stringify(record.data.events))) ===
            record.data.sha256
        ) &&
        !prepare &&
        p.legacy?.commit !== record.ordinal
      ) {
        p.lookup = {
          commit: record.ordinal,
          batch: String(record.data.batch_id),
          scan: '0',
          prepare: null,
        };
        return result(true);
      }
      events = businessCommit(record, prepare);
      prepared.delete(String(record.data.batch_id));
    } else if (record.kind === 'business.event') events = [record.data];
    else if (record.kind === 'source.packet') {
      const packet = await decodeRecordingPacket(
        Buffer.from(String(record.data.packet_base64), 'base64'),
      );
      if (packet.kind === 2 || packet.kind === 4) {
        const event =
          packet.kind === 2
            ? parseSourceEvent(new TextDecoder().decode(packet.payload))
            : parseRobotSourceEvent(new TextDecoder().decode(packet.payload));
        events = [
          {
            event_id: event.event_id,
            event_type: event.event_type,
            entity_id:
              'entity_id' in event.subject ? event.subject.entity_id : null,
            recorded_at: record.recorded_at,
            sim_time_ns: event.sim_time_ns,
            event:
              packet.kind === 4
                ? { ...event.event, subject: event.subject }
                : event.event,
          },
        ];
      }
    }
    if (!append(record, events)) return result(true);
  }
  return result(part.more);
}
