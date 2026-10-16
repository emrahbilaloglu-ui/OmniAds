#!/usr/bin/env python3
"""DB ROOT volume only; encrypted copies, digest readback, no production SQL."""
import base64
import json
import os
import signal
import fcntl
import datetime
import subprocess
import time
from mirror_protocol import (ACK, UUID, PURPOSE, NAME, MAX_BYTES, ROOT_FLOOR, RESERVE, atomic_json,
                             canonical, digest, need, read_file, safe_directory, sync_directory,
                             utc, validate_manifest, volume)

ROOT = '/var/lib/adsecute-native-replica'
SSH = ['/usr/bin/ssh', '-i', '/root/.ssh/adsecute-native-mirror', '-o', 'BatchMode=yes',
       '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/root/.ssh/adsecute-native-mirror-known-hosts',
       '-o', 'ConnectTimeout=7', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
       'root@178.156.222.119', 'adsecute-native-mirror-v1']
STOP = False


def remote(request):
    result = subprocess.run(SSH, input=canonical(request) + b'\n', stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=45, check=False)
    need(result.returncode == 0 and len(result.stdout) <= 48 * 1024 ** 2, 'replica_transport_unavailable')
    value = json.loads(result.stdout)
    need(isinstance(value, dict) and 'error' not in value, 'replica_endpoint_refused')
    return value


def sample_existing_capacity():
    # The existing READ-ONLY host sampler, also used by the finite operator.
    # No provider job, arbitrary SQL, scheduler change or budget override.
    data = os.stat('/var/lib/postgresql/16/main').st_dev
    need(data == os.stat('/var/lib/postgresql/16/main/pg_wal').st_dev
         and data != os.stat(ROOT).st_dev == os.stat('/').st_dev, 'source_wal_volume_changed')
    subprocess.run(['/usr/bin/systemctl', 'start', 'adsecute-db-healthcheck.service'],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=75, check=True)
    result = subprocess.run(['/usr/bin/systemctl', 'show', 'adsecute-db-healthcheck.service',
                             '-p', 'Result', '-p', 'ExecMainStatus'], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=10, check=True)
    properties = dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)
    need(properties.get('Result') == 'success' and properties.get('ExecMainStatus') == '0', 'capacity_sampler_unacknowledged')


def immutable(path, data):
    safe_directory(os.path.dirname(path))
    pending = path + '.writing'
    if os.path.lexists(pending):
        import stat
        fd = os.open(pending, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            s = os.fstat(fd)
            need(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink in (1, 2)
                 and not s.st_mode & 0o022 and s.st_size <= len(data))
            b = os.read(fd, s.st_size + 1)
            end = os.fstat(fd)
            need(len(b) == s.st_size and b == data[:s.st_size] and s.st_mtime_ns == end.st_mtime_ns
                 and s.st_ctime_ns == end.st_ctime_ns)
            if s.st_nlink == 2:
                target = os.lstat(path)
                need(target.st_ino == s.st_ino and target.st_dev == s.st_dev and len(b) == len(data))
        finally:
            os.close(fd)
        os.unlink(pending)
        sync_directory(os.path.dirname(path))
    try:
        read_file(path, len(data), digest(data), len(data))
        return
    except FileNotFoundError:
        pass
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
        os.fchmod(output.fileno(), 0o400)
    os.link(pending, path, follow_symlinks=False)
    os.unlink(pending)
    sync_directory(os.path.dirname(path))
    read_file(path, len(data), digest(data), len(data))


def replicate(root, m, source_sha, files, enforce_root_device=True):
    validate_manifest(m)
    need(m['kind'] == 'copy' and source_sha == digest(canonical(m)) and set(files) == {f['name'] for f in m['files']})
    v = volume(root, enforce_root_device)
    need(v['availableBytes'] >= ROOT_FLOOR + RESERVE + sum(f['bytes'] for f in m['files']), 'replica_physical_reserve')
    business = os.path.join(root, m['businessId'])
    safe_directory(business, True)
    path = os.path.join(business, m['jobRunId'])
    safe_directory(path, True)
    # Durable ownership intent precedes every write; an interrupted partial
    # original remains owned and can be resumed or explicitly erased.
    intent = {'request': m, 'sourceManifestSha256': source_sha}
    immutable(os.path.join(path, 'manifest.json'), canonical(intent))
    for f in m['files']:
        data = files[f['name']]
        need(isinstance(data, bytes) and len(data) == f['bytes'] and digest(data) == f['sha256'])
        immutable(os.path.join(path, f['name']), data)
    for f in m['files']:
        read_file(os.path.join(path, f['name']), f['bytes'], f['sha256'], f['bytes'])
    sync_directory(path)
    sync_directory(business)
    sync_directory(root)
    return volume(root, enforce_root_device)


def scrub_one(root):
    """One complete retained encrypted original per idle tick, never its key."""
    cursor_path = os.path.join(root, 'scrub.json')
    try:
        cursor = json.loads(read_file(cursor_path, 4096)).get('cursor', '')
    except FileNotFoundError:
        cursor = ''
    first, following, count = None, None, 0
    with os.scandir(root) as businesses:
        for b in businesses:
            if b.name in ('health.json', 'cursor.json', 'scrub.json', 'installation.json', '.lock'):
                need(b.is_file(follow_symlinks=False))
                continue
            need(b.is_dir(follow_symlinks=False) and UUID.fullmatch(b.name))
            safe_directory(b.path)
            with os.scandir(b.path) as jobs:
                for j in jobs:
                    count += 1
                    need(count <= 100000 and j.is_dir(follow_symlinks=False) and UUID.fullmatch(j.name))
                    key = b.name + '/' + j.name
                    if first is None or key < first:
                        first = key
                    if key > cursor and (following is None or key < following):
                        following = key
    key = following or first
    if key is None:
        return {'scrubbed': False}
    path = os.path.join(root, key)
    intent = json.loads(read_file(os.path.join(path, 'manifest.json'), 32768))
    m = validate_manifest(intent['request'])
    need(m['kind'] == 'copy' and key == m['businessId'] + '/' + m['jobRunId']
         and intent['sourceManifestSha256'] == digest(canonical(m)))
    for f in m['files']:
        read_file(os.path.join(path, f['name']), f['bytes'], f['sha256'], f['bytes'])
    atomic_json(cursor_path, {'cursor': key, 'observedAt': utc()})
    return {'scrubbed': True, 'filesVerified': len(m['files'])}


def erase_business(root, business_id, enforce_root_device=True):
    need(isinstance(business_id, str) and UUID.fullmatch(business_id))
    volume(root, enforce_root_device)
    business = os.path.join(root, business_id)
    if not os.path.lexists(business):
        return volume(root, enforce_root_device)
    safe_directory(business)
    jobs, files_seen = [], 0
    with os.scandir(business) as entries:
        for entry in entries:
            need(entry.is_dir(follow_symlinks=False) and UUID.fullmatch(entry.name) and len(jobs) < 30000)
            safe_directory(entry.path)
            jobs.append(entry.path)
    for path in jobs:
        final_intent, pending_intent = os.path.join(path, 'manifest.json'), os.path.join(path, 'manifest.json.writing')
        if os.path.lexists(final_intent) and os.path.lexists(pending_intent):
            a, b = os.lstat(final_intent), os.lstat(pending_intent)
            if a.st_ino == b.st_ino and a.st_dev == b.st_dev:
                need(a.st_nlink == 2 and a.st_uid == os.getuid() and not a.st_mode & 0o022)
                os.unlink(pending_intent)
        remaining = os.listdir(path)
        if not remaining:
            os.rmdir(path)
            sync_directory(business)
            continue
        if remaining == ['manifest.json.writing']:
            import stat
            pending = os.path.join(path, remaining[0])
            s = os.lstat(pending)
            need(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink == 1
                 and not s.st_mode & 0o077 and s.st_size <= 32768)
            os.unlink(pending)
            os.rmdir(path)
            sync_directory(business)
            continue
        intent = json.loads(read_file(os.path.join(path, 'manifest.json'), 32768))
        need(isinstance(intent, dict) and set(intent) == {'request', 'sourceManifestSha256'})
        m = validate_manifest(intent['request'])
        need(m['kind'] == 'copy' and m['businessId'] == business_id and m['jobRunId'] == os.path.basename(path))
        expected = {f['name']: f for f in m['files']}
        for name in expected:
            final, pending = os.path.join(path, name), os.path.join(path, name + '.writing')
            if os.path.lexists(final) and os.path.lexists(pending):
                a, b = os.lstat(final), os.lstat(pending)
                if a.st_ino == b.st_ino and a.st_dev == b.st_dev:
                    need(a.st_nlink == 2 and a.st_uid == os.getuid() and not a.st_mode & 0o022)
                    os.unlink(pending)
        remove = []
        with os.scandir(path) as entries:
            for entry in entries:
                files_seen += 1
                need(files_seen <= 1000000 and entry.is_file(follow_symlinks=False))
                if entry.name == 'manifest.json':
                    continue
                pending = entry.name.endswith('.writing')
                name = entry.name[:-8] if pending else entry.name
                need(name in expected and NAME.fullmatch(name))
                f = expected[name]
                if pending:
                    # Only the durable exact intent's unfinished filename.
                    import stat
                    s = os.lstat(entry.path)
                    need(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink == 1
                         and not s.st_mode & 0o077 and 0 <= s.st_size <= f['bytes'])
                else:
                    # Private intent + tenant/job namespace establish owner.
                    # Corruption/partial bytes refuse a COPY acknowledgement,
                    # but cannot exempt owned redundant data from explicit erase.
                    import stat
                    s = os.lstat(entry.path)
                    need(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink == 1
                         and not s.st_mode & 0o022 and 0 <= s.st_size <= f['bytes'])
                remove.append(entry.path)
        for filename in remove:
            os.unlink(filename)
        sync_directory(path)
        os.unlink(os.path.join(path, 'manifest.json'))
        os.rmdir(path)
        sync_directory(business)
    os.rmdir(business)
    sync_directory(root)
    need(not os.path.lexists(business))
    scrub = os.path.join(root, 'scrub.json')
    try:
        c = json.loads(read_file(scrub, 4096))
        if c.get('cursor', '').startswith(business_id + '/'):
            atomic_json(scrub, {'cursor': '', 'observedAt': utc()})
    except FileNotFoundError:
        pass
    return volume(root, enforce_root_device)


def one_tick(root=ROOT, send=remote, enforce_root_device=True):
    safe_directory(root)
    current = send({'op': 'list'})
    need(set(current) == {'requests'} and isinstance(current['requests'], list) and len(current['requests']) <= 64)
    requests = current['requests']
    erasing = {r['businessId'] for r in requests if r.get('kind') == 'erase'}
    # One finite original/action per iteration. Active erasure always wins;
    # old copy requests cannot resurrect a hidden business after erase ACK.
    eligible = [r for r in requests if r.get('kind') == 'erase' or r.get('businessId') not in erasing]
    if not eligible:
        return {'outcome': 'idle', 'replicaVolume': volume(root, enforce_root_device), **scrub_one(root)}
    # Refresh every active request fairly; the controller removes acknowledged
    # completed requests, so a lost ACK never silently skips an original.
    eligible.sort(key=lambda r: (r.get('kind') != 'erase', r.get('purpose', '')))
    cursor_path = os.path.join(root, 'cursor.json')
    try:
        cursor = json.loads(read_file(cursor_path, 4096)).get('purpose', '')
    except FileNotFoundError:
        cursor = ''
    candidates = [r for r in eligible if r['purpose'] > cursor] or eligible
    r = candidates[0]
    need(set(r) == {'businessId', 'purpose', 'kind', 'manifestSha256'})
    result = send({'op': 'fetch', **{k: r[k] for k in ('businessId', 'purpose', 'manifestSha256')}})
    if result == {'expired': True, 'manifestSha256': r['manifestSha256']}:
        return {'outcome': 'owner_attention', 'reason': 'replica_purpose_expired', 'replicaVolume': volume(root, enforce_root_device)}
    need(set(result) == {'manifest', 'manifestSha256', 'files'} and result['manifestSha256'] == r['manifestSha256'])
    m = validate_manifest(result['manifest'])
    need(m['businessId'] == r['businessId'] and m['purpose'] == r['purpose'] and m['kind'] == r['kind'])
    if m['kind'] != 'erase':
        ttl = datetime.datetime.fromisoformat(m['expiresAt'].replace('Z', '+00:00')).timestamp() - time.time()
        if ttl <= 0:
            return {'outcome': 'owner_attention', 'reason': 'replica_purpose_expired', 'replicaVolume': volume(root, enforce_root_device)}
        need(ttl <= 30 * 60, 'finite_replica_purpose_required')
    if m['kind'] == 'copy':
        files = {name: base64.b64decode(data, validate=True) for name, data in result['files'].items()}
        v = replicate(root, m, result['manifestSha256'], files, enforce_root_device)
        if enforce_root_device:
            sample_existing_capacity()
            v = volume(root, True)
    elif m['kind'] == 'capacity':
        need(result['files'] == {})
        if enforce_root_device:
            sample_existing_capacity()
        v = volume(root, enforce_root_device)
    else:
        need(result['files'] == {})
        v = erase_business(root, m['businessId'], enforce_root_device)
    ack = {'contract': ACK, 'kind': m['kind'], 'businessId': m['businessId'], 'purpose': m['purpose'],
           'jobRunId': m['jobRunId'], 'manifestSha256': result['manifestSha256'], 'files': m['files'],
           'replicaVolume': v, 'observedAt': utc(), 'verified': True, 'sourceDeleted': False}
    need(send({'op': 'ack', **{k: r[k] for k in ('businessId', 'purpose', 'manifestSha256')}, 'ack': ack}) ==
         {'acknowledged': True, 'manifestSha256': result['manifestSha256']})
    atomic_json(cursor_path, {'purpose': '' if m['kind'] == 'erase' else m['purpose']})
    return {'outcome': 'verified_copy' if m['kind'] == 'copy' else 'verified_capacity_sample' if m['kind'] == 'capacity' else 'verified_business_absence', 'replicaVolume': v}


def main():
    global STOP
    safe_directory(ROOT)
    lock = os.open(os.path.join(ROOT, '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    def stop(_signal, _frame):
        global STOP
        STOP = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not STOP:
        try:
            result = one_tick()
        except BaseException:
            result = {'outcome': 'owner_attention', 'reason': 'native_replica_unavailable'}
        atomic_json(os.path.join(ROOT, 'health.json'), {'contract': 'native-cold-replica-health.v1',
                    'observedAt': utc(), **result})
        try:
            need(remote({'op': 'health', 'health': {'contract': 'native-cold-replica-health.v1',
                        'observedAt': utc(), 'outcome': result['outcome'], 'reason': result.get('reason')}}) == {'recorded': True})
        except BaseException:
            # Transport loss is visible as stale/missing owner telemetry. No
            # customer state or earlier successful erasure ACK is rewritten.
            pass
        for _ in range(15):
            if STOP:
                break
            time.sleep(1)


if __name__ == '__main__':
    main()
