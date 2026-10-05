"""Finite native storage batch: ONE source-bound operation on one fixed host.
Closed operation set; no free shell, SQL, path or command from the payload.
App host (root): status, db (stage bundle in the EXISTING worker), stage-cipher,
publish-root (disposable container of the EXACT web image, network none),
activate-root (web-only same-image recreate, worker never touched).
DB host (root): db-status, sample-capacity (the EXISTING oneshot sampler unit).
Every non-status op: durable intent before acting, write-once receipt, a
monotone remote sequence per purpose, status-only on anything ambiguous,
never a retry. Fixture mode exists only for a NON-root user with an explicit
fixture root; as root the fixture variable is refused."""
from pathlib import Path
from datetime import datetime, timezone
import base64, hashlib, json, os, re, selectors, signal, socket, stat, subprocess, sys, time

HUMAN = '79ee0d9d813bb78152a0c3c7df9b653cf7d3b7ad90ee0c6b607a0e54ad2c4358'
BOOTSTRAP_SHA256 = 'b6cf8571dd9bc510b375adb7b62cd6770de525ddb87a45cd3539d01956037984'
HOSTNAMES = {'app': 'adsecute-prod-8gb-ash-1', 'db': 'adsecute-db-1'}
ROLES = {'web': 'adsecute-web-1', 'worker': 'adsecute-worker-1'}
REPO = 'ghcr.io/emrahbilaloglu-ui/omniads-'
ROUTE_KEYS = ('ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED', 'ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT',
              'ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256')
ARCHIVE_MOUNT = '/run/adsecute-native-archive'
APPLY = ['compose', 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--timeout', '90', '--force-recreate', 'web']
SAMPLER_UNIT = 'adsecute-db-healthcheck.service'
APP_OPS = {'status': 30, 'db': 160, 'stage-cipher': 60, 'publish-root': 150, 'activate-root': 600}
DB_OPS = {'db-status': 20, 'sample-capacity': 90}
# stage-bundle op -> (mutating, child seconds)
DB_STAGE_OPS = {'evidence': (False, 30), 'select': (False, 30), 'freeze': (False, 120), 'pins': (False, 30), 'readback': (False, 60),
                'space': (False, 30), 'capture': (False, 150), 'retire': (True, 75), 'vacuum': (True, 75)}
STAGE_LABELS = {'plan', 'evidence', 'capture-restore', 'publish', 'activate', 'retire', 'independent-readback', 'vacuum-main',
                'vacuum-toast', 'space-readback', 'status'}
# The only (stage, op) transitions; for 'db' the closed stage-bundle ops. The
# selection/freeze prelude is its own phase; every other stage is execution.
TRANSITIONS = {('status', 'status'): None, ('status', 'db-status'): None, ('plan', 'db'): {'select', 'freeze'},
               ('evidence', 'db'): {'evidence', 'pins', 'readback'}, ('evidence', 'sample-capacity'): None,
               ('capture-restore', 'db'): {'capture'}, ('publish', 'stage-cipher'): None, ('publish', 'publish-root'): None,
               ('activate', 'activate-root'): None, ('retire', 'db'): {'retire'}, ('independent-readback', 'db'): {'readback'},
               ('vacuum-main', 'db'): {'vacuum'}, ('vacuum-toast', 'db'): {'vacuum'}, ('space-readback', 'db'): {'space'}}
UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
# Bound in the durable intent AND the receipt of every remote entry; status lists them.
IDENTITY = ('contract', 'purpose', 'stage', 'op', 'stageOp', 'sequence', 'phase', 'planSha256', 'selectionSha256', 'sourceManifestSha256',
            'actualSourceReviewSha256', 'operatorRevision', 'runtimeRevision', 'unitJobRunIds', 'subjectSha256s', 'requestSha256')
SOURCE_IDENTITY = ('sourceManifestSha256', 'actualSourceReviewSha256', 'operatorRevision', 'runtimeRevision')

FIXTURE = os.environ.get('NSB_ACTOR_FIXTURE')


def need(x, c):
    if not x:
        raise RuntimeError(c)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def utc():
    return datetime.now(timezone.utc).isoformat()


def canonical(x):
    return json.dumps(x, separators=(',', ':'), ensure_ascii=False, sort_keys=True).encode()


if FIXTURE:
    # Fixture-only bindings: a non-root user, an explicit absolute fixture root.
    need(os.geteuid() != 0 and FIXTURE.startswith('/') and '..' not in FIXTURE, 'FIXTURE_ONLY_FOR_NON_ROOT')
    FX = json.loads(Path(FIXTURE, 'fixture.json').read_text())
    BASE, OWNER, BIN, HOSTNAME = Path(FIXTURE), os.geteuid(), FX['bin'], FX['hostname']
else:
    BASE, OWNER, BIN, HOSTNAME = Path('/'), 0, {'docker': 'docker', 'curl': 'curl', 'systemctl': 'systemctl'}, None
APP = BASE / 'var/www/adsecute'
ARCHIVE = APP / 'native-archive'
STATE = APP / '.native-storage-batch'
DBSTATE = BASE / 'var/lib/adsecute-native-storage-batch'
ACTOR_DEADLINE = None


def remaining(limit):
    left = ACTOR_DEADLINE - time.monotonic()
    need(left > 1, 'ACTOR_TOTAL_BUDGET_EXHAUSTED')
    return min(limit, left)


def call(args, limit=20, cap=4194304, inp=None, env=None):
    q = subprocess.run(args, cwd=APP if APP.exists() else None, input=inp, capture_output=True, timeout=remaining(limit), env=env)
    need(q.returncode == 0 and len(q.stdout) <= cap, 'BOUNDED_COMMAND_REFUSED')
    return q.stdout


def docker(*args, limit=20, cap=4194304):
    return call([BIN['docker'], *args], limit, cap)


# ---------------- private files ----------------
def read_exact(path, limit, mode=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid == OWNER and st.st_nlink == 1 and 0 < st.st_size <= limit and
             not (st.st_mode & 0o022) and (mode is None or stat.S_IMODE(st.st_mode) == mode), 'BOUNDED_OWNED_FILE')
        data = os.read(fd, st.st_size + 1)
        need(len(data) == st.st_size, 'FILE_CHANGED_DURING_READ')
        return data
    finally:
        os.close(fd)


def read_config(path, limit=65536):
    """Global compose config files: bytes are hashed; ownership is not this actor's concern."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and 0 < st.st_size <= limit, 'BOUNDED_CONFIG_FILE')
        data = os.read(fd, st.st_size + 1)
        need(len(data) == st.st_size, 'FILE_CHANGED_DURING_READ')
        return data
    finally:
        os.close(fd)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_once(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(data)
        while view:
            n = os.write(fd, view)
            view = view[n:]
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_directory(path.parent)


def private_directory(path, create=False):
    if create and not os.path.lexists(path):
        path.mkdir(mode=0o700)
        sync_directory(path.parent)
    st = os.lstat(path)
    need(stat.S_ISDIR(st.st_mode) and st.st_uid == OWNER and not (st.st_mode & 0o077), 'PRIVATE_OWNED_DIRECTORY')
    return path


# ---------------- payload ----------------
def payload_gate(p):
    need(not sys.flags.optimize, 'ASSERTIONS_REQUIRED')
    need(FIXTURE or os.geteuid() == 0, 'ROOT_ACTOR_REQUIRED')
    need(p.get('contract') == 'native-storage-production-stage.v2' and p.get('humanAuthoritySha256') == HUMAN, 'EXACT_HUMAN_AUTHORITY')
    need(p.get('host') in ('app', 'db'), 'FIXED_HOST_ROLE')
    need((HOSTNAME or socket.gethostname()) == HOSTNAMES[p['host']], 'EXACT_HOST_IDENTITY')
    need(re.fullmatch('[a-f0-9]{12}', p.get('purpose', '')) and re.fullmatch('[a-f0-9]{40}', p.get('operatorRevision', '')) and
         re.fullmatch('[a-f0-9]{40}', p.get('runtimeRevision', '')), 'EXACT_PURPOSE_AND_REVISIONS')
    for k in ('sourceManifestSha256', 'actualSourceReviewSha256'):
        need(re.fullmatch('[a-f0-9]{64}', p.get(k, '')), 'EXACT_DIGEST:' + k)
    # Explicit phase: the prelude binds ONLY its declared immutable selection
    # digest; execution binds ONLY the final plan digest. Never one for the other.
    if p.get('phase') == 'execution':
        need(re.fullmatch('[a-f0-9]{64}', p.get('planSha256', '')) and 'selectionSha256' not in p, 'EXECUTION_BINDS_FINAL_PLAN_ONLY')
    else:
        need(p.get('phase') == 'selection-prelude' and re.fullmatch('[a-f0-9]{64}', p.get('selectionSha256', '')) and 'planSha256' not in p,
             'PRELUDE_BINDS_DECLARED_SELECTION_ONLY')
    ops = APP_OPS if p['host'] == 'app' else DB_OPS
    need(p.get('op') in ops and p.get('stage') in STAGE_LABELS, 'ALLOWLISTED_OPERATION')
    need(isinstance(p.get('sequence'), int) and (p['op'] in ('status', 'db-status') or 1 <= p['sequence'] <= 4096), 'FINITE_REMOTE_SEQUENCE')
    if p['host'] == 'app' and p['op'] != 'status':
        prestate_gate(p.get('prestate'))
    if p['op'] in ('db', 'publish-root'):
        bundle = p.get('stageBundleSource', '').encode()
        need(0 < len(bundle) <= 8388608 and sha(bundle) == p.get('stageBundleSha256'), 'EXACT_SOURCE_BOUND_STAGE_BUNDLE')
        need(len(p.get('bootstrapSource', '')) <= 4096 and sha(p.get('bootstrapSource', '').encode()) == BOOTSTRAP_SHA256, 'EXACT_PINNED_BOOTSTRAP')
    if p['op'] == 'db':
        r = p.get('request')
        need(isinstance(r, dict) and r.get('op') in DB_STAGE_OPS and 'heldKeyHex' not in r and len(canonical(r)) <= 4194304, 'TYPED_CLOSED_STAGE_REQUEST')
        if r['op'] == 'capture':
            need(re.fullmatch('[a-f0-9]{64}', p.get('heldKeySha256', '')) and re.fullmatch('[a-zA-Z0-9._-]{1,80}', p.get('heldKeyId', '')), 'EXACT_HELD_KEY_IDENTITY')
    if p['op'] == 'activate-root':
        need(isinstance(p.get('newRoot'), dict), 'EXACT_OWN_NEW_ROOT')
    if p['op'] == 'publish-root':
        need(isinstance(p.get('newLeaves'), list) and 1 <= len(p['newLeaves']) <= 8, 'FINITE_NEW_LEAVES')
    if p['op'] == 'stage-cipher':
        need(isinstance(p.get('object'), dict), 'EXACT_CIPHER_OBJECT')
    stage_op = (p.get('request') or {}).get('op') if p['op'] == 'db' else None
    allowed = TRANSITIONS.get((p['stage'], p['op']), 'none')
    need(allowed != 'none' and (allowed is None or stage_op in allowed), 'TYPED_STAGE_TRANSITION')
    need(p['stage'] not in ('vacuum-main', 'vacuum-toast') or p['request'].get('component') == p['stage'][7:], 'TYPED_STAGE_TRANSITION')
    need(p['op'] in ('status', 'db-status') or (p['phase'] == 'selection-prelude') == (p['stage'] == 'plan'), 'PRELUDE_SELECT_FREEZE_ONLY')
    if p['op'] not in ('status', 'db-status'):
        unit_ids(p)


def unit_ids(p):
    """Exact unit identity of one remote entry; for stage-bundle ops it must
    equal the IDs the closed request itself names."""
    ids = p.get('unitJobRunIds')
    need(isinstance(ids, list) and len(ids) <= 64 and len(set(ids)) == len(ids) and
         all(isinstance(x, str) and re.fullmatch(UUID, x) for x in ids), 'EXACT_UNIT_IDENTITY')
    if p['op'] == 'db':
        r, o = p['request'], p['request']['op']
        derived = ([((r.get('capture') or {}).get('generation') or {}).get('jobRunId')] if o in ('capture', 'freeze') else
                   [((r.get('config') or {}).get('generation') or {}).get('jobRunId')] if o in ('retire', 'readback', 'pins') else
                   r.get('jobRunIds') if o in ('evidence', 'vacuum') else [] if o == 'select' else None)
        need(derived is None or derived == ids, 'EXACT_UNIT_IDENTITY')
    elif p['op'] == 'sample-capacity':
        need(ids == [], 'EXACT_UNIT_IDENTITY')
    else:
        need(len(ids) >= 1, 'EXACT_UNIT_IDENTITY')
    return ids


def subject_shas(p):
    """The exact object one entry acts on (cipher object, new leaves, new root)."""
    if p['op'] == 'stage-cipher':
        return [p['object'].get('sha256')]
    if p['op'] == 'publish-root':
        return [x.get('sha256') for x in p['newLeaves']]
    if p['op'] == 'activate-root':
        return [p['newRoot'].get('sha256')]
    return []


def prestate_gate(s):
    need(isinstance(s, dict) and set(s.get('roles', {})) == {'web', 'worker'}, 'FROZEN_PRESTATE_REQUIRED')
    for role, v in s['roles'].items():
        need(re.fullmatch('[a-f0-9]{64}', v.get('containerId', '')) and re.fullmatch('sha256:[a-f0-9]{64}', v.get('imageId', '')) and
             re.fullmatch('sha256:[a-f0-9]{64}', v.get('repoDigest', '')) and isinstance(v.get('startedAt'), str) and
             re.fullmatch('[a-f0-9]{64}', v.get('otherEnvSha256', '')) and re.fullmatch('[a-f0-9]{64}', v.get('mountsSha256', '')), 'EXACT_ROLE_PRESTATE:' + role)
    files = s.get('runtimeSourceHashes')
    need(isinstance(files, dict) and 1 <= len(files) <= 128 and all(re.fullmatch('/app/(lib|app|scripts)/[A-Za-z0-9_./\\[\\]-]{1,200}', k) and
         '..' not in k and re.fullmatch('[a-f0-9]{64}', v) for k, v in files.items()), 'EXACT_RUNTIME_SOURCE_SET')
    for k in ('composeModelSha256', 'archiveEnvSha256'):
        need(re.fullmatch('[a-f0-9]{64}', s.get(k, '')), 'EXACT_PRESTATE_DIGEST:' + k)
    need(set(s.get('globalConfigHashes', {})) == {'.env', '.env.production', 'docker-compose.override.yml'}, 'EXACT_GLOBAL_CONFIG_SET')
    root = s.get('activeRoot', {})
    need(re.fullmatch('[a-f0-9]{64}', root.get('sha256', '')) and re.fullmatch('routing-[a-z0-9-]{1,80}', root.get('name', '')), 'EXACT_ACTIVE_ROOT')


# ---------------- host state ----------------
def other_env_sha(env):
    return sha(canonical({k: v for k, v in env.items() if k not in ROUTE_KEYS}))


def role_state():
    rows = json.loads(docker('inspect', '--type', 'container', ROLES['web'], ROLES['worker']))
    out = {}
    for c in rows:
        role = c['Config']['Labels'].get('com.docker.compose.service')
        need(role in ROLES and role not in out and c['Name'].lstrip('/') == ROLES[role], 'EXACT_TWO_ROLES')
        env = dict(x.split('=', 1) for x in c['Config']['Env'] if '=' in x)
        image = json.loads(docker('image', 'inspect', c['Image']))[0]
        digests = [d.split('@', 1)[1] for d in image.get('RepoDigests', []) if d.startswith(REPO + role + '@')]
        need(len(digests) == 1, 'EXACT_ONE_ROLE_REPO_DIGEST:' + role)
        mounts = [m for m in c.get('Mounts', []) if m.get('Destination') == ARCHIVE_MOUNT]
        out[role] = {'containerId': c['Id'], 'imageId': c['Image'], 'repoDigest': digests[0], 'startedAt': c['State']['StartedAt'],
                     'running': c['State']['Running'] is True, 'health': c['State'].get('Health', {}).get('Status'),
                     'buildId': env.get('APP_BUILD_ID'), 'labelRevision': c['Config']['Labels'].get('org.opencontainers.image.revision'),
                     'labelRole': c['Config']['Labels'].get('com.adsecute.release.role'),
                     'imageLabelRevision': image['Config']['Labels'].get('org.opencontainers.image.revision'),
                     'imageLabelRole': image['Config']['Labels'].get('com.adsecute.release.role'),
                     'otherEnvSha256': other_env_sha(env), 'mountsSha256': sha(canonical(c.get('Mounts', []))),
                     'route': [env.get(k) for k in ROUTE_KEYS] if role == 'web' else None,
                     'archiveMount': [{'source': m.get('Source'), 'rw': m.get('RW')} for m in mounts],
                     'archiveEnvKeys': sorted(k for k in env if k.startswith('ENGINE_V3_NATIVE_ARCHIVE_'))}
        env = {}
    need(set(out) == set(ROLES), 'TWO_CURRENT_ROLES')
    return out


def role_gate(p, state, web_baseline=None):
    """Per-role exact identity. Distinct web/worker images are legitimate; each
    role must match ITS frozen prestate. After this purpose's own activation
    only its own new web baseline is accepted; the worker never changes."""
    rev = p['runtimeRevision']
    for role, actual in state.items():
        need(actual['running'] and actual['health'] == 'healthy' and actual['buildId'] == rev and actual['labelRevision'] == rev and
             actual['imageLabelRevision'] == rev and actual['labelRole'] == role + '-runner' and actual['imageLabelRole'] == role + '-runner',
             'EXACT_RUNTIME_ROLE:' + role)
        expected = dict(p['prestate']['roles'][role])
        if role == 'web' and web_baseline is not None:
            expected.update(containerId=web_baseline['containerId'], startedAt=web_baseline['startedAt'])
        for k in ('containerId', 'imageId', 'repoDigest', 'startedAt', 'otherEnvSha256', 'mountsSha256'):
            need(actual[k] == expected[k], 'EXACT_ROLE_IDENTITY:%s:%s' % (role, k))
    web, worker = state['web'], state['worker']
    need(len(web['archiveMount']) == 1 and web['archiveMount'][0]['rw'] is False and web['archiveMount'][0]['source'] == str(ARCHIVE), 'WEB_ARCHIVE_RO_MOUNT')
    need(not worker['archiveMount'] and not worker['archiveEnvKeys'], 'WORKER_HAS_NO_ARCHIVE_AUTHORITY')


def archive_env():
    raw = read_exact(APP / '.env.native-archive', 16384, 0o600)
    lines = raw.decode().splitlines()
    need(raw.endswith(b'\n') and len(lines) == len({x.split('=', 1)[0] for x in lines}), 'EXACT_PRIVATE_ARCHIVE_ENV')
    return raw, dict(x.split('=', 1) for x in lines)


def model_normalized_sha(model):
    v = json.loads(json.dumps(model))
    env = v['services']['web'].get('environment', {}) or {}
    for k in ROUTE_KEYS:
        env.pop(k, None)
    return sha(canonical(v))


COMPOSE_PINS = ('APP_IMAGE_TAG', 'APP_BUILD_ID')


def compose_env(p):
    """Runtime-only child pins: every compose config/apply/recovery resolves the
    image tag and APP_BUILD_ID from the exact 40-hex runtime revision, never
    from a possibly stale global .env (a release may have exported them only
    inline). Nothing is written; global files stay byte-identical. No other
    variable is inherited from the caller."""
    rev = p['runtimeRevision']
    need(re.fullmatch('[a-f0-9]{40}', rev), 'EXACT_RUNTIME_PIN')
    env = {k: os.environ[k] for k in ('PATH', 'HOME') if k in os.environ}
    if FIXTURE:
        env['NSB_ACTOR_FIXTURE'] = FIXTURE
    env.update({k: rev for k in COMPOSE_PINS})
    return env


def compose_model(p):
    return json.loads(call([BIN['docker'], 'compose', 'config', '--format', 'json'], 20, 4194304, env=compose_env(p)))


def compose_resolution(p, model, expected):
    """Per role: the pinned model image ref must resolve (docker image inspect)
    to that role's exact running image id + repo digest, and image Config.Env
    overlaid with the model's resolved environment must predict the role's
    running non-route env exactly, with APP_BUILD_ID == runtime. Returns
    metadata only (refs, ids, booleans); no env value leaves this function."""
    rev, roles = p['runtimeRevision'], {}
    for role in ('web', 'worker'):
        svc = (model.get('services') or {}).get(role) or {}
        ref = svc.get('image') or ''
        x = {'ref': ref, 'pinnedRef': ref == REPO + role + ':' + rev, 'resolvedImageId': None, 'imageMatches': False, 'predictedEnvMatches': False}
        try:
            image = json.loads(docker('image', 'inspect', ref))[0]
            x['resolvedImageId'] = image.get('Id')
            digests = [d.split('@', 1)[1] for d in image.get('RepoDigests') or [] if d.startswith(REPO + role + '@')]
            x['imageMatches'] = image.get('Id') == expected[role]['imageId'] and expected[role]['repoDigest'] in digests
            environment = svc.get('environment') or {}
            predicted = dict(v.split('=', 1) for v in (image.get('Config') or {}).get('Env') or [] if '=' in v)
            predicted.update({k: str(v) for k, v in environment.items() if v is not None})
            x['predictedEnvMatches'] = (not svc.get('env_file') and environment.get('APP_BUILD_ID') == rev and
                                        other_env_sha(predicted) == expected[role]['otherEnvSha256'])
            predicted, environment = {}, {}
        except BaseException:
            pass
        x['matches'] = x['pinnedRef'] and x['imageMatches'] and x['predictedEnvMatches']
        roles[role] = x
    return {'pins': {k: rev for k in COMPOSE_PINS}, 'roles': roles}


def compose_gate(p, model, expected):
    res = compose_resolution(p, model, expected)
    for role in ('web', 'worker'):
        x = res['roles'][role]
        need(x['pinnedRef'] and x['imageMatches'], 'COMPOSE_MODEL_IS_NOT_RUNNING_RELEASE:%s:image' % role)
        need(x['predictedEnvMatches'], 'COMPOSE_MODEL_IS_NOT_RUNNING_RELEASE:%s:env' % role)
    return res


def config_gate(p, archive_sha):
    s = p['prestate']
    for name, digest in s['globalConfigHashes'].items():
        need(sha(read_config(APP / name)) == digest, 'UNCHANGED_GLOBAL_CONFIG:' + name)
    raw, env = archive_env()
    need(sha(raw) == archive_sha, 'EXACT_PRIVATE_ARCHIVE_ENV_STATE')
    model = compose_model(p)
    need(model_normalized_sha(model) == s['composeModelSha256'], 'EXACT_COMPOSE_MODEL')
    need(not any(k.startswith('ENGINE_V3_NATIVE_ARCHIVE_') for k in (model['services']['worker'].get('environment') or {})), 'WORKER_MODEL_NO_ARCHIVE')
    return raw, env, model


def healthz(p):
    h = json.loads(call([BIN['curl'], '-fsS', '--max-time', '8', 'http://127.0.0.1:3000/api/healthz'], 10, 65536))
    need(h.get('ok') is True and h.get('buildId') == p['runtimeRevision'], 'EXACT_HEALTHZ')
    return {'ok': True, 'buildId': h['buildId']}


def root_gate(p, state, env, root):
    """The web serves exactly `root` from the read-only archive mount."""
    runtime_dir, host_dir = ARCHIVE_MOUNT + '/' + root['name'], ARCHIVE / root['name']
    need(state['web']['route'] == ['true', runtime_dir, root['sha256']] and [env.get(k) for k in ROUTE_KEYS] == ['true', runtime_dir, root['sha256']],
         'EXACT_ACTIVE_ROUTING_ROOT')
    raw = read_exact(host_dir / 'root' / (root['sha256'] + '.json'), 32768, 0o440)
    need(sha(raw) == root['sha256'], 'EXACT_ACTIVE_ROOT_BYTES')
    return json.loads(raw)


def source_gate(p):
    files = p['prestate']['runtimeSourceHashes']
    script = ("const fs=require('fs'),c=require('crypto');const v=" + json.dumps(files, separators=(',', ':')) +
              ";let n=0;for(const[f,w]of Object.entries(v)){if(c.createHash('sha256').update(fs.readFileSync(f)).digest('hex')!==w)process.exit(3);n++;}"
              "process.stdout.write(JSON.stringify({verified:n}));")
    out = docker('exec', ROLES['worker'], 'node', '-e', script, limit=30, cap=4096)
    need(json.loads(out).get('verified') == len(files), 'EXACT_RUNTIME_SOURCE_BYTES')
    return {'verifiedRuntimeSources': len(files)}


def app_volume():
    v = os.statvfs(APP)
    return {'observedAt': utc(), 'availableBytes': v.f_bavail * v.f_frsize}


def host_gates(p, roots=None):
    """Exact roles/images/health/config/root/source; returns comparable state."""
    s = p['prestate']
    state = role_state()
    role_gate(p, state, s.get('webBaselineAfterOwnActivation'))
    raw, env, model = config_gate(p, s['archiveEnvSha256'])
    # Before ANY intent: the pinned compose model is provably the running release.
    compose = compose_gate(p, model, s['roles'])
    model = {}
    root_gate(p, state, env, s['activeRoot'])
    env = {}
    return {'roles': state, 'healthz': healthz(p), 'source': source_gate(p), 'archiveEnvSha256': sha(raw), 'activeRoot': s['activeRoot'],
            'compose': compose}


# ---------------- purpose state + monotone sequence ----------------
# '__' separates stage and op unambiguously (both may contain '-').
NAME = re.compile(r'^(\d{4})-([a-z-]+)__([a-z-]+)\.(intent|receipt)\.json$')


def listing(directory):
    entries = {}
    if not directory.exists():
        return []
    private_directory(directory)
    for name in sorted(os.listdir(directory)):
        m = NAME.match(name)
        need(m, 'FOREIGN_FILE_IN_PURPOSE_STATE')
        seq = int(m.group(1))
        e = entries.setdefault(seq, {'sequence': seq, 'stage': m.group(2), 'op': m.group(3), 'intent': False, 'receipt': None})
        need(e['stage'] == m.group(2) and e['op'] == m.group(3), 'SEQUENCE_REUSED_FOR_OTHER_STAGE')
        r = json.loads(read_exact(directory / name, 1048576, 0o600))
        ident = {k: r.get(k) for k in IDENTITY}
        need(ident['purpose'] == directory.name and ident['sequence'] == seq and ident['stage'] == e['stage'] and ident['op'] == e['op'],
             'REMOTE_ENTRY_IDENTITY_MISMATCH')
        need(e.get('identity') in (None, ident), 'REMOTE_INTENT_RECEIPT_IDENTITY_MISMATCH')
        e['identity'] = ident
        if m.group(4) == 'intent':
            e['intent'] = True
        else:
            e['receipt'] = {'actualExitCode': r.get('actualExitCode'), 'statusReadOnlyRequired': r.get('statusReadOnlyRequired') is True,
                            'resultSha256': r.get('resultSha256'), 'finishedAt': r.get('finishedAt'), 'commitAcknowledged': r.get('commitAcknowledged') is True}
    out = [entries[k] for k in sorted(entries)]
    need([e['sequence'] for e in out] == list(range(1, len(out) + 1)) and all(e['intent'] for e in out), 'CONTIGUOUS_REMOTE_SEQUENCE')
    return out


def once_key(e):
    """Consuming transitions acknowledged at most once per purpose (per unit /
    object where it applies); evidence and the prelude are read-only."""
    i = e['identity']
    if i['stage'] in ('capture-restore', 'retire', 'independent-readback'):
        return (i['stage'], i['stageOp'], tuple(i['unitJobRunIds'] or ()))
    if i['op'] == 'stage-cipher':
        return (i['stage'], i['op'], tuple(i['subjectSha256s'] or ()))
    if i['stage'] in ('publish', 'activate', 'vacuum-main', 'vacuum-toast', 'space-readback'):
        return (i['stage'], i['op'])
    return None


def begin(p, root_dir, record):
    """Durable intent; the remote sequence must be exactly last+1 and the last
    stage must have an unambiguous receipt. A consumed marker is never reissued."""
    private_directory(root_dir, True)
    directory = private_directory(root_dir / p['purpose'], True)
    seq = listing(directory)
    need(p['sequence'] == len(seq) + 1, 'NON_MONOTONE_REMOTE_SEQUENCE')
    need(not seq or (seq[-1]['receipt'] is not None and not seq[-1]['receipt']['statusReadOnlyRequired']), 'UNACKNOWLEDGED_OR_AMBIGUOUS_REMOTE_STAGE_STATUS_ONLY')
    mine = {'identity': {k: record.get(k) for k in IDENTITY}}
    for e in seq:
        i = e['identity']
        need(all(i[k] == record[k] for k in SOURCE_IDENTITY), 'FOREIGN_SOURCE_OR_REVISION_FOR_PURPOSE')
        if record['phase'] == 'selection-prelude':
            need(i['phase'] == 'selection-prelude', 'PRELUDE_AFTER_EXECUTION')
            need(i['selectionSha256'] == record['selectionSha256'], 'FOREIGN_SELECTION_FOR_PURPOSE')
        elif i['phase'] == 'execution':
            need(i['planSha256'] == record['planSha256'], 'FOREIGN_PLAN_FOR_PURPOSE')
    key = once_key(mine)
    need(key is None or not any(once_key(e) == key and e['receipt'] is not None and e['receipt']['actualExitCode'] == 0 for e in seq),
         'STAGE_ALREADY_ACKNOWLEDGED_REMOTE')
    stem = '%04d-%s__%s' % (p['sequence'], p['stage'], p['op'])
    intent, receipt = directory / (stem + '.intent.json'), directory / (stem + '.receipt.json')
    need(not os.path.lexists(intent) and not os.path.lexists(receipt), 'EXISTING_STAGE_STATUS_ONLY')
    write_once(intent, (json.dumps(record) + '\n').encode())
    return receipt


# ---------------- bounded child ----------------
class Lines:
    def __init__(self, child, seconds):
        self.child, self.deadline, self.buf, self.err = child, time.monotonic() + remaining(seconds), bytearray(), bytearray()
        self.sel = selectors.DefaultSelector()
        self.sel.register(child.stdout, selectors.EVENT_READ, 'out')
        self.sel.register(child.stderr, selectors.EVENT_READ, 'err')

    def next(self):
        while True:
            if b'\n' in self.buf:
                line, rest = self.buf.split(b'\n', 1)
                self.buf = bytearray(rest)
                need(len(line) <= 16777216, 'BOUND_CHILD_PROTOCOL_LINE')
                return json.loads(line)
            left = self.deadline - time.monotonic()
            need(left > 0, 'FINITE_CHILD_WINDOW')
            for key, _ in self.sel.select(min(left, 1)):
                b = os.read(key.fileobj.fileno(), 262144)
                if not b:
                    self.sel.unregister(key.fileobj)
                    continue
                if key.data == 'out':
                    self.buf.extend(b)
                    need(len(self.buf) <= 16777216, 'BOUND_CHILD_OUTPUT')
                else:
                    self.err.extend(b)
                    need(len(self.err) <= 262144, 'BOUND_CHILD_STDERR')
            if not self.sel.get_map():
                raise RuntimeError('CHILD_EOF_BEFORE_TERMINAL_RECEIPT')


def bundle_child(p, command, request):
    """`command` ends with the program that receives `-e <bootstrap> sha len`:
    `... exec -i <worker> node` or `... run --entrypoint node <image>`."""
    bundle = p['stageBundleSource'].encode()
    child = subprocess.Popen([*command, '-e', p['bootstrapSource'], p['stageBundleSha256'], str(len(bundle))],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=APP)
    child.stdin.write(bundle + json.dumps(request, separators=(',', ':')).encode() + b'\n')
    child.stdin.flush()
    return child


def held_key(p):
    """Existing held key from the root-only private archive env; digest/id
    bound; returned only for the child's stdin, never logged or stored."""
    raw, env = archive_env()
    secret = env.get('ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX', '')
    need(re.fullmatch('[a-f0-9]{64}', secret) and sha(bytes.fromhex(secret)) == p['heldKeySha256'] and
         env.get('ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID') == p['heldKeyId'], 'EXACT_HELD_EXISTING_KEY')
    return secret


def prepared_gate(line, p):
    a, cfg = line.get('prepared') or {}, p['request']['config']
    need(line.get('type') == 'prepared' and re.fullmatch('[a-f0-9]{64}', line.get('preparedSha256', '')) and
         re.fullmatch('[a-f0-9]{32}', line.get('challengeNonce', '')), 'ACTUAL_PREPARED_CHALLENGE')
    need(a.get('preparedUncommitted') is True and a.get('committed') is False, 'ACTUAL_UNCOMMITTED_PREPARATION')
    need(a.get('deletedEvaluationIdsSha256') == sha(json.dumps(cfg['evaluationIds'], separators=(',', ':')).encode()) and
         a.get('deletedContextIdsSha256') == sha(json.dumps(cfg['contextIds'], separators=(',', ':')).encode()), 'EXACT_FROZEN_IDS')
    for table, value in a.get('retainedRoots', {}).items():
        need(value == cfg['tableHashes'][table], 'RETAINED_ROOTS_FULL_BYTES')
    need(a.get('pins', {}).get('measuredKnownPinsZero') is True and a.get('providerAuthority') is False and a.get('physicalReclaimedBytes') == 0,
         'MEASURED_PINS_ZERO_NO_AUTHORITY')
    return {'action': 'COMMIT_EXACT_UNIT_ONCE', 'preparedSha256': line['preparedSha256'], 'challengeNonce': line['challengeNonce'],
            'proofSha256': p['request']['proofSha256']}


# ---------------- operations ----------------
def op_db(p, r, before):
    request = dict(p['request'], targetRevision=p['operatorRevision'], runtimeRevision=p['runtimeRevision'])
    mutating, seconds = DB_STAGE_OPS[request['op']]
    if request['op'] == 'capture':
        meminfo = Path('/proc/meminfo')
        if meminfo.exists():
            mem = dict(line.split(':', 1) for line in meminfo.read_text().splitlines())
            need(int(mem['MemAvailable'].strip().split()[0]) * 1024 >= 2 * 1024 ** 3, 'MINIMUM_EXISTING_MEMORY_2GIB')
        request['heldKeyHex'] = held_key(p)
        request['heldKeySha256'], request['keyId'] = p['heldKeySha256'], p['heldKeyId']
    r['childDispatched'] = True
    child = bundle_child(p, [BIN['docker'], 'exec', '-i', '-e', 'NSB_HOST_MODE=production', ROLES['worker'], 'node'], request)
    request = {}
    lines = Lines(child, seconds)
    try:
        line = lines.next()
        if p['request']['op'] == 'retire':
            need(line.get('type') == 'prepared', 'ACTUAL_PREPARATION_NOT_COMPLETED_STATUS_ONLY')
            challenge = prepared_gate(line, p)
            need(host_gates(p) == before, 'HOST_ROLE_ROOT_CONFIG_OR_SOURCE_DRIFT_BEFORE_COMMIT')
            r['commitChallengeSent'] = True
            child.stdin.write(json.dumps(challenge).encode() + b'\n')
            child.stdin.flush()
            line = lines.next()
            r['commitAcknowledged'] = line.get('type') == 'result' and line.get('value', {}).get('committed') is True
        need(line.get('type') == 'result', 'ACTUAL_TERMINAL_RESULT_REQUIRED:' + str(line.get('code', ''))[:120])
        child.stdin.close()
        need(child.wait(timeout=max(1, lines.deadline - time.monotonic())) == 0, 'ACTUAL_CHILD_EXIT_ZERO')
        return line['value'], mutating
    finally:
        r['childStderrSha256'] = sha(bytes(lines.err))
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
            r['transportChildTerminated'] = True


def op_stage_cipher(p, r):
    item = p['object']
    need(re.fullmatch('[a-f0-9]{64}', item.get('sha256', '')) and isinstance(item.get('bytes'), int) and 0 < item['bytes'] <= 2097280, 'EXACT_CIPHER_OBJECT')
    binary = base64.b64decode(p['cipherBase64'], validate=True)
    need(len(binary) == item['bytes'] and sha(binary) == item['sha256'], 'ONLY_EXACT_ENCRYPTED_INPUT')
    directory = ARCHIVE / 'native' / 'v2'
    for d in (ARCHIVE, ARCHIVE / 'native', directory):
        st = os.lstat(d)
        need(stat.S_ISDIR(st.st_mode) and st.st_uid == OWNER and not (st.st_mode & 0o022), 'EXISTING_ARCHIVE_DIRECTORY')
    fs = os.statvfs(ARCHIVE)
    need(fs.f_bavail * fs.f_frsize >= 2 * 1024 ** 3 + 512 * 1024 ** 2 + item['bytes'], 'APP_VOLUME_FLOOR_AND_OBJECT_RESERVE')
    path = directory / (item['sha256'] + '.bin')
    existed = os.path.lexists(path)
    r['existingExactVerified'] = existed
    if not existed:
        r['writeAttempted'] = True
        write_once(path, binary, 0o400)
    actual = read_exact(path, item['bytes'], 0o400)
    need(len(actual) == item['bytes'] and sha(actual) == item['sha256'], 'ACTUAL_IMMUTABLE_ENCRYPTED_READBACK')
    return {'object': {'sha256': item['sha256'], 'bytes': item['bytes'], 'key': 'native/v2/' + item['sha256'] + '.bin'}, 'written': not existed}, True


def read_root_graph(name, sha256):
    d = ARCHIVE / name
    root = json.loads(read_exact(d / 'root' / (sha256 + '.json'), 32768, 0o440))
    legacy = read_exact(d / 'legacy' / (root['legacy']['sha256'] + '.json'), 16384, 0o440)
    need(sha(legacy) == root['legacy']['sha256'], 'EXACT_LEGACY_BYTES')
    records, leaves = [], {}
    for s in root['shards']:
        shard = read_exact(d / 'shard' / (s['sha256'] + '.json'), 32768, 0o440)
        need(sha(shard) == s['sha256'], 'EXACT_SHARD_BYTES')
        for rec in json.loads(shard)['records']:
            leaf = read_exact(d / 'leaf' / (rec['leaf']['sha256'] + '.json'), 944 * 1024, 0o440)
            need(sha(leaf) == rec['leaf']['sha256'], 'EXACT_LEAF_BYTES')
            records.append(rec)
            leaves[rec['leaf']['sha256']] = leaf
    return root, legacy, records, leaves


def op_publish_root(p, r, before):
    """ONE complete immutable root: legacy + every prior leaf (host bytes) + the
    new leaves; superset verified; every referenced cipher object present."""
    old = p['prestate']['activeRoot']
    root, legacy, records, prior = read_root_graph(old['name'], old['sha256'])
    new_leaves = []
    for x in p['newLeaves']:
        b = base64.b64decode(x['base64'], validate=True)
        need(0 < len(b) <= 944 * 1024 and sha(b) == x['sha256'] and x['sha256'] not in prior, 'EXACT_NEW_LEAF')
        for e in json.loads(b)['entries']:
            obj = read_exact(ARCHIVE / e['object']['key'], e['ciphertextBytes'], 0o400)
            need(e['object']['key'] == 'native/v2/' + e['ciphertextSha256'] + '.bin' and sha(obj) == e['ciphertextSha256'], 'EVERY_NEW_CIPHER_OBJECT_STAGED')
        new_leaves.append({'base64': x['base64'], 'sha256': x['sha256']})
    name = 'routing-nsb-' + p['purpose']
    target = ARCHIVE / name
    need(not os.path.lexists(target), 'ONLY_NEW_ROUTING_DIRECTORY')
    target.mkdir(mode=0o700)
    sync_directory(ARCHIVE)
    request = {'op': 'publish-routing', 'targetRevision': p['operatorRevision'], 'runtimeRevision': p['runtimeRevision'],
               'legacy': {'base64': base64.b64encode(legacy).decode(), 'sha256': root['legacy']['sha256']},
               'priorLeaves': [{'base64': base64.b64encode(v).decode(), 'sha256': k} for k, v in prior.items()], 'newLeaves': new_leaves}
    container = 'nsb-publish-' + p['purpose'] + '-' + str(p['sequence'])
    r['publisherDispatched'] = True
    child = bundle_child(p, [BIN['docker'], 'run', '--name', container, '--interactive', '--network', 'none', '--read-only', '--user', '0:0',
                             '--memory', '256m', '--cpus', '1', '--pids-limit', '128', '-e', 'NSB_HOST_MODE=production',
                             '-e', 'APP_BUILD_ID=' + p['runtimeRevision'], '--mount', 'type=bind,src=' + str(target) + ',dst=/routing',
                             '--entrypoint', 'node', before['roles']['web']['imageId']], request)
    lines = Lines(child, 90)
    try:
        line = lines.next()
        need(line.get('type') == 'result', 'ACTUAL_PUBLISHER_RESULT:' + str(line.get('code', ''))[:120])
        child.stdin.close()
        need(child.wait(timeout=max(1, lines.deadline - time.monotonic())) == 0, 'PUBLISHER_EXIT_ZERO')
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        q = subprocess.run([BIN['docker'], 'rm', '--force', container], capture_output=True, timeout=15)
        r['publisherCleanupExitCode'] = q.returncode
    result = line['value']
    new_sha = result['root']['sha256']
    for f in result['files']:
        b = read_exact(target / f['kind'] / (f['sha256'] + '.json'), f['bytes'], 0o440)
        need(len(b) == f['bytes'] and sha(b) == f['sha256'], 'EXACT_PUBLISHED_METADATA_FILE')
    new_root, new_legacy, new_records, _ = read_root_graph(name, new_sha)
    need(new_root['legacy'] == root['legacy'] and new_legacy == legacy, 'LEGACY_RETAINED_EXACTLY')
    need(all(rec in new_records for rec in records) and len(new_records) == len(records) + len(new_leaves), 'COMPLETE_ROOT_SUPERSET')
    return {'newRoot': {'sha256': new_sha, 'bytes': result['root']['bytes'], 'name': name}, 'files': result['files'],
            'retainedPriorRecords': len(records), 'newRecords': len(new_leaves)}, True


def apply_once(p):
    try:
        q = subprocess.run([BIN['docker'], *APPLY], cwd=APP, capture_output=True, timeout=remaining(150), env=compose_env(p))
        # A signal-terminated command is an unknown outcome, never a failure we may recover from.
        return {'actualCommandExitCode': q.returncode, 'ambiguous': q.returncode < 0, 'stdoutSha256': sha(q.stdout), 'stderrSha256': sha(q.stderr)}
    except subprocess.TimeoutExpired:
        return {'actualCommandExitCode': None, 'ambiguous': True}


NO_RECOVERY_REFUSALS = ('SAME_EXACT_WEB_IMAGE_ENV_MOUNTS', 'WORKER_NEVER_RECREATED')


def await_web(p, route_root, worker):
    until = time.monotonic() + remaining(120)
    last = None
    while time.monotonic() < until:
        try:
            state = role_state()
            need(state['worker'] == worker, 'WORKER_NEVER_RECREATED')
            web = state['web']
            if web['health'] == 'healthy':
                expected = p['prestate']['roles']['web']
                need(all(web[k] == expected[k] for k in ('imageId', 'repoDigest', 'otherEnvSha256', 'mountsSha256')), 'SAME_EXACT_WEB_IMAGE_ENV_MOUNTS')
                need(web['route'] == ['true', ARCHIVE_MOUNT + '/' + route_root['name'], route_root['sha256']], 'WEB_SERVES_EXACT_ROOT')
                return web, healthz(p)
        except RuntimeError as e:
            last = str(e)
            if last in ('WORKER_NEVER_RECREATED', 'SAME_EXACT_WEB_IMAGE_ENV_MOUNTS'):
                raise
        time.sleep(2)
    raise RuntimeError('WEB_HEALTH_WINDOW_EXPIRED:' + str(last)[:80])


def op_activate_root(p, r, before):
    new = p['newRoot']
    need(re.fullmatch('[a-f0-9]{64}', new.get('sha256', '')) and new.get('name') == 'routing-nsb-' + p['purpose'], 'EXACT_OWN_NEW_ROOT')
    raw = read_exact(ARCHIVE / new['name'] / 'root' / (new['sha256'] + '.json'), 32768, 0o440)
    need(sha(raw) == new['sha256'], 'EXACT_NEW_ROOT_BYTES')
    original, env = archive_env()
    need(sha(original) == p['prestate']['archiveEnvSha256'] and env.get(ROUTE_KEYS[0]) == 'true', 'EXACT_ORIGINAL_ROUTED_ENV')
    old_root = p['prestate']['activeRoot']
    values = {ROUTE_KEYS[1]: ARCHIVE_MOUNT + '/' + new['name'], ROUTE_KEYS[2]: new['sha256']}
    planned = ('\n'.join(k + '=' + values.get(k, v) for k, v in (x.split('=', 1) for x in original.decode().splitlines())) + '\n').encode()
    need(planned != original and len(planned.splitlines()) == len(original.splitlines()), 'ONLY_TWO_ROUTE_FIELDS')
    env = {}
    stem = APP / ('.nsb-route-' + p['purpose'])
    backup, pending = Path(str(stem) + '.original-env'), Path(str(stem) + '.pending-env')
    need(not any(os.path.lexists(x) for x in (backup, pending)), 'EXISTING_ACTIVATION_STATUS_ONLY')
    write_once(backup, original, 0o600)
    write_once(pending, planned, 0o600)
    need(read_exact(APP / '.env.native-archive', 16384, 0o600) == original, 'FOREIGN_ENV_NO_OVERWRITE')
    r['archiveEnvWriteAttempted'] = True
    os.replace(pending, APP / '.env.native-archive')
    sync_directory(APP)
    expected = p['prestate']['roles']

    def restore_original(tag):
        need(read_exact(APP / '.env.native-archive', 16384, 0o600) == planned, 'FOREIGN_ENV_NO_RESTORE')
        back = Path(str(stem) + tag)
        write_once(back, original, 0o600)
        os.replace(back, APP / '.env.native-archive')
        sync_directory(APP)

    # The SAME pinned gate again immediately before apply; a failure here puts the
    # exact original env back and refuses without any recreate.
    try:
        model = compose_model(p)
        need(model_normalized_sha(model) == p['prestate']['composeModelSha256'], 'ONLY_TWO_WEB_ROOT_FIELDS_COMPOSE_DELTA')
        compose_gate(p, model, expected)
        model = {}
    except BaseException:
        restore_original('.unapplied-env')
        r['envRestoredWithoutApply'] = True
        raise
    r['applyAttempted'] = True
    r['actualApply'] = apply_once(p)
    if r['actualApply']['ambiguous']:
        r['applyAmbiguous'] = True
        raise RuntimeError('AMBIGUOUS_APPLY_STATUS_ONLY_NO_RETRY')
    try:
        need(r['actualApply']['actualCommandExitCode'] == 0, 'ACKNOWLEDGED_APPLY_FAILED')
        web, health = await_web(p, new, before['roles']['worker'])
        need(web['containerId'] != before['roles']['web']['containerId'] and web['startedAt'] != before['roles']['web']['startedAt'], 'ACTUAL_NEW_WEB_START')
        return {'newWebBaseline': {'containerId': web['containerId'], 'startedAt': web['startedAt'], 'imageId': web['imageId']},
                'healthz': health, 'newArchiveEnvSha256': sha(planned), 'activeRoot': new, 'previousRoot': old_root,
                'workerUnchanged': True, 'newWebOwnObservationRequired': True, 'compose': before['compose']}, True
    except BaseException as failure:
        # Foreign image/env/mounts or a touched worker: a recovery recreate would
        # come from the same resolution, so nothing more is applied (status-only).
        if isinstance(failure, RuntimeError) and str(failure) in NO_RECOVERY_REFUSALS:
            r['recoveryRefused'] = 'IDENTITY_DRIFT_NO_RECOVERY_STATUS_ONLY'
            raise
        # Acknowledged own failure only: one bounded recovery to the prior root,
        # behind the same pinned gate; never on an ambiguous apply.
        try:
            # Gate first: a drifted model refuses before the env file is touched.
            compose_gate(p, compose_model(p), expected)
            restore_original('.recovery-env')
            model = compose_model(p)
            need(model_normalized_sha(model) == p['prestate']['composeModelSha256'], 'RECOVERY_COMPOSE_MODEL_DRIFT')
            compose_gate(p, model, expected)
            model = {}
            r['recoveryApply'] = apply_once(p)
            need(not r['recoveryApply']['ambiguous'] and r['recoveryApply']['actualCommandExitCode'] == 0, 'RECOVERY_APPLY_STATUS_ONLY')
            web, _ = await_web(p, old_root, before['roles']['worker'])
            r['recoveredPriorRoot'] = True
            r['recoveredWebBaseline'] = {'containerId': web['containerId'], 'startedAt': web['startedAt']}
        except BaseException as e:
            r['recoveryRefused'] = str(e)[:120] if isinstance(e, RuntimeError) else 'RECOVERY_STATUS_ONLY'
        raise


def op_sample_capacity(p, r):
    """The EXISTING oneshot DB-host sampler; its row carries the DB's own
    clock_timestamp(). No SQL from this actor, no cached value."""
    r['samplerDispatched'] = True
    call([BIN['systemctl'], 'start', SAMPLER_UNIT], 75, 65536)
    shown = call([BIN['systemctl'], 'show', SAMPLER_UNIT, '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'ExecMainExitTimestamp'], 10, 65536)
    props = dict(x.split('=', 1) for x in shown.decode().splitlines() if '=' in x)
    need(props.get('Result') == 'success' and props.get('ExecMainStatus') == '0', 'EXISTING_SAMPLER_SUCCESS')
    return {'unit': SAMPLER_UNIT, 'result': 'success', 'exitTimestamp': props.get('ExecMainExitTimestamp'), 'triggeredAt': utc()}, False


def status(p):
    """Read-only. No env value other than the three routing fields; no secret."""
    out = {'contract': 'native-storage-production-status.v1', 'observedAt': utc(), 'host': p['host'], 'actualExitCode': 0}
    if p['host'] == 'db':
        out['sequence'] = listing(DBSTATE / p['purpose'])
        return out
    state = role_state()
    raw, env = archive_env()
    route = [env.get(k) for k in ROUTE_KEYS]
    env = {}
    model = compose_model(p)
    # Metadata only: refs, resolved ids, booleans; never a global env value.
    global_pins = dict(x.split('=', 1) for x in read_config(APP / '.env').decode().splitlines() if '=' in x and x.split('=', 1)[0] in COMPOSE_PINS)
    compose = compose_resolution(p, model, {role: state[role] for role in ('web', 'worker')})
    compose['globalEnvPinKeysEqualRuntime'] = {k: global_pins.get(k) == p['runtimeRevision'] for k in COMPOSE_PINS}
    global_pins = {}
    routed = []
    m = re.fullmatch(re.escape(ARCHIVE_MOUNT) + '/(routing-[a-z0-9-]{1,80})', route[1] or '')
    if route[0] == 'true' and m and re.fullmatch('[a-f0-9]{64}', route[2] or ''):
        root, _, records, _ = read_root_graph(m.group(1), route[2])
        routed = sorted(set(root['legacy']['jobRunIds']) | {r['generation']['jobRunId'] for r in records})
    out.update(roles=state, archiveEnvSha256=sha(raw), route=route, routedJobs=routed, composeModelSha256=model_normalized_sha(model), compose=compose,
               globalConfigHashes={n: sha(read_config(APP / n)) for n in ('.env', '.env.production', 'docker-compose.override.yml')},
               healthz=healthz(p), appVolume=app_volume(), sequence=listing(STATE / p['purpose']))
    checks = []
    for root in p.get('verifyRoots', [])[:16]:
        try:
            b = read_exact(ARCHIVE / root['name'] / 'root' / (root['sha256'] + '.json'), 32768, 0o440)
            checks.append({'name': root['name'], 'sha256': root['sha256'], 'present': sha(b) == root['sha256']})
        except BaseException:
            checks.append({'name': root['name'], 'sha256': root['sha256'], 'present': False})
    for obj in p.get('verifyObjects', [])[:512]:
        try:
            b = read_exact(ARCHIVE / 'native' / 'v2' / (obj['sha256'] + '.bin'), obj['bytes'], 0o400)
            checks.append({'object': obj['sha256'], 'present': sha(b) == obj['sha256'] and len(b) == obj['bytes']})
        except BaseException:
            checks.append({'object': obj['sha256'], 'present': False})
    out['checks'] = checks
    return out


def run(p, request_sha256):
    global ACTOR_DEADLINE
    payload_gate(p)
    ACTOR_DEADLINE = time.monotonic() + (APP_OPS if p['host'] == 'app' else DB_OPS)[p['op']]
    if p['op'] in ('status', 'db-status'):
        return status(p)
    before = host_gates(p) if p['host'] == 'app' else {'host': 'db'}
    root_dir = STATE if p['host'] == 'app' else DBSTATE
    # Identity (IDENTITY keys) is written into the durable intent and the receipt:
    # phase + final plan OR declared selection digest, source, review, revisions,
    # exact units, exact object, and the digest of the exact received request bytes.
    r = {'contract': 'native-storage-production-stage-receipt.v3', 'purpose': p['purpose'], 'stage': p['stage'], 'op': p['op'],
         'stageOp': (p.get('request') or {}).get('op'), 'sequence': p['sequence'], 'startedAt': utc(), 'actualExitCode': None,
         'phase': p['phase'], 'planSha256': p.get('planSha256'), 'selectionSha256': p.get('selectionSha256'),
         'sourceManifestSha256': p['sourceManifestSha256'], 'actualSourceReviewSha256': p['actualSourceReviewSha256'],
         'unitJobRunIds': unit_ids(p), 'subjectSha256s': subject_shas(p), 'requestSha256': request_sha256,
         'operatorRevision': p['operatorRevision'], 'runtimeRevision': p['runtimeRevision'],
         'stageBundleSha256': p.get('stageBundleSha256'), 'before': {k: v for k, v in before.items() if k != 'healthz'},
         'childDispatched': False, 'commitChallengeSent': False, 'commitAcknowledged': False, 'retryPerformed': False,
         'providerWrites': False, 'forcedJobs': False, 'physicalReclaimedBytes': 0, 'keyOrPlaintextEmitted': False}
    receipt = begin(p, root_dir, r)
    # Only actions that may have changed state make a failure status-only. The
    # sampler only (re)writes its own telemetry row; read-only DB ops change nothing.
    result = None
    mutating = DB_STAGE_OPS[p['request']['op']][0] if p['op'] == 'db' else p['op'] != 'sample-capacity'
    try:
        if p['op'] == 'db':
            result, mutating = op_db(p, r, before)
        elif p['op'] == 'stage-cipher':
            result, mutating = op_stage_cipher(p, r)
        elif p['op'] == 'publish-root':
            result, mutating = op_publish_root(p, r, before)
        elif p['op'] == 'activate-root':
            result, mutating = op_activate_root(p, r, before)
        elif p['op'] == 'sample-capacity':
            result, mutating = op_sample_capacity(p, r)
        if p['host'] == 'app':
            r['appVolume'] = app_volume()
        r.update(actualExitCode=0, statusReadOnlyRequired=False, resultSha256=sha(canonical(result)))
    except BaseException as e:
        dispatched = r['childDispatched'] or r.get('writeAttempted') or r.get('publisherDispatched') or r.get('archiveEnvWriteAttempted') or r.get('samplerDispatched')
        r.update(actualExitCode=1, reason=str(e)[:200] if isinstance(e, RuntimeError) else 'REFUSED_OR_AMBIGUOUS_STATUS_ONLY',
                 statusReadOnlyRequired=bool(dispatched) and (mutating or r['commitChallengeSent']))
        if r['commitChallengeSent'] and not r['commitAcknowledged']:
            r['commitAmbiguous'] = True
    finally:
        r['finishedAt'] = utc()
        # Host receipt: metadata only. Ciphertext/leaf bodies go to stdout only.
        write_once(receipt, (json.dumps(r) + '\n').encode())
    out = dict(r)
    out['result'] = result
    return out


if __name__ == '__main__':
    os.umask(0o077)
    try:
        if FIXTURE is None:
            need('NSB_ACTOR_FIXTURE' not in os.environ, 'FIXTURE_ENV_IN_PRODUCTION')
        raw = sys.stdin.buffer.read(12582913)
        need(0 < len(raw) <= 12582912, 'BOUND_ACTOR_PAYLOAD')
        out = run(json.loads(raw), sha(raw))
    except BaseException as e:
        out = {'actualExitCode': 1, 'reason': str(e)[:200] if isinstance(e, RuntimeError) else 'PRECONDITION_OR_AMBIGUOUS_STATUS_ONLY',
               'privateDataEmitted': False}
    sys.stdout.write(json.dumps(out) + '\n')
    sys.stdout.flush()
    sys.exit(out['actualExitCode'])
