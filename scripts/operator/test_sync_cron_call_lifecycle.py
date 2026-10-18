import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("caller", Path(__file__).with_name("sync-cron-call-lifecycle.py"))
caller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(caller)
TOKEN = "owned-test-token-0123456789"


def fixture(log=caller.LOG):
    return ('# unrelated\n17 4 * * * certbot renew --quiet\n# BEGIN adsecute-sync\n'
            '*/10 * * * * curl -fsS -m 300 -X POST http://127.0.0.1:3000/api/sync/cron '
            '-H "Authorization: Bearer ' + TOKEN + '" >' + log + ' 2>&1\n'
            '# END adsecute-sync\n# last unrelated\n')


class CallerTests(unittest.TestCase):
    def test_apply_identity_failures_cannot_reach_a_crontab_write(self):
        operator_sha = __import__('hashlib').sha256(Path(caller.__file__).read_bytes()).hexdigest()
        current = fixture()
        cases = [
            (['--expected-crontab-sha', '0' * 64], 'crontab_changed'),
            (['--expected-crontab-sha', caller.sha(current), '--expected-operator-sha', '0' * 64], 'operator_identity_mismatch'),
            (['--expected-crontab-sha', caller.sha(current), '--expected-operator-sha', operator_sha, '--expected-build', 'invalid'], 'build_required'),
        ]
        for arguments, code in cases:
            with self.subTest(code=code), patch.object(caller.sys, 'argv', ['operator', '--apply', *arguments]), patch.object(caller.sys, 'platform', 'linux'), patch.object(caller.os, 'geteuid', return_value=0), patch.object(caller.subprocess, 'run', return_value=SimpleNamespace(stdout=current)) as run, patch.object(caller.os, 'open') as opened:
                with self.assertRaisesRegex(ValueError, '^' + code + '$'):
                    caller.main()
                self.assertEqual([c.args[0] for c in run.call_args_list], [['crontab', '-l']])
                opened.assert_not_called()

    def test_runtime_mismatch_refuses_before_files_or_scheduler_mutation(self):
        current = fixture()
        operator_sha = __import__('hashlib').sha256(Path(caller.__file__).read_bytes()).hexdigest()
        def run(command, **_):
            if command == ['/usr/bin/flock', '--version']:
                return SimpleNamespace(stdout='flock from util-linux owned-test')
            if command == ['crontab', '-l']:
                return SimpleNamespace(stdout=current)
            if command[:3] == ['docker', 'compose', 'ps']:
                return SimpleNamespace(stdout='owned-container')
            if command[:2] == ['docker', 'inspect']:
                return SimpleNamespace(stdout=json.dumps([{'Config': {'Env': ['APP_BUILD_ID=' + '1' * 40], 'Labels': {'org.opencontainers.image.revision': '1' * 40}}, 'State': {'Health': {'Status': 'healthy'}}}]))
            raise AssertionError('unexpected mutation or command')
        args = ['operator', '--apply', '--expected-crontab-sha', caller.sha(current), '--expected-operator-sha', operator_sha, '--expected-build', '0' * 40]
        with patch.object(caller.sys, 'argv', args), patch.object(caller.sys, 'platform', 'linux'), patch.object(caller.os, 'geteuid', return_value=0), patch.object(caller.subprocess, 'run', side_effect=run), patch.object(caller.Path, 'is_file', return_value=True), patch.object(caller.os, 'open') as opened:
            with self.assertRaisesRegex(ValueError, '^runtime_identity_mismatch$'):
                caller.main()
            opened.assert_not_called()

    def test_exact_scope_and_no_credential_in_receipt(self):
        original = fixture()
        proposed, receipt = caller.plan(original)
        self.assertTrue(receipt["accepted"])
        self.assertEqual(receipt["clientMaxSecondsBefore"], 300)
        self.assertEqual(receipt["clientMaxSecondsAfter"], 1440)
        self.assertNotIn(TOKEN, json.dumps(receipt))
        self.assertTrue(proposed.startswith(original.split(caller.BEGIN)[0]))
        self.assertEqual(proposed.split(caller.END)[1], original.split(caller.END)[1])
        line = proposed.splitlines()[3]
        args = __import__('shlex').split(line[len('*/10 * * * * '):])
        self.assertEqual(args[:7], ['/usr/bin/flock', '-n', '-E', '75', caller.LOCK, '/bin/sh', '-c'])
        self.assertIn('>' + caller.LOG + ' 2>&1', args[7])
        self.assertNotIn('>' + caller.LOG, args[:7])
        # The existing shell adoption guard must recover the same credential.
        self.assertEqual(re.search(r'Bearer ([^"]+)', proposed)[1], TOKEN)

    def test_inspection_of_installed_form_is_idempotent(self):
        proposed, _ = caller.plan(fixture())
        repeated, receipt = caller.plan(proposed)
        self.assertEqual(repeated, proposed)
        self.assertTrue(receipt['alreadyGuarded'])

    def test_rejects_changed_schedules_endpoints_auth_and_shell(self):
        for old, new in [('*/10', '*/5'), ('127.0.0.1', 'external.example'),
                         ('POST', 'GET'), ('-m 300', '-m 301'),
                         ('Bearer ' + TOKEN, 'Basic ' + TOKEN),
                         (TOKEN, '$(owned_command)'),
                         ('curl -fsS', 'curl -k -fsS'),
                         ('2>&1', '2>&1; true'),
                         (caller.LOG, '/tmp/other.log')]:
            with self.subTest(new=new), self.assertRaises(ValueError):
                caller.plan(fixture().replace(old, new))

    def test_rejects_ambiguous_or_absent_blocks(self):
        for value in ['', fixture() + fixture(), fixture().replace(caller.END, ''),
                      fixture().replace(caller.BEGIN + '\n', caller.BEGIN + '\n# extra\n')]:
            with self.assertRaises(ValueError):
                caller.plan(value)

    @unittest.skipUnless(Path('/usr/bin/flock').is_file(), 'real util-linux flock requires Linux; exercised in CI')
    def test_actual_two_process_guard_preserves_inflight_log_and_later_ticks(self):
        with tempfile.TemporaryDirectory(prefix='owned-sync-caller-') as temp:
            root = Path(temp)
            log, lock, release, count = [root / n for n in ['body.log', 'lock', 'release', 'count']]
            curl = root / 'curl'
            curl.write_text('#!/usr/bin/env python3\n'
                'import os,pathlib,sys,time,json\n'
                'r=pathlib.Path(os.environ["OWNED_CALLER_ROOT"])\n'
                'assert sys.argv[1:3]==["-fsS","-m"] and sys.argv[3] in ["300","1440"] and sys.argv[4]=="-X"\n'
                'with (r/"count").open("a") as f:f.write("call\\n")\n'
                'print("owned-inflight",flush=True)\n'
                'deadline=time.monotonic()+5\n'
                'while not (r/"release").exists():\n'
                ' if time.monotonic()>deadline:sys.exit(28)\n'
                ' time.sleep(.01)\n'
                'print(json.dumps({"ok":True,"ownedOnly":True}))\n')
            curl.chmod(0o700)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'], OWNED_CALLER_ROOT=str(root))
            legacy = fixture(str(log)).splitlines()[3][len('*/10 * * * * '):]
            old = [subprocess.Popen(['/bin/sh', '-c', legacy], env=env) for _ in range(2)]
            try:
                deadline = time.monotonic() + 3
                while (not count.exists() or len(count.read_text().splitlines()) < 2) and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertEqual(count.read_text().splitlines(), ['call', 'call'])
            finally:
                release.touch()
                for proc in old:
                    self.assertEqual(proc.wait(timeout=6), 0)
            for file in [release, count, log]:
                file.unlink()
            proposed, _ = caller.plan(fixture(str(log)), lock=str(lock), log=str(log))
            command = proposed.splitlines()[3][len('*/10 * * * * '):]
            first = subprocess.Popen(['/bin/sh', '-c', command], env=env)
            try:
                deadline = time.monotonic() + 3
                while (not log.exists() or 'owned-inflight' not in log.read_text()) and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertEqual(count.read_text().splitlines(), ['call'])
                second = subprocess.run(['/bin/sh', '-c', command], env=env, timeout=2)
                self.assertEqual(second.returncode, 75)
                self.assertEqual(count.read_text().splitlines(), ['call'])
                self.assertEqual(log.read_text().strip(), 'owned-inflight')
                release.touch()
                self.assertEqual(first.wait(timeout=3), 0)
                self.assertIn('"ok": true', log.read_text())
                third = subprocess.run(['/bin/sh', '-c', command], env=env, timeout=3)
                self.assertEqual(third.returncode, 0)
                self.assertEqual(count.read_text().splitlines(), ['call', 'call'])
                print('owned-caller: legacy-concurrent=2 guarded-concurrent=1 later-tick=retained log=preserved no-network=true')
            finally:
                release.touch()
                first.wait(timeout=6)


if __name__ == '__main__':
    unittest.main()
