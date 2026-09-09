import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

type WorkflowStep = { name: string; id?: string; run?: string; env?: Record<string, string>; "continue-on-error"?: boolean };
type Workflow = { jobs: Record<string, { permissions: Record<string, string>; steps: WorkflowStep[] }> };
const promotion = yaml.load(readFileSync(".github/workflows/promote-release-gate-mode.yml", "utf8")) as Workflow;
const verification = yaml.load(readFileSync(".github/workflows/post-deploy-verify.yml", "utf8")) as Workflow;
const expectedSha = "1234567890abcdef1234567890abcdef12345678ab";
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adsecute-promotion-evidence-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  return { root, bin };
}

function executable(path: string, source: string) {
  writeFileSync(path, source, { mode: 0o755 });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("promotion registry credentials", () => {
  const step = promotion.jobs.promote!.steps.find((item) => item.name === "Promote release gate mode on Hetzner")!;
  const source = step.run!;

  it("uses package read permission and a token on stdin before running the promotion body", () => {
    expect(promotion.jobs.promote!.permissions.packages).toBe("read");
    expect(step.env?.GHCR_PULL_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(source).toContain("printf '%s\\n' \"${GHCR_PULL_TOKEN}\"");
    const remoteExpression = source.slice(source.indexOf('"EXPECTED_SHA='));
    expect(remoteExpression).not.toContain("GHCR_PULL_TOKEN");
    expect(remoteExpression).not.toContain("export __ghcr_tok");
    expect(remoteExpression.indexOf("login ghcr.io")).toBeLessThan(remoteExpression.indexOf("bash -seuo pipefail"));
    expect(source).toContain("timeout 60s docker");
  });

  it.each([
    { mode: "success", expected: 0, ran: true },
    { mode: "login-failed", expected: 78, ran: false },
    { mode: "missing-token", expected: 78, ran: false },
    { mode: "promotion-failed", expected: 29, ran: true },
  ])("cleans private credentials when $mode", ({ mode, expected, ran }) => {
    const { root, bin } = fixture();
    executable(join(bin, "timeout"), "#!/bin/sh\nshift\nexec \"$@\"\n");
    executable(join(bin, "docker"), `#!/usr/bin/env python3
import json, os, pathlib, stat, sys
args = sys.argv[1:]
cfg = pathlib.Path(args[args.index('--config') + 1])
entry = {'args': args, 'mode': stat.S_IMODE(cfg.stat().st_mode)}
with open(os.environ['DOCKER_TRACE'], 'a') as trace:
    trace.write(json.dumps(entry) + '\\n')
if 'login' in args:
    token = sys.stdin.read()
    if token != 'private-test-token' or os.environ['TEST_MODE'] == 'login-failed':
        sys.exit(1)
    (cfg / 'config.json').write_text('private-registry-credential')
`);
    const remoteExpression = source.slice(source.indexOf('"EXPECTED_SHA=')).trim();
    const body = 'test -f "$DOCKER_CONFIG/config.json"\n'
      + 'test -z "${__ghcr_tok+x}"\n'
      + 'printf done > "$PROMOTION_MARKER"\n'
      + (mode === "promotion-failed" ? "exit 29\n" : "true\n");
    const tracePath = join(root, "docker.jsonl");
    const marker = join(root, "promotion-ran");
    // Evaluate the exact YAML remote command, then run it with the same stdin
    // framing as SSH. Only the Docker executable and remote body are fixtures.
    const result = spawnSync("bash", ["-c", `remote_command=${remoteExpression}\nexec bash -c "$remote_command"`], {
      cwd: root,
      input: `${mode === "missing-token" ? "" : "private-test-token"}\n${body}`,
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: `${bin}:${process.env.PATH}`, TMPDIR: root,
        EXPECTED_SHA: expectedSha, RELEASE_GATE_MODE: "block", ghcr_user_q: "test-actor",
        TEST_MODE: mode, DOCKER_TRACE: tracePath, PROMOTION_MARKER: marker,
      },
    });
    expect(result.status, result.stderr).toBe(expected);
    expect(existsSync(marker)).toBe(ran);
    expect(result.stdout + result.stderr).not.toContain("private-test-token");
    const entries = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; mode: number });
    expect(entries.at(-1)?.args).toContain("logout");
    for (const entry of entries) {
      expect(entry.mode).toBe(0o700);
      expect(entry.args.join(" ")).not.toContain("private-test-token");
      expect(existsSync(entry.args[entry.args.indexOf("--config") + 1]!)).toBe(false);
    }
  });
});

describe("post-deploy exact public build gate", () => {
  const step = verification.jobs.verify!.steps.find((item) => item.id === "exact_build")!;

  it("is a hard gate before document checks and retains the raw public evidence", () => {
    const steps = verification.jobs.verify!.steps;
    expect(step["continue-on-error"]).not.toBe(true);
    expect(steps.indexOf(step)).toBeLessThan(steps.findIndex((item) => item.name === "Verify public and workspace documents"));
    expect(step.run).toContain("--max-time 10");
    expect(step.run).toContain("--retry-max-time 60");
    expect(readFileSync(".github/workflows/post-deploy-verify.yml", "utf8")).toContain(".artifacts/post-deploy-build-info.json");
  });

  it.each([
    { label: "exact", body: JSON.stringify({ buildId: expectedSha }), curlExit: 0, success: true },
    { label: "different", body: JSON.stringify({ buildId: "a".repeat(40) }), curlExit: 0, success: false },
    { label: "missing", body: "{}", curlExit: 0, success: false },
    { label: "malformed", body: "not-json", curlExit: 0, success: false },
    { label: "null", body: "null", curlExit: 0, success: false },
    { label: "array", body: "[]", curlExit: 0, success: false },
    { label: "HTTP failure", body: JSON.stringify({ buildId: expectedSha }), curlExit: 22, success: false },
  ])("accepts only the expected deployed build: $label", ({ body, curlExit, success }) => {
    const { root, bin } = fixture();
    executable(join(bin, "curl"), `#!/usr/bin/env python3
import os, pathlib, sys
args = sys.argv[1:]
pathlib.Path(args[args.index('-o') + 1]).write_text(os.environ['BUILD_REPLY'])
sys.exit(int(os.environ['CURL_EXIT']))
`);
    const result = spawnSync("bash", ["-c", step.run!], {
      cwd: root, encoding: "utf8", timeout: 5000,
      env: { PATH: `${bin}:${process.env.PATH}`, EXPECTED_SHA: expectedSha, BUILD_REPLY: body, CURL_EXIT: String(curlExit) },
    });
    expect(result.status === 0, result.stderr).toBe(success);
    expect(readFileSync(join(root, ".artifacts/post-deploy-build-info.json"), "utf8")).toBe(body);
  });
});
