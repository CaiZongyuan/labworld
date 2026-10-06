import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerProcess } from '../support/server-process.ts';

test(
  'data-directory lease rejects a live second owner and permits reopening after force-kill; all externally acknowledged commits survive 20 kills',
  { timeout: 180_000 },
  async () => {
    const target = await new ServerProcess().create();
    target.entry = 'tests/support/spike-process.ts';
    const evidence: Array<Record<string, unknown>> = [];
    const acknowledged: Array<{
      id: string;
      entity_id: string;
      received_at: string;
      data: unknown;
    }> = [];
    try {
      await target.start();
      const second = await new ServerProcess().create();
      const unused = second.directory;
      second.directory = target.directory;
      try {
        await second.spawn();
        const [code] = await once(second.child!, 'exit');
        assert.notEqual(code, 0);
        assert.match(second.logs, /EADDRINUSE/);
        assert.equal((await fetch(`${target.url}/health/ready`)).status, 200);
      } finally {
        second.directory = unused;
        await second.cleanup();
      }
      const initial = (await (
        await fetch(`${target.url}/proof/devices`)
      ).json()) as { devices: Array<{ entity_id: string }> };
      const entityId = initial.devices[0].entity_id;
      for (let cycle = 0; cycle < 20; cycle++) {
        const writing = await fetch(
          `${target.url}/proof/burst?entity_id=${entityId}`,
        );
        assert.equal(writing.status, 200);
        const reader = writing.body!.getReader();
        let text = '';
        let count = 0;
        while (count < 3) {
          const next = await reader.read();
          assert.equal(next.done, false);
          text += new TextDecoder().decode(next.value);
          while (text.includes('\n') && count < 3) {
            const end = text.indexOf('\n');
            const line = text.slice(0, end);
            text = text.slice(end + 1);
            const body = JSON.parse(line) as { committed: typeof acknowledged };
            acknowledged.push(...body.committed);
            count++;
          }
        }
        await writeFile(
          join(target.evidence, 'external-acknowledgements.json'),
          JSON.stringify(acknowledged, null, 2),
        );
        // The response is an ongoing DB write loop. Kill the actual server while it remains open.
        const pid = target.child!.pid;
        await target.stop('SIGKILL');
        await reader.cancel().catch(() => {});
        await target.start();
        const records: typeof acknowledged = [];
        let cursor: string | null = null;
        do {
          const response: Response = await fetch(
            `${target.url}/proof/history?entity_id=${entityId}&limit=100${cursor ? '&cursor=' + cursor : ''}`,
          );
          assert.equal(response.status, 200);
          const page = (await response.json()) as {
            items: typeof acknowledged;
            next_cursor: string | null;
          };
          records.push(...page.items);
          cursor = page.next_cursor;
        } while (cursor);
        for (const ack of acknowledged)
          assert.deepEqual(
            records.find((item) => item.id === ack.id),
            ack,
            `acknowledged commit lost after kill ${cycle + 1}`,
          );
        evidence.push({
          cycle: cycle + 1,
          killedPid: pid,
          reopenedPid: target.child!.pid,
          acknowledged: acknowledged.length,
          verified: true,
        });
        await writeFile(
          join(target.evidence, 'force-kill-results.json'),
          JSON.stringify(
            {
              engine: '@electric-sql/pglite@0.5.8',
              platform: process.platform,
              node: process.version,
              cycles: evidence,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await target.cleanup();
    }
  },
);
