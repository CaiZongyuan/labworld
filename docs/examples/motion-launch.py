"""Admit a local synthetic Publisher through the existing Lab HTTP API."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--server', default='http://127.0.0.1:3000')
parser.add_argument('--lab-id', required=True)
parser.add_argument('--duration', type=float, default=600)
args = parser.parse_args()
server = urlsplit(args.server)
if server.hostname not in ('127.0.0.1', 'localhost', '::1') or server.scheme not in ('http', 'https') or server.path not in ('', '/') or server.query or server.fragment or server.username:
    parser.error('--server must be a loopback origin')
key = os.environ.pop('MOTION_API_KEY', '')
if not key:
    parser.error('Set MOTION_API_KEY to an active lab:full key')

def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(args.server.rstrip('/') + path, data=data,
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)

prefix = '/api/v1/lab/labs/' + args.lab_id + '/motion-fixture'
fixture = request(prefix)
ticket = request(prefix + '/' + fixture['session_id'] + '/publisher-tickets', {'preferred_rate_hz': 30})
ws_origin = args.server.rstrip('/').replace('http://', 'ws://').replace('https://', 'wss://')
root = Path(__file__).resolve().parents[2]
# Send the scoped ticket on stdin; the long-term key is absent from child env.
result = subprocess.run([sys.executable, str(root / 'tools/synthetic-motion/publisher.py'),
    '--url', ws_origin + ticket['websocket_path'], '--session-id', fixture['session_id'],
    '--scene-hash', fixture['scene_hash'], '--ticket-stdin', '--duration', str(args.duration)],
    input=ticket['ticket'] + '\n', text=True, check=False)
sys.exit(result.returncode)
