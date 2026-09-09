/**
 * PRE-DEPLOY AUDIT — the capability-toggle workflow's own safety invariants,
 * asserted statically. GitHub Actions cannot be executed in this repository
 * (no host, no runner, no secrets), so this is the deterministic proof that
 * the YAML itself carries every safety property the task requires: manual
 * dispatch only, the exact concurrency group deploy-hetzner.yml uses, a
 * default-closed capability, a required typed confirmation for open, and an
 * artifact that is uploaded on every outcome — pass or fail.
 */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const PATH = ".github/workflows/automation-capability-toggle.yml";
const SOURCE = readFileSync(PATH, "utf8");
const REMOTE_SOURCE = readFileSync(".github/scripts/automation-capability-remote.sh", "utf8");
const DOC = yaml.load(SOURCE) as Record<string, unknown>;

describe("automation-capability-toggle.yml — parses and is dispatch-only", () => {
  it("parses as valid YAML with exactly one job", () => {
    expect(DOC).toBeTruthy();
    const jobs = DOC.jobs as Record<string, unknown>;
    expect(Object.keys(jobs)).toEqual(["toggle"]);
  });

  it("triggers ONLY on workflow_dispatch — no push, schedule, or pull_request", () => {
    // YAML 1.1 loads a bare `on:` key as boolean `true`.
    const on = (DOC.on ?? DOC[true as unknown as string]) as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
  });

  it("declares no cron schedule anywhere in the source", () => {
    expect(SOURCE).not.toMatch(/schedule:/);
    expect(SOURCE).not.toMatch(/cron:/);
  });
});

describe("automation-capability-toggle.yml — inputs are exactly what the task specifies", () => {
  const inputs = (
    (DOC.on ?? DOC[true as unknown as string]) as { workflow_dispatch: { inputs: Record<string, unknown> } }
  ).workflow_dispatch.inputs;

  it("sha is required, no default", () => {
    expect((inputs.sha as { required?: boolean }).required).toBe(true);
  });

  it("capability is a closed/open choice, defaulting to closed", () => {
    const capability = inputs.capability as { type: string; default: string; options: string[] };
    expect(capability.type).toBe("choice");
    expect(capability.default).toBe("closed");
    expect(capability.options.sort()).toEqual(["closed", "open"]);
  });

  it("confirm_open exists and defaults to empty (so a bare dispatch cannot open)", () => {
    const confirm = inputs.confirm_open as { default: string };
    expect(confirm.default).toBe("");
  });

  it("require_current_main_head defaults to true", () => {
    expect((inputs.require_current_main_head as { default: string }).default).toBe("true");
  });
});

describe("automation-capability-toggle.yml — the exact-40-char SHA gate", () => {
  it("validates length and hex-lowercase, mirroring deploy-hetzner.yml's own gate", () => {
    expect(SOURCE).toContain('[ "${#sha}" -ne 40 ]');
    expect(SOURCE).toContain("*[!0-9a-f]*");
  });
});

describe("automation-capability-toggle.yml — stale close is never a green no-op", () => {
  it("ships current-main safety code for close while preserving the caller SHA as evidence", () => {
    expect(SOURCE).toContain('if [ "${CAPABILITY}" = "closed" ]; then');
    expect(SOURCE).toContain('echo "should_run=true" >> "$GITHUB_OUTPUT"');
    expect(SOURCE).toContain('echo "stale_close=true" >> "$GITHUB_OUTPUT"');
    expect(SOURCE).toContain('echo "checkout_sha=${current_main_sha}" >> "$GITHUB_OUTPUT"');
    expect(SOURCE).toContain("ref: ${{ steps.freshness.outputs.checkout_sha }}");
    expect(SOURCE).toContain("EXPECTED_SHA=${REQUESTED_SHA} REQUESTED_SHA=${REQUESTED_SHA}");
  });

  it("resolves close's effective SHA only from matching running web+worker identities plus web build-info", () => {
    expect(REMOTE_SOURCE).toContain("capability_resolve_running_release");
    expect(REMOTE_SOURCE).toContain('web_revision="$(capability_container_label web org.opencontainers.image.revision)"');
    expect(REMOTE_SOURCE).toContain('worker_revision="$(capability_container_label worker org.opencontainers.image.revision)"');
    expect(REMOTE_SOURCE).toContain('if [ "${web_revision}" != "${worker_revision}" ]; then');
    expect(REMOTE_SOURCE).toContain('if [ "${build_id}" != "${web_revision}" ]; then');
    expect(REMOTE_SOURCE).toContain('EFFECTIVE_SHA="${CAP_RUNNING_SHA}"');
    expect(REMOTE_SOURCE).toContain('capability_recreate_and_verify "false" "${EFFECTIVE_SHA}"');
  });

  it("persists false before any runtime read and bounds each subsequent HTTP/Docker read", () => {
    expect(REMOTE_SOURCE).toContain(
      'CAPABILITY_BUILD_INFO_MAX_TIME_SECONDS="${CAPABILITY_BUILD_INFO_MAX_TIME_SECONDS:-10}"',
    );
    expect(REMOTE_SOURCE).toContain("1|2|3|4|5|6|7|8|9|10)");
    expect(REMOTE_SOURCE).toContain(
      'curl -fsS --max-time "${CAPABILITY_BUILD_INFO_MAX_TIME_SECONDS}" "${CAPABILITY_BUILD_INFO_URL}"',
    );
    expect(REMOTE_SOURCE).toContain('build_json="$(capability_wait_for_build_info 3 1)"');

    const closeStart = REMOTE_SOURCE.indexOf("capability_close() {");
    const closeSource = REMOTE_SOURCE.slice(closeStart);
    expect(closeSource.indexOf("capability_resolve_running_release")).toBeGreaterThan(0);
    const falseWrite = closeSource.indexOf('atomic_set_env_var "${ENV_FILE}" "${ENV_KEY}" "false"');
    expect(falseWrite).toBeGreaterThan(0);
    expect(falseWrite).toBeLessThan(closeSource.indexOf("capability_state_snapshot"));
    expect(falseWrite).toBeLessThan(
      closeSource.indexOf("capability_resolve_running_release"),
    );
    expect(REMOTE_SOURCE).toContain('CAPABILITY_DOCKER_READ_MAX_TIME_SECONDS="${CAPABILITY_DOCKER_READ_MAX_TIME_SECONDS:-10}"');
    expect(REMOTE_SOURCE).toContain("os.killpg(child.pid, signal.SIGKILL)");
    expect(REMOTE_SOURCE).not.toMatch(/\$\(docker (compose ps|inspect)/);
    expect(REMOTE_SOURCE).toContain('capability_docker_read compose exec -T "${service}" node -e');
  });

  it("stops both writer services without selecting an image when close identity is unprovable, retaining a failed result", () => {
    expect(REMOTE_SOURCE).toContain('"running_release_identity_unverified,${CAP_EMERGENCY_STOP_BLOCKER}"');
    expect(REMOTE_SOURCE).toContain("docker compose stop --timeout 90 web worker");
    expect(REMOTE_SOURCE).toContain('capability_docker_read compose ps --all -q "${service}"');
    expect(REMOTE_SOURCE).toContain("runtime_emergency_stopped_degraded");
    expect(REMOTE_SOURCE).toContain("runtime_emergency_stop_unverified");
    expect(REMOTE_SOURCE).toContain('"effectiveSha": os.environ.get("EFFECTIVE_SHA") or None');
    expect(SOURCE).toContain('"requestedSha": requested_sha');
    expect(SOURCE).toContain('"effectiveSha": effective_sha');
  });
});

describe("automation-capability-toggle.yml — the typed confirmation for open", () => {
  it("requires the EXACT phrase OPEN_AUTOMATION_CAPABILITY when capability=open", () => {
    expect(SOURCE).toContain('"${CAPABILITY}" = "open" ] && [ "${CONFIRM_OPEN}" != "OPEN_AUTOMATION_CAPABILITY"');
  });

  it("the confirmation gate runs BEFORE the SSH/host step in the step list", () => {
    const validateAt = SOURCE.indexOf("Validate the capability request");
    const sshAt = SOURCE.indexOf("Run a capability phase on the host");
    expect(validateAt).toBeGreaterThan(0);
    expect(sshAt).toBeGreaterThan(validateAt);
  });
});

describe("automation-capability-toggle.yml — concurrency matches deploy-hetzner.yml exactly", () => {
  it("group is deploy-production-main, cancel-in-progress is false", () => {
    const concurrency = DOC.concurrency as { group: string; "cancel-in-progress": boolean };
    expect(concurrency.group).toBe("deploy-production-main");
    expect(concurrency["cancel-in-progress"]).toBe(false);
  });

  it("deploy-hetzner.yml itself still declares the SAME group — proving this is not a stale copy", () => {
    const deploySource = readFileSync(".github/workflows/deploy-hetzner.yml", "utf8");
    const deployDoc = yaml.load(deploySource) as { concurrency: { group: string; "cancel-in-progress": boolean } };
    expect(deployDoc.concurrency.group).toBe("deploy-production-main");
    expect(deployDoc.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("release-gate promotion shares the host mutation group too", () => {
    const promotion = yaml.load(readFileSync(".github/workflows/promote-release-gate-mode.yml", "utf8")) as {
      concurrency: { group: string; "cancel-in-progress": boolean };
    };
    expect(promotion.concurrency).toEqual(DOC.concurrency);
  });

  it("bounds current-main lookup, SSH connection and both complete phases while allowing OPEN rollback", () => {
    expect(SOURCE).toContain("child.communicate(timeout=30)");
    expect(SOURCE).toContain("-o ConnectTimeout=10 -o ConnectionAttempts=1");
    expect(SOURCE).toContain('close_max_seconds="${CAPABILITY_CLOSE_SSH_MAX_TIME_SECONDS:-2100}"');
    expect(SOURCE).toContain('deadline = int(sys.argv[1]) if sys.argv[2] == "closed" else 3600');
    expect(SOURCE).toContain("os.killpg(child.pid, signal.SIGKILL)");
    expect((DOC.jobs as { toggle: { "timeout-minutes": number } }).toggle["timeout-minutes"]).toBe(65);
    expect(REMOTE_SOURCE).toContain('capability_bounded_command "${CAPABILITY_PREFLIGHT_MAX_TIME_SECONDS}" docker compose exec');
    expect(REMOTE_SOURCE).toContain('CAPABILITY_PREFLIGHT_MAX_TIME_SECONDS="$(capability_deadline "${CAPABILITY_PREFLIGHT_MAX_TIME_SECONDS:-60}" 60)"');
    expect(REMOTE_SOURCE).toContain('CAPABILITY_DOCKER_MUTATION_MAX_TIME_SECONDS="$(capability_deadline "${CAPABILITY_DOCKER_MUTATION_MAX_TIME_SECONDS:-300}" 300)"');
    expect(REMOTE_SOURCE).toContain('capability_bounded_command "${CAPABILITY_DOCKER_MUTATION_MAX_TIME_SECONDS}" docker compose pull');
    expect(REMOTE_SOURCE).toContain('capability_bounded_command "${CAPABILITY_DOCKER_MUTATION_MAX_TIME_SECONDS}" docker compose up');
  });

  it("allows lookup failure fallback only to the exact trusted main dispatch commit and records its provenance", () => {
    expect(SOURCE).toContain('DISPATCH_REF: ${{ github.ref }}');
    expect(SOURCE).toContain('DISPATCH_SHA: ${{ github.sha }}');
    expect(SOURCE).toContain('[ "${CAPABILITY}" = "closed" ] && [ "${DISPATCH_REF:-}" = "refs/heads/main" ]');
    expect(SOURCE).toContain('echo "checkout_sha=${DISPATCH_SHA}" >> "$GITHUB_OUTPUT"');
    expect(SOURCE).toContain('echo "script_source=dispatch_main_fallback" >> "$GITHUB_OUTPUT"');
    expect(SOURCE).toContain('echo "main_lookup=unavailable" >> "$GITHUB_OUTPUT"');
  });

  it("bounds every post-deploy HTTP transfer and the verification job without changing its checks", () => {
    const source = readFileSync(".github/workflows/post-deploy-verify.yml", "utf8");
    const workflow = yaml.load(source) as {
      jobs: { verify: { "timeout-minutes": number; steps: Array<{ name: string; run?: string }> } };
    };
    expect(workflow.jobs.verify["timeout-minutes"]).toBe(20);
    const documentCheck = workflow.jobs.verify.steps.find((step) => step.name === "Verify public and workspace documents")?.run ?? "";
    const curls = documentCheck.split("\n").filter((line) => /\bcurl\b/.test(line));
    expect(curls).toHaveLength(3);
    for (const curl of curls) {
      expect(curl).toContain("--max-time 10");
      expect(curl).toContain("--retry-max-time 60");
    }
    expect(documentCheck).toContain('[ "${login_status}" != "200" ]');
    expect(documentCheck).toContain('[ "${workspace_status}" != "307" ]');
    expect(source).toContain("ref: ${{ steps.expected.outputs.sha }}");
  });

  it("bounds deploy ingress reads and its single verification dispatch without shortening migration recovery", () => {
    const source = readFileSync(".github/workflows/deploy-hetzner.yml", "utf8");
    const workflow = yaml.load(source) as {
      jobs: { deploy: { "timeout-minutes": number; steps: Array<{ name: string; run?: string }> } };
    };
    expect(workflow.jobs.deploy["timeout-minutes"]).toBe(180);
    const curls = workflow.jobs.deploy.steps.flatMap((step) =>
      (step.run ?? "").split("\n").filter((line) => /\bcurl\s+-/.test(line)),
    );
    expect(curls).toHaveLength(4);
    expect(curls.filter((line) => line.includes("--max-time 10"))).toHaveLength(3);
    expect(curls.filter((line) => line.includes("--max-time 30"))).toHaveLength(1);
    const dispatch = workflow.jobs.deploy.steps.find((step) => step.name === "Dispatch post-deploy verification workflow")?.run ?? "";
    expect(dispatch).toContain("-X POST");
    expect(dispatch).not.toMatch(/--retry\b/);
    expect(source).toContain("ref: ${{ steps.deploy_sha.outputs.sha }}");
  });
});

describe("automation-capability-toggle.yml — the result gate is real, not decorative", () => {
  it("a dedicated step fails the job when summary.result != 'pass' OR blockers is non-empty", () => {
    expect(SOURCE).toContain("Fail the job on anything but summary.result == pass");
    expect(SOURCE).toContain('if result != "pass" or blockers:');
    expect(SOURCE).toContain("sys.exit(1)");
  });

  it("the phase step's own exit code can downgrade a pass to fail — it is never trusted blindly", () => {
    expect(SOURCE).toContain('if phase_status != 0 and result == "pass":');
    expect(SOURCE).toContain('result = "fail"');
  });

  it("a non-empty blockers list ALSO downgrades a pass to fail — result and blockers can never disagree", () => {
    expect(SOURCE).toContain('if (summary.get("blockers") or []) and result == "pass":');
  });

  it("captures ALL THREE pipeline stages via ONE PIPESTATUS snapshot — never two separate sequential reads", () => {
    // PIPESTATUS is overwritten by the very NEXT command bash runs,
    // including a plain assignment with no external command at all (it
    // completes as its own trivial one-element pipeline). Reading
    // `ssh_status="${PIPESTATUS[0]}"` then `tee_status="${PIPESTATUS[1]}"`
    // as two separate statements loses tee's real status: by the second
    // read, PIPESTATUS has already been reset to reflect only the first
    // assignment. The only correct approach is to snapshot the WHOLE array
    // in ONE statement immediately after the pipe, then derive everything
    // from that snapshot (never from live PIPESTATUS again). If cat fails,
    // ssh must never be dispatched with partial/missing input.
    expect(SOURCE).toContain('stage_status=("${PIPESTATUS[@]}")');
    expect(SOURCE).toContain('ssh_status="${stage_status[0]:-99}"');
    expect(SOURCE).toContain('tee_status="${stage_status[1]:-99}"');
    expect(SOURCE).toContain('if [ "${cat_status}" -eq 0 ]; then');
    expect(SOURCE).toContain('if [ "${cat_status}" -ne 0 ]');
    expect(SOURCE).toContain('elif [ "${ssh_status}" -ne 0 ]');
    expect(SOURCE).toContain('elif [ "${tee_status}" -ne 0 ]');
  });

  it("the grep-for-CAPABILITY_JSON extraction snapshots ALL THREE stage statuses at once, and only grep=1/tail=0/sed=0 is a legitimate no-match", () => {
    // Same PIPESTATUS-snapshot requirement as the phase-runner step above.
    // A tail or sed that writes valid-looking output and THEN exits
    // nonzero must not be swallowed just because the combined/rightmost
    // pipefail status happens to look tolerable.
    expect(SOURCE).toContain('extraction_stage_status=("${PIPESTATUS[@]}")');
    expect(SOURCE).toContain('grep_status="${extraction_stage_status[0]:-99}"');
    expect(SOURCE).toContain('tail_status="${extraction_stage_status[1]:-99}"');
    expect(SOURCE).toContain('sed_status="${extraction_stage_status[2]:-99}"');
    expect(SOURCE).toContain('if [ "${grep_status}" = "0" ] && [ "${tail_status}" = "0" ] && [ "${sed_status}" = "0" ]');
    expect(SOURCE).toContain('elif [ "${grep_status}" = "1" ] && [ "${tail_status}" = "0" ] && [ "${sed_status}" = "0" ]');
    expect(SOURCE).toContain("capability_json_extraction_failed");
  });

  it("the phase-runner step never appends `|| true` to swallow a failure", () => {
    const phaseStepStart = SOURCE.indexOf("Run a capability phase on the host");
    const phaseStepEnd = SOURCE.indexOf("- name:", phaseStepStart + 1);
    const phaseStepBody = SOURCE.slice(phaseStepStart, phaseStepEnd);
    // Strip comments first — this step's own comment explains, in prose,
    // that it does NOT do this, and that sentence must not trip the check
    // meant to catch actual code doing it.
    const codeOnly = phaseStepBody
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(codeOnly).not.toContain("|| true");
  });
});

describe("automation-capability-toggle.yml — the artifact is uploaded on every outcome", () => {
  it("the upload step condition includes always()", () => {
    const uploadAt = SOURCE.indexOf("Upload result artifact");
    const uploadBody = SOURCE.slice(uploadAt, uploadAt + 400);
    expect(uploadBody).toContain("if: always()");
  });

  it("if-no-files-found is 'error' — a missing artifact must itself be loud", () => {
    expect(SOURCE).toContain("if-no-files-found: error");
  });
});

describe("automation-capability-toggle.yml — no secret is ever echoed in plaintext", () => {
  it("uses per-invocation registry auth after file close, with bounded login and no credential in remote argv", () => {
    const toggle = (DOC.jobs as { toggle: { permissions: Record<string, string> } }).toggle;
    expect(toggle.permissions.packages).toBe("read");
    expect(SOURCE).toContain("IFS= read -r CAP_REGISTRY_TOKEN; source /dev/stdin");
    expect(SOURCE).toContain('printf \'%s\\n\' "${GHCR_PULL_TOKEN:-}" > "${concat_file}"');
    expect(REMOTE_SOURCE).toContain('export -n CAP_REGISTRY_TOKEN');
    expect(REMOTE_SOURCE).toContain('capability_bounded_command 60 docker --config "${CAP_REGISTRY_CONFIG}" login');
    expect(REMOTE_SOURCE).toContain("trap capability_cleanup_registry_auth EXIT");
    expect(REMOTE_SOURCE).toContain('docker compose up -d --pull never --force-recreate web worker');
    expect(REMOTE_SOURCE).toContain('"${cached_identity}" != "${running_image} ${release_sha} ${service}-runner"');
    expect(REMOTE_SOURCE).toContain('docker_read compose config --no-env-resolution --format json "${service}"');
  });

  it("no step prints a raw ${{ secrets.* }} expression outside an env: assignment", () => {
    const lines = SOURCE.split("\n");
    const offenders = lines.filter((line) => {
      const trimmed = line.trim();
      // The actual GH Actions expression, not the bare English word — a
      // sentence like `"Missing required Hetzner secrets."` must not trip
      // this; only a real `${{ secrets.X }}` interpolation counts.
      if (!/\$\{\{\s*secrets\./.test(trimmed)) return false;
      // Legitimate: `KEY: ${{ secrets.X }}` under an `env:` block.
      if (/^[A-Z_][A-Z0-9_]*:\s*\$\{\{\s*secrets\./.test(trimmed)) return false;
      return true;
    });
    expect(offenders).toEqual([]);
  });

  it("the SSH private key is written with a restrictive mode before use", () => {
    expect(SOURCE).toContain("chmod 600 ~/.ssh/id_ed25519");
  });
});

describe("automation-capability-toggle.yml — the host phases are exactly the two the task names", () => {
  it("dispatches capability_open for open and capability_close for closed", () => {
    expect(SOURCE).toContain('phase="capability_close"');
    expect(SOURCE).toContain('phase="capability_open"');
    expect(SOURCE).toContain('if [ "${CAPABILITY}" = "open" ]');
  });

  it("concatenates the env-writer library and the phase script into ONE stdin stream", () => {
    const runAt = SOURCE.indexOf("Run a capability phase on the host");
    const runBody = SOURCE.slice(runAt, SOURCE.indexOf("- name: Build the redacted result artifact", runAt));
    // ONE `cat` invocation, both files as its arguments — never a
    // `{ cat A; cat B; }` group (whose own exit status is only the LAST
    // command's, silently masking an earlier cat failing while a later one
    // succeeds) and never two separate `cat` commands either.
    expect(runBody).toContain(
      "cat .github/scripts/automation-capability-env.sh .github/scripts/automation-capability-remote.sh >> \"${concat_file}\"",
    );
  });

  it("no meta_automation_business_controls or decision-mode write appears anywhere in this workflow or its scripts", () => {
    const remote = readFileSync(".github/scripts/automation-capability-remote.sh", "utf8");
    const env = readFileSync(".github/scripts/automation-capability-env.sh", "utf8");

    // The two shell scripts do the actual work — neither has any legitimate
    // reason to name these tables at all, not even in a comment, so the
    // bare name is forbidden outright.
    for (const source of [remote, env]) {
      expect(source).not.toMatch(/meta_automation_business_controls/i);
      expect(source).not.toMatch(/meta_automation_decision_type_modes/i);
    }

    // The workflow's own header comment legitimately NAMES these tables —
    // it documents that the workflow never writes them — so only forbid an
    // actual SQL write pattern here, not the bare table name.
    expect(SOURCE).not.toMatch(/INSERT\s+INTO\s+meta_automation_business_controls/i);
    expect(SOURCE).not.toMatch(/UPDATE\s+meta_automation_business_controls/i);
    expect(SOURCE).not.toMatch(/INSERT\s+INTO\s+meta_automation_decision_type_modes/i);
    expect(SOURCE).not.toMatch(/UPDATE\s+meta_automation_decision_type_modes/i);
  });
});
