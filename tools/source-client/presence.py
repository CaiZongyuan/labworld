"""Independent source presence entrypoint; the caller owns its native program."""
import argparse
import ipaddress
import json
from pathlib import Path
import re
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler
import uuid


def configuration(value):
    data = json.loads(Path(value).read_text()) if isinstance(value, (str, Path)) else dict(value)
    if data.get('format') != 'lab-world-source-v1':
        raise ValueError('Unsupported configuration')
    parsed = urlsplit(data['server_url'])
    try:
        local = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        local = parsed.hostname == 'localhost'
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ('', '/')
            or not (parsed.scheme == 'https' or parsed.scheme == 'http' and local)):
        raise ValueError('Use HTTPS or direct loopback HTTP')
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', data['credential']):
        raise ValueError('Invalid credential')
    for key in ('lab_id', 'source_id', 'machine_id'):
        data[key] = str(uuid.UUID(data[key]))
    data['server_url'] = data['server_url'].rstrip('/')
    return data


class SourceClient:
    """A cached phase and independent network thread; never reads or owns native state."""
    def __init__(self, config, source_run_id=None):
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._connection = None
        self._phase = 'initializing'
        self._status = {'state': 'offline', 'phase': self._phase, 'reason': None}
        self._config = None
        try:
            self._config = configuration(config)
            self.source_run_id = str(uuid.UUID(source_run_id)) if source_run_id else str(uuid.uuid4())
        except (ValueError, TypeError, KeyError, OSError):
            self._status = {'state': 'configuration_failed', 'phase': self._phase, 'reason': 'invalid_configuration'}

    @property
    def status(self):
        with self._lock:
            return dict(self._status)

    def set_phase(self, phase):
        if phase not in ('initializing', 'ready'):
            raise ValueError('Use initializing or ready')
        with self._lock:
            self._phase = phase

    def _status_as(self, state, reason=None):
        with self._lock:
            self._status = {'state': state, 'phase': self._phase, 'reason': reason}

    def start(self):
        if self._config is not None and self._thread is None:
            self._thread = threading.Thread(target=self._loop, name='lab-world-source-presence', daemon=True)
            self._thread.start()
        return self

    def _request(self, action, body):
        base = self._config['server_url']
        path = f"/api/v1/lab/labs/{self._config['lab_id']}/sources/{self._config['source_id']}/{action}"
        request = Request(base + path, data=json.dumps(body).encode(), method='POST', headers={
            'Authorization': 'Bearer ' + self._config['credential'], 'Content-Type': 'application/json'})
        # Configuration is an explicit direct source endpoint, not a proxy capability.
        with build_opener(ProxyHandler({})).open(request, timeout=2) as response:
            data = response.read(16385)
            if len(data) > 16384:
                raise ValueError('Bounded response exceeded')
            return json.loads(data) if data else None

    def _loop(self):
        while not self._stop.is_set():
            action = 'heartbeat' if self._connection else 'connections'
            with self._lock:
                phase = self._phase
            body = {'machine_id': self._config['machine_id'], 'phase': phase}
            if self._connection:
                body.update(self._connection)
            else:
                body['source_run_id'] = self.source_run_id
            try:
                response = self._request(action, body)
                if action == 'connections':
                    self._connection = {'connection_id': str(uuid.UUID(response['connection_id'])),
                                        'epoch': str(response['epoch'])}
                if not self._stop.is_set():
                    self._status_as('connected')
            except HTTPError as error:
                code = None
                try:
                    code = json.loads(error.read(16384)).get('error', {}).get('code')
                except (ValueError, AttributeError):
                    pass
                finally:
                    error.close()
                if error.code == 403 and (action == 'connections' or code == 'identity.machine_unauthorized'):
                    self._status_as('authorization_failed', 'access_denied')
                    return
                self._connection = None
                self._status_as('connection_conflict' if error.code == 409 else 'offline', 'connection_rejected')
            except (URLError, OSError, ValueError, TypeError, KeyError):
                self._connection = None
                self._status_as('offline', 'connection_unavailable')
            self._stop.wait(1)

    def close(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
        if self._connection and (self._thread is None or not self._thread.is_alive()):
            try:
                self._request('disconnect', {'machine_id': self._config['machine_id'], **self._connection})
            except (HTTPError, URLError, OSError, ValueError, TypeError):
                pass
        self._connection = None
        self._config = None
        self._status_as('stopped')


def start_presence(config, source_run_id=None):
    """Load once in a launch callback; network rejection stays outside the native caller."""
    return SourceClient(config, source_run_id).start()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--duration', type=float)
    parser.add_argument('--phase', choices=('initializing', 'ready'), default='initializing')
    args = parser.parse_args()
    client = SourceClient(args.config)
    client.set_phase(args.phase)
    client.start()
    started = time.monotonic()
    previous = None
    try:
        while args.duration is None or time.monotonic() - started < args.duration:
            current = client.status
            if current != previous:
                print(json.dumps(current), flush=True)
                previous = current
            if current['state'] in ('configuration_failed', 'authorization_failed'):
                return 1
            time.sleep(.05)
    except KeyboardInterrupt:
        return 130
    finally:
        client.close()
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
