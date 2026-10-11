"""Admit one external Synthetic Session over trusted HTTPS, then publish outbound WSS."""
import argparse
import asyncio
import ipaddress
import json
import re
import ssl
import sys
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

from publisher import publish_session, run_owned
from synthetic import parse_startup
from motion_codec import MAX_CONTROL_BYTES, UUID


def origin(value):
    parsed = urlsplit(value)
    try:
        local = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        local = parsed.hostname == 'localhost'
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ('', '/')
            or not (parsed.scheme == 'https' or parsed.scheme == 'http' and local)):
        raise ValueError('Use HTTPS, or loopback HTTP for debugging')
    return urlunsplit((parsed.scheme, parsed.netloc, '', '', ''))


def admit(server, lab, session, machine, credential):
    if not all(UUID.fullmatch(value) for value in (lab, session, machine)):
        raise ValueError('Use existing Lab, Session and Machine UUIDs')
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', credential):
        raise ValueError('Provide the independent machine credential on stdin')
    endpoint = f'{server}/api/v1/lab/labs/{lab}/sessions/{session}/publisher-admissions'
    request = Request(endpoint, data=json.dumps({'machine_id': machine}).encode(),
                      headers={'Authorization': 'Bearer ' + credential, 'Content-Type': 'application/json'},
                      method='POST')
    with urlopen(request, context=ssl.create_default_context(), timeout=3) as response:
        if response.status != 201:
            raise ValueError('Publisher admission rejected')
        data = response.read(MAX_CONTROL_BYTES + 1)
    if len(data) > MAX_CONTROL_BYTES:
        raise ValueError('Publisher admission exceeds budget')
    result = json.loads(data)
    path = result['websocket_path']
    if path != f'/api/v1/lab/motion/sessions/{session}/publisher':
        raise ValueError('Publisher admission scope rejected')
    startup = {'version': 1, 'url': server.replace('http', 'ws', 1) + path,
               'ticket': result['ticket'], **result['bootstrap'], 'recording': result['recording']}
    return parse_startup(json.dumps(startup))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', required=True)
    parser.add_argument('--lab', required=True)
    parser.add_argument('--session', required=True)
    parser.add_argument('--machine', required=True)
    args = parser.parse_args()
    try:
        startup = admit(origin(args.server), args.lab, args.session, args.machine,
                        sys.stdin.readline(514).strip())
        result = asyncio.run(run_owned(publish_session(startup)))
        print(json.dumps(result, separators=(',', ':')))
    except (KeyboardInterrupt, asyncio.CancelledError):
        return 130
    except Exception as error:
        print(f'Publisher stopped: {getattr(error, "code", type(error).__name__)}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
