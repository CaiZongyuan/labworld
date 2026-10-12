import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const key = process.env.LAB_API_KEY;
const lab = process.env.LAB_ID;
const robot = process.env.ROBOT_ID;
if (!key || !lab || !robot)
  throw new Error('Set LAB_API_KEY, LAB_ID and ROBOT_ID');
const action = process.env.ROBOT_ACTION ?? 'home';
const inputs = {
  home: { capability: 'robot.home', parameters: {} },
  joints: {
    capability: 'robot.move_joints',
    parameters: {
      joints: JSON.parse(process.env.ROBOT_JOINTS ?? '[0,0,0,0,0,0.7]'),
    },
  },
  gripper: {
    capability: 'robot.set_gripper',
    parameters: { position: Number(process.env.ROBOT_GRIPPER ?? '0.7') },
  },
  cancel: { capability: 'robot.cancel', parameters: {} },
};
const input = inputs[action];
if (!input)
  throw new Error('ROBOT_ACTION must be home, joints, gripper or cancel');
const requestKey = process.env.ROBOT_REQUEST_KEY ?? crypto.randomUUID();
const path = `/api/v1/lab/labs/${encodeURIComponent(lab)}/entities/${encodeURIComponent(robot)}`;

async function request(suffix, body) {
  const response = await fetch(`${base}${path}${suffix}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${key}`,
      ...(body
        ? { 'content-type': 'application/json', 'Idempotency-Key': requestKey }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      `${response.status}: ${data.error?.code ?? 'request_failed'}`,
    );
  return data;
}

// Keep this key and exact input if the HTTP acceptance response is lost.
console.log(JSON.stringify({ request_key: requestKey, input }));
const command = await request('/actions', input);
console.log(
  JSON.stringify({
    command_id: command.id,
    status: command.status,
    task_id: command.task_id,
  }),
);
if (!command.task_id)
  throw new Error(
    'No Task returned; inspect the Command before sending another action',
  );
const deadline = Date.now() + 30000;
let task;
do {
  task = await request(`/tasks/${command.task_id}`);
  console.log(JSON.stringify({ task_id: task.id, status: task.status }));
  if (
    ['completed', 'cancelled', 'failed', 'unknown', 'interrupted'].includes(
      task.status,
    )
  )
    break;
  await delay(250);
} while (Date.now() < deadline);
const result = await request(`/results/${task.result_id}`);
console.log(
  JSON.stringify({ command_id: command.id, task_id: task.id, result }),
);
if (!['completed', 'cancelled'].includes(result.status)) {
  console.error(
    'No confirmed success. Read this Task and result before any new action. This script does not resend actions.',
  );
  process.exitCode = 2;
}
