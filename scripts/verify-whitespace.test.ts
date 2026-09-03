/**
 * PRE-DEPLOY AUDIT — regression for the blind spot found preparing the
 * release candidate: `verify-whitespace.sh` only ever ran `git diff`
 * (working tree vs index) and `git diff --cached` (index vs HEAD), so a
 * file nobody had ever `git add`ed had no index entry for either to compare
 * against and was invisible to both. Seven newly-added files carried real
 * whitespace damage through a full pass of typecheck, lint and Vitest
 * because of exactly this gap; it was found only once something finally
 * staged them.
 *
 * Proven here against a REAL, disposable git repository (no host repo, no
 * mocks) running the actual current script content, so a regression in the
 * untracked-file scan fails this test rather than silently reappearing.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REAL_SCRIPT = join(process.cwd(), "scripts/verify-whitespace.sh");

let repoDir: string;
let scriptPath: string;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
}

/** Runs the fixture's own copy of the script inside the fixture repo. */
function runVerifier(): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(scriptPath, [], { cwd: repoDir, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "adsecute-verify-whitespace-fixture-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "fixture@adsecute.test"]);
  git(["config", "user.name", "fixture"]);

  // `cd "$(dirname "$0")/.."` in the real script means the fixture must
  // place its copy at the SAME relative path (scripts/verify-whitespace.sh)
  // for it to resolve back to the fixture repo root, not the real one.
  mkdirSync(join(repoDir, "scripts"));
  scriptPath = join(repoDir, "scripts/verify-whitespace.sh");
  writeFileSync(scriptPath, readFileSync(REAL_SCRIPT, "utf8"));
  chmodSync(scriptPath, 0o755);

  writeFileSync(join(repoDir, "README.md"), "fixture baseline\n");
  git(["add", "README.md", "scripts/verify-whitespace.sh"]);
  git(["commit", "-q", "-m", "baseline"]);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("verify-whitespace.sh — untracked-file scan", () => {
  it("PASSES on a clean untracked file (nothing staged, nothing committed)", () => {
    writeFileSync(join(repoDir, "clean.ts"), "export const x = 1;\n");

    const result = runVerifier();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS");
    expect(result.stdout).toContain("untracked files");
  });

  it("FAILS on an untracked file with trailing whitespace — the exact blind spot", () => {
    writeFileSync(join(repoDir, "dirty.ts"), "export const x = 1;   \n");

    const result = runVerifier();

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("trailing whitespace");
    expect(result.stdout + result.stderr).toContain(
      "FAIL: an untracked file has whitespace damage",
    );
  });

  it("FAILS on an untracked file with a new blank line at EOF", () => {
    writeFileSync(join(repoDir, "dirty-eof.ts"), "export const x = 1;\n\n");

    const result = runVerifier();

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("new blank line at EOF");
  });

  it("never leaves the real index of the repo it runs in dirty", () => {
    writeFileSync(join(repoDir, "dirty.ts"), "export const x = 1;   \n");

    runVerifier();

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(staged.trim()).toBe("");
  });

  it("does not flag a binary untracked file", () => {
    writeFileSync(join(repoDir, "binary.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));

    const result = runVerifier();

    expect(result.status).toBe(0);
  });

  it("still catches damage in the working tree and the index (existing checks preserved)", () => {
    // Working tree: a tracked file modified with trailing whitespace, unstaged.
    writeFileSync(join(repoDir, "README.md"), "fixture baseline   \n");
    let result = runVerifier();
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "FAIL: the working tree has whitespace damage",
    );

    // Index: the same damage, staged.
    git(["add", "README.md"]);
    result = runVerifier();
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("FAIL: the index has whitespace damage");

    git(["reset", "-q"]);
    git(["checkout", "--", "README.md"]);
  });
});
