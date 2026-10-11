"""Passive bounded source-first witness for the real production Synthetic program."""
import os
from pathlib import Path
import re
import runpy
import struct
import sys

root = Path(__file__).resolve().parents[2]
source = root / 'tools' / 'synthetic-motion'
sys.path.insert(0, str(source))
import recording_source
from tls_pressure_measure import SourceFacts, observation_health

directory = Path(os.environ['SECURE_MOTION_SOURCE_WITNESS'])
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
owned = {}
pressure_facts = {}


def pressure_owner(scope):
    session = scope['session_id']
    if session not in pressure_facts:
        pressure_facts[session] = SourceFacts(session)
    return pressure_facts[session]


def append(scope, suffix, data):
    session = scope['session_id']
    if not re.fullmatch(r'[0-9a-f-]{36}', session):
        raise RuntimeError('Witness scope rejected')
    path = directory / (session + '.' + suffix)
    if path not in owned:
        owned[path] = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    descriptor = owned[path]
    if os.fstat(descriptor).st_size + len(data) + 4 > 16 * 1024 * 1024:
        raise RuntimeError('Owned witness exceeded bound')
    pending = struct.pack('<I', len(data)) + bytes(data)
    while pending:
        written = os.write(descriptor, pending)
        if written <= 0:
            raise RuntimeError('Witness write failed')
        pending = pending[written:]


original_capture = recording_source.ReliableRecording.capture
original_send = recording_source.ReliableRecording.send


def capture(self, frame, sequence, immediate=False):
    # Observe selection before the actual collector can accept, queue or fault.
    # The bytes and timing policy are never replaced by the witness.
    append(self.scope, 'frames', frame)
    if os.environ.get('TLS_PRESSURE_PROBE_DIR'):
        health = observation_health('source', self.scope['session_id'])
        health.poll_seal(lambda: pressure_owner(self.scope).snapshot(force=True))
        health.observe(lambda: pressure_owner(self.scope).capture(frame, sequence))
    return original_capture(self, frame, sequence, immediate)


async def send(self, packet):
    append(self.scope, 'packets', packet)
    if os.environ.get('TLS_PRESSURE_PROBE_DIR'):
        health = observation_health('source', self.scope['session_id'])
        health.poll_seal(lambda: pressure_owner(self.scope).snapshot(force=True))
        health.observe(lambda: pressure_owner(self.scope).packet(packet))
    return await original_send(self, packet)


recording_source.ReliableRecording.capture = capture
recording_source.ReliableRecording.send = send
remote = '--witness-remote' in sys.argv
if remote:
    sys.argv.remove('--witness-remote')
target = source / ('remote.py' if remote else 'publisher.py')
sys.argv[0] = str(target)
try:
    runpy.run_path(str(target), run_name='__main__')
finally:
    for scope, facts in pressure_facts.items():
        facts.health.receipt(final=True)
    for descriptor in owned.values():
        os.fsync(descriptor)
        os.close(descriptor)
