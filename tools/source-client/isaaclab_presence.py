"""Isaac Lab external callback: presence only, independent of rendering and physics."""
import atexit
from importlib import import_module
import os
from presence import start_presence

_client = None

def install():
    global _client
    # Isaac Lab intersects this result with its remaining Hydra arguments.
    # None consumes nothing; preserve an existing callback's actual result.
    remaining = None
    original = os.environ.get('LAB_WORLD_SOURCE_CALLBACK')
    if original:
        module_name, function_name = original.rsplit('.', 1)
        callback = getattr(import_module(module_name), function_name)
        if callback is install:
            raise ValueError('The original callback must differ from the presence callback')
        remaining = callback()
    if _client is None:
        _client = start_presence(os.environ.get('LAB_WORLD_SOURCE_CONFIG', ''))
        _client.set_phase('ready')
        atexit.register(_client.close)
    return remaining

def status():
    return _client.status if _client is not None else {'state': 'offline'}
