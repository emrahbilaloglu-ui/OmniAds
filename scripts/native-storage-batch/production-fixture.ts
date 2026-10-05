import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runActor, type ActorHost, type ActorTransport } from "./production-transport";

/** FIXTURE ONLY — never imported by the executor. The REAL production-actor.py
 * runs locally as a non-root user against two fake host trees (app, db). The
 * fake docker/curl/systemctl below stand in for the host binaries: containers
 * are local node processes on owned PostgreSQL clusters; nothing can reach a
 * production host. Paths inside "containers" are mapped explicitly here. */
export class FixtureActorTransport implements ActorTransport {
  readonly kind = "fixture" as const;
  constructor(private readonly root: string) {}
  send(host: ActorHost, payload: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
    return runActor(["python3"], payload, timeoutMs, { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin",
      NSB_ACTOR_FIXTURE: join(this.root, host) }, signal);
  }
}

export const FAKE_DOCKER = String.raw`#!/usr/bin/env python3
"""FIXTURE ONLY fake docker: state in $NSB_ACTOR_FIXTURE/docker-state.json."""
import json, os, re, secrets, signal, subprocess, sys
from datetime import datetime, timezone
FX = os.environ['NSB_ACTOR_FIXTURE']; STATE = os.path.join(FX, 'docker-state.json'); st = json.load(open(STATE)); a = sys.argv[1:]
def save():
    open(STATE + '.tmp', 'w').write(json.dumps(st)); os.replace(STATE + '.tmp', STATE)
def container(name):
    for c in st['containers'].values():
        if c['Name'] == '/' + name: return c
    sys.exit(1)
def archive_env():
    return dict(l.split('=', 1) for l in open(os.path.join(st['appRoot'], '.env.native-archive')).read().splitlines())
def env_of(c): return dict(x.split('=', 1) for x in c['Config']['Env'])
if a[:2] == ['inspect', '--type']: print(json.dumps([container(n) for n in a[3:]])); sys.exit(0)
def image(ref):
    # By id, or by repo:tag exactly as the local tag table resolves it now.
    i = ref if ref in st['images'] else st['tags'].get(ref)
    return st['images'][i] if i in st['images'] else None
if a[:2] == ['image', 'inspect']:
    img = image(a[2])
    if img is None: sys.exit(1)
    print(json.dumps([img])); sys.exit(0)
def dotenv():
    out = {}
    for line in open(os.path.join(st['appRoot'], '.env')).read().splitlines():
        if '=' in line and not line.startswith('#'): k, v = line.split('=', 1); out[k] = v
    return out
def model():
    # Compose precedence: the invoking process env wins over the project .env.
    v = dotenv(); v.update({k: os.environ[k] for k in ('APP_IMAGE_TAG', 'APP_BUILD_ID', 'WEB_IMAGE_REPO', 'WORKER_IMAGE_REPO') if k in os.environ})
    tag, build = v.get('APP_IMAGE_TAG') or 'dev-build', v.get('APP_BUILD_ID') or 'dev-build'
    web = dict(st['composeBase']['web']); web['APP_BUILD_ID'] = build; web.update(archive_env())
    worker = dict(st['composeBase']['worker']); worker['APP_BUILD_ID'] = build
    return {'name': 'adsecute', 'services': {
        'web': {'image': (v.get('WEB_IMAGE_REPO') or 'ghcr.io/emrahbilaloglu-ui/omniads-web') + ':' + tag, 'environment': web,
                'volumes': [{'type': 'bind', 'source': st['archiveRoot'], 'target': '/run/adsecute-native-archive', 'read_only': True}]},
        'worker': {'image': (v.get('WORKER_IMAGE_REPO') or 'ghcr.io/emrahbilaloglu-ui/omniads-worker') + ':' + tag, 'environment': worker}}}
def recreate(c, image_id, environment):
    img = st['images'][image_id]; merged = dict(x.split('=', 1) for x in img['Config']['Env']); merged.update(environment)
    c['Image'] = image_id; c['Config']['Env'] = [k + '=' + v for k, v in merged.items()]
    c['Config']['Labels']['org.opencontainers.image.revision'] = img['Config']['Labels']['org.opencontainers.image.revision']
    c['Id'] = secrets.token_hex(32); c['State']['StartedAt'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
if a[:2] == ['compose', 'config']: print(json.dumps(model())); sys.exit(0)
if a[:2] == ['compose', 'up']:
    assert a[-1] == 'web' and '--force-recreate' in a and '--no-deps' in a and '--no-build' in a and '--pull' in a
    st['composeUpCalls'] = st.get('composeUpCalls', 0) + 1; save()
    m = model(); ref = m['services']['web']['image']; image_id = st['tags'].get(ref)
    if image_id is None: sys.exit(1)  # --pull never: no such local image, nothing is recreated
    fault = st.get('faults', {}).get('composeUp')
    if fault == 'foreign-web-image': image_id = st['foreignImage']  # the tag moved between the gate and the apply
    recreate(st['containers']['web'], image_id, m['services']['web']['environment'])
    if fault == 'recreate-worker':
        w = st['containers']['worker']; recreate(w, w['Image'], m['services']['worker']['environment'])
    save()
    if fault == 'kill-after-recreate': os.kill(os.getpid(), signal.SIGKILL)
    sys.exit(0)
if a[0] == 'exec':
    i, extra, interactive = 1, {}, False
    while a[i].startswith('-'):
        if a[i] == '-i': interactive = True; i += 1
        elif a[i] == '-e': k, v = a[i + 1].split('=', 1); extra[k] = v; i += 2
        else: sys.exit(2)
    c = container(a[i]); cmd = a[i + 1:]; assert cmd[0] == 'node' and cmd[1] == '-e'
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin')}; env.update(env_of(c)); env.update(extra)
    script = cmd[2] if interactive else cmd[2].replace('"/app/', '"' + st['repoRoot'] + '/')  # container /app -> fixture repo
    os.chdir(st['repoRoot']); os.execve(st['node'], [st['node'], '-e', script, *cmd[3:]], env)
if a[0] == 'run':
    args, i, envs, mount = a[1:], 0, {}, None
    while args[i].startswith('-'):
        if args[i] == '--mount': mount = args[i + 1]; i += 2
        elif args[i] == '-e': k, v = args[i + 1].split('=', 1); envs[k] = v; i += 2
        elif args[i] in ('--interactive', '--read-only'): i += 1
        else: i += 2
    image, rest = args[i], args[i + 1:]
    assert image == st['containers']['web']['Image'] and envs.get('NSB_HOST_MODE') == 'production' and rest[0] == '-e'
    src = re.match(r'^type=bind,src=([^,]+),dst=/routing$', mount).group(1)
    n = int(rest[-1]); bundle = sys.stdin.buffer.read(n); req = json.loads(sys.stdin.buffer.readline()); req['routingDirectory'] = src  # /routing -> bind source
    env = {'PATH': os.environ.get('PATH', ''), 'NODE_ENV': 'production', 'NSB_HOST_MODE': 'owned', 'NSB_STATE_ROOT': os.path.dirname(src), 'APP_BUILD_ID': envs['APP_BUILD_ID']}
    sys.exit(subprocess.run([st['node'], *rest], input=bundle + json.dumps(req).encode() + b'\n', env=env, cwd=st['repoRoot']).returncode)
if a[:2] == ['rm', '--force']: sys.exit(0)
sys.exit(3)
`;
export const FAKE_CURL = String.raw`#!/usr/bin/env python3
import json, os, sys
st = json.load(open(os.path.join(os.environ['NSB_ACTOR_FIXTURE'], 'docker-state.json'))); web = st['containers']['web']
if web['State']['Health']['Status'] != 'healthy': sys.exit(22)
print(json.dumps({'ok': True, 'buildId': dict(x.split('=', 1) for x in web['Config']['Env'])['APP_BUILD_ID']}))
`;
/** Stands in for the EXISTING oneshot unit: same row shape (source, DB-clock
 * sampled_at, database.name, /var/lib/postgresql disk) from a REAL statfs of
 * the owned cluster's data directory. Faults: fail, noop (no new row). */
export const FAKE_SYSTEMCTL = String.raw`#!/usr/bin/env python3
import json, os, subprocess, sys, time
FX = os.environ['NSB_ACTOR_FIXTURE']; cfg = json.load(open(os.path.join(FX, 'sampler.json'))); a = sys.argv[1:]; last = os.path.join(FX, 'sampler-last.json')
if a == ['start', 'adsecute-db-healthcheck.service']:
    if cfg.get('fault') == 'fail': open(last, 'w').write(json.dumps({'exit': 1})); sys.exit(1)
    if cfg.get('fault') == 'noop': open(last, 'w').write(json.dumps({'exit': 0})); sys.exit(0)
    v = os.statvfs(cfg['dataDirectory'])
    payload = json.dumps({'database': {'name': cfg['database']}, 'disks': [{'path': '/var/lib/postgresql', 'totalBytes': v.f_blocks * v.f_frsize,
        'usedBytes': (v.f_blocks - v.f_bfree) * v.f_frsize, 'availableBytes': v.f_bavail * v.f_frsize}], 'fixtureOfExistingSampler': True})
    sql = "INSERT INTO system_capacity_snapshots (source,hostname,sampled_at,payload) VALUES ('db_host_healthcheck','adsecute-db-1',clock_timestamp(),$fx$" + payload + "$fx$::jsonb)"
    q = subprocess.run([cfg['psql'], '-h', cfg['socket'], '-p', str(cfg['port']), '-U', cfg['user'], '-d', cfg['database'], '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql],
        env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, capture_output=True)
    open(last, 'w').write(json.dumps({'exit': q.returncode})); sys.exit(q.returncode)
if a[:2] == ['show', 'adsecute-db-healthcheck.service']:
    x = json.load(open(last)) if os.path.exists(last) else {'exit': 0}
    print('Result=' + ('success' if x['exit'] == 0 else 'exit-code')); print('ExecMainStatus=' + str(x['exit'])); print('ExecMainExitTimestamp=' + time.ctime()); sys.exit(0)
sys.exit(3)
`;
export async function writeExecutable(path: string, source: string) { await writeFile(path, source, { mode: 0o700 }); await chmod(path, 0o700); }
export const hex64 = () => randomBytes(32).toString("hex");
export async function mkdirs(...dirs: string[]) { for (const d of dirs) await mkdir(d, { recursive: true, mode: 0o700 }); }
