#!/usr/bin/env python3
"""Restricted forced SSH command; no DB, key, provider or general host access."""
import base64
import json
import os
import sys
from datetime import datetime, timezone
from mirror_protocol import (need, list_requests, load_request, source_files, validate_ack, atomic_json, utc)

CONTROL = '/var/www/adsecute/business-erasure-control/cold'


def handle(request, control=CONTROL):
    need(isinstance(request, dict) and request.get('op') in ('list', 'fetch', 'ack', 'health'))
    if request['op'] == 'health':
        need(set(request) == {'op', 'health'})
        h = request['health']
        need(isinstance(h, dict) and set(h) == {'contract', 'observedAt', 'outcome', 'reason'}
             and h['contract'] == 'native-cold-replica-health.v1'
             and h['outcome'] in ('idle', 'verified_copy', 'verified_capacity_sample', 'verified_business_absence', 'owner_attention')
             and h['reason'] in (None, 'native_replica_unavailable', 'replica_purpose_expired'))
        age = datetime.now(timezone.utc).timestamp() - datetime.fromisoformat(h['observedAt'].replace('Z', '+00:00')).timestamp()
        need(0 <= age <= 60)
        atomic_json(os.path.join(control, 'replication', 'health.json'), h)
        return {'recorded': True}
    if request['op'] == 'list':
        need(set(request) == {'op'})
        if control == CONTROL:
            from runtime_probe import observe
            try:
                observation = observe()
            except BaseException:
                observation = {'contract': 'native-cold-runtime-observation.v1', 'observedAt': utc(),
                               'valid': False, 'reason': 'runtime_probe_unavailable'}
            # Role observation is independent of deletion/copy ACKs. An app
            # role outage must not prevent an already-authorized mirror erase.
            atomic_json(os.path.join(control, 'replication', 'runtime.json'), observation)
        return {'requests': list_requests(control)}
    need(set(request) == ({'op', 'businessId', 'purpose', 'manifestSha256'} if request['op'] == 'fetch' else
                         {'op', 'businessId', 'purpose', 'manifestSha256', 'ack'}))
    path, m, sha = load_request(control, request['businessId'], request['purpose'], request['manifestSha256'])
    if request['op'] == 'fetch':
        if m['kind'] != 'erase' and datetime.now(timezone.utc).timestamp() > datetime.fromisoformat(m['expiresAt'].replace('Z', '+00:00')).timestamp():
            return {'expired': True, 'manifestSha256': sha}
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
