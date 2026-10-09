import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeReport, parseArgs, parseEventLines, rebaseHref, renderFile, renderReport, summarizeCommands } from '../scripts/render.mjs';

const renderer = fileURLToPath(new URL('../scripts/render.mjs', import.meta.url));
const at = minute => `2026-01-02T10:${String(minute).padStart(2, '0')}:00.000Z`;
const event = (id, start = at(0), end = at(10), overrides = {}) => ({
  id, lane: 'Developer', kind: 'command', category: 'validation', label: 'Focused check', start,
  ...(end ? { end } : {}), outcome: 'passed', confidence: 'verified', evidence: [], ...overrides,
});
const report = overrides => ({ project: 'Example project', title: 'Development timeline', snapshotAt: at(40),
  task: { status: 'in-progress', goal: 'Deliver a usable workflow', startedAt: at(0) },
  tickets: [], events: [], findings: [], rules: [], tests: [], resources: [], ...overrides });

function extractData(html) {
  const open = '<script id="report-data" type="application/json">';
  const start = html.indexOf(open) + open.length;
  return JSON.parse(html.slice(start, html.indexOf('</script>', start)));
}

test('command statistics distinguish cumulative time from parallel union and exclude other activity', () => {
  const rows = [event('a'), event('b', at(5), at(15)), event('c', at(20), at(25)),
    event('phase', at(0), at(40), { kind: 'phase' }), event('wait', at(0), at(40), { kind: 'wait' }),
    event('point', at(0), at(40), { kind: 'point' }), event('unfinished', at(30), null), event('zero', at(25), at(25))];
  assert.deepEqual(summarizeCommands(rows), { count: 4, cumulativeMs: 25 * 60_000, unionMs: 20 * 60_000, overlapMs: 5 * 60_000 });
});

test('local green outcomes do not infer task completion or fill unknown gaps', () => {
  const normalized = normalizeReport(report({ events: [event('a'), event('b', at(30), at(35))] }));
  assert.equal(normalized.task.status, 'in-progress');
  assert.deepEqual(normalized.scope, { platform: 'desktop-web', mobile: false });
  assert.equal(normalized.events.length, 2);
  assert.equal(normalized.metrics.unionMs, 15 * 60_000);
  assert.equal(normalizeReport(report({ task: { status: 'completed', goal: 'Verified integration', startedAt: at(0) } })).task.status, 'completed');
});

test('evidence rebases from the report directory to output, preserving safe URLs and fragments', () => {
  const input = '/tmp/work/input/report.json', output = '/tmp/work/published/timeline.html';
  assert.equal(rebaseHref('proof/screen shot.png#detail', input, output), '../input/proof/screen%20shot.png#detail');
  assert.equal(rebaseHref('/tmp/work/proof.txt', input, output), '../proof.txt');
  assert.equal(rebaseHref('#event', input, output), '#event');
  assert.equal(rebaseHref('https://example.org/a?q=1#b', input, output), 'https://example.org/a?q=1#b');
  assert.equal(rebaseHref('mailto:dev@example.org', input, output), 'mailto:dev@example.org');
  for (const unsafe of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', '//example.org/remote', '\\\\host\\share', 'vbscript:msgbox(1)', 'javascript :alert(1)']) {
    assert.equal(rebaseHref(unsafe, input, output), undefined, unsafe);
  }
});

test('embedded data and document title cannot terminate script or inject HTML', async () => {
  const payload = '</script><script>globalThis.compromised=true</script><img src=x onerror=alert(1)> & \u2028';
  const html = await renderReport(report({ title: payload, events: [event('malicious', undefined, undefined, {
    label: payload, detail: payload, evidence: [{ href: 'javascript:alert(1)', label: payload }],
  })], findings: [{ title: payload, mechanism: payload, proposal: payload, confidence: 'unknown', evidence: [] }] }));
  assert.equal(html.includes(payload), false);
  assert.equal(html.includes('<script>globalThis.compromised'), false);
  assert.match(html, /<title>&lt;\/script&gt;/);
  const data = extractData(html);
  assert.equal(data.title, payload);
  assert.equal(data.events[0].evidence[0].href, undefined);
  assert.equal(data.events[0].label, payload);
  assert.equal(html.includes('innerHTML'), false);
  assert.equal(html.includes('src="https://'), false);
});

test('public rendering preserves user text matching template markers', async () => {
  const title = '__REPORT_DATA__';
  const detail = '__REPORT_TITLE__ __REPORT_DATA__';
  const html = await renderReport(report({ title, events: [event('marker', undefined, undefined, { detail })] }));
  assert.equal(extractData(html).title, title);
  assert.equal(extractData(html).events[0].detail, detail);
  assert.ok(html.includes('<title>__REPORT_DATA__</title>'));
});

test('renderer can be imported by an actual stdin module without running the CLI', () => {
  const source = `const renderer = await import(${JSON.stringify(pathToFileURL(renderer).href)}); console.log(typeof renderer.renderReport);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'function');
  assert.equal(result.stderr, '');
});

test('structured journals merge start/end detail and evidence; orphan ends and points have no duration', () => {
  const records = parseEventLines([
    JSON.stringify({ type: 'start', at: at(0), event: event('run', at(0), null, { detail: 'Before', evidence: [{ href: 'start.txt', label: 'Start' }] }) }),
    JSON.stringify({ type: 'end', at: at(10), eventId: 'run', outcome: 'failed', confidence: 'verified', detail: 'After', evidence: [{ href: 'end.txt', label: 'End' }] }),
    JSON.stringify({ type: 'point', at: at(12), event: event('artifact', at(12), null, { kind: 'point', detail: 'Artifact mtime' }) }),
    JSON.stringify({ type: 'end', at: at(20), eventId: 'missing', outcome: 'unknown' }),
    JSON.stringify(event('full-record', at(25), at(30))), '',
  ].join('\n'));
  const data = normalizeReport(report(), { eventRecords: records, inputPath: '/tmp/input/report.json', eventPath: '/tmp/log/events.jsonl', outputPath: '/tmp/out/report.html' });
  assert.equal(data.events.length, 4);
  assert.equal(data.events[0].detail, 'Before\nAfter');
  assert.equal(data.events[0].outcome, 'failed');
  assert.equal(data.events[0].evidence.length, 2);
  assert.equal(data.events[0].evidence[0].href, '../log/start.txt');
  assert.equal(data.events[0].evidence[1].href, '../log/end.txt');
  assert.equal(data.events[2].kind, 'point');
  assert.equal(data.events[2].end, undefined);
  assert.equal(data.events[2].confidence, 'unknown');
  assert.equal(data.warnings.length, 1);
  assert.equal(data.metrics.cumulativeMs, 15 * 60_000);
});

test('invalid structured input reports its field or JSONL line before writing', () => {
  assert.throws(() => parseEventLines('{}\nnot-json'), /line 2/);
  assert.throws(() => normalizeReport(report({ task: { status: 'green', startedAt: at(0) } })), /task.status/);
  assert.throws(() => normalizeReport(report({ events: [event('x', at(10), at(0))] })), /end precedes start/);
  assert.throws(() => normalizeReport(report({ events: [event('x'), event('x')] })), /Duplicate event id/);
  assert.throws(() => normalizeReport(report({ snapshotAt: '2026-01-02T10:40:00' })), /timezone/);
  assert.throws(() => normalizeReport(report({ events: [event('x', at(0), null)] }), { eventRecords: [{ type: 'end', eventId: 'x', at: at(0), outcome: 'pass' }] }), /outcome/);
  assert.throws(() => parseArgs(['--input']), /Missing value/);
  assert.throws(() => parseArgs(['--input', 'a', '--output', 'b', '--surprise', 'c']), /Unknown option/);
});

test('CLI supports multiple journals, creates parent output and leaves inputs unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'development-timeline-test-'));
  try {
    const input = join(root, 'report.json'), first = join(root, 'first.jsonl'), nested = join(root, 'other');
    await mkdir(nested);
    const second = join(nested, 'second.jsonl'), output = join(root, 'published', 'timeline.html');
    const initial = JSON.stringify(report());
    await writeFile(input, initial);
    await writeFile(first, JSON.stringify({ type: 'start', at: at(0), event: event('journal', at(0), null) }) + '\n');
    await writeFile(second, JSON.stringify({ type: 'end', at: at(10), eventId: 'journal', outcome: 'passed', evidence: [{ href: 'proof.txt', label: 'Proof' }] }) + '\n');
    const result = spawnSync(process.execPath, [renderer, '--input', input, '--events', first, '--events', second, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), output);
    const data = extractData(await readFile(output, 'utf8'));
    assert.equal(data.events[0].end, at(10));
    assert.equal(data.events[0].evidence[0].href, '../other/proof.txt');
    assert.equal(await readFile(input, 'utf8'), initial);
    await assert.rejects(renderFile({ input, output: input }), /must not overwrite/);
    await assert.rejects(renderFile({ input, events: [first, second], output: second }), /must not overwrite/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
