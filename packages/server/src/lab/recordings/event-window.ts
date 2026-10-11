import type { JournalRecord } from './journal.ts';
import type { EventWindow } from './event-page.ts';
export type EventPart = {
  id: string;
  index: number;
  size: number;
  first_ordinal: string;
  last_ordinal: string;
  file_id: string | null;
  path: string | null;
};
/** One scan segment and at most two exact ordinal segments; cache dies with GET. */
export async function eventWindow(
  after: string,
  parts: EventPart[],
  read: (part: EventPart) => Promise<JournalRecord[]>,
): Promise<EventWindow> {
  const cache = new Map<string, JournalRecord[]>();
  async function load(part: EventPart) {
    const old = cache.get(part.id);
    if (old) return old;
    if (cache.size >= 3 || part.size < 36 || part.size > 1024 * 1024)
      throw new Error('recording_event_window_capacity');
    const records = await read(part);
    if (
      records[0]?.ordinal !== part.first_ordinal ||
      records.at(-1)?.ordinal !== part.last_ordinal ||
      records.some(
        (r, i) =>
          !/^\d+$/.test(r.ordinal) ||
          (i > 0 && BigInt(r.ordinal) !== BigInt(records[i - 1].ordinal) + 1n),
      )
    )
      throw new Error('recording_ordinal_gap');
    cache.set(part.id, records);
    return records;
  }
  const candidates = parts
    .filter((p) => BigInt(p.last_ordinal) > BigInt(after))
    .sort((a, b) => a.index - b.index);
  if (candidates[0] && BigInt(candidates[0].first_ordinal) > BigInt(after) + 1n)
    throw new Error('recording_ordinal_gap');
  const records = candidates[0]
    ? (await load(candidates[0])).filter(
        (r) => BigInt(r.ordinal) > BigInt(after),
      )
    : [];
  return {
    records,
    more: candidates.length > 1,
    at: async (ordinal) => {
      const part = parts.find(
        (p) =>
          BigInt(p.first_ordinal) <= BigInt(ordinal) &&
          BigInt(p.last_ordinal) >= BigInt(ordinal),
      );
      return part
        ? (await load(part)).find((r) => r.ordinal === ordinal)
        : undefined;
    },
  };
}
