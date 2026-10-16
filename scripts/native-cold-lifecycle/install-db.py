#!/usr/bin/env python3
"""Fixed DB-root encrypted-replica installation; never source SQL/PG maintenance."""
import json
import os
import re
import sys
from install_common import reviewed_files, replace_private, run
from mirror_protocol import need, safe_directory, atomic_json, read_file, utc, volume

ROOT = '/var/lib/adsecute-native-replica'
KEY = '/root/.ssh/adsecute-native-mirror'
KNOWN = '/root/.ssh/adsecute-native-mirror-known-hosts'
SERVICE = '/etc/systemd/system/adsecute-native-replica.service'


def main(r):
    need(set(r) == {'action', 'sourceInventorySha256', 'knownHosts'} and r['action'] in ('prepare', 'activate'))
    directory, _ = reviewed_files(r['sourceInventorySha256'])
    need(isinstance(r['knownHosts'], str) and 20 < len(r['knownHosts']) < 32768 and '\n' not in r['knownHosts'].rstrip('\n'))
    host = r['knownHosts'].strip().split()
    need(len(host) == 3 and host[0] == '178.156.222.119' and host[1] == 'ssh-ed25519' and re.fullmatch('[A-Za-z0-9+/=]+', host[2]))
    root_device = os.stat('/').st_dev
    data_device = os.stat('/var/lib/postgresql/16/main').st_dev
    wal_device = os.stat('/var/lib/postgresql/16/main/pg_wal').st_dev
    need(data_device == wal_device and root_device != data_device, 'source_wal_volume_proof_refused')
    safe_directory(ROOT, True)
    v = volume(ROOT, True)
    need(v['availableBytes'] >= 16 * 1024 ** 3 + 512 * 1024 ** 2, 'replica_root_floor')
    safe_directory('/root/.ssh')
    if not os.path.lexists(KEY):
        run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'adsecute-native-cold-mirror', '-f', KEY])
    need(os.lstat(KEY).st_mode & 0o077 == 0 and os.lstat(KEY).st_nlink == 1)
    public = read_file(KEY + '.pub', 4096).decode().strip()
    need(re.fullmatch('ssh-ed25519 [A-Za-z0-9+/=]+ adsecute-native-cold-mirror', public))
    if os.path.lexists(KNOWN):
        need(read_file(KNOWN, 32768) == (r['knownHosts'].strip()+'\n').encode(), 'existing_host_pin_changed')
    else:
        replace_private(KNOWN, (r['knownHosts'].strip()+'\n').encode())
    proof = {'contract': 'native-cold-db-installation.v1', 'observedAt': utc(),
             'sourceInventorySha256': r['sourceInventorySha256'], 'sourceDataAndWalSameDevice': True,
             'replicaRootSeparateFromSourceData': True, 'sourceDataDevice': str(data_device),
             'sourceWalDevice': str(wal_device), 'replicaRootDevice': str(root_device), 'replicaVolume': v}
    atomic_json(os.path.join(ROOT, 'installation.json'), proof)
    if r['action'] == 'activate':
        unit = ('[Unit]\nDescription=Adsecute lossless encrypted native history replica\nAfter=network-online.target\nWants=network-online.target\n'
                '[Service]\nType=simple\nUser=root\nWorkingDirectory='+directory+'\n'
                'Environment=PYTHONDONTWRITEBYTECODE=1\nExecStart=/usr/bin/python3 '+directory+'/mirror-replica.py\n'
                'Restart=on-failure\nRestartSec=15\nTimeoutStopSec=100\nUMask=0077\nMemoryMax=256M\n'
                '[Install]\nWantedBy=multi-user.target\n').encode()
        if os.path.lexists(SERVICE):
            old_unit=read_file(SERVICE, 32768)
            old_directory=re.findall(rb'/opt/adsecute-native-cold/[a-f0-9]{64}', old_unit)
            need(old_unit==unit or len(set(old_directory))==1 and
                 old_unit.replace(old_directory[0],directory.encode())==unit, 'existing_replica_service_differs')
            if old_unit!=unit:
                replace_private(SERVICE,unit)
        else:
            replace_private(SERVICE, unit)
        run(['/usr/bin/systemctl', 'daemon-reload'])
        run(['/usr/bin/systemctl', 'enable', '--now', 'adsecute-native-replica.service'])
        run(['/usr/bin/systemctl', 'restart', 'adsecute-native-replica.service'])
        need(run(['/usr/bin/systemctl', 'is-active', 'adsecute-native-replica.service']).strip() == b'active')
    return {**proof, 'publicKey': public, 'serviceEnabled': r['action'] == 'activate'}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(65537)
        need(len(raw) <= 65536)
        print(json.dumps(main(json.loads(raw))))
    except BaseException:
        print('{"error":"native_cold_db_install_refused"}')
        sys.exit(1)
