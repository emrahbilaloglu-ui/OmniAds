import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const remote = readFileSync(".github/scripts/hetzner-remote.sh", "utf8");
const workerId = "1".repeat(64);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function actualFunction(name: string): string {
  for (const [open, close] of [["{", "}"], ["(", ")"]]) {
    const start = remote.indexOf(`${name}() ${open}`);
    if (start < 0) continue;
    const end = remote.indexOf(`\n${close}\n`, start);
    if (end < 0) throw new Error(`actual function ${name} has no end`);
    return remote.slice(start, end + 3);
  }
  return ""; // Baseline executes its actual phase, which has no recovery yet.
}

function run(input: {
  migrationStatus?: number; initiallyRunning?: boolean; missingWorker?: boolean;
  changedWorker?: boolean; startFails?: boolean; stopFails?: boolean; gateRefuses?: boolean; signal?: boolean; activeMigrator?: boolean;
  coordinatorRecovery?: boolean;
  nextPurpose?: boolean; recoveryId?: string; archiveRole?: boolean; archiveInventoryFails?: boolean;
}) {
  const directory = mkdtempSync(join(tmpdir(), "migration-worker-recovery-"));
  directories.push(directory);
  const state = join(directory, "state.json"), calls = join(directory, "calls");
  const original = {
    Id: workerId, Image: `sha256:${"a".repeat(64)}`,
    Config: { Image: "old-exact-worker:original", Env: ["APP_BUILD_ID=old", "SECRET=fixture"], Labels: { "com.docker.compose.service": "worker" } },
    Mounts: [], State: { Running: input.initiallyRunning ?? true, Health: { Status: "healthy" } },
  };
  writeFileSync(state, JSON.stringify(original)); writeFileSync(calls, "");
  if(input.archiveRole)writeFileSync(join(directory,".env.native-archive"),"BUSINESS_ARCHIVE_ERASURE_ENABLED=true\n");
  const phaseStart = remote.indexOf("  run_migrations)\n");
  const phaseEnd = remote.indexOf("\n    ;;", phaseStart);
  if (phaseStart < 0 || phaseEnd < 0) throw new Error("actual migration phase absent");
  const phase = remote.slice(phaseStart, phaseEnd + 7);
  const recoveryStart = remote.indexOf("  recover_migration_worker)\n");
  const recoveryEnd = remote.indexOf("\n    ;;", recoveryStart);
  const recoveryPhase = recoveryStart < 0 ? "  recover_migration_worker) return 88 ;;" : remote.slice(recoveryStart, recoveryEnd + 7);
  const functions = ["migration_worker_identity", "migration_worker_state_file", "persist_previous_migration_worker",
    "restore_previous_migration_worker", "recover_stored_migration_worker", "run_migrations_with_worker_recovery",
    "archive_erasure_configured", "stop_archive_erasure_if_declared"]
    .map(actualFunction).join("\n");
  const script = `
set -Eeuo pipefail
log() { printf '%s\\n' "$*"; }
on_phase_error() { local failed=$?; printf 'phase-error=%s\\n' "$failed"; exit "$failed"; }
trap on_phase_error ERR
assert_not_cutover_required() { [ "$GATE_REFUSES" != true ]; }
assert_no_cutover_in_progress() { :; }
rootcron_assert_quiesced() { printf 'cron-quiesced\\n' >> "$CALLS"; }
docker() {
  printf 'docker %s\\n' "$*" >> "$CALLS"
  case "$1" in
    compose) if [[ "$*" == 'compose --profile business-erasure config --services' ]];then
        [ "$ARCHIVE_INVENTORY_FAILS" != true ] || return 91
        printf 'worker\\n';if [ "$ARCHIVE_ROLE" = true ];then printf 'archive-erasure\\n';fi
      fi
      if [[ "$*" == 'compose --profile business-erasure ps -a -q archive-erasure' ]] && [ "$ARCHIVE_ROLE" = true ];then printf '%s\\n' '${"c".repeat(64)}';fi
      if [ "$MISSING_WORKER" != true ] && [ "$2" = ps ] && [ "\${@: -1}" = worker ]; then printf '%s\\n' '${workerId}'; fi
      if [ "$2" = ps ] && [ "\${@: -1}" = migrate ] && [ "$ACTIVE_MIGRATOR" = true ]; then printf '%s\\n' fake-active-migrate; fi
      if [ "$2" = stop ]; then change_state stop; fi ;;
    inspect) if [[ "$*" == *'.State.Health'* ]]; then printf healthy; else cat "$STATE"; fi ;;
    stop) [ "$STOP_FAILS" != true ] || return 9; change_state stop ;;
    start) [ "$START_FAILS" != true ] || return 17; if [ "$2" != '${"c".repeat(64)}' ];then change_state start;fi ;;
    *) return 88 ;;
  esac
}
change_state() {
  python3 - "$STATE" "$1" <<'PY'
import json,sys
p=sys.argv[1];x=json.load(open(p));x['State']['Running']=sys.argv[2]=='start'
if sys.argv[2]=='tamper':x['Config']['Env'].append('FOREIGN=changed')
open(p,'w').write(json.dumps(x))
PY
}
run_migrations_service_with_contention_retry() {
  printf 'migration\\n' >> "$CALLS"
  if [ "$CHANGED_WORKER" = true ]; then change_state tamper; fi
  if [ "$SIGNAL" = true ]; then python3 -c 'import os,signal; os.kill(os.getppid(),signal.SIGTERM)'; fi
  return "$MIGRATION_STATUS"
}
${functions}
DEPLOY_SHA=${"b".repeat(40)}
DEPLOY_SCHEDULER_STATE_DIR=${JSON.stringify(join(directory, "recovery-state"))}
case "$TEST_PHASE" in
${phase}
${recoveryPhase}
esac
`;
  const options = {
    cwd: directory, encoding: "utf8", timeout: 6000,
    env: { ...process.env, TEST_PHASE: "run_migrations", DEPLOY_WORKER_RECOVERY_ID: input.recoveryId ?? "12345-1", STATE: state, CALLS: calls, MIGRATION_STATUS: String(input.migrationStatus ?? 42),
      MISSING_WORKER: String(input.missingWorker ?? false), CHANGED_WORKER: String(input.changedWorker ?? false),
      START_FAILS: String(input.startFails ?? false), STOP_FAILS: String(input.stopFails ?? false),
      GATE_REFUSES: String(input.gateRefuses ?? false), SIGNAL: String(input.signal ?? false), ACTIVE_MIGRATOR: String(input.activeMigrator ?? false),
      ARCHIVE_ROLE:String(input.archiveRole??false),ARCHIVE_INVENTORY_FAILS:String(input.archiveInventoryFails??false) },
  } as const;
  const result = spawnSync("bash", ["-c", script], options);
  // A second process exercises the actual persisted interface the multi-host
  // coordinator uses after another host or scheduler restoration failed.
  const coordinator = input.coordinatorRecovery
    ? spawnSync("bash", ["-c", script], { ...options, env: { ...options.env, TEST_PHASE: "recover_migration_worker" } })
    : undefined;
  const nextPurpose = input.nextPurpose
    ? spawnSync("bash", ["-c", script], { ...options, env: { ...options.env, DEPLOY_WORKER_RECOVERY_ID: "12345-2" } })
    : undefined;
  return { ...result, coordinator, nextPurpose, calls: readFileSync(calls, "utf8").trim().split("\n"), state: JSON.parse(readFileSync(state, "utf8")) as typeof original, original };
}

describe("actual migration phase restores only its own previous worker on failure", () => {
  it("quiesces the archive role before worker migration and recovers its exact existing container through the coordinator",()=>{
    const r=run({archiveRole:true,coordinatorRecovery:true});
    expect(r.status).toBe(42);expect(r.coordinator?.status).toBe(0);
    expect(r.calls.indexOf("docker compose --profile business-erasure stop archive-erasure")).toBeLessThan(r.calls.indexOf("migration"));
    expect(r.calls.filter(x=>x===`docker start ${"c".repeat(64)}`)).toHaveLength(1);
    expect(r.calls.some(x=>/docker (?:pull|compose up)/.test(x))).toBe(false);
  });
  it("fails closed before stopping workers or migrating when archive writer inventory is unavailable",()=>{
    const r=run({archiveInventoryFails:true});expect(r.status).toBe(1);expect(r.state.State.Running).toBe(true);
    expect(r.calls.some(x=>x==="migration"||x.startsWith("docker stop ")||x.startsWith("docker start "))).toBe(false);
  });
  it("preserves the failed migration status and starts the exact existing worker once", () => {
    const r = run({});
    expect(r.status).toBe(42);
    expect(r.calls.filter((x) => x.startsWith("docker start "))).toEqual([`docker start ${workerId}`]);
    expect(r.state.State.Running).toBe(true);
    expect(r.state.Config).toEqual(r.original.Config);
    expect(r.calls.some((x) => /docker (?:pull|compose up)/.test(x))).toBe(false);
  });
  it("keeps the worker stopped after successful migrations for canonical recreation", () => {
    const r = run({ migrationStatus: 0 });
    expect(r.status).toBe(0); expect(r.state.State.Running).toBe(false);
    expect(r.calls.filter((x) => x.startsWith("docker start "))).toEqual([]);
    expect(r.calls.filter((x) => x === "migration")).toHaveLength(1);
  });
  it.each([{ initiallyRunning: false }, { missingWorker: true }])("does not start a worker it did not own and stop: %j", (input) => {
    const r = run(input); expect(r.status).toBe(42);
    expect(r.calls.filter((x) => x.startsWith("docker start "))).toEqual([]);
  });
  it("refuses recovery if the previous container configuration changed", () => {
    const r = run({ changedWorker: true }); expect(r.status).toBe(42);
    expect(r.calls.filter((x) => x.startsWith("docker start "))).toEqual([]);
  });
  it("never repeats an unsuccessful start and preserves the original migration failure", () => {
    const r = run({ startFails: true }); expect(r.status).toBe(42);
    expect(r.calls.filter((x) => x.startsWith("docker start "))).toEqual([`docker start ${workerId}`]);
  });
  it("does not restart the previous worker while a migration container still runs", () => {
    const r = run({ activeMigrator: true }); expect(r.status).toBe(42);
    expect(r.calls.filter((x) => x.startsWith("docker start "))).toEqual([]);
    expect(r.state.State.Running).toBe(false);
  });
  it("does not migrate if stopping its previous worker failed", () => {
    const r = run({ stopFails: true }); expect(r.status).toBe(9);
    expect(r.calls).not.toContain("migration");
    expect(r.state.State.Running).toBe(true);
  });
  it("leaves all services alone when the pre-migration cutover gate refuses", () => {
    const r = run({ gateRefuses: true }); expect(r.status).toBe(1);
    expect(r.calls).toEqual([""]); expect(r.state.State.Running).toBe(true);
  });
  it("restores its previous worker on a caught termination without claiming migration success", () => {
    const r = run({ signal: true }); expect(r.status, JSON.stringify({ calls: r.calls, stdout: r.stdout, stderr: r.stderr, signal: r.signal })).toBe(143);
    expect(r.calls.filter((x) => x.startsWith("docker start "))).toEqual([`docker start ${workerId}`]);
    expect(r.state.State.Running).toBe(true);
  });
  it("allows coordinator recovery of a stopped worker after this host's migrations succeeded", () => {
    const r = run({ migrationStatus: 0, coordinatorRecovery: true });
    expect(r.status).toBe(0); expect(r.coordinator?.status, r.coordinator?.stderr).toBe(0);
    expect(r.calls.filter((x) => x.startsWith("docker start "))).toEqual([`docker start ${workerId}`]);
    expect(r.calls.filter((x) => x === "migration")).toHaveLength(1);
    expect(r.state.State.Running).toBe(true); expect(r.state.Config).toEqual(r.original.Config);
  });
  it("does not start an already restored worker again during coordinator recovery", () => {
    const r = run({ coordinatorRecovery: true });
    expect(r.status).toBe(42); expect(r.coordinator?.status).toBe(0);
    expect(r.calls.filter((x) => x.startsWith("docker start "))).toEqual([`docker start ${workerId}`]);
    expect(r.state.State.Running).toBe(true);
  });
  it("refuses a second start across processes after the first start failed", () => {
    const r = run({ startFails: true, coordinatorRecovery: true });
    expect(r.status).toBe(42); expect(r.coordinator?.status).toBe(1);
    expect(r.calls.filter((x) => x.startsWith("docker start "))).toEqual([`docker start ${workerId}`]);
    expect(r.state.State.Running).toBe(false);
  });
  it("permits a separate purpose for the same target without reusing the first start marker", () => {
    const r = run({ nextPurpose: true });
    expect(r.status).toBe(42); expect(r.nextPurpose?.status, r.nextPurpose?.stderr).toBe(42);
    expect(r.calls.filter((x) => x.startsWith("docker start "))).toEqual([`docker start ${workerId}`, `docker start ${workerId}`]);
    expect(r.state.State.Running).toBe(true);
  });
  it("refuses an invalid recovery purpose before stopping its worker", () => {
    const r = run({ recoveryId: "../foreign" });
    expect(r.status).toBe(1); expect(r.state.State.Running).toBe(true);
    expect(r.calls.some((x) => x.startsWith("docker stop ") || x === "migration")).toBe(false);
  });
});
