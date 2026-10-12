"""One formal robot action, followed by bounded reads of its Task and result."""

import json
import os
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request

base = os.environ.get("LAB_API_BASE", "http://127.0.0.1:3000")
key = os.environ["LAB_API_KEY"]
lab = urllib.parse.quote(os.environ["LAB_ID"], safe="")
robot = urllib.parse.quote(os.environ["ROBOT_ID"], safe="")
action = os.environ.get("ROBOT_ACTION", "home")
inputs = {
    "home": {"capability": "robot.home", "parameters": {}},
    "joints": {
        "capability": "robot.move_joints",
        "parameters": {
            "joints": json.loads(os.environ.get("ROBOT_JOINTS", "[0,0,0,0,0,0.7]"))
        },
    },
    "gripper": {
        "capability": "robot.set_gripper",
        "parameters": {"position": float(os.environ.get("ROBOT_GRIPPER", "0.7"))},
    },
    "cancel": {"capability": "robot.cancel", "parameters": {}},
}
input_action = inputs[action]
request_key = os.environ.get("ROBOT_REQUEST_KEY", str(uuid.uuid4()))
path = f"{base}/api/v1/lab/labs/{lab}/entities/{robot}"


def request(suffix, body=None):
    headers = {"Authorization": f"Bearer {key}"}
    if body is not None:
        headers.update(
            {"Content-Type": "application/json", "Idempotency-Key": request_key}
        )
    req = urllib.request.Request(
        path + suffix,
        data=None if body is None else json.dumps(body).encode(),
        headers=headers,
        method="GET" if body is None else "POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        data = json.load(error)
        raise RuntimeError(f"{error.code}: {data['error']['code']}") from None


# Keep this key and exact input if the HTTP acceptance response is lost.
print(json.dumps({"request_key": request_key, "input": input_action}), flush=True)
command = request("/actions", input_action)
print(json.dumps({"command_id": command["id"], "status": command["status"]}))
if not command.get("task_id"):
    raise RuntimeError("No Task returned; inspect the Command before another action")
deadline = time.monotonic() + 30
while True:
    task = request(f"/tasks/{command['task_id']}")
    print(json.dumps({"task_id": task["id"], "status": task["status"]}))
    if task["status"] in ("completed", "cancelled", "failed", "unknown", "interrupted"):
        break
    if time.monotonic() >= deadline:
        break
    time.sleep(0.25)
result = request(f"/results/{task['result_id']}")
print(json.dumps({"command_id": command["id"], "task_id": task["id"], "result": result}))
if result["status"] not in ("completed", "cancelled"):
    raise SystemExit("No confirmed success. Read this Task and result before another action. No action was resent.")
