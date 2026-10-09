import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, release, arch } from 'node:os';
import { type LabWorld } from '../../packages/sdk/src/index';
import {
  evidence,
  member,
  world,
  chapter,
  capture,
  retainFailure,
} from './lab-foundation-support';

test.use({ locale: 'zh-CN' });
test.afterEach(retainFailure);

test('one hundred Entities and twenty 1 Hz devices remain bounded in two real browsers', async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.E2E_LAB_REFERENCE_LOAD !== '1',
    'Run just perf-lab-reference in its own isolated stack',
  );
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  const { agent, secret } = await member(page);
  await page.addInitScript(() => {
    const events: { bytes: number; type: string }[] = [];
    Object.defineProperty(window, 'foundationEvents', { value: events });
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (
        response.headers.get('content-type')?.startsWith('text/event-stream')
      ) {
        void (async () => {
          const reader = response.clone().body!.getReader();
          const decoder = new TextDecoder();
          let pending = '';
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) return;
              pending += decoder.decode(value, { stream: true });
              let boundary;
              while ((boundary = pending.indexOf('\n\n')) >= 0) {
                const frame = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                const data = frame
                  .split('\n')
                  .find((line) => line.startsWith('data: '))
                  ?.slice(6);
                if (data && events.length < 1000)
                  events.push({
                    bytes: new TextEncoder().encode(data).length,
                    type: JSON.parse(data).type,
                  });
              }
              if (pending.length > 1048640) return;
            }
          } catch {
            /* Offline transitions close the observed HTTP response. */
          }
        })();
      }
      return response;
    };
  });
  const response = await agent.post('/api/v1/lab/labs', {
    data: { name: 'Foundation reference load' },
  });
  expect(response.status()).toBe(201);
  const lab = (await response.json()).id;
  const path = `/api/v1/lab/labs/${lab}`;
  const env = { LAB_API_BASE: process.env.E2E_API_URL!, LAB_API_KEY: secret };
  const assets = ['cube-draco', 'cube-basis'].map((name) =>
    chapter('import-asset', { ...env, LAB_ASSET_NAME: `Reference ${name}` }, [
      `tests/fixtures/lab/${name}.glb`,
    ]),
  );
  let second;
  try {
    for (let i = 0; i < 100; i++) {
      const definition =
        i < 20
          ? 'sensor'
          : i === 20
            ? 'bench'
            : i === 21
              ? 'robot'
              : i === 22
                ? 'labware'
                : 'model';
      const response = await agent.post(`${path}/entities`, {
        data: {
          name: `Reference ${i.toString().padStart(3, '0')}`,
          definition_id: definition,
          definition_version: '1.0',
          reality: 'simulated',
          configuration:
            definition === 'sensor'
              ? { baseline_temperature: 20 + i / 10 }
              : {},
          representation_id:
            definition === 'model' ? assets[i % 2].representation_id : null,
        },
      });
      expect(response.status()).toBe(201);
    }
    let current = await world(agent, lab);
    expect(current.entities).toHaveLength(100);
    expect(current.assets).toHaveLength(2);
    const nodes = current.nodes.map((node, index) => ({
      id: node.id,
      entity_id: node.entity_id,
      representation_id: node.representation_id,
      placement: {
        position: [
          ((index % 10) - 4.5) * 1.2,
          0,
          (Math.floor(index / 10) - 4.5) * 1.2,
        ],
        rotation: [0, 0, 0],
        scale: [0.7, 0.7, 0.7],
      },
    }));
    expect(
      (
        await agent.put(`${path}/layout`, {
          data: {
            expected_version: current.lab.layout_version,
            nodes,
            relationships: [],
          },
        })
      ).status(),
    ).toBe(200);
    const sensors = current.entities.filter(
      (entity) => entity.definition_id === 'sensor',
    );
    for (const entity of sensors)
      expect(
        (
          await agent.post(`${path}/entities/${entity.id}/program/start`)
        ).status(),
      ).toBe(201);
    await page.reload();
    await page.getByRole('combobox', { name: '打开 Lab' }).selectOption(lab);
    await expect(page.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
      { timeout: 45000 },
    );
    await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
    await page.getByRole('button', { name: '性能', exact: true }).click();
    second = await browser.newContext({
      storageState: await page.context().storageState(),
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
    });
    const observer = await second.newPage();
    observer.setDefaultTimeout(15000);
    observer.on('pageerror', (error) => errors.push(error.name));
    await observer.goto('/lab');
    await observer
      .getByRole('button', { name: 'English', exact: true })
      .click();
    await observer
      .getByRole('combobox', { name: 'Open Lab' })
      .selectOption(lab);
    await expect(observer.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
      { timeout: 45000 },
    );
    await observer
      .getByRole('button', { name: 'Fit model', exact: true })
      .click();
    await observer
      .getByRole('button', { name: 'Performance', exact: true })
      .click();
    await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
    await expect(observer.getByText('Live', { exact: true })).toBeVisible();
    const started = Date.now();
    current = await world(agent, lab);
    const sampleStart = new Date().toISOString();
    const baseline = new Map(
      sensors.map((sensor) => [
        sensor.id,
        current.entities.find((entity) => entity.id === sensor.id)!.observation!
          .sequence,
      ]),
    );
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const latest = await world(agent, lab);
      const target = latest.entities.find(
        (entity) => entity.id === sensors[0].id,
      )!.observation!.sequence;
      await expect
        .poll(
          async () =>
            Number(
              (await world(agent, lab)).entities.find(
                (entity) => entity.id === sensors[0].id,
              )!.observation!.sequence,
            ),
          { timeout: 10000 },
        )
        .toBeGreaterThan(Number(target));
      const before = performance.now();
      const snapshotResponse = await agent.get(`${path}/world`);
      expect(snapshotResponse.status()).toBe(200);
      const bytes = await snapshotResponse.body();
      const snapshot: LabWorld = JSON.parse(bytes.toString());
      const metrics = async (view: Page) => ({
        fps: Number(await view.locator('.lab-perf-main strong').innerText()),
        frame: await view.locator('.lab-perf-main small').innerText(),
        stats: await view.locator('.lab-perf-stats').innerText(),
      });
      samples.push({
        elapsedMs: Date.now() - started,
        snapshotBytes: bytes.length,
        httpMs: performance.now() - before,
        worldVersion: snapshot.version,
        browserVersions: [
          await page.getByLabel('世界版本').innerText(),
          await observer.getByLabel('World version').innerText(),
        ],
        browserMetrics: [await metrics(page), await metrics(observer)],
      });
    }
    writeFileSync(
      `${evidence}/reference-samples.json`,
      JSON.stringify(samples, null, 2),
    );
    const sampled = await world(agent, lab);
    const sampleEnd = new Date().toISOString();
    const rates = sensors.map((sensor) => {
      const observation = sampled.entities.find(
        (entity) => entity.id === sensor.id,
      )!.observation!;
      expect(observation.properties?.temperature.unit).toBe('degC');
      expect(Number(observation.sequence)).toBeGreaterThan(
        Number(baseline.get(sensor.id)),
      );
      return {
        entity: sensor.id,
        receivedReports:
          Number(observation.sequence) - Number(baseline.get(sensor.id)),
        elapsedSeconds:
          (Date.parse(sampleEnd) - Date.parse(sampleStart)) / 1000,
      };
    });
    for (const entity of sensors)
      expect(
        (
          await agent.post(`${path}/entities/${entity.id}/program/stop`)
        ).status(),
      ).toBe(200);
    const final = await world(agent, lab);
    await expect(page.getByLabel('世界版本')).toHaveText(`W${final.version}`);
    await expect(observer.getByLabel('World version')).toHaveText(
      `W${final.version}`,
    );
    const frames: { bytes: number; type: string }[] = await page.evaluate(() =>
      Reflect.get(window, 'foundationEvents'),
    );
    expect(frames.length).toBeGreaterThan(0);
    const budgets = JSON.parse(
      readFileSync('scripts/perf/baselines.json', 'utf8'),
    ).budgets.lab;
    expect(Math.max(...frames.map((frame) => frame.bytes))).toBeLessThanOrEqual(
      budgets.eventBytes,
    );
    expect(
      Math.max(...samples.map((sample) => sample.snapshotBytes)),
    ).toBeLessThanOrEqual(budgets.eventBytes);
    const records = [];
    for (const sensor of sensors) {
      const response = await agent.get(
        `${path}/entities/${sensor.id}/history`,
        {
          params: {
            record_type: 'observation',
            from: sampleStart,
            to: sampleEnd,
            limit: '100',
          },
        },
      );
      expect(response.status()).toBe(200);
      const body = await response.body();
      const history = JSON.parse(body.toString());
      expect(history.items.length).toBeLessThanOrEqual(budgets.pageItems);
      expect(history.items.length).toBeGreaterThan(0);
      expect(body.length).toBeLessThanOrEqual(budgets.historyBytes);
      expect(history.next_cursor).toBeNull();
      records.push({
        entity: sensor.id,
        observations: history.items.length,
        bytes: body.length,
      });
    }
    const storage = execFileSync(
      'docker',
      [
        'exec',
        process.env.TEST_PG_CONTAINER!,
        'psql',
        '-U',
        'postgres',
        '-d',
        'labos_threejs_test',
        '-Atc',
        "SELECT json_build_object('database_bytes',pg_database_size(current_database()),'lab_table_bytes',(SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lab' AND c.relkind='r'),'observation_rows',(SELECT count(*) FROM lab.observation_history),'entity_rows',(SELECT count(*) FROM lab.entities),'node_rows',(SELECT count(*) FROM lab.scene_nodes));",
      ],
      { encoding: 'utf8' },
    );
    const canvas = await page.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      const gl = canvas.getContext('webgl2')!;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: ext
          ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
        browser: navigator.userAgent,
        canvas: [canvas.width, canvas.height],
        viewport: [innerWidth, innerHeight],
      };
    });
    const models = ['cube-draco', 'cube-basis'].map((name) => {
      const bytes = readFileSync(`tests/fixtures/lab/${name}.glb`);
      const json = JSON.parse(
        bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString(),
      );
      return {
        name,
        bytes: bytes.length,
        meshes: json.meshes.length,
        textures: json.textures?.length ?? 0,
        embeddedImageBytes: (json.images ?? []).reduce(
          (sum: number, image: { bufferView?: number }) =>
            sum +
            (image.bufferView === undefined
              ? 0
              : json.bufferViews[image.bufferView].byteLength),
          0,
        ),
      };
    });
    const pixels = [
      await capture(page, 'reference-desktop-zh'),
      await capture(observer, 'reference-desktop-en'),
    ];
    expect(errors).toEqual([]);
    writeFileSync(
      `${evidence}/reference-load.json`,
      JSON.stringify(
        {
          testedRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim(),
          dirtyScope: execFileSync('git', ['status', '--short'], {
            encoding: 'utf8',
          }).trim(),
          hardware: {
            cpu: cpus()[0].model,
            logicalCpus: cpus().length,
            memoryBytes: totalmem(),
            os: release(),
            arch: arch(),
          },
          canvas,
          browserVersion: browser.version(),
          entities: final.entities.length,
          placedUnarchivedNodes: final.nodes.length,
          independentAssets: final.assets.length,
          models,
          targetDeviceHz: 1,
          devices: sensors.length,
          browsers: 2,
          sampleStart,
          sampleEnd,
          rates,
          samples,
          sse: {
            events: frames.length,
            maxEventBytes: Math.max(...frames.map((frame) => frame.bytes)),
            types: [...new Set(frames.map((frame) => frame.type))],
          },
          history: records,
          storage: JSON.parse(storage),
          pixels,
          errors,
          limits:
            'FPS, latency and memory are observations of this environment. Backlog failure is covered by the isolated Router slow-client contract, not inferred from browser timing.',
        },
        null,
        2,
      ),
    );
  } finally {
    await second?.close();
    await agent.dispose();
  }
});
