"""Isaac Lab external callback: presence only, independent of rendering and physics."""
import atexit
import os
from presence import start_presence

_client = None

def install():
    global _client
    if _client is None:
        _client = start_presence(os.environ.get('LAB_WORLD_SOURCE_CONFIG', ''))
        _client.set_phase('ready')
        atexit.register(_client.close)
    return []

def status():
    return _client.status if _client is not None else {'state': 'offline'}
