#!/usr/bin/env python3
"""Versioned host operator for the ALREADY reviewed immutable runtime.
The deployment intentionally leaves the host Git checkout frozen; its HEAD is
not release identity. Verify actual images, all runtime source bytes and host
Compose instead. The operator has its OWN review digest; runtime4fc2 stays exact.
No source DB/provider operation; downstream C3 gates are unchanged.
"""
import json
import os
import re
import sys
RUNTIME_INVENTORY = "4fc2add5a34b2933878ff54386affde0bb70308b1338bf47cd833cdcf432189f"
sys.path.insert(0, "/opt/adsecute-native-cold/" + RUNTIME_INVENTORY)
import time
import subprocess
from install_common import reviewed_files, replace_private, run
from runtime_probe import observe
from mirror_protocol import need, safe_directory, read_file, digest, canonical, atomic_json

APP = '/var/www/adsecute'
CONTROL = APP + '/business-erasure-control/cold'
IMAGE = 'docker.io/library/postgres@sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551'


def compose(args, timeout=120):
    return run(['/usr/bin/docker', 'compose', '--profile', 'business-erasure', '--profile', 'native-restore'] + args, APP, timeout)


def verify_live_runtime(r, inventory):
    need(r['sourceInventorySha256'] == RUNTIME_INVENTORY, 'exact_runtime_inventory_required')
    observed = observe()
    need(observed['contract'] == 'native-cold-runtime-observation.v1' and observed['valid'] is True
         and set(observed['roles']) == {'web', 'worker', 'archive-erasure'}, 'exact_runtime_roles_required')
    for name, role in observed['roles'].items():
        need(role['running'] is True and role['buildId'] == r['buildId']
             and role['immutableBuildId'] == r['buildId'] and role['ociRevision'] == r['buildId']
             and role['imageRole'] == ('web-runner' if name == 'web' else 'worker-runner'), 'runtime_image_identity_differs')
        if name == 'worker':
            need(role['mounts'] == [], 'provider_worker_must_be_archive_free')
        else:
            need(role['archive']['keySha256'] == r['keySha256'], 'actual_key_recovery_differs')
            for destination, source in [('/run/adsecute-native-archive', APP+'/native-archive'),
                                        ('/run/adsecute-business-erasure', APP+'/business-erasure-control')]:
                matches = [m for m in role['mounts'] if m['destination'] == destination]
                need(len(matches) == 1 and matches[0]['type'] == 'bind' and matches[0]['source'] == source
                     and matches[0]['writable'] == (name == 'archive-erasure'), 'runtime_mount_scope_differs')
    config = next(e for e in inventory['files'] if e['path'] == 'docker-compose.yml')
    read_file(APP+'/docker-compose.yml', config['bytes'], config['sha256'], config['bytes'])
    # Run the REVIEWED verifier inside the actual immutable archive image.
    # This flag belongs only to the verification subprocess; it enables no lane.
    code = "require('./scripts/native-cold-lifecycle/inventory.ts').verifyRuntimeColdInventory().then(v=>process.stdout.write(JSON.stringify({inventory:v,build:process.env.APP_BUILD_ID,immutable:process.env.ADSECUTE_IMAGE_BUILD_ID}))).catch(()=>process.exit(1))"
    proof = json.loads(compose(['exec', '-T', '--workdir', '/app', '-e',
        'NATIVE_COLD_SOURCE_INVENTORY_SHA256='+RUNTIME_INVENTORY, 'archive-erasure', 'node', '--import', 'tsx', '-e', code]))
    need(proof == {'inventory': RUNTIME_INVENTORY, 'build': r['buildId'], 'immutable': r['buildId']}, 'actual_runtime_source_differs')
    return {'immutableImagesVerified': True, 'runtimeFilesVerified': len(inventory['files']), 'hostComposeVerified': True}


def main(r):
    need(set(r) == {'action', 'buildId', 'sourceInventorySha256', 'publicKey', 'dbProof', 'review', 'keySha256', 'offlineRecoveryMatch'}
         and r['action'] in ('prepare', 'activate', 'disable_writer') and re.fullmatch('[a-f0-9]{40}', r['buildId'])
         and re.fullmatch('[a-f0-9]{64}', r['keySha256']) and r['offlineRecoveryMatch'] is True)
    directory, inventory = reviewed_files(r['sourceInventorySha256'])
    verify_live_runtime(r, inventory)
    need(re.fullmatch('ssh-ed25519 [A-Za-z0-9+/=]+ adsecute-native-cold-mirror', r['publicKey']))
    review = r['review']
    need(review['contract'] == 'native-cold-source-review.v1' and review['reviewer'] == 'Codex'
         and review['sourceInventorySha256'] == r['sourceInventorySha256'] and review['canonicalPassed'] is True
         and review['verdict'] == 'APPROVE_EXECUTION')
    own = digest(read_file(os.path.realpath(__file__), 128*1024))
    need(review.get('hostOperatorSha256') == own and os.path.realpath(__file__) ==
         '/opt/adsecute-native-cold-runtime-install/'+own+'/install.py', 'reviewed_host_operator_required')
    proof = r['dbProof']
    need(proof['contract'] == 'native-cold-db-installation.v1' and proof['sourceInventorySha256'] == r['sourceInventorySha256']
         and proof['sourceDataAndWalSameDevice'] is True and proof['replicaRootSeparateFromSourceData'] is True)
    for p in [CONTROL, CONTROL+'/replication', CONTROL+'/replication/outbox', CONTROL+'/copies', CONTROL+'/jobs']:
        safe_directory(p, True)
    review_bytes = canonical(review)
    replace_private(CONTROL+'/source-review.json', review_bytes)
    safe_directory('/root/.ssh')
    auth = '/root/.ssh/authorized_keys'
    old = read_file(auth, 512*1024)
    line = ('restrict,command="/usr/bin/python3 '+directory+'/mirror-endpoint.py" '+r['publicKey']+'\n').encode()
    same = [x for x in old.splitlines() if b'adsecute-native-cold-mirror' in x]
    if same and same!=[line.rstrip(b'\n')]:
        old_directory=re.findall(rb'/opt/adsecute-native-cold/[a-f0-9]{64}',same[0])
        need(len(same)==1 and len(old_directory)==1 and same[0].replace(old_directory[0],directory.encode())==line.rstrip(b'\n'),
             'existing_replica_key_boundary_differs')
        replace_private(auth,b'\n'.join(line.rstrip(b'\n') if x==same[0] else x for x in old.splitlines())+b'\n')
    if not same:
        replace_private(auth, old.rstrip(b'\n')+b'\n'+line)
    if r['action'] == 'prepare':
        compose(['pull', 'native-restore'], 180)
        ids = run(['/usr/bin/docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'id', IMAGE, '-u', 'postgres']).strip()
        groups = run(['/usr/bin/docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'id', IMAGE, '-g', 'postgres']).strip()
        need(ids.isdigit() and groups.isdigit())
        for name in ('native-restore-data', 'native-restore-socket'):
            p = APP+'/'+name
            os.makedirs(p, mode=0o700, exist_ok=True)
            need(os.path.realpath(p) == p and os.stat(p).st_dev == os.stat('/').st_dev)
            # Fixed new private companion directories only, no production PG.
            os.chown(p, int(ids), int(groups));os.chmod(p, 0o700)
        compose(['up', '-d', 'native-restore'])
        ready = False
        for _ in range(30):
            try:
                ready = b'accepting connections' in compose(['exec', '-T', 'native-restore', 'pg_isready', '-h', '/var/run/postgresql', '-p', '25432', '-U', 'native_restore', '-d', 'postgres'])
            except subprocess.CalledProcessError:
                pass
            if ready:
                break
            time.sleep(2)
        need(ready, 'private_companion_not_ready')
        cid = compose(['ps', '-q', 'native-restore']).decode().strip()
        container = json.loads(run(['/usr/bin/docker', 'inspect', cid]))[0]
        need(container['HostConfig']['NetworkMode'] == 'none' and not container['HostConfig'].get('PortBindings'))
        atomic_json(CONTROL+'/installation.json', {'contract': 'native-cold-installation.v1',
                    'sourceInventorySha256': r['sourceInventorySha256'], 'keySha256': r['keySha256'], 'offlineRecoveryMatch': True,
                    'sourceDataAndWalSameDevice': True, 'replicaRootSeparateFromSourceData': True,
                    'restoreDataAndSocketOnAppRoot': True, 'privateRestoreNetwork': 'none', 'hostOperatorSha256': own})
        return {'prepared': True, 'privateRestoreNetwork': 'none', 'sourceMutated': False, 'runtimeFilesVerified': len(inventory['files']), 'hostOperatorSha256': own}
    need(os.path.lexists(CONTROL+'/installation.json'))
    env_path = APP+'/.env.native-archive'
    before = read_file(env_path, 128*1024)
    updates = {'NATIVE_COLD_REPLICA_REQUIRED': 'true', 'NATIVE_COLD_LIFECYCLE_ENABLED': 'true' if r['action']=='activate' else 'false',
               'ADSECUTE_SYNC_LANE_NATIVE_ARCHIVE_ENABLED': 'enabled' if r['action']=='activate' else 'disabled',
               'NATIVE_COLD_SOURCE_INVENTORY_SHA256': r['sourceInventorySha256'],
               'NATIVE_COLD_SOURCE_REVIEW_SHA256': digest(review_bytes), 'NATIVE_COLD_KEY_SHA256': r['keySha256']}
    lines = before.decode().splitlines()
    existing = {line.split('=', 1)[0] for line in lines if '=' in line and not line.lstrip().startswith('#')}
    need(len(existing) == sum('=' in line and not line.lstrip().startswith('#') for line in lines), 'duplicate_archive_env_key')
    new = ['{}={}'.format(line.split('=',1)[0], updates[line.split('=',1)[0]]) if line.split('=',1)[0] in updates else line for line in lines]
    new += [k+'='+v for k, v in updates.items() if k not in existing]
    if r['action']=='activate':
        h = json.loads(read_file(CONTROL+'/replication/health.json',8192))
        from datetime import datetime, timezone
        age = datetime.now(timezone.utc).timestamp()-datetime.fromisoformat(h['observedAt'].replace('Z','+00:00')).timestamp()
        need(0<=age<=90 and h['outcome']!='owner_attention', 'actual_replica_connection_required')
    # Only the digest is retained; the preexisting env stays on-host in its own
    # private fixed rollback file and is never returned/logged/off-host.
    env_backup = APP+'/.env.native-archive.before-cold-'+digest(before)[:12]
    if not os.path.lexists(env_backup):
        replace_private(env_backup, before)
    replace_private(env_path, ('\n'.join(new)+'\n').encode())
    compose(['up', '-d', '--no-deps', '--force-recreate', 'web', 'worker', 'archive-erasure'], 180)
    return {'activated': r['action']=='activate', 'writerDisabled': r['action']=='disable_writer',
            'replicaRequired': True, 'sourceInventorySha256': r['sourceInventorySha256'], 'envBeforeSha256': digest(before)}


if __name__ == '__main__':
    try:
        raw=sys.stdin.buffer.read(131073);need(len(raw)<=131072)
        print(json.dumps(main(json.loads(raw))))
    except BaseException as e:
        reason = str(e) if isinstance(e, ValueError) and re.fullmatch('[a-z_]{1,80}', str(e)) else 'host_install_operation_failed'
        print(json.dumps({'error':'native_cold_app_install_refused','reason':reason}))
        sys.exit(1)
