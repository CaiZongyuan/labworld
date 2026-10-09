import type { LabRecordsPage } from '@labos-threejs/sdk';

function cell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  const formulaCandidate = text
    .replaceAll(String.fromCharCode(0), '')
    .trimStart();
  const safe =
    /^[=+\-@]/.test(formulaCandidate) || /^[\t\r]/.test(text)
      ? `'${text}`
      : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
function pageCsv(page: LabRecordsPage, labId: string) {
  const header = [
    'lab_id',
    'query_upper_bound',
    'filter_entity_id',
    'filter_record_type',
    'filter_from',
    'filter_to',
    'record_id',
    'record_type',
    'entity_id',
    'entity_name',
    'reality',
    'archived_at',
    'run_id',
    'binding_id',
    'command_id',
    'task_id',
    'result_id',
    'recorded_at',
    'ended_at',
    'state',
    'summary',
    'source',
    'actor_id',
    'actor_source',
    'actor_role',
    'data_json',
  ];
  const rows = page.items
    .slice(0, 100)
    .map((record) =>
      [
        labId,
        page.query_upper_bound,
        page.entity_id,
        page.record_type,
        page.from,
        page.to,
        record.id,
        record.record_type,
        record.entity_id,
        record.entity_name,
        record.reality,
        record.archived_at,
        record.run_id,
        record.binding_id,
        record.command_id,
        record.task_id,
        record.result_id,
        record.recorded_at,
        record.ended_at,
        record.state,
        record.summary,
        record.source,
        record.actor_id,
        record.actor_source,
        record.actor_role,
        JSON.stringify(record.data),
      ]
        .map(cell)
        .join(','),
    );
  return '\uFEFF' + [header.map(cell).join(','), ...rows].join('\r\n') + '\r\n';
}

/** Downloads only the page already read; no request or shared World mutation. */
export function downloadRecordsPage(page: LabRecordsPage, labId: string) {
  const url = URL.createObjectURL(
    new Blob([pageCsv(page, labId)], { type: 'text/csv;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `lab-records-${labId}-current-page.csv`;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}
