import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CreatedApiKey } from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
test(
  'published Agent examples execute Node devices, history, records, database trends and lifecycle end to end',
  { timeout: 90000 },
  async () => {
    const target = await new ServerProcess().create();
    target.env.APP_ORIGIN = target.url;
    target.env.RATE_LIMIT_ENABLED = 'false';
    try {
      await target.start();
      const member = new CoreHttp(target.url);
      await member.register('owner@example.test');
      const key = await member.json<CreatedApiKey>(
        'POST',
        '/api/v1/api-keys',
        { name: 'Teaching Agent', scopes: ['lab:full'], expires_in_days: 1 },
        201,
      );
      async function example(name: string, env: Record<string, string> = {}) {
        const actor = await new ServerProcess().create();
        actor.entry = 'examples/lab/' + name + '.mjs';
        actor.env = {
          LAB_API_BASE: target.url,
          LAB_API_KEY: key.secret,
          ...env,
        };
        try {
          await actor.spawn();
          await until(
            async () => actor.child!.exitCode,
            (code) => code !== null,
            60000,
          );
          assert.equal(
            actor.child!.exitCode,
            0,
            name + ' failed: ' + actor.logs,
          );
          return JSON.parse(actor.logs.trim()) as {
            lab_id: string;
            entity_ids?: string[];
            lights?: Array<{ entity_id: string }>;
            devices?: Array<{ entity_id: string }>;
          };
        } finally {
          await actor.cleanup();
        }
      }
      const lights = await example('control-lights'),
        sensors = await example('observe-temperature'),
        centrifuges = await example('run-centrifuges');
      assert.ok(lights.lab_id);
      assert.ok(sensors.lab_id);
      assert.ok(centrifuges.lab_id);
      const sensor = sensors.entity_ids![0],
        entity = centrifuges.devices![0].entity_id;
      await example('query-history', {
        LAB_ID: sensors.lab_id,
        LAB_ENTITY_ID: sensor,
      });
      await example('query-records', { LAB_ID: centrifuges.lab_id });
      await example('query-trend', {
        LAB_ID: sensors.lab_id,
        LAB_ENTITY_ID: sensor,
      });
      await member.json(
        'POST',
        '/api/v1/lab/labs/' +
          centrifuges.lab_id +
          '/entities/' +
          entity +
          '/program/stop',
      );
      await example('manage-entity', {
        LAB_ID: centrifuges.lab_id,
        LAB_ENTITY_ID: entity,
      });
    } finally {
      await target.cleanup();
    }
  },
);
