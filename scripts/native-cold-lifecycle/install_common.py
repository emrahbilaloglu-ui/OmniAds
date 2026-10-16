"""Closed host installation helpers. Input/output contain digests/public keys only."""
import json
import os
import re
import subprocess
from mirror_protocol import need, digest, canonical, safe_directory, read_file, sync_directory


def run(args, cwd=None, timeout=60):
    r = subprocess.run(args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL, timeout=timeout, check=True)
    need(len(r.stdout) <= 2 * 1024 ** 2)
    return r.stdout


def reviewed_files(expected):
    need(os.getuid() == 0 and re.fullmatch('[a-f0-9]{64}', expected))
    directory = os.path.dirname(os.path.realpath(__file__))
    need(directory == '/opt/adsecute-native-cold/' + expected)
    safe_directory(directory)
    inventory = json.loads(read_file(os.path.join(directory, 'source-inventory.json'), 512 * 1024))
    body = {k: v for k, v in inventory.items() if k != 'sourceInventorySha256'}
    need(inventory['sourceInventorySha256'] == expected == digest(canonical(body)))
    for e in inventory['files']:
        if e['path'].startswith('scripts/native-cold-lifecycle/') and e['path'].endswith('.py'):
            read_file(os.path.join(directory, os.path.basename(e['path'])), e['bytes'], e['sha256'], e['bytes'])
    return directory, inventory


def replace_private(path, data):
    safe_directory(os.path.dirname(path))
    need(isinstance(data, bytes) and len(data) <= 512 * 1024)
    if os.path.lexists(path):
        read_file(path, 512 * 1024)
    pending = path + '.cold-install-pending'
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(pending, path)
    sync_directory(os.path.dirname(path))
