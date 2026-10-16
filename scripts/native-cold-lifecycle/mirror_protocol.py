"""Fixed native ciphertext mirror protocol. No provider/DB access or shell."""
import base64
import datetime
import hashlib
import json
import os
import re
import stat
import time

UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
PURPOSE = re.compile(r'^[a-f0-9]{12}$')
SHA = re.compile(r'^[a-f0-9]{64}$')
NAME = re.compile(r'^(?:[a-f0-9]{64}\.bin|leaf-[a-f0-9]{64}\.json|capture\.json|config\.json\.gz)$')
CONTRACT = 'native-cold-replica-request.v1'
ACK = 'native-cold-replica-ack.v1'
MAX_BYTES = 32 * 1024 ** 2
ROOT_FLOOR = 16 * 1024 ** 3
RESERVE = 512 * 1024 ** 2


def need(value, code='native_mirror_refused'):
    if not value:
        raise ValueError(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def canonical(value):
    return json.dumps(value, separators=(',', ':'), sort_keys=True).encode()


def safe_directory(path, create=False):
    need(os.path.isabs(path) and os.path.normpath(path) == path)
    if create:
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass
    s = os.lstat(path)
    need(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_uid == os.getuid()
         and not s.st_mode & 0o022 and os.path.realpath(path) == path)
    return s


def read_file(path, maximum, sha=None, exact=None):
    safe_directory(os.path.dirname(path))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == os.getuid()
             and not s.st_mode & 0o022 and 0 < s.st_size <= maximum
             and (exact is None or s.st_size == exact))
        chunks, length = [], 0
        while True:
            chunk = os.read(fd, min(1024 ** 2, maximum + 1 - length))
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
            need(length <= maximum)
        end, named = os.fstat(fd), os.lstat(path)
        need(length == s.st_size and end.st_size == s.st_size and end.st_mtime_ns == s.st_mtime_ns
             and end.st_ctime_ns == s.st_ctime_ns and end.st_nlink == 1
             and named.st_ino == s.st_ino and named.st_dev == s.st_dev)
        result = b''.join(chunks)
        need(sha is None or digest(result) == sha)
        return result
    finally:
        os.close(fd)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path, value):
    safe_directory(os.path.dirname(path))
    pending = path + '.pending'
    data = canonical(value)
    need(len(data) <= 32768)
    # Only this fixed ACK/health filename is replaceable. Pending bytes from a
    # killed prior fixed writer are not treated as a completed acknowledgement.
    try:
        s = os.lstat(pending)
        need(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink == 1 and not s.st_mode & 0o077)
        os.unlink(pending)
    except FileNotFoundError:
        pass
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        raise
    os.replace(pending, path)
    sync_directory(os.path.dirname(path))


def validate_manifest(m):
    need(isinstance(m, dict) and set(m) == {'contract', 'kind', 'businessId', 'purpose', 'jobRunId', 'expiresAt', 'files'})
    need(m['contract'] == CONTRACT and m['kind'] in ('copy', 'erase')
         and isinstance(m['businessId'], str) and UUID.fullmatch(m['businessId'])
         and isinstance(m['purpose'], str) and PURPOSE.fullmatch(m['purpose']) and isinstance(m['files'], list))
    if m['kind'] == 'erase':
        need(m['jobRunId'] is None and m['expiresAt'] is None and not m['files'])
        return m
    need(isinstance(m['jobRunId'], str) and UUID.fullmatch(m['jobRunId']) and 4 <= len(m['files']) <= 19)
    need(isinstance(m['expiresAt'], str))
    datetime.datetime.fromisoformat(m['expiresAt'].replace('Z', '+00:00'))
    names, total = set(), 0
    for f in m['files']:
        need(isinstance(f, dict) and set(f) == {'name', 'sha256', 'bytes'} and isinstance(f['name'], str)
             and NAME.fullmatch(f['name']) and f['name'] not in names and isinstance(f['sha256'], str)
             and SHA.fullmatch(f['sha256']) and type(f['bytes']) is int and f['bytes'] > 0)
        limit = 2 * 1024 ** 2 + 128 if f['name'].endswith('.bin') else 2 * 1024 ** 2 if f['name'] == 'config.json.gz' else 32768 if f['name'] == 'capture.json' else 944 * 1024
        need(f['bytes'] <= limit)
        if f['name'].endswith('.bin'):
            need(f['name'] == f['sha256'] + '.bin')
        names.add(f['name'])
        total += f['bytes']
    need(total <= MAX_BYTES and {'capture.json', 'config.json.gz'}.issubset(names)
         and len([n for n in names if n.endswith('.bin')]) >= 1
         and len([n for n in names if n.startswith('leaf-')]) == 1)
    leaf = next(f for f in m['files'] if f['name'].startswith('leaf-'))
    need(leaf['name'] == 'leaf-' + leaf['sha256'] + '.json')
    return m


def load_request(control, business, purpose, sha=None):
    need(isinstance(business, str) and UUID.fullmatch(business) and isinstance(purpose, str) and PURPOSE.fullmatch(purpose))
    path = control
    for name in ('replication', 'outbox', business, purpose):
        safe_directory(path)
        path = os.path.join(path, name)
    safe_directory(path)
    data = read_file(os.path.join(path, 'manifest.json'), 32768, sha)
    m = validate_manifest(json.loads(data))
    need(m['businessId'] == business and m['purpose'] == purpose)
    return path, m, digest(data)


def list_requests(control):
    result = []
    path = os.path.join(control, 'replication', 'outbox')
    safe_directory(control)
    safe_directory(os.path.dirname(path))
    safe_directory(path)
    with os.scandir(path) as businesses:
        for b in businesses:
            need(b.is_dir(follow_symlinks=False) and UUID.fullmatch(b.name))
            safe_directory(b.path)
            with os.scandir(b.path) as purposes:
                for p in purposes:
                    need(p.is_dir(follow_symlinks=False) and PURPOSE.fullmatch(p.name) and len(result) < 64)
                    _, m, sha = load_request(control, b.name, p.name)
                    result.append({'businessId': b.name, 'purpose': p.name, 'kind': m['kind'], 'manifestSha256': sha})
    return sorted(result, key=lambda x: (x['kind'] != 'erase', x['businessId'], x['purpose']))


def source_files(control, m):
    path = control
    for name in ('copies', m['businessId'], m['jobRunId'], 'primary'):
        safe_directory(path)
        path = os.path.join(path, name)
    safe_directory(path)
    return {f['name']: read_file(os.path.join(path, f['name']), f['bytes'], f['sha256'], f['bytes']) for f in m['files']}


def volume(root, enforce_root_device=True):
    s = safe_directory(root)
    need(not enforce_root_device or s.st_dev == os.stat('/').st_dev, 'replica_not_on_root_volume')
    v = os.statvfs(root)
    return {'observedAt': utc(), 'availableBytes': v.f_bavail * v.f_frsize,
            'minimumFreeBytes': ROOT_FLOOR, 'device': str(s.st_dev), 'host': '87.99.149.56', 'scope': 'db-root'}


def validate_ack(a, m, manifest_sha):
    need(isinstance(a, dict) and set(a) == {'contract', 'kind', 'businessId', 'purpose', 'jobRunId',
         'manifestSha256', 'files', 'replicaVolume', 'observedAt', 'verified', 'sourceDeleted'})
    need(a['contract'] == ACK and a['kind'] == m['kind'] and a['businessId'] == m['businessId']
         and a['purpose'] == m['purpose'] and a['jobRunId'] == m['jobRunId'] and a['manifestSha256'] == manifest_sha
         and a['files'] == m['files'] and a['verified'] is True and a['sourceDeleted'] is False)
    now = time.time()
    if m['kind'] == 'copy':
        need(now <= datetime.datetime.fromisoformat(m['expiresAt'].replace('Z', '+00:00')).timestamp(), 'replica_purpose_expired')
    for at in (a['observedAt'], a['replicaVolume']['observedAt']):
        age = now - datetime.datetime.fromisoformat(at.replace('Z', '+00:00')).timestamp()
        need(0 <= age <= 60, 'replica_ack_stale')
    v = a['replicaVolume']
    need(set(v) == {'observedAt', 'availableBytes', 'minimumFreeBytes', 'device', 'host', 'scope'}
         and v['host'] == '87.99.149.56' and v['scope'] == 'db-root' and isinstance(v['device'], str)
         and v['device'].isdigit() and type(v['availableBytes']) is int and v['minimumFreeBytes'] == ROOT_FLOOR
         and v['availableBytes'] >= ROOT_FLOOR + RESERVE, 'replica_physical_reserve')
    return a
