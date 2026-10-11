"""Pure real hook fall-through falsifier; no source/server/TLS/browser execution."""
import ast
import asyncio
import contextlib
import io
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import tls_pressure_measure as measures

support = Path(__file__).parent
session = '10000000-0000-0000-0000-000000000001'

def definitions(file, names, namespace):
    tree = ast.parse((support / file).read_text())
    selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    exec(compile(ast.Module(body=selected, type_ignores=[]), file, 'exec'), namespace)

async def check(root):
    blocked = root / 'blocked'; blocked.write_text('file')
    os.environ['TLS_PRESSURE_PROBE_DIR'] = str(blocked)
    os.environ['SECURE_MOTION_SOURCE_WITNESS'] = str(root)
    called = []
    def capture(owner, frame, sequence, immediate):
        called.append(('capture', owner, frame, sequence, immediate)); return 'original capture'
    async def send(owner, packet):
        called.append(('send', owner, packet)); return 'original send'
    namespace = {'os': os, 'pressure_facts': {}, 'SourceFacts': measures.SourceFacts,
                 'observation_health': measures.observation_health, 'append': lambda *args: None,
                 'original_capture': capture, 'original_send': send}
    definitions('synthetic-source-witness.py', {'pressure_owner', 'capture', 'send'}, namespace)
    owner = SimpleNamespace(scope={'session_id': session})
    assert namespace['capture'](owner, b'original frame', 7, True) == 'original capture'
    assert await namespace['send'](owner, b'original packet') == 'original send'
    assert called == [('capture', owner, b'original frame', 7, True), ('send', owner, b'original packet')]
    assert not measures.observation_health('source', session).status()['valid']
    sentinel = ValueError('original exception')
    namespace['original_capture'] = lambda *args: (_ for _ in ()).throw(sentinel)
    try: namespace['capture'](owner, b'frame', 8)
    except ValueError as error: assert error is sentinel
    else: raise AssertionError('Original exception swallowed')

    sleeps = []; options = []
    async def sleep(value): sleeps.append(value)
    class Peer:
        def setsockopt(self, *args): options.append(args)
        def setblocking(self, value): pass
        def getsockopt(self, *args): return 8192
    class SocketOwner:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): assert sleeps == [2, 700]
        async def send(self, data): pass
        async def recv(self): return '{"type":"motion.welcome","session_id":"' + session + '"}'
        transport = SimpleNamespace(get_extra_info=lambda name: ('127.0.0.1', 12345), is_reading=lambda: False)
    import json, socket
    from urllib.parse import urlsplit
    peer_globals = {'asyncio': SimpleNamespace(sleep=sleep, create_task=asyncio.create_task, gather=asyncio.gather),
                    'socket': SimpleNamespace(create_connection=lambda args: Peer(), SOL_SOCKET=socket.SOL_SOCKET,
                                              SO_RCVBUF=socket.SO_RCVBUF),
                    'sys': SimpleNamespace(argv=['reader', 'ws://127.0.0.1:12345/reader', 'origin', session],
                                           stdin=io.StringIO('fixture_ticket\n')),
                    'os': os, 'json': json, 'urlsplit': urlsplit, 'connect': lambda *args, **kwargs: SocketOwner(),
                    'PeerFacts': measures.PeerFacts, 'observation_health': measures.observation_health, 'watch_peer_task': measures.watch_peer_task}
    definitions('motion-slow-reader.py', {'main'}, peer_globals)
    await peer_globals['main']()
    assert sleeps == [2, 700]
    assert options == [(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)]
    assert not measures.observation_health('peer', session).status()['valid']

with tempfile.TemporaryDirectory(prefix='pressure-passivity-') as path, patch.dict(os.environ), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    asyncio.run(check(Path(path)))
print('PASS full source capture/send and peer sleeps survive diagnostic mkdir failure; original exception preserved')
