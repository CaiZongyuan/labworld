import type { LabRecord } from '@labos-threejs/sdk';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import { useAppMessage } from '../shell/messages';

export default function RecordDetails({ record }: { record: LabRecord }) {
  const message = useAppMessage('lab');
  const data =
    record.data !== null && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : null;
  const result = data?.result;
  const matchingResult =
    !record.result_id ||
    (result !== null &&
      typeof result === 'object' &&
      (result as { id?: string }).id === record.result_id);
  const value = (value: string | null | undefined) =>
    value && value !== 'unknown' ? value : message('records.unknown');
  const fields = [
    ['Entity', record.entity_id],
    ['Run', record.run_id],
    ['Binding', record.binding_id],
    ['Command', record.command_id],
    ['Task', record.task_id],
    ['Result', record.result_id],
    [message('records.source'), record.source],
    [message('records.actor'), record.actor_id],
    [message('records.actorSource'), record.actor_source],
    [message('records.actorRole'), record.actor_role],
  ];
  return (
    <section
      className="record-details"
      aria-label={message('records.originalResult')}
    >
      <h3>{message('records.originalResult')}</h3>
      <p>
        {record.summary} · {record.state}
      </p>
      <dl className="world-properties">
        {fields.map(([label, text]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value(text)}</dd>
          </div>
        ))}
      </dl>
      <p>
        <time dateTime={record.recorded_at}>{record.recorded_at}</time>
        {record.ended_at ? (
          <>
            {' '}
            — <time dateTime={record.ended_at}>{record.ended_at}</time>
          </>
        ) : null}
      </p>
      {matchingResult && result !== undefined && result !== null ? (
        <pre>{JSON.stringify(result, null, 2)}</pre>
      ) : (
        <Alert>
          <AlertDescription>
            {message(
              record.result_id && !matchingResult
                ? 'records.resultMismatch'
                : 'records.noResult',
            )}
          </AlertDescription>
        </Alert>
      )}
      <details>
        <summary>{message('records.rawData')}</summary>
        <pre>{JSON.stringify(record.data, null, 2)}</pre>
      </details>
    </section>
  );
}
