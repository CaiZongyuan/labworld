export type RetentionPolicy = {
  observation_seconds: number;
  record_seconds: number;
};
export const defaultRetention: RetentionPolicy = {
  observation_seconds: 86400,
  record_seconds: 2592000,
};
export const historyKinds = [
  'observation',
  'command',
  'task',
  'event',
] as const;
export type HistoryKind = (typeof historyKinds)[number];
export type HistoryRecord = {
  id: string;
  entity_id: string;
  run_id: string;
  recorded_at: string;
  observed_at: string | null;
  received_at: string;
  data: unknown;
};
