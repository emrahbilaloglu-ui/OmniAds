"""Owned filesystem exercise; no SSH, DB, provider or production paths."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
import datetime
from unittest.mock import patch
from mirror_protocol import (ACK, CONTRACT, ROOT_FLOOR, RESERVE, atomic_json, canonical, digest,
                             read_file, validate_ack, validate_manifest)


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(os.path.dirname(__file__), filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


endpoint = module('owned_endpoint', 'mirror-endpoint.py')
replica = module('owned_replica', 'mirror-replica.py')
BIZ = '00000000-0000-4000-9000-000000000777'
FOREIGN = '00000000-0000-4000-9000-000000000778'
JOB = '00000000-0000-4000-9000-000000000001'


class Protocol(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='owned-native-mirror-')
        self.base = os.path.realpath(self.temp.name)
        self.control, self.root = [os.path.join(self.base, n) for n in ('control', 'replica')]
        for p in (self.control, self.root):
            os.mkdir(p, 0o700)

    def tearDown(self):
        self.temp.cleanup()

    def request(self, business=BIZ, purpose='a' * 12, kind='copy'):
        parts = {'capture.json': b'{"metadata":"opaque-original"}', 'config.json.gz': b'opaque gzip config transport bytes'}
        data = b'owned opaque ciphertext - key absent from protocol'
        parts[digest(data) + '.bin'] = data
        leaf = b'{"test":"immutable-leaf"}'
        parts['leaf-' + digest(leaf) + '.json'] = leaf
        if kind == 'erase':
            parts = {}
        m = {'contract': CONTRACT, 'kind': kind, 'businessId': business, 'purpose': purpose,
             'jobRunId': JOB if kind == 'copy' else None,
             'expiresAt': (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=30)).isoformat().replace('+00:00', 'Z') if kind == 'copy' else None,
             'files': [{'name': n, 'sha256': digest(b), 'bytes': len(b)} for n, b in sorted(parts.items())]}
        target = os.path.join(self.control, 'replication', 'outbox', business, purpose)
        os.makedirs(target, mode=0o700, exist_ok=True)
        # makedirs applies mode only to the final directory; pin all owned parents.
        for path, dirs, _files in os.walk(self.control):
            os.chmod(path, 0o700)
        atomic_json(os.path.join(target, 'manifest.json'), m)
        if parts:
            primary = os.path.join(self.control, 'copies', business, JOB, 'primary')
            os.makedirs(primary, mode=0o700, exist_ok=True)
            for path, dirs, _files in os.walk(self.control):
                os.chmod(path, 0o700)
            for name, b in parts.items():
                with open(os.path.join(primary, name), 'wb') as f:
                    f.write(b)
                os.chmod(os.path.join(primary, name), 0o400)
        return m, target, parts

    def tick(self):
        return replica.one_tick(self.root, lambda r: endpoint.handle(r, self.control), False)

    def test_two_hosts_protocol_bytes_and_no_fresh_ack_after_replica_drift(self):
        m, outbox, parts = self.request()
        self.assertEqual(self.tick()['outcome'], 'verified_copy')
        ack = json.loads(read_file(os.path.join(outbox, 'ack.json'), 32768))
        self.assertEqual(ack['files'], m['files'])
        self.assertTrue(ack['verified'])
        self.assertFalse(ack['sourceDeleted'])
        for name, b in parts.items():
            self.assertEqual(read_file(os.path.join(self.root, BIZ, JOB, name), len(b)), b)
        target = os.path.join(self.root, BIZ, JOB, 'capture.json')
        os.chmod(target, 0o600)
        with open(target, 'wb') as f:
            f.write(b'corrupt')
        with self.assertRaises(ValueError):
            self.tick()
        self.assertEqual(json.loads(read_file(os.path.join(outbox, 'ack.json'), 32768)), ack)

    def test_exact_partial_write_recovers_without_a_partial_ack(self):
        m, outbox, parts = self.request()
        self.tick()
        target = os.path.join(self.root, BIZ, JOB, 'capture.json')
        os.unlink(target)
        with open(target + '.writing', 'wb') as f:
            f.write(parts['capture.json'][:5])
        os.chmod(target + '.writing', 0o600)
        self.assertEqual(self.tick()['outcome'], 'verified_copy')
        self.assertEqual(read_file(target, len(parts['capture.json'])), parts['capture.json'])
        self.assertFalse(os.path.lexists(target + '.writing'))
        # Real crash interval after the immutable hard link but before alias
        # unlink: recover only these exact two names of the same owned inode.
        os.link(target, target + '.writing')
        self.assertEqual(os.stat(target).st_nlink, 2)
        self.assertEqual(self.tick()['outcome'], 'verified_copy')
        self.assertEqual(os.stat(target).st_nlink, 1)

    def test_whole_business_erasure_preserves_foreign_and_old_copy_cannot_resurrect_it(self):
        self.request()
        self.tick()
        _, _, foreign = self.request(FOREIGN, 'b' * 12)
        self.tick()
        self.request(BIZ, 'c' * 12, 'erase')
        # Explicit erasure includes owned corrupt/partial redundant copies.
        target = os.path.join(self.root, BIZ, JOB, 'capture.json')
        os.chmod(target, 0o600)
        with open(target, 'wb') as f:
            f.write(b'partial')
        for _ in range(3):
            self.assertEqual(self.tick()['outcome'], 'verified_business_absence')
            self.assertFalse(os.path.lexists(os.path.join(self.root, BIZ)))
        for name, b in foreign.items():
            self.assertEqual(read_file(os.path.join(self.root, FOREIGN, JOB, name), len(b)), b)
        self.assertTrue(os.path.isdir(os.path.join(self.control, 'copies', BIZ)))

    def test_refuses_traversal_missing_part_symlink_and_low_physical_reserve(self):
        m, _, parts = self.request()
        bad = {**m, 'businessId': '../foreign'}
        with self.assertRaises(ValueError):
            validate_manifest(bad)
        bad = {**m, 'files': [{**m['files'][0], 'name': '../../escape'}] + m['files'][1:]}
        with self.assertRaises(ValueError):
            validate_manifest(bad)
        with self.assertRaises(ValueError):
            replica.replicate(self.root, m, digest(canonical(m)), {}, False)
        with patch.object(replica, 'volume', return_value={'availableBytes': ROOT_FLOOR + RESERVE - 1}):
            with self.assertRaises(ValueError):
                replica.replicate(self.root, m, digest(canonical(m)), parts, False)
        self.assertFalse(os.path.lexists(os.path.join(self.root, BIZ)))
        os.symlink(self.base, os.path.join(self.root, BIZ))
        with self.assertRaises(ValueError):
            self.tick()

    def test_stale_ack_is_rejected_and_forced_endpoint_has_no_general_operation(self):
        m, outbox, _ = self.request()
        self.tick()
        a = json.loads(read_file(os.path.join(outbox, 'ack.json'), 32768))
        a['observedAt'] = '2000-01-01T00:00:00Z'
        with self.assertRaises(ValueError):
            validate_ack(a, m, digest(canonical(m)))
        with self.assertRaises(ValueError):
            endpoint.handle({'op': 'shell', 'cmd': 'anything'}, self.control)


if __name__ == '__main__':
    unittest.main()
