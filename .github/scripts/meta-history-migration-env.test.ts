import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

const KEY = "ADSECUTE_META_HISTORY_SCHEMA_MAINTENANCE";
const VALUE = "index_only_while_source_fenced";
const REMOTE = readFileSync(".github/scripts/hetzner-remote.sh", "utf8");
const COMPOSE = yaml.load(readFileSync("docker-compose.yml", "utf8")) as {
  services: Record<string, { environment?: Record<string, string> }>;
};

function shellFunction(name: string): string {
  const start = REMOTE.indexOf(`${name}() {`);
  const end = REMOTE.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`missing actual shell function ${name}`);
  return REMOTE.slice(start, end + 3);
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runMigration(input: { timeoutAvailable: boolean; migrationStatus?: number; gateRefuses?: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), "meta-history-migration-env-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const calls = join(directory, "calls");
  writeFileSync(calls, "");
  const envFile = join(directory, ".env.production");
  const originalEnv = "META_AUTOMATION_LIVE_WRITES=false\nUNCHANGED=fixture\n";
  writeFileSync(envFile, originalEnv);

  const executable = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\n${body}`);
    chmodSync(path, 0o755);
  };
  executable("docker", `
printf '%s|%s\\n' "$*" "\${${KEY}-unset}" >> "\${CALL_LOG}"
if [ "$1 $2" = "compose up" ] && [ "\${@: -1}" = "migrate" ]; then exit "\${MIGRATION_STATUS}"; fi
exit 0
`);
  if (input.timeoutAvailable) {
    executable("timeout", `
printf 'timeout %s|%s\\n' "$1" "\${${KEY}-unset}" >> "\${CALL_LOG}"
shift
exec "$@"
`);
  }

  const stdout = execFileSync("bash", ["-c", `
set -euo pipefail
command() {
  if [ "$*" = "-v timeout" ] && [ "\${TIMEOUT_AVAILABLE}" = "false" ]; then return 1; fi
  builtin command "$@"
}
log() { :; }
read_env_file_migration_timeout_ms() { printf 30000; }
assert_not_cutover_required() {
  printf 'cutover-required-gate|%s\\n' "\${${KEY}-unset}" >> "\${CALL_LOG}"
  [ "\${GATE_REFUSES}" != "true" ]
}
assert_no_cutover_in_progress() {
  printf 'cutover-progress-gate|%s\\n' "\${${KEY}-unset}" >> "\${CALL_LOG}"
}
${shellFunction("is_positive_integer")}
${shellFunction("run_migrations_service")}
status=0
run_migrations_service || status=$?
printf 'status=%s\\nparentFlag=%s\\n' "$status" "\${${KEY}-unset}"
docker compose up -d web worker
`], {
    cwd: directory,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      // Feature detection above also proves the absent-timeout path on Linux.
      PATH: `${bin}:/usr/bin:/bin`,
      CALL_LOG: calls,
      MIGRATION_STATUS: String(input.migrationStatus ?? 0),
      TIMEOUT_AVAILABLE: String(input.timeoutAvailable),
      GATE_REFUSES: String(input.gateRefuses ?? false),
      MIGRATION_LAST_LOG: join(directory, "migration.log"),
      DEPLOY_MIGRATION_TIMEOUT_MS: "30000",
    },
  });
  return { stdout, calls: readFileSync(calls, "utf8").trim().split("\n"), env: readFileSync(envFile, "utf8"), originalEnv };
}

describe("Meta history schema maintenance stays inside the explicit deploy migration", () => {
  it("declares the empty-default pass-through only on migrate, never web or worker", () => {
    expect(COMPOSE.services.migrate.environment?.[KEY]).toBe(`\${${KEY}:-}`);
    for (const [name, service] of Object.entries(COMPOSE.services)) {
      if (name !== "migrate") expect(service.environment).not.toHaveProperty(KEY);
    }
    expect(REMOTE).not.toMatch(new RegExp(`export\\s+${KEY}`));
    expect(readFileSync(".github/scripts/hetzner-ssh.sh", "utf8")).not.toContain(KEY);
  });

  it("keeps the existing exact-SHA workflow and run_migrations=true opt-in", () => {
    const workflow = yaml.load(readFileSync(".github/workflows/deploy-hetzner.yml", "utf8")) as {
      jobs: { deploy: { steps: Array<{ name: string; if?: string; run?: string; env?: Record<string, string> }> } };
    };
    const migrate = workflow.jobs.deploy.steps.find((step) => step.name === "Run database migrations");
    expect(migrate?.if).toContain("inputs.run_migrations == 'true'");
    expect(migrate?.run).toContain("run_migrations_with_all_schedulers_paused");
    expect(migrate?.env?.DEPLOY_SHA).toBe("${{ steps.deploy_sha.outputs.sha }}");
    expect(readFileSync(".github/workflows/deploy-hetzner.yml", "utf8")).not.toContain(KEY);
  });

  it.each([true, false])("passes the exact flag only to migrate-up (timeout available=%s)", (timeoutAvailable) => {
    const result = runMigration({ timeoutAvailable });
    expect(result.stdout).toContain("status=0\nparentFlag=unset");
    expect(result.env).toBe(result.originalEnv);
    const flagged = result.calls.filter((line) => line.endsWith(`|${VALUE}`));
    expect(flagged).toEqual([
      ...(timeoutAvailable ? [`timeout 90|${VALUE}`] : []),
      `compose up --no-deps --abort-on-container-exit --exit-code-from migrate migrate|${VALUE}`,
    ]);
    expect(result.calls).toContain("compose up -d web worker|unset");
    expect(result.calls[0]).toBe("cutover-required-gate|unset");
    expect(result.calls[1]).toBe("cutover-progress-gate|unset");
  });

  it("preserves migration failure and does not leak the flag through cleanup or later recreate", () => {
    const result = runMigration({ timeoutAvailable: true, migrationStatus: 42 });
    expect(result.stdout).toContain("status=42\nparentFlag=unset");
    expect(result.calls).toContain("compose logs --tail=200 migrate|unset");
    expect(result.calls.at(-1)).toBe("compose up -d web worker|unset");
    expect(result.env).toBe(result.originalEnv);
  });

  it("cannot reach migration maintenance before the existing cutover gate permits it", () => {
    const result = runMigration({ timeoutAvailable: true, gateRefuses: true });
    expect(result.stdout).toContain("status=1\nparentFlag=unset");
    expect(result.calls.some((line) => line.includes(VALUE) || line.includes("migrate"))).toBe(false);
    expect(result.env).toBe(result.originalEnv);
  });
});
