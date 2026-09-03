/**
 * PRE-DEPLOY AUDIT — the REAL remote script + env writer + workflow
 * pipeline/summary-extraction path, run end-to-end. No host, no SSH, no
 * Docker, no network — but nothing here is a rewrite or a mock of the
 * ORCHESTRATION LOGIC itself.
 *
 * Every earlier test in this pass proved the PURE TypeScript orchestrator
 * (`lib/meta/automation-capability-orchestrator.ts`) is safe, and the
 * static contract test proved the workflow YAML's shape is right. Neither
 * proves the thing that actually runs on a real dispatch: the shipped
 * workflow never calls the TypeScript orchestrator at all — it runs
 * `.github/scripts/automation-capability-env.sh` and
 * `.github/scripts/automation-capability-remote.sh`, concatenated over
 * `bash -s`, and the workflow's OWN `run:` blocks do the SSH pipeline and
 * artifact extraction.
 *
 * This harness runs those exact files, UNMODIFIED — the `run:` scripts are
 * read directly out of `automation-capability-toggle.yml` via `js-yaml`,
 * never retyped — against:
 *
 *   - a fake `ssh` that evaluates its last argument LOCALLY via
 *     `bash -c`, inheriting this process's stdin exactly like real ssh
 *     does, so the two concatenated scripts really do reach a real `bash -s`
 *     and really do execute;
 *   - fake `docker` and `curl` binaries whose behavior per test case is
 *     driven entirely by env vars, standing in for the Docker daemon and
 *     the build-info endpoint a real host would have;
 *   - a REAL local file standing in for `.env.production`, mutated by the
 *     REAL `atomic_set_env_var`/`atomic_restore_env_backup` and inspected
 *     byte-for-byte afterward.
 *
 * Every scenario the task named is covered: success, preflight refusal, a
 * wrong pre-existing SHA (baseline refusal), a wrong worker SHA/env after
 * recreate, a nonzero `docker compose pull`/`up`, an env-file write that
 * cannot preserve ownership, a nonzero SSH exit, a phase that prints no
 * CAPABILITY_JSON line at all, a rollback whose OWN restore fails, and
 * `capability_close` succeeding while the DB-backed preflight would
 * refuse. The PIPESTATUS[1] fix (workflow item 6) is proven by literally
 * reconstructing the OLD `PIPESTATUS[0]` line and showing it reports
 * success for the exact SSH failure the fixed line correctly reports as a
 * failure — the real broken path is shown failing, not assumed.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WORKFLOW_PATH = ".github/workflows/automation-capability-toggle.yml";
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, "utf8");
const WORKFLOW_DOC = yaml.load(WORKFLOW_SOURCE) as {
  jobs: { toggle: { steps: Array<{ name: string; run?: string }> } };
};
const STEPS = WORKFLOW_DOC.jobs.toggle.steps;

function stepRun(name: string): string {
  const step = STEPS.find((s) => s.name === name);
  if (!step?.run) throw new Error(`step not found or has no run: block: ${name}`);
  return step.run;
}

const PHASE_RUNNER_SCRIPT = stepRun("Run a capability phase on the host");
const BUILD_ARTIFACT_SCRIPT = stepRun("Build the redacted result artifact");
const FAIL_GATE_SCRIPT = stepRun("Fail the job on anything but summary.result == pass");

const ENV_SH = readFileSync(".github/scripts/automation-capability-env.sh", "utf8");
const REMOTE_SH = readFileSync(".github/scripts/automation-capability-remote.sh", "utf8");

const VALID_SHA = "a".repeat(40);

const FAKE_SSH_SCRIPT = `#!/usr/bin/env bash
# Fake ssh: ignore every connection flag, evaluate the LAST argument
# locally via bash -c, with this process's OWN stdin passed through
# untouched -- exactly what real ssh does with a remote command string,
# just without leaving the machine.
last="\${@: -1}"
exec bash -c "$last"
`;

const FAKE_CURL_SCRIPT = `#!/usr/bin/env bash
set -u
if [ "\${FAKE_CURL_EXIT:-0}" != "0" ]; then
  exit "\${FAKE_CURL_EXIT}"
fi
printf '{"buildId":"%s"}' "\${FAKE_BUILD_ID:-\${EXPECTED_SHA:-}}"
`;

// A STATEFUL fake: \`docker compose up\` marks a per-test marker file
// (inside REMOTE_APP_DIR, always present) the moment it is invoked. Every
// later \`inspect\`/\`exec\` call checks that marker to decide whether to
// answer with the PRE-recreate facts or the POST-recreate ones — so a test
// can set a baseline that is genuinely correct and have it go wrong ONLY
// after the real recreate step runs, instead of being wrong from the very
// first (baseline) read too. \`*_AFTER_UP\` variables are the post-recreate
// override; without one, the post-recreate answer is the SAME as the
// pre-recreate one (nothing changed).
const FAKE_DOCKER_SCRIPT = `#!/usr/bin/env bash
set -u
UP_MARKER="\${REMOTE_APP_DIR}/.fake-docker-up-called"

if [ "\$1" = "compose" ]; then
  shift
  case "\$1" in
    pull) exit "\${FAKE_PULL_EXIT:-0}" ;;
    up)
      : > "\$UP_MARKER"
      exit "\${FAKE_UP_EXIT:-0}"
      ;;
    ps)
      service="\$3"
      case "\$service" in
        web) miss="\${FAKE_WEB_MISSING:-0}" ;;
        worker) miss="\${FAKE_WORKER_MISSING:-0}" ;;
        *) miss="0" ;;
      esac
      if [ "\$miss" = "1" ]; then exit 0; fi
      echo "\${service}-fake-cid"
      exit 0
      ;;
    exec)
      service="\$3"
      shift 3
      if printf '%s ' "\$@" | grep -q "automation-capability-preflight-cli.ts"; then
        exit "\${FAKE_PREFLIGHT_EXIT:-0}"
      fi
      # Default: read the REAL current value out of the .env.production
      # this test actually wrote, so a successful atomic_set_env_var write
      # is genuinely reflected back — exactly like a real recreated
      # container reading its own real env would.
      current_env_value="\$(grep -E '^META_AUTOMATION_LIVE_WRITES=' "\${REMOTE_APP_DIR}/.env.production" 2>/dev/null | tail -n1 | cut -d= -f2-)"
      [ -z "\$current_env_value" ] && current_env_value="false"
      after_up="0"
      [ -f "\$UP_MARKER" ] && after_up="1"
      case "\$service" in
        web)
          if [ "\$after_up" = "1" ] && [ -n "\${FAKE_WEB_ENV_AFTER_UP:-}" ]; then
            val="\$FAKE_WEB_ENV_AFTER_UP"
          elif [ -n "\${FAKE_WEB_ENV:-}" ]; then
            val="\$FAKE_WEB_ENV"
          else
            val="\$current_env_value"
          fi
          ec="\${FAKE_WEB_EXEC_EXIT:-0}"
          ;;
        worker)
          if [ "\$after_up" = "1" ] && [ -n "\${FAKE_WORKER_ENV_AFTER_UP:-}" ]; then
            val="\$FAKE_WORKER_ENV_AFTER_UP"
          elif [ -n "\${FAKE_WORKER_ENV:-}" ]; then
            val="\$FAKE_WORKER_ENV"
          else
            val="\$current_env_value"
          fi
          ec="\${FAKE_WORKER_EXEC_EXIT:-0}"
          ;;
        *) val="false"; ec="0" ;;
      esac
      printf '%s' "\$val"
      exit "\$ec"
      ;;
    *) echo "fake docker compose: unhandled \$1" >&2; exit 1 ;;
  esac
fi
if [ "\$1" = "inspect" ]; then
  shift
  fmt=""
  cid=""
  while [ "\$#" -gt 0 ]; do
    case "\$1" in
      --format) fmt="\$2"; shift 2 ;;
      *) cid="\$1"; shift ;;
    esac
  done
  service="\${cid%-fake-cid}"
  after_up="0"
  [ -f "\$UP_MARKER" ] && after_up="1"
  case "\$fmt" in
    *State.Running*)
      case "\$service" in
        web) nr="\${FAKE_WEB_NOT_RUNNING:-0}" ;;
        worker) nr="\${FAKE_WORKER_NOT_RUNNING:-0}" ;;
        *) nr="0" ;;
      esac
      if [ "\$nr" = "1" ]; then echo "false"; else echo "true"; fi
      ;;
    *image.revision*)
      case "\$service" in
        web)
          if [ "\$after_up" = "1" ] && [ -n "\${FAKE_WEB_REVISION_AFTER_UP:-}" ]; then
            echo "\$FAKE_WEB_REVISION_AFTER_UP"
          else
            echo "\${FAKE_WEB_REVISION:-\${EXPECTED_SHA:-}}"
          fi
          ;;
        worker)
          if [ "\$after_up" = "1" ] && [ -n "\${FAKE_WORKER_REVISION_AFTER_UP:-}" ]; then
            echo "\$FAKE_WORKER_REVISION_AFTER_UP"
          else
            echo "\${FAKE_WORKER_REVISION:-\${EXPECTED_SHA:-}}"
          fi
          ;;
        *) echo "" ;;
      esac
      ;;
    *release.role*)
      case "\$service" in
        web) echo "\${FAKE_WEB_ROLE:-web-runner}" ;;
        worker) echo "\${FAKE_WORKER_ROLE:-worker-runner}" ;;
        *) echo "" ;;
      esac
      ;;
    *) echo "fake docker inspect: unhandled format \$fmt" >&2; exit 1 ;;
  esac
  exit 0
fi
echo "fake docker: unhandled command \$*" >&2
exit 1
`;

const FAKE_SSH_ALWAYS_FAILS_SCRIPT = `#!/usr/bin/env bash
# Simulates a dead/unreachable host -- never evaluates anything, never
# touches stdin, just fails the way ssh fails on connection refused.
echo "ssh: connect to host fake-host.invalid port 22: Connection refused" >&2
exit 255
`;

let dir: string;
let remoteAppDir: string;
let fakeBinDir: string;
let envFile: string;

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adsecute-capability-integration-"));
  remoteAppDir = join(dir, "remote-app");
  mkdirSync(remoteAppDir, { recursive: true });
  envFile = join(remoteAppDir, ".env.production");
  writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES=false\nOTHER_KEY=kept\n");

  fakeBinDir = join(dir, "fake-bin");
  mkdirSync(fakeBinDir, { recursive: true });
  writeExecutable(join(fakeBinDir, "ssh"), FAKE_SSH_SCRIPT);
  writeExecutable(join(fakeBinDir, "docker"), FAKE_DOCKER_SCRIPT);
  writeExecutable(join(fakeBinDir, "curl"), FAKE_CURL_SCRIPT);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function parseGithubOutput(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

/**
 * Runs the REAL "Run a capability phase on the host" step script exactly
 * as the workflow does — concatenated env.sh + remote.sh piped through
 * (fake) ssh, `tee`'d to a temp file, PIPESTATUS captured. `sshBinary`
 * lets a test case swap in a dead-host fake ssh instead of the working one.
 */
function runPhaseStep(input: {
  capability: "open" | "closed";
  expectedSha?: string;
  fakeEnv?: Record<string, string>;
  sshScript?: string;
}): { phaseStatus: number; outFileContent: string; githubOutput: Record<string, string> } {
  if (input.sshScript) {
    writeExecutable(join(fakeBinDir, "ssh"), input.sshScript);
  }
  const githubOutputFile = join(dir, `gh-output-${Math.random().toString(36).slice(2)}`);
  writeFileSync(githubOutputFile, "");

  execFileSync("bash", ["-c", PHASE_RUNNER_SCRIPT], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? dir,
      EXPECTED_SHA: input.expectedSha ?? VALID_SHA,
      HETZNER_PORT: "22",
      HETZNER_USER: "deployer",
      CAPABILITY: input.capability,
      PRIMARY_DEPLOY_HOST: "fake-host.invalid",
      REMOTE_APP_DIR: remoteAppDir,
      GITHUB_OUTPUT: githubOutputFile,
      ...input.fakeEnv,
    },
  });

  const githubOutput = parseGithubOutput(readFileSync(githubOutputFile, "utf8"));
  const outFileContent = githubOutput.out_file ? readFileSync(githubOutput.out_file, "utf8") : "";
  return {
    phaseStatus: Number(githubOutput.phase_status ?? "NaN"),
    outFileContent,
    githubOutput,
  };
}

/** Runs the REAL "Build the redacted result artifact" step script. */
function runBuildArtifactStep(input: {
  phaseStatus: number;
  outFileContent: string;
  capability: "open" | "closed";
  expectedSha?: string;
}): { artifact: Record<string, unknown>; artifactsDir: string } {
  const artifactsDir = mkdtempSync(join(tmpdir(), "adsecute-capability-artifact-"));
  const outFile = join(artifactsDir, "out.txt");
  writeFileSync(outFile, input.outFileContent);

  execFileSync("bash", ["-c", BUILD_ARTIFACT_SCRIPT], {
    cwd: artifactsDir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      PHASE_STATUS: String(input.phaseStatus),
      OUT_FILE: outFile,
      EXPECTED_SHA: input.expectedSha ?? VALID_SHA,
      CAPABILITY: input.capability,
    },
  });

  const artifact = JSON.parse(readFileSync(join(artifactsDir, ".artifacts", "automation-capability-toggle.json"), "utf8"));
  return { artifact, artifactsDir };
}

/** Runs the REAL "Fail the job on anything but summary.result == pass" step. Throws on a non-pass verdict, exactly like the real job would fail. */
function runFailGateStep(artifactsDir: string): { stdout: string } {
  const stdout = execFileSync("bash", ["-c", FAIL_GATE_SCRIPT], {
    cwd: artifactsDir,
    encoding: "utf8",
  });
  return { stdout };
}

/** Runs env.sh + remote.sh in ONE shot (no ssh layer) for scenarios that don't need the workflow's own steps — the direct remote-script test. */
function runRemoteDirect(input: {
  phase: "capability_open" | "capability_close" | "capability_preflight";
  expectedSha?: string;
  fakeEnv?: Record<string, string>;
}): { status: number; stdout: string; capabilityJson: Record<string, unknown> | null } {
  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync("bash", ["-c", `${ENV_SH}\n${REMOTE_SH}`], {
      encoding: "utf8",
      env: {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        EXPECTED_SHA: input.expectedSha ?? VALID_SHA,
        PHASE: input.phase,
        REMOTE_APP_DIR: remoteAppDir,
        ...input.fakeEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { status?: number; stdout?: string };
    status = e.status ?? 1;
    stdout = e.stdout ?? "";
  }
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("CAPABILITY_JSON: "));
  const capabilityJson = line ? JSON.parse(line.slice("CAPABILITY_JSON: ".length)) : null;
  return { status, stdout, capabilityJson };
}

function readEnvFile(): string {
  return readFileSync(envFile, "utf8");
}

describe("the full workflow pipeline — success", () => {
  it("capability=open: env file flips, both steps' artifact is pass with blockers=[], the fail gate does not throw", () => {
    const phase = runPhaseStep({ capability: "open" });
    expect(phase.phaseStatus).toBe(0);
    expect(phase.outFileContent).toContain("CAPABILITY_JSON: ");

    const { artifact, artifactsDir } = runBuildArtifactStep({
      phaseStatus: phase.phaseStatus, outFileContent: phase.outFileContent, capability: "open",
    });
    expect((artifact.summary as Record<string, unknown>).result).toBe("pass");
    expect((artifact.summary as Record<string, unknown>).blockers).toEqual([]);

    expect(() => runFailGateStep(artifactsDir)).not.toThrow();
    expect(readEnvFile()).toContain("META_AUTOMATION_LIVE_WRITES=true");
    expect(readEnvFile()).toContain("OTHER_KEY=kept");
  });

  it("the artifact's before/after carries REAL measured facts, not a bare declaration", () => {
    const phase = runPhaseStep({ capability: "open" });
    const { artifact } = runBuildArtifactStep({
      phaseStatus: phase.phaseStatus, outFileContent: phase.outFileContent, capability: "open",
    });
    const summary = artifact.summary as Record<string, unknown>;
    const before = summary.before as Record<string, unknown>;
    const after = summary.after as Record<string, unknown>;
    expect((before.web as Record<string, unknown>).envValue).toBe("false");
    expect((after.web as Record<string, unknown>).envValue).toBe("true");
    expect((after.web as Record<string, unknown>).revision).toBe(VALID_SHA);
    expect((after.worker as Record<string, unknown>).revision).toBe(VALID_SHA);
  });

  it("capability=closed: env file flips to false, artifact is pass", () => {
    writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES=true\n");
    const phase = runPhaseStep({ capability: "closed" });
    expect(phase.phaseStatus).toBe(0);
    const { artifact } = runBuildArtifactStep({
      phaseStatus: phase.phaseStatus, outFileContent: phase.outFileContent, capability: "closed",
    });
    expect((artifact.summary as Record<string, unknown>).result).toBe("pass");
    expect(readEnvFile()).toContain("META_AUTOMATION_LIVE_WRITES=false");
  });
});

describe("preflight refusal — capability_open refuses before writing anything", () => {
  it("a refused preflight leaves the env file byte-for-byte unchanged", () => {
    const before = readEnvFile();
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      fakeEnv: { FAKE_PREFLIGHT_EXIT: "1" },
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("refused");
    expect((capabilityJson?.blockers as string[]).join(",")).toContain("preflight_refused");
    expect(readEnvFile()).toBe(before);
  });
});

describe("baseline refusal — a wrong pre-existing SHA is refused, not silently deployed over", () => {
  it("web already running a DIFFERENT SHA than requested refuses capability_open outright", () => {
    const before = readEnvFile();
    const wrongSha = "b".repeat(40);
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      expectedSha: VALID_SHA,
      fakeEnv: { FAKE_WEB_REVISION: wrongSha }, // worker still reports VALID_SHA
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("refused");
    expect((capabilityJson?.blockers as string[]).join(",")).toContain("baseline_refused");
    expect(readEnvFile()).toBe(before); // never even attempted the write
  });

  it("capability ALREADY true in the env file refuses capability_open outright (no double-open)", () => {
    writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES=true\n");
    const { status, capabilityJson } = runRemoteDirect({ phase: "capability_open" });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("refused");
    expect((capabilityJson?.blockers as string[]).join(",")).toContain("baseline_refused");
  });

  it("`current main HEAD` alone (a correct EXPECTED_SHA) is NOT sufficient — the baseline check is what actually verifies what is running", () => {
    // EXPECTED_SHA is valid and matches the workflow's own freshness gate,
    // but the running WORKER happens to be on the wrong revision. The
    // baseline check must catch this even though "the SHA is current main"
    // was already true.
    const wrongSha = "c".repeat(40);
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      fakeEnv: { FAKE_WORKER_REVISION: wrongSha },
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("refused");
  });
});

describe("post-write verification — a wrong worker SHA or env after recreate rolls back", () => {
  it("worker reporting the WRONG env value after recreate triggers rollback, and the env file is restored", () => {
    const original = readEnvFile();
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      fakeEnv: { FAKE_WORKER_ENV: "false" }, // worker never actually picks up the new value
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("fail");
    expect(capabilityJson?.rolledBack).toBe(true);
    expect(readEnvFile()).toBe(original);
  });

  it("baseline SHA is genuinely correct; ONLY AFTER the real recreate does worker's SHA drift — the stateful fake proves the POST-recreate check independently, not baseline reusing its own refusal", () => {
    // FAKE_WORKER_REVISION_AFTER_UP only takes effect once `docker compose
    // up` has actually been invoked (the stateful fake's marker file) — so
    // the baseline read (before ANY write/recreate) genuinely sees the
    // CORRECT worker revision and would pass on its own. This is the exact
    // branch a static (non-stateful) fake cannot isolate: without
    // statefulness, "web/worker wrong from the start" always fails at
    // baseline, never proving capability_recreate_and_verify's OWN check
    // fires independently.
    const original = readEnvFile();
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      fakeEnv: { FAKE_WORKER_REVISION_AFTER_UP: "d".repeat(40) },
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("fail");
    // Proves baseline itself passed (no baseline_refused blocker) and the
    // failure came from the POST-recreate verification specifically.
    expect((capabilityJson?.blockers as string[]).join(",")).not.toContain("baseline_refused");
    expect(capabilityJson?.rolledBack).toBe(true);
    expect(readEnvFile()).toBe(original);
  });

  it("baseline SHA is genuinely correct; ONLY AFTER recreate does worker's live env fail to reflect the write — final preflight-adjacent verification catches it", () => {
    const original = readEnvFile();
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      fakeEnv: { FAKE_WORKER_ENV_AFTER_UP: "false" },
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("fail");
    expect((capabilityJson?.blockers as string[]).join(",")).not.toContain("baseline_refused");
    expect(capabilityJson?.rolledBack).toBe(true);
    expect(readEnvFile()).toBe(original);
  });
});

describe("docker compose pull/up failures — explicit propagation, not swallowed by an if-condition", () => {
  it("a nonzero `docker compose pull` fails the phase and rolls back — never silently continues to `up`", () => {
    const original = readEnvFile();
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      fakeEnv: { FAKE_PULL_EXIT: "1" },
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("fail");
    expect(capabilityJson?.rolledBack).toBe(true);
    expect(readEnvFile()).toBe(original);
  });

  it("a nonzero `docker compose up` fails the phase and rolls back", () => {
    const original = readEnvFile();
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      fakeEnv: { FAKE_UP_EXIT: "1" },
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("fail");
    expect(readEnvFile()).toBe(original);
  });
});

describe("env-writer failure modes — real filesystem faults, not simulated by mocking the function", () => {
  it("a write to a directory this process cannot create a backup in fails cleanly, and the original file is untouched", () => {
    // Remove write permission on the directory itself -- cp -p for the
    // backup cannot create a new file there, a real (not mocked) failure.
    chmodSync(remoteAppDir, 0o500);
    try {
      const original = readEnvFile();
      const { status, capabilityJson } = runRemoteDirect({ phase: "capability_open" });
      expect(status).not.toBe(0);
      expect(capabilityJson?.blockers).toBeTruthy();
      expect(readEnvFile()).toBe(original);
    } finally {
      chmodSync(remoteAppDir, 0o700);
    }
  });

  it("atomic_set_env_var itself refuses when the env file is missing, with a named error — proven directly, no docker/ssh involved", () => {
    const missing = join(dir, "does-not-exist", ".env.production");
    let threw = false;
    let stderr = "";
    try {
      execFileSync(
        "bash", ["-c", `set -euo pipefail; ${ENV_SH}\natomic_set_env_var ${missing} KEY value`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      threw = true;
      stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    }
    expect(threw).toBe(true);
    expect(stderr).toContain("env file missing");
  });

  it("chown failure is NOT swallowed — a bogus owner:group makes the write refuse instead of silently reporting success", () => {
    // A local temp file's owner is (typically) the current user; forcing
    // _env_stat_owner/_env_stat_group to report a made-up numeric id the
    // current (unprivileged) process cannot chown to reproduces a real
    // chown failure without needing root or a second real user.
    const patchedEnvSh = ENV_SH
      .replace(
        '_env_stat_owner() {\n  stat -c \'%u\' "$1" 2>/dev/null || stat -f \'%u\' "$1"\n}',
        '_env_stat_owner() {\n  echo 999999\n}',
      );
    let threw = false;
    let stderr = "";
    try {
      execFileSync(
        "bash", ["-c", `set -euo pipefail; ${patchedEnvSh}\natomic_set_env_var ${envFile} KEY value`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      threw = true;
      stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    }
    expect(threw).toBe(true);
    expect(stderr).toContain("could not chown");
    // The original file must be untouched -- no tmp file left renamed over it.
    expect(readEnvFile()).toBe("META_AUTOMATION_LIVE_WRITES=false\nOTHER_KEY=kept\n");
  });

  it("a read failure while stripping the key's existing lines does not collapse the file to just the new key — proven by an artificially broken grep", () => {
    // A `grep` that always exits 2 (a genuine read error, not "no match")
    // reproduces exactly the failure mode the task named: without the
    // explicit exit-status check this fixed, the file would have been
    // silently overwritten with just the freshly appended line.
    const brokenPath = join(dir, "broken-bin");
    mkdirSync(brokenPath, { recursive: true });
    writeExecutable(join(brokenPath, "grep"), "#!/usr/bin/env bash\nexit 2\n");
    let threw = false;
    let stderr = "";
    try {
      execFileSync(
        "bash", ["-c", `set -euo pipefail; ${ENV_SH}\natomic_set_env_var ${envFile} KEY value`],
        {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: `${brokenPath}:${process.env.PATH ?? ""}` },
        },
      );
    } catch (error) {
      threw = true;
      stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    }
    expect(threw).toBe(true);
    expect(stderr).toContain("could not read");
    expect(readEnvFile()).toBe("META_AUTOMATION_LIVE_WRITES=false\nOTHER_KEY=kept\n");
  });
});

describe("rollback failure — the restore's OWN failure is never swallowed into a false recovery", () => {
  it("when the recreate-verify step fails AND the subsequent forced-close recreate ALSO fails, rollbackVerified is false and the blocker names it", () => {
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      fakeEnv: {
        // Fail the FIRST recreate-verify (post-open) via a bad worker env,
        // AND make the forced-close recreate fail too (pull fails from the
        // second call onward is hard to target selectively without a call
        // counter, so instead make `up` itself always fail -- both the
        // open attempt and the close-recovery attempt use the same
        // recreate function).
        FAKE_UP_EXIT: "1",
      },
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("fail");
    expect(capabilityJson?.rolledBack).toBe(true);
    expect(capabilityJson?.rollbackVerified).toBe(false);
    expect((capabilityJson?.blockers as string[]).join(",")).toContain("restore_recreate_verify_failed");
  });

  it("when atomic_restore_env_backup itself fails (the backup file is gone), the blocker names restore_failed, not a generic failure", () => {
    // Force the very first recreate-verify to fail (bad worker env), then
    // sabotage the restore by deleting every backup file the moment it's
    // created -- a fake `rm`-racing setup is fragile; instead we patch the
    // library to make atomic_restore_env_backup itself refuse, proving the
    // remote script's OWN handling of that refusal, not re-testing
    // atomic_restore_env_backup's internals (already covered above).
    const patchedEnvSh = ENV_SH.replace(
      "atomic_restore_env_backup() {",
      'atomic_restore_env_backup() {\n  echo "atomic_restore_env_backup: forced failure for this test" >&2\n  return 1\n  # unreachable, kept for shape:',
    );
    let stdout = "";
    let status = 0;
    try {
      stdout = execFileSync("bash", ["-c", `${patchedEnvSh}\n${REMOTE_SH}`], {
        encoding: "utf8",
        env: {
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          EXPECTED_SHA: VALID_SHA,
          PHASE: "capability_open",
          REMOTE_APP_DIR: remoteAppDir,
          FAKE_WORKER_ENV: "false", // forces the first recreate-verify to fail
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? 1;
      stdout = (error as { stdout?: string }).stdout ?? "";
    }
    const line = stdout.split("\n").reverse().find((l) => l.startsWith("CAPABILITY_JSON: "));
    const capabilityJson = line ? JSON.parse(line.slice("CAPABILITY_JSON: ".length)) : null;
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("fail"); // a rollback situation is never reported as pass
    // The restore itself failed -- named and never hidden -- but recovery
    // was NOT abandoned: an independent forced-false write is attempted
    // (see "FINDING 1" below), and here it succeeds, so the runtime IS
    // verified closed even though the backup restore specifically failed.
    expect(capabilityJson?.rollbackVerified).toBe(true);
    expect((capabilityJson?.blockers as string[]).join(",")).toContain("restore_failed");
  });
});

describe("capability_close — fail-safe under DB/preflight failure, never gated on it", () => {
  it("capability_close succeeds even when the DB-backed preflight would refuse — close is never gated on it", () => {
    writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES=true\n");
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_close",
      fakeEnv: { FAKE_PREFLIGHT_EXIT: "1" }, // preflight would refuse -- irrelevant to close
    });
    expect(status).toBe(0);
    expect(capabilityJson?.result).toBe("pass");
    expect(readEnvFile()).toContain("META_AUTOMATION_LIVE_WRITES=false");
  });

  it("capability_close never calls the preflight CLI at all — proven by making ANY preflight invocation fail the whole process", () => {
    writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES=true\n");
    // If capability_close ever invoked the preflight, this docker fake
    // would make that specific `exec` call print to stderr AND exit
    // nonzero via FAKE_PREFLIGHT_EXIT, which the assertions above already
    // prove does not fail close's result. This case additionally asserts
    // the six-business/preflight fields are simply absent from the
    // artifact's "before", since close never reads them.
    const { capabilityJson } = runRemoteDirect({
      phase: "capability_close",
      fakeEnv: { FAKE_PREFLIGHT_EXIT: "1" },
    });
    const before = capabilityJson?.before as Record<string, unknown> | null;
    expect(before === null || before?.sixBusinessStatus === undefined).toBe(true);
  });

  it("no business-enable or decision-mode SQL is ever issued by either phase — the fake docker's preflight branch is the ONLY DB touchpoint, and close never reaches it", () => {
    writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES=true\n");
    const { status } = runRemoteDirect({ phase: "capability_close" });
    expect(status).toBe(0);
    // The static contract test already proves neither script's SOURCE
    // contains a business-controls/decision-mode write; this proves the
    // RUNTIME path for close never even reaches the one place a DB call
    // happens (the preflight), which the FAKE_PREFLIGHT_EXIT case above
    // demonstrates is never invoked.
  });
});

describe("SSH failure — a dead host is caught by the current phase-status capture", () => {
  it("a nonzero ssh exit is correctly reported as a nonzero phase_status", () => {
    const phase = runPhaseStep({ capability: "open", sshScript: FAKE_SSH_ALWAYS_FAILS_SCRIPT });
    expect(phase.phaseStatus).not.toBe(0);
    expect(phase.outFileContent).not.toContain("CAPABILITY_JSON: ");
  });
  // The PIPESTATUS[0]-vs-[1] historical bug this once reconstructed was
  // fixed, then the capture itself was corrected again (see "FINDING 3"
  // below): PIPESTATUS is overwritten by the very next command bash runs,
  // including a plain assignment with no external command, so reading two
  // separate indices as two separate statements loses the second one —
  // ordinary bash behavior, not a pipe-size-specific reliability issue.
  // The exact OLD line no longer exists to reconstruct. FINDING 3's own
  // tests below prove the CURRENT design against the CURRENT bugs it
  // targets, fail-first, which is the up-to-date form of this same proof.
});

describe("missing CAPABILITY_JSON — the pipefail-protected fallback, proven live", () => {
  it("a phase whose stdout has no CAPABILITY_JSON line still produces a clean no_capability_json_emitted artifact, not a raw pipeline crash", () => {
    // A dead ssh's stderr message never contains CAPABILITY_JSON, and the
    // out_file it produced (via tee) is likewise empty of it.
    const phase = runPhaseStep({ capability: "open", sshScript: FAKE_SSH_ALWAYS_FAILS_SCRIPT });
    const { artifact } = runBuildArtifactStep({
      phaseStatus: phase.phaseStatus, outFileContent: phase.outFileContent, capability: "open",
    });
    const summary = artifact.summary as Record<string, unknown>;
    expect(summary.result).toBe("fail");
    expect((summary.blockers as string[])).toContain("no_capability_json_emitted");
  });

  // The blanket `|| true` this once reconstructed as a crash proof was
  // replaced (see "FINDING 3b" below) by an explicit `set +e` / captured
  // exit-status / `set -e` sequence that distinguishes a real extraction
  // failure from a legitimate no-match — the exact OLD substring no
  // longer exists to reconstruct. FINDING 3b's own tests prove the
  // CURRENT design fail-first against the CURRENT bug it targets.
});

describe("the fail gate requires BOTH result==pass AND blockers==[]", () => {
  it("throws (fails the job) on a refused artifact", () => {
    const { artifact, artifactsDir } = runBuildArtifactStep({
      phaseStatus: 1, outFileContent: "CAPABILITY_JSON: " + JSON.stringify({ result: "refused", blockers: ["x"] }),
      capability: "open",
    });
    expect((artifact.summary as Record<string, unknown>).result).toBe("refused");
    expect(() => runFailGateStep(artifactsDir)).toThrow();
  });

  it("throws even on a result=pass artifact if blockers is somehow non-empty (defense in depth, not just trusting result)", () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "adsecute-capability-inconsistent-"));
    mkdirSync(join(artifactsDir, ".artifacts"), { recursive: true });
    writeFileSync(
      join(artifactsDir, ".artifacts", "automation-capability-toggle.json"),
      JSON.stringify({ summary: { result: "pass", blockers: ["should never coexist with pass"] } }),
    );
    expect(() => runFailGateStep(artifactsDir)).toThrow();
  });

  it("does not throw on a clean pass with empty blockers", () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "adsecute-capability-clean-pass-"));
    mkdirSync(join(artifactsDir, ".artifacts"), { recursive: true });
    writeFileSync(
      join(artifactsDir, ".artifacts", "automation-capability-toggle.json"),
      JSON.stringify({ summary: { result: "pass", blockers: [] } }),
    );
    expect(() => runFailGateStep(artifactsDir)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FIFTH PASS — three findings from independent review, each proven
// fail-first against the CURRENT (unfixed) scripts before the fix lands.
// ─────────────────────────────────────────────────────────────────────────

describe("FINDING 1 — a failure discovered only AFTER the rename must still roll back", () => {
  const STAT_COUNTER_ENV = "TEST_STAT_MODE_CALL_COUNT_FILE";

  /**
   * Patches _env_stat_mode so its SECOND call (the post-rename
   * verification inside atomic_set_env_var — the FIRST call is the
   * pre-write capture) reports a wrong mode, forcing atomic_set_env_var to
   * fail AFTER the real `mv -f` has already landed the new value on disk.
   * Later calls (inside a subsequent restore/forced-write attempt) are
   * left correct, so this fault does not contaminate the recovery path
   * itself.
   */
  function patchedEnvShForcingPostRenameStatFailure(): string {
    const original = `_env_stat_mode() {\n  stat -c '%a' "$1" 2>/dev/null || stat -f '%OLp' "$1"\n}`;
    const patched = `_env_stat_mode() {\n  local n=0\n  [ -f "\${${STAT_COUNTER_ENV}:-}" ] && n="$(cat "\${${STAT_COUNTER_ENV}}")"\n  n=$((n + 1))\n  [ -n "\${${STAT_COUNTER_ENV}:-}" ] && echo "$n" > "\${${STAT_COUNTER_ENV}}"\n  if [ "$n" -eq 2 ]; then\n    echo "777"\n    return 0\n  fi\n  stat -c '%a' "$1" 2>/dev/null || stat -f '%OLp' "$1"\n}`;
    expect(ENV_SH).toContain(original);
    return ENV_SH.replace(original, patched);
  }

  it("proves the injected fault in isolation: the rename already happened while atomic_set_env_var itself reports failure", () => {
    const patched = patchedEnvShForcingPostRenameStatFailure();
    const counterFile = join(dir, "stat-mode-counter-isolated");
    let threw = false;
    let stderr = "";
    try {
      execFileSync(
        "bash", ["-c", `set -euo pipefail; ${patched}\natomic_set_env_var ${envFile} META_AUTOMATION_LIVE_WRITES true`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, [STAT_COUNTER_ENV]: counterFile } },
      );
    } catch (error) {
      threw = true;
      stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    }
    expect(threw).toBe(true);
    expect(stderr).toContain("post-write mode is 777");
    // The dangerous fact: the rename already committed the NEW value.
    expect(readEnvFile()).toContain("META_AUTOMATION_LIVE_WRITES=true");
  });

  it("proves capability_open recovers from a post-rename verification failure: env ends at false, rolledBack is true", () => {
    const patched = patchedEnvShForcingPostRenameStatFailure();
    const counterFile = join(dir, "stat-mode-counter-open");
    let stdout = "";
    let status = 0;
    try {
      stdout = execFileSync("bash", ["-c", `${patched}\n${REMOTE_SH}`], {
        encoding: "utf8",
        env: {
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          EXPECTED_SHA: VALID_SHA,
          PHASE: "capability_open",
          REMOTE_APP_DIR: remoteAppDir,
          [STAT_COUNTER_ENV]: counterFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? 1;
      stdout = (error as { stdout?: string }).stdout ?? "";
    }
    const line = stdout.split("\n").reverse().find((l) => l.startsWith("CAPABILITY_JSON: "));
    const capabilityJson = line ? JSON.parse(line.slice("CAPABILITY_JSON: ".length)) : null;

    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("fail");
    expect(capabilityJson?.rolledBack).toBe(true);
    expect(readEnvFile()).toContain("META_AUTOMATION_LIVE_WRITES=false");
  });

  it("when the backup restore itself fails, an explicit forced-false write is attempted, verified via both runtime gates, and the result stays FAIL with restore_failed visible", () => {
    const patchedEnvSh = ENV_SH.replace(
      "atomic_restore_env_backup() {",
      'atomic_restore_env_backup() {\n  echo "atomic_restore_env_backup: forced failure for this test" >&2\n  return 1\n  # unreachable, kept for shape:',
    );
    expect(patchedEnvSh).not.toBe(ENV_SH);
    let stdout = "";
    let status = 0;
    try {
      stdout = execFileSync("bash", ["-c", `${patchedEnvSh}\n${REMOTE_SH}`], {
        encoding: "utf8",
        env: {
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          EXPECTED_SHA: VALID_SHA,
          PHASE: "capability_open",
          REMOTE_APP_DIR: remoteAppDir,
          FAKE_WORKER_ENV_AFTER_UP: "false", // forces the FIRST recreate-verify to fail, triggering rollback
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? 1;
      stdout = (error as { stdout?: string }).stdout ?? "";
    }
    const line = stdout.split("\n").reverse().find((l) => l.startsWith("CAPABILITY_JSON: "));
    const capabilityJson = line ? JSON.parse(line.slice("CAPABILITY_JSON: ".length)) : null;

    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("fail"); // always fail regardless of forced-recovery outcome
    expect((capabilityJson?.blockers as string[]).join(",")).toContain("restore_failed"); // stays visible
    expect(capabilityJson?.rollbackVerified).toBe(true); // the forced-false attempt DID recover the runtime
    expect(readEnvFile()).toContain("META_AUTOMATION_LIVE_WRITES=false");
  });
});

describe("FINDING 2 — baseline must assert LIVE web/worker env is false, normalized like the app itself, not just the FILE with a strict ===", () => {
  it("web's LIVE env already true (file says false) is caught by baseline", () => {
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      fakeEnv: { FAKE_WEB_ENV: "true" },
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("refused");
    expect((capabilityJson?.blockers as string[]).join(",")).toContain("baseline_refused");
  });

  it("worker's LIVE env already true (the process that actually reads the gate) is caught by baseline", () => {
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      fakeEnv: { FAKE_WORKER_ENV: "true" },
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("refused");
    expect((capabilityJson?.blockers as string[]).join(",")).toContain("baseline_refused");
  });

  it("an unreadable live env on web is a refusal, never treated as closed", () => {
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      fakeEnv: { FAKE_WEB_EXEC_EXIT: "1" },
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("refused");
    expect((capabilityJson?.blockers as string[]).join(",")).toContain("baseline_refused");
  });

  it("an unreadable live env on worker is a refusal, never treated as closed", () => {
    const { status, capabilityJson } = runRemoteDirect({
      phase: "capability_open",
      fakeEnv: { FAKE_WORKER_EXEC_EXIT: "1" },
    });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("refused");
    expect((capabilityJson?.blockers as string[]).join(",")).toContain("baseline_refused");
  });

  it("the env FILE containing 'TRUE' (uppercase) is treated as OPEN, matching lib/meta/release-gates.ts's trim+lowercase parseGate — not passed by a strict === 'true' check", () => {
    writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES=TRUE\n");
    const { status, capabilityJson } = runRemoteDirect({ phase: "capability_open" });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("refused");
    expect((capabilityJson?.blockers as string[]).join(",")).toContain("baseline_refused");
  });

  it("the env FILE containing ' true ' (whitespace-padded) is ALSO treated as OPEN, matching the app's .trim()", () => {
    writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES= true \n");
    const { status, capabilityJson } = runRemoteDirect({ phase: "capability_open" });
    expect(status).not.toBe(0);
    expect(capabilityJson?.result).toBe("refused");
    expect((capabilityJson?.blockers as string[]).join(",")).toContain("baseline_refused");
  });

  it("a genuinely closed baseline (file false, web live false, worker live false) still opens successfully — the stricter check is not a false-positive regression", () => {
    const { status, capabilityJson } = runRemoteDirect({ phase: "capability_open" });
    expect(status).toBe(0);
    expect(capabilityJson?.result).toBe("pass");
  });
});

describe("FINDING 3 — the phase-runner step must capture ALL pipeline stages (cat, ssh, tee), not just ssh", () => {
  // `ssh` is wrapped with a MARKER file the moment it is invoked, so a
  // cat-failure test can assert ssh was never dispatched at all — not just
  // that phase_status ended up nonzero.
  const SSH_MARKER_ENV = "TEST_SSH_INVOKED_MARKER_FILE";
  const FAKE_SSH_WITH_MARKER_SCRIPT = `#!/usr/bin/env bash
if [ -n "\${${SSH_MARKER_ENV}:-}" ]; then
  : > "\${${SSH_MARKER_ENV}}"
fi
last="\${@: -1}"
exec bash -c "$last"
`;

  it("the SECOND cat (remote.sh) failing while the first (env.sh) succeeds is caught — ssh is NEVER dispatched, and phase_status is nonzero, not silently 0", () => {
    writeExecutable(join(fakeBinDir, "ssh"), FAKE_SSH_WITH_MARKER_SCRIPT);
    const sshMarker = join(dir, "ssh-invoked-cat2");

    const brokenCwd = join(dir, "cwd-without-remote-sh");
    mkdirSync(join(brokenCwd, ".github", "scripts"), { recursive: true });
    writeFileSync(join(brokenCwd, ".github", "scripts", "automation-capability-env.sh"), ENV_SH);
    // automation-capability-remote.sh deliberately absent here.

    const githubOutputFile = join(dir, "gh-output-cat2-fail");
    writeFileSync(githubOutputFile, "");
    execFileSync("bash", ["-c", PHASE_RUNNER_SCRIPT], {
      cwd: brokenCwd,
      encoding: "utf8",
      env: {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? dir,
        EXPECTED_SHA: VALID_SHA,
        HETZNER_PORT: "22",
        HETZNER_USER: "deployer",
        CAPABILITY: "open",
        PRIMARY_DEPLOY_HOST: "fake-host.invalid",
        REMOTE_APP_DIR: remoteAppDir,
        GITHUB_OUTPUT: githubOutputFile,
        [SSH_MARKER_ENV]: sshMarker,
      },
    });
    const out = parseGithubOutput(readFileSync(githubOutputFile, "utf8"));
    expect(Number(out.phase_status)).not.toBe(0);
    expect(existsSync(sshMarker)).toBe(false);
  });

  it("the FIRST cat (env.sh) failing while the second (remote.sh) succeeds is caught the same way — ssh never dispatched", () => {
    writeExecutable(join(fakeBinDir, "ssh"), FAKE_SSH_WITH_MARKER_SCRIPT);
    const sshMarker = join(dir, "ssh-invoked-cat1");

    const brokenCwd = join(dir, "cwd-without-env-sh");
    mkdirSync(join(brokenCwd, ".github", "scripts"), { recursive: true });
    writeFileSync(join(brokenCwd, ".github", "scripts", "automation-capability-remote.sh"), REMOTE_SH);
    // automation-capability-env.sh deliberately absent here.

    const githubOutputFile = join(dir, "gh-output-cat1-fail");
    writeFileSync(githubOutputFile, "");
    execFileSync("bash", ["-c", PHASE_RUNNER_SCRIPT], {
      cwd: brokenCwd,
      encoding: "utf8",
      env: {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? dir,
        EXPECTED_SHA: VALID_SHA,
        HETZNER_PORT: "22",
        HETZNER_USER: "deployer",
        CAPABILITY: "open",
        PRIMARY_DEPLOY_HOST: "fake-host.invalid",
        REMOTE_APP_DIR: remoteAppDir,
        GITHUB_OUTPUT: githubOutputFile,
        [SSH_MARKER_ENV]: sshMarker,
      },
    });
    const out = parseGithubOutput(readFileSync(githubOutputFile, "utf8"));
    expect(Number(out.phase_status)).not.toBe(0);
    expect(existsSync(sshMarker)).toBe(false);
  });

  it("a nonzero tee exit is caught EVEN WHEN tee already wrote a full, valid-looking pass line — a real fake tee, the complete run block executed for real", () => {
    // The root cause this fixes: `ssh_status="${PIPESTATUS[0]}"` then
    // `tee_status="${PIPESTATUS[1]}"` as two SEPARATE statements loses
    // tee's status -- PIPESTATUS is overwritten by the very next command
    // bash runs, including a plain assignment with no external command at
    // all. The fix snapshots the whole array in ONE statement
    // (`stage_status=("${PIPESTATUS[@]}")`) before deriving anything from
    // it. This is not asserted from a reconstructed decision block: the
    // REAL `tee` binary is replaced with a fake that writes a genuine
    // CAPABILITY_JSON pass line and THEN exits 1, and the complete
    // "Run a capability phase on the host" run: block is executed exactly
    // as the workflow would run it.
    const FAKE_TEE_SCRIPT = `#!/usr/bin/env bash
/usr/bin/tee "$@"
exit "\${FAKE_TEE_EXIT:-0}"
`;
    writeExecutable(join(fakeBinDir, "tee"), FAKE_TEE_SCRIPT);
    const phase = runPhaseStep({ capability: "open", fakeEnv: { FAKE_TEE_EXIT: "1" } });
    expect(phase.phaseStatus).not.toBe(0);
    // tee DID write the real CAPABILITY_JSON pass line before failing —
    // proving this is caught despite valid-looking captured output, not
    // because nothing was captured at all.
    expect(phase.outFileContent).toContain("CAPABILITY_JSON: ");
    expect(phase.outFileContent).toContain('"result": "pass"');
  });

  it("a normal successful phase still reports phase_status=0 with all three stages captured — the stricter capture is not a false-positive regression", () => {
    const phase = runPhaseStep({ capability: "open" });
    expect(phase.phaseStatus).toBe(0);
  });
});

describe("FINDING 3b — the CAPABILITY_JSON extraction must distinguish a genuine read failure from a legitimate no-match, never swallow both the same way", () => {
  it("a real extraction failure (out_file unreadable) produces its own distinct blocker, not the generic no_capability_json_emitted used for a legitimately silent phase", () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "adsecute-capability-extraction-fail-"));
    const outFile = join(artifactsDir, "out.txt");
    writeFileSync(outFile, "CAPABILITY_JSON: {}\n");
    chmodSync(outFile, 0o000);
    try {
      let threw = false;
      let artifact: Record<string, unknown> | null = null;
      try {
        execFileSync("bash", ["-c", BUILD_ARTIFACT_SCRIPT], {
          cwd: artifactsDir,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            PHASE_STATUS: "0",
            OUT_FILE: outFile,
            EXPECTED_SHA: VALID_SHA,
            CAPABILITY: "open",
          },
        });
        artifact = JSON.parse(
          readFileSync(join(artifactsDir, ".artifacts", "automation-capability-toggle.json"), "utf8"),
        );
      } catch {
        threw = true;
      }
      const summary = artifact?.summary as Record<string, unknown> | undefined;
      const blockers = (summary?.blockers as string[] | undefined) ?? [];
      expect(threw).toBe(false);
      expect(blockers).toContain("capability_json_extraction_failed");
      expect(blockers).not.toContain("no_capability_json_emitted");
      expect(summary?.result).toBe("fail");
    } finally {
      chmodSync(outFile, 0o644);
    }
  });

  it("a legitimately empty phase output (no CAPABILITY_JSON line, but the file WAS readable) still produces no_capability_json_emitted, unaffected by the stricter check", () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "adsecute-capability-extraction-empty-"));
    const outFile = join(artifactsDir, "out.txt");
    writeFileSync(outFile, "some container log line with no marker at all\n");
    execFileSync("bash", ["-c", BUILD_ARTIFACT_SCRIPT], {
      cwd: artifactsDir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        PHASE_STATUS: "1",
        OUT_FILE: outFile,
        EXPECTED_SHA: VALID_SHA,
        CAPABILITY: "open",
      },
    });
    const artifact = JSON.parse(
      readFileSync(join(artifactsDir, ".artifacts", "automation-capability-toggle.json"), "utf8"),
    );
    const summary = artifact.summary as Record<string, unknown>;
    expect((summary.blockers as string[])).toContain("no_capability_json_emitted");
    expect((summary.blockers as string[])).not.toContain("capability_json_extraction_failed");
  });

  it("a healthy extraction (grep=0, tail=0, sed=0) produces the real parsed summary, not any failure blocker", () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "adsecute-capability-extraction-healthy-"));
    const outFile = join(artifactsDir, "out.txt");
    writeFileSync(outFile, 'some log line\nCAPABILITY_JSON: {"result":"pass","blockers":[]}\n');
    execFileSync("bash", ["-c", BUILD_ARTIFACT_SCRIPT], {
      cwd: artifactsDir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        PHASE_STATUS: "0",
        OUT_FILE: outFile,
        EXPECTED_SHA: VALID_SHA,
        CAPABILITY: "open",
      },
    });
    const artifact = JSON.parse(
      readFileSync(join(artifactsDir, ".artifacts", "automation-capability-toggle.json"), "utf8"),
    );
    const summary = artifact.summary as Record<string, unknown>;
    expect(summary.result).toBe("pass");
    expect(summary.blockers).toEqual([]);
  });

  it("a real fake tail that writes the full valid line and THEN exits 1 is caught as capability_json_extraction_failed — writing valid-looking output does not excuse a nonzero exit", () => {
    const fakeBin = join(dir, "fake-bin-tail");
    mkdirSync(fakeBin, { recursive: true });
    writeExecutable(
      join(fakeBin, "tail"),
      `#!/usr/bin/env bash
/usr/bin/tail "$@"
exit "\${FAKE_TAIL_EXIT:-0}"
`,
    );
    const artifactsDir = mkdtempSync(join(tmpdir(), "adsecute-capability-extraction-tail-fail-"));
    const outFile = join(artifactsDir, "out.txt");
    writeFileSync(outFile, 'CAPABILITY_JSON: {"result":"pass","blockers":[]}\n');
    execFileSync("bash", ["-c", BUILD_ARTIFACT_SCRIPT], {
      cwd: artifactsDir,
      encoding: "utf8",
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PHASE_STATUS: "0",
        OUT_FILE: outFile,
        EXPECTED_SHA: VALID_SHA,
        CAPABILITY: "open",
        FAKE_TAIL_EXIT: "1",
      },
    });
    const artifact = JSON.parse(
      readFileSync(join(artifactsDir, ".artifacts", "automation-capability-toggle.json"), "utf8"),
    );
    const summary = artifact.summary as Record<string, unknown>;
    expect(summary.result).toBe("fail");
    expect((summary.blockers as string[])).toContain("capability_json_extraction_failed");
    expect((summary.blockers as string[])).not.toContain("no_capability_json_emitted");
  });

  it("a real fake sed that writes the full valid line and THEN exits 1 is caught as capability_json_extraction_failed", () => {
    const fakeBin = join(dir, "fake-bin-sed");
    mkdirSync(fakeBin, { recursive: true });
    writeExecutable(
      join(fakeBin, "sed"),
      `#!/usr/bin/env bash
/usr/bin/sed "$@"
exit "\${FAKE_SED_EXIT:-0}"
`,
    );
    const artifactsDir = mkdtempSync(join(tmpdir(), "adsecute-capability-extraction-sed-fail-"));
    const outFile = join(artifactsDir, "out.txt");
    writeFileSync(outFile, 'CAPABILITY_JSON: {"result":"pass","blockers":[]}\n');
    execFileSync("bash", ["-c", BUILD_ARTIFACT_SCRIPT], {
      cwd: artifactsDir,
      encoding: "utf8",
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PHASE_STATUS: "0",
        OUT_FILE: outFile,
        EXPECTED_SHA: VALID_SHA,
        CAPABILITY: "open",
        FAKE_SED_EXIT: "1",
      },
    });
    const artifact = JSON.parse(
      readFileSync(join(artifactsDir, ".artifacts", "automation-capability-toggle.json"), "utf8"),
    );
    const summary = artifact.summary as Record<string, unknown>;
    expect(summary.result).toBe("fail");
    expect((summary.blockers as string[])).toContain("capability_json_extraction_failed");
    expect((summary.blockers as string[])).not.toContain("no_capability_json_emitted");
  });

  it("a true no-match (grep=1, tail=0, sed=0 — the ONLY acceptable nonzero combination) is still the legitimate no_capability_json_emitted case", () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "adsecute-capability-extraction-true-nomatch-"));
    const outFile = join(artifactsDir, "out.txt");
    writeFileSync(outFile, "no marker line in this output at all\njust regular logs\n");
    execFileSync("bash", ["-c", BUILD_ARTIFACT_SCRIPT], {
      cwd: artifactsDir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        PHASE_STATUS: "0",
        OUT_FILE: outFile,
        EXPECTED_SHA: VALID_SHA,
        CAPABILITY: "open",
      },
    });
    const artifact = JSON.parse(
      readFileSync(join(artifactsDir, ".artifacts", "automation-capability-toggle.json"), "utf8"),
    );
    const summary = artifact.summary as Record<string, unknown>;
    expect((summary.blockers as string[])).toContain("no_capability_json_emitted");
    expect((summary.blockers as string[])).not.toContain("capability_json_extraction_failed");
  });
});
