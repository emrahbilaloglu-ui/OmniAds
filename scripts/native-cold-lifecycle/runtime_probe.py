"""READ-ONLY fixed-role Docker observer on the app HOST; never a Docker socket
mount or general command facility inside the archive container. Only whitelisted
identity/config hashes leave this module; raw ENV/credentials never do."""
import hashlib
import json
import re
import subprocess
from mirror_protocol import need, utc

APP = '/var/www/adsecute'
ROLES = ('web', 'worker', 'archive-erasure')


def command(args):
    r = subprocess.run(['/usr/bin/docker'] + args, cwd=APP, stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL, timeout=8, check=True)
    need(len(r.stdout) <= 2 * 1024 ** 2)
    return r.stdout


def configuration(env):
    key = env.get('ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX', '')
    return {'base': {
        'catalogPath': env.get('ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH') or None,
        'catalogSha256': env.get('ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256') or None,
        'routingEnabled': env.get('ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED') == 'true',
        'routingDirectory': env.get('ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT') or None,
        'rootSha256': env.get('ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256') or None,
        'localRoot': env.get('ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT') or None,
        'transport': env.get('ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT') or None},
        'activePointer': env.get('ENGINE_V3_NATIVE_ARCHIVE_ACTIVE_POINTER') or None,
        'keyId': env.get('ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID') or None,
        'keySha256': hashlib.sha256(bytes.fromhex(key)).hexdigest() if re.fullmatch('[a-f0-9]{64}', key) else None,
        'replicaRequired': env.get('NATIVE_COLD_REPLICA_REQUIRED') == 'true',
        'coldEnabled': env.get('NATIVE_COLD_LIFECYCLE_ENABLED') == 'true'}


def role_record(container, image):
    env = dict(v.split('=', 1) for v in container['Config'].get('Env', []) if '=' in v)
    immutable_env = dict(v.split('=', 1) for v in image['Config'].get('Env', []) if '=' in v)
    labels = image['Config'].get('Labels') or {}
    return {'containerId': container['Id'], 'imageId': container['Image'],
            'buildId': env.get('APP_BUILD_ID'), 'immutableBuildId': immutable_env.get('ADSECUTE_IMAGE_BUILD_ID'),
            'ociRevision': labels.get('org.opencontainers.image.revision'), 'imageRole': labels.get('com.adsecute.release.role'),
            'startedAt': container['State']['StartedAt'], 'running': container['State']['Running'],
            'health': container['State'].get('Health', {}).get('Status'),
            'archive': configuration(env),
            'mounts': [{'source': m['Source'], 'destination': m['Destination'], 'writable': m['RW'], 'type': m['Type']}
                       for m in container.get('Mounts', []) if m['Destination'] in (
                           '/run/adsecute-native-archive', '/run/adsecute-business-erasure', '/run/adsecute-native-restore-socket')]}


def observe():
    ids = command(['compose', '--profile', 'business-erasure', 'ps', '-q', *ROLES]).decode().splitlines()
    need(len(ids) == 3 and all(re.fullmatch('[a-f0-9]{64}', i) for i in ids))
    containers = json.loads(command(['inspect', *ids]))
    images = {i['Id']: i for i in json.loads(command(['image', 'inspect', *sorted({c['Image'] for c in containers})]))}
    roles = {}
    for c in containers:
        role = c['Config']['Labels'].get('com.docker.compose.service')
        need(role in ROLES and role not in roles)
        roles[role] = role_record(c, images[c['Image']])
    need(set(roles) == set(ROLES))
    return {'contract': 'native-cold-runtime-observation.v1', 'observedAt': utc(), 'valid': True, 'roles': roles}
