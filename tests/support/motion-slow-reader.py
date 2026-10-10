"""Real TCP receiver pressure, independent of target implementation."""
import asyncio
import ctypes
import json
import os
import signal
import socket
import sys
from urllib.parse import urlsplit
from websockets.asyncio.client import connect

if ctypes.CDLL(None).prctl(1, signal.SIGKILL) != 0:
    sys.exit(1)
if os.getppid() != int(os.environ['MOTION_E2E_PARENT_PID']):
    sys.exit(1)

async def main():
    url, origin, session = sys.argv[1:]
    ticket = sys.stdin.readline(513).strip()
    address = urlsplit(url)
    peer = socket.create_connection((address.hostname, address.port))
    peer.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
    peer.setblocking(False)
    async with connect(url, sock=peer, origin=origin, compression=None,
                       ping_interval=None, max_queue=1, proxy=None,
                       close_timeout=1) as ws:
        await ws.send(json.dumps({'type': 'motion.hello', 'version': 1,
                                 'codec': 'pose-f32-v1', 'role': 'viewer',
                                 'session_id': session, 'ticket': ticket,
                                 'preferred_rate_hz': 30}))
        hello = json.loads(await ws.recv())
        if hello.get('type') != 'motion.welcome' or hello.get('session_id') != session:
            raise RuntimeError('admission_failed')
        local = ws.transport.get_extra_info('sockname')
        remote = ws.transport.get_extra_info('peername')
        print(json.dumps({'event': 'slow.admitted',
                          'local_address': local[0], 'local_port': local[1],
                          'server_address': remote[0], 'server_port': remote[1],
                          'receive_buffer_bytes': peer.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF)}), flush=True)
        await asyncio.sleep(2)
        print(json.dumps({'event': 'slow.pressure', 'transport_reading': ws.transport.is_reading()}), flush=True)
        # Do not consume queued snapshots. The real TCP receive window will close.
        await asyncio.sleep(700)

asyncio.run(main())
