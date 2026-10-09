import RecordsPanel, { type RecordsPanelProps } from './records-panel';

/** Bounded first-page reader for the future overview; contains no raw Observation stream. */
export default function RecentActivity(
  props: Omit<RecordsPanelProps, 'variant'>,
) {
  return <RecordsPanel {...props} variant="recent" />;
}
