import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const python = process.platform === 'win32' ? 'python' : 'python3';
const available = spawnSync(python, ['--version']).status === 0;
const callbackDirectory = resolve('tools/source-client');

test(
  'the normal Isaac Lab callback filter retains a physics timestep and preset override',
  { skip: !available },
  () => {
    const program = `import json,sys\nsys.path.insert(0,sys.argv[1])\nimport isaaclab_presence\n# Isaac Lab play_rsl_rl.py filters parse-known/Hydra arguments with this public helper contract.\ndef list_intersection(first,second):\n    if second is None:\n        return first\n    accepted=set(second)\n    return [value for value in first if value in accepted]\nremaining=['presets=newton_mjwarp','env.sim.dt=0.0125']\nfiltered=list_intersection(remaining,isaaclab_presence.install())\nprint(json.dumps({'hydra_arguments':filtered,'caller_timestep':next((value for value in filtered if value.startswith('env.sim.dt=')),None)}))\n`;
    const result = spawnSync(python, ['-B', '-c', program, callbackDirectory], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LAB_WORLD_SOURCE_CONFIG: '',
        LAB_WORLD_SOURCE_CALLBACK: '',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      hydra_arguments: ['presets=newton_mjwarp', 'env.sim.dt=0.0125'],
      caller_timestep: 'env.sim.dt=0.0125',
    });
  },
);

test(
  'presence composes the original registration callback and preserves its consumed-argument result',
  { skip: !available },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'labworld-source-callback-'));
    try {
      writeFileSync(
        join(directory, 'original_registration.py'),
        `called=False\ndef install():\n    global called\n    called=True\n    return ['presets=newton_mjwarp','env.sim.dt=0.0125']\n`,
      );
      const program = `import json,sys\nsys.path[:0]=[sys.argv[1],sys.argv[2]]\nimport isaaclab_presence,original_registration\nremaining=isaaclab_presence.install()\nprint(json.dumps({'original_called':original_registration.called,'remaining':remaining}))\n`;
      const result = spawnSync(
        python,
        ['-B', '-c', program, callbackDirectory, directory],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            LAB_WORLD_SOURCE_CONFIG: '',
            LAB_WORLD_SOURCE_CALLBACK: 'original_registration.install',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        original_called: true,
        remaining: ['presets=newton_mjwarp', 'env.sim.dt=0.0125'],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
