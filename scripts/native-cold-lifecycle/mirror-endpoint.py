#!/usr/bin/env python3
"""Restricted forced SSH command; no DB, key, provider or general host access."""
import base64
import json
import os
import sys
from mirror_protocol import (need, list_requests, load_request, source_files, validate_ack, atomic_json)

CONTROL = '/var/www/adsecute/business-erasure-control/cold'


def handle(request, control=CONTROL):
    need(isinstance(request, dict) and request.get('op') in ('list', 'fetch', 'ack'))
    if request['op'] == 'list':
        need(set(request) == {'op'})
        return {'requests': list_requests(control)}
    need(set(request) == ({'op', 'businessId', 'purpose', 'manifestSha256'} if request['op'] == 'fetch' else
                         {'op', 'businessId', 'purpose', 'manifestSha256', 'ack'}))
    path, m, sha = load_request(control, request['businessId'], request['purpose'], request['manifestSha256'])
    if request['op'] == 'fetch':
        files = source_files(control, m) if m['kind'] == 'copy' else {}
        return {'manifest': m, 'manifestSha256': sha,
                'files': {name: base64.b64encode(data).decode('ascii') for name, data in files.items()}}
    ack = validate_ack(request['ack'], m, sha)
    atomic_json(os.path.join(path, 'ack.json'), ack)
    return {'acknowledged': True, 'manifestSha256': sha}


def main():
    need(os.environ.get('SSH_ORIGINAL_COMMAND') == 'adsecute-native-mirror-v1', 'forced_command_required')
    line = sys.stdin.buffer.readline(65537)
    need(0 < len(line) <= 65536 and line.endswith(b'\n'))
    result = handle(json.loads(line))
    sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
    sys.stdout.flush()


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        sys.stdout.write('{"error":"native_mirror_refused"}\n')
        sys.stdout.flush()
        sys.exit(1)
