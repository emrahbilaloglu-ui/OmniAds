"""TEST ONLY. Loads the actual production-actor.py (argv[1]) in its non-root
fixture mode and drives its real op_db/payload_gate code with scripted child
protocol lines. No docker, network, database or production host is touched.
Prints one JSON object; exit 0 only when every expectation holds."""
import hashlib, importlib.util, json, os, shutil, sys, tempfile, time

sys.dont_write_bytecode = True  # never leave __pycache__ beside the reviewed actor
actor_path = sys.argv[1]
fx = tempfile.mkdtemp(prefix='nsb-actor-terminal-')
json.dump({'hostname': 'adsecute-prod-8gb-ash-1', 'bin': {'docker': '/usr/bin/false', 'curl': '/usr/bin/false', 'systemctl': '/usr/bin/false'}},
          open(os.path.join(fx, 'fixture.json'), 'w'))
os.environ['NSB_ACTOR_FIXTURE'] = fx
spec = importlib.util.spec_from_file_location('nsb_actor_under_test', actor_path)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
a.ACTOR_DEADLINE = time.monotonic() + 120
UUID = '11111111-1111-4111-8111-111111111111'
sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
checks, failures = {}, []


def expect(name, actual, wanted):
    checks[name] = actual
    if actual != wanted:
        failures.append({'check': name, 'actual': actual, 'wanted': wanted})


class FakeStdin:
    def __init__(self):
        self.writes = []

    def write(self, b):
        self.writes.append(b)

    def flush(self):
        pass

    def close(self):
        pass


class FakeChild:
    def __init__(self, code=0):
        self.stdin, self.code, self.done, self.killed = FakeStdin(), code, False, False

    def poll(self):
        return self.code if self.done else None

    def wait(self, timeout=None):
        self.done = True
        return self.code

    def kill(self):
        self.killed, self.done = True, True


def run_op(op, lines, code=0):
    """Real op_db with only the child process and its line reader substituted."""
    child, queue = FakeChild(code), list(lines)

    class ScriptedLines:
        def __init__(self, c, seconds):
            self.err, self.deadline = bytearray(), time.monotonic() + 30

        def next(self):
            if not queue:
                raise RuntimeError('CHILD_EOF_BEFORE_TERMINAL_RECEIPT')
            item = queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
    a.bundle_child = lambda p, command, request: child
    a.Lines = ScriptedLines
    a.prepared_gate = lambda line, p: {'action': 'COMMIT_EXACT_UNIT_ONCE', 'preparedSha256': 'p' * 64, 'challengeNonce': 'n' * 32,
                                       'proofSha256': 'z' * 64}
    a.host_gates = lambda p, roots=None: {'unchanged': True}
    request = {'op': op, 'config': {}, 'proofSha256': 'z' * 64} if op == 'retire' else {'op': op, 'jobRunIds': [UUID], 'component': 'main'}
    p = {'request': request, 'operatorRevision': 'a' * 40, 'runtimeRevision': 'b' * 40}
    r = {'childDispatched': False, 'commitChallengeSent': False, 'commitAcknowledged': False}
    try:
        a.op_db(p, r, {'unchanged': True})
        outcome = 'OK'
    except Exception as e:  # the actor raises RuntimeError codes
        outcome = str(e)
    return outcome, r, child


def terminal(r):
    return r.get('childTerminal', 'ABSENT')


def case(name, fn):
    try:
        fn()
    except Exception as e:  # a missing field on the code under test is a failed expectation, not a crash
        failures.append({'check': name, 'error': type(e).__name__ + ':' + str(e)[:120]})


# ---- D2: bounded child terminal shape survives a refusal; nothing is invented ----
def d2_statement_timeout():
    leak = 'canceling statement due to statement timeout: secret-row-value'
    outcome, r, child = run_op('vacuum', [{'type': 'error', 'code': 'STAGE_REFUSED', 'sqlState': '57014', 'message': leak}])
    expect('timeoutOutcome', outcome, 'ACTUAL_TERMINAL_RESULT_REQUIRED:STAGE_REFUSED')
    expect('timeoutTerminal', terminal(r), {'type': 'error', 'code': 'STAGE_REFUSED', 'sqlState': '57014'})
    expect('timeoutNoMessageLeak', leak in json.dumps(r) or 'secret-row-value' in json.dumps(r), False)
    expect('timeoutChildTerminated', [child.killed, r.get('transportChildTerminated')], [True, True])


def d2_unterminated():
    outcome, r, _ = run_op('space', [])
    expect('unterminatedOutcome', outcome, 'CHILD_EOF_BEFORE_TERMINAL_RECEIPT')
    expect('unterminatedTerminal', terminal(r), None)
    expect('unterminatedNo57014', '57014' in json.dumps(r), False)


def d2_unparseable():
    outcome, r, _ = run_op('space', [ValueError('Expecting value')])
    expect('unparseableTerminal', terminal(r), None)


def d2_unsafe_shapes():
    _, r, _ = run_op('space', [{'type': 'weird', 'code': 'bad code with spaces', 'sqlState': '57014; DROP'}])
    expect('unsafeTerminal', terminal(r), {'type': 'unknown', 'code': None, 'sqlState': None})
    _, r, _ = run_op('space', [{'type': 'error', 'code': 'RETAINED_PIN_VETO:job_dependencies', 'sqlState': '5701'}])
    expect('lowercaseCodeAndShortState', terminal(r), {'type': 'error', 'code': None, 'sqlState': None})
    _, r, _ = run_op('space', [{'type': 'error', 'code': 'X' * 161, 'sqlState': 57014}])
    expect('oversizeCodeNonStringState', terminal(r), {'type': 'error', 'code': None, 'sqlState': None})


def d2_success():
    outcome, r, _ = run_op('space', [{'type': 'result', 'value': {'relations': []}}])
    expect('successOutcome', outcome, 'OK')
    expect('successTerminal', terminal(r), {'type': 'result', 'code': None, 'sqlState': None})


def d2_retire_preparation_refused():
    outcome, r, child = run_op('retire', [{'type': 'error', 'code': 'STAGE_REFUSED', 'sqlState': '55P03'}])
    expect('retirePrepOutcome', outcome, 'ACTUAL_PREPARATION_NOT_COMPLETED_STATUS_ONLY')
    expect('retirePrepTerminal', terminal(r), {'type': 'error', 'code': 'STAGE_REFUSED', 'sqlState': '55P03'})
    expect('retirePrepNoChallenge', [r['commitChallengeSent'], len(child.stdin.writes)], [False, 0])


def d2_retire_commit_error():
    outcome, r, child = run_op('retire', [{'type': 'prepared'}, {'type': 'error', 'code': 'STAGE_REFUSED', 'sqlState': '40001'}])
    expect('retireCommitErrorOutcome', outcome, 'ACTUAL_TERMINAL_RESULT_REQUIRED:STAGE_REFUSED')
    expect('retireCommitErrorTerminal', terminal(r), {'type': 'error', 'code': 'STAGE_REFUSED', 'sqlState': '40001'})
    expect('retireCommitErrorChallengeOnce', [r['commitChallengeSent'], r['commitAcknowledged'], len(child.stdin.writes)], [True, False, 1])


def d2_retire_commit_lost():
    outcome, r, child = run_op('retire', [{'type': 'prepared'}])
    expect('retireLostOutcome', outcome, 'CHILD_EOF_BEFORE_TERMINAL_RECEIPT')
    expect('retireLostTerminal', terminal(r), None)
    expect('retireLostChallengeOnce', [r['commitChallengeSent'], r['commitAcknowledged'], len(child.stdin.writes)], [True, False, 1])


def d2_retire_committed():
    outcome, r, _ = run_op('retire', [{'type': 'prepared'}, {'type': 'result', 'value': {'committed': True}}])
    expect('retireCommittedOutcome', outcome, 'OK')
    expect('retireCommittedAck', [r['commitAcknowledged'], terminal(r)], [True, {'type': 'result', 'code': None, 'sqlState': None}])


# ---- D1: the actor dispatches a read-only TOAST observation, never a TOAST VACUUM ----
PRESTATE = {'roles': {role: {'containerId': 'c' * 64, 'imageId': 'sha256:' + 'd' * 64, 'repoDigest': 'sha256:' + 'e' * 64,
                             'startedAt': '2026-10-05T00:00:00Z', 'otherEnvSha256': 'f' * 64, 'mountsSha256': '0' * 64}
                      for role in ('web', 'worker')},
            'runtimeSourceHashes': {'/app/lib/db.ts': '1' * 64}, 'composeModelSha256': '2' * 64, 'archiveEnvSha256': '3' * 64,
            'globalConfigHashes': {'.env': '4' * 64, '.env.production': '5' * 64, 'docker-compose.override.yml': '6' * 64},
            'activeRoot': {'sha256': '7' * 64, 'name': 'routing-fixture'}}


def gate(stage, request):
    a.BOOTSTRAP_SHA256 = sha('bootstrap')
    p = {'contract': 'native-storage-production-stage.v2', 'humanAuthoritySha256': a.HUMAN, 'host': 'app', 'purpose': 'a1b2c3d4e5f6',
         'operatorRevision': 'a' * 40, 'runtimeRevision': 'b' * 40, 'sourceManifestSha256': 'c' * 64, 'actualSourceReviewSha256': 'd' * 64,
         'phase': 'execution', 'planSha256': 'e' * 64, 'op': 'db', 'stage': stage, 'sequence': 1, 'unitJobRunIds': [UUID],
         'prestate': PRESTATE, 'stageBundleSource': 'bundle', 'stageBundleSha256': sha('bundle'), 'bootstrapSource': 'bootstrap', 'request': request}
    try:
        a.payload_gate(p)
        return 'ACCEPTED'
    except Exception as e:
        return str(e)


def d1_actor():
    expect('observationTransition', sorted(a.TRANSITIONS.get(('toast-observation', 'db')) or []), ['toast-observation'])
    expect('observationReadOnly', list(a.DB_STAGE_OPS.get('toast-observation') or ()), [False, 30])
    expect('toastVacuumTransitionAbsent', ('vacuum-toast', 'db') in a.TRANSITIONS, False)
    expect('observationAccepted', gate('toast-observation', {'op': 'toast-observation'}), 'ACCEPTED')
    expect('toastVacuumRefused', gate('vacuum-toast', {'op': 'vacuum', 'component': 'toast', 'jobRunIds': [UUID]}), 'ALLOWLISTED_OPERATION')
    expect('mainStageToastComponentRefused', gate('vacuum-main', {'op': 'vacuum', 'component': 'toast', 'jobRunIds': [UUID]}), 'TYPED_STAGE_TRANSITION')
    expect('mainVacuumUnchanged', gate('vacuum-main', {'op': 'vacuum', 'component': 'main', 'jobRunIds': [UUID]}), 'ACCEPTED')
    expect('observationNotUnderVacuumStage', gate('vacuum-main', {'op': 'toast-observation'}), 'TYPED_STAGE_TRANSITION')


for name, fn in [('d2_statement_timeout', d2_statement_timeout), ('d2_unterminated', d2_unterminated), ('d2_unparseable', d2_unparseable),
                 ('d2_unsafe_shapes', d2_unsafe_shapes), ('d2_success', d2_success), ('d2_retire_preparation_refused', d2_retire_preparation_refused),
                 ('d2_retire_commit_error', d2_retire_commit_error), ('d2_retire_commit_lost', d2_retire_commit_lost),
                 ('d2_retire_committed', d2_retire_committed), ('d1_actor', d1_actor)]:
    case(name, fn)
shutil.rmtree(fx, ignore_errors=True)
print(json.dumps({'actor': os.path.basename(actor_path), 'actorSha256': hashlib.sha256(open(actor_path, 'rb').read()).hexdigest(),
                  'checks': len(checks), 'failures': failures}, default=str))
sys.exit(1 if failures else 0)
