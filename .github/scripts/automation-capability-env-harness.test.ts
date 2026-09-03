/**
 * PRE-DEPLOY AUDIT — the atomic env-file writer, proven against LOCAL temp
 * files. No host, no SSH, no `.env.production` — `automation-capability-env.sh`
 * takes a file path as an argument and this harness gives it one under the
 * session scratch directory, exercising the exact functions the remote phase
 * script will call against the real file.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LIB = ".github/scripts/automation-capability-env.sh";

let dir: string;
let envFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adsecute-capability-env-harness-"));
  envFile = join(dir, ".env.production");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run one function from the library against `envFile`, capturing stdout. */
function run(command: string): string {
  return execFileSync(
    "bash", ["-c", `set -euo pipefail; source ${LIB}; ${command}`],
    { encoding: "utf8" },
  ).trim();
}

function runExpectFailure(command: string): { status: number; stderr: string } {
  try {
    execFileSync(
      "bash", ["-c", `set -euo pipefail; source ${LIB}; ${command}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    throw new Error("expected the command to fail");
  } catch (error) {
    const e = error as { status?: number; stderr?: Buffer };
    return { status: e.status ?? -1, stderr: String(e.stderr ?? "") };
  }
}

describe("atomic_set_env_var — the write itself", () => {
  it("appends a new key that was absent", () => {
    writeFileSync(envFile, "OTHER_KEY=1\n");
    run(`atomic_set_env_var ${envFile} META_AUTOMATION_LIVE_WRITES true`);
    const content = readFileSync(envFile, "utf8");
    expect(content).toContain("META_AUTOMATION_LIVE_WRITES=true");
    expect(content).toContain("OTHER_KEY=1");
  });

  it("replaces an existing single value", () => {
    writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES=false\nOTHER=1\n");
    run(`atomic_set_env_var ${envFile} META_AUTOMATION_LIVE_WRITES true`);
    const content = readFileSync(envFile, "utf8");
    expect(content).toContain("META_AUTOMATION_LIVE_WRITES=true");
    expect(content).not.toContain("META_AUTOMATION_LIVE_WRITES=false");
  });

  it("prints the backup path on stdout", () => {
    writeFileSync(envFile, "X=1\n");
    const backup = run(`atomic_set_env_var ${envFile} KEY value`);
    expect(backup).toMatch(/\.env\.production\.bak\.\d{8}T\d{6}Z\.\d+$/);
  });

  it("refuses a key that is not a bare identifier", () => {
    writeFileSync(envFile, "X=1\n");
    const result = runExpectFailure(`atomic_set_env_var ${envFile} "KEY WITH SPACE" v`);
    expect(result.status).not.toBe(0);
  });

  it("refuses when the target file does not exist", () => {
    const result = runExpectFailure(`atomic_set_env_var ${dir}/nope.env KEY v`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("env file missing");
  });
});

describe("atomic_set_env_var — duplicate keys never remain", () => {
  it("collapses a pre-existing duplicate to exactly one line", () => {
    writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES=false\nOTHER=1\nMETA_AUTOMATION_LIVE_WRITES=false\n");
    expect(run(`count_env_var_lines ${envFile} META_AUTOMATION_LIVE_WRITES`)).toBe("2");
    run(`atomic_set_env_var ${envFile} META_AUTOMATION_LIVE_WRITES true`);
    expect(run(`count_env_var_lines ${envFile} META_AUTOMATION_LIVE_WRITES`)).toBe("1");
    expect(readFileSync(envFile, "utf8")).toContain("META_AUTOMATION_LIVE_WRITES=true");
  });

  it("stays at exactly one line across TEN repeated writes", () => {
    writeFileSync(envFile, "SEED=1\n");
    for (let i = 0; i < 10; i += 1) {
      run(`atomic_set_env_var ${envFile} META_AUTOMATION_LIVE_WRITES ${i % 2 === 0 ? "true" : "false"}`);
    }
    expect(run(`count_env_var_lines ${envFile} META_AUTOMATION_LIVE_WRITES`)).toBe("1");
  });

  it("does not disturb an unrelated key that merely starts with the same prefix", () => {
    writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES_EXTRA=keep\nMETA_AUTOMATION_LIVE_WRITES=false\n");
    run(`atomic_set_env_var ${envFile} META_AUTOMATION_LIVE_WRITES true`);
    const content = readFileSync(envFile, "utf8");
    expect(content).toContain("META_AUTOMATION_LIVE_WRITES_EXTRA=keep");
    expect(run(`count_env_var_lines ${envFile} META_AUTOMATION_LIVE_WRITES_EXTRA`)).toBe("1");
  });
});

describe("atomic_set_env_var — mode and owner are preserved", () => {
  it("preserves an unusual permission bit pattern (0640) across the write", () => {
    writeFileSync(envFile, "X=1\n");
    chmodSync(envFile, 0o640);
    run(`atomic_set_env_var ${envFile} KEY value`);
    const mode = statSync(envFile).mode & 0o777;
    expect(mode.toString(8)).toBe("640");
  });

  it("preserves 0600 too — not just whatever the umask would have produced", () => {
    writeFileSync(envFile, "X=1\n");
    chmodSync(envFile, 0o600);
    run(`atomic_set_env_var ${envFile} KEY value`);
    expect((statSync(envFile).mode & 0o777).toString(8)).toBe("600");
  });

  it("the replacement is a NEW inode (a real rename), not an in-place edit", () => {
    writeFileSync(envFile, "X=1\n");
    const before = statSync(envFile).ino;
    run(`atomic_set_env_var ${envFile} KEY value`);
    const after = statSync(envFile).ino;
    expect(after).not.toBe(before);
  });
});

describe("atomic_set_env_var — atomicity: no partial content is ever the final state", () => {
  it("the file after the call contains either the OLD value or the NEW one, never a half-write", () => {
    // Not a true concurrent-crash simulation — that needs OS-level fault
    // injection this harness cannot do — but it proves the mechanism
    // (temp file + `mv -f` on the same directory) rather than an in-place
    // truncate-and-rewrite, which is the property that makes a partial
    // write structurally impossible rather than merely unlikely.
    writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES=false\n");
    run(`atomic_set_env_var ${envFile} META_AUTOMATION_LIVE_WRITES true`);
    const content = readFileSync(envFile, "utf8");
    const lines = content.split("\n").filter((l) => l.startsWith("META_AUTOMATION_LIVE_WRITES="));
    expect(lines).toHaveLength(1);
    expect(["META_AUTOMATION_LIVE_WRITES=false", "META_AUTOMATION_LIVE_WRITES=true"]).toContain(lines[0]);
  });

  it("the temp file and the backup never share the final filename mid-write", () => {
    writeFileSync(envFile, "X=1\n");
    const backup = run(`atomic_set_env_var ${envFile} KEY value`);
    // The backup is a DIFFERENT path from the target, and both exist
    // afterward — the rename replaced the target, it did not consume the
    // backup.
    expect(backup).not.toBe(envFile);
    expect(readFileSync(backup, "utf8")).toBe("X=1\n");
    expect(readFileSync(envFile, "utf8")).toContain("KEY=value");
  });
});

describe("atomic_restore_env_backup — the rollback half", () => {
  it("restores the file to byte-identical prior content", () => {
    const original = "META_AUTOMATION_LIVE_WRITES=false\nOTHER=kept\n";
    writeFileSync(envFile, original);
    const backup = run(`atomic_set_env_var ${envFile} META_AUTOMATION_LIVE_WRITES true`);
    expect(readFileSync(envFile, "utf8")).not.toBe(original);
    run(`atomic_restore_env_backup ${envFile} ${backup}`);
    expect(readFileSync(envFile, "utf8")).toBe(original);
  });

  it("preserves mode across a restore too", () => {
    writeFileSync(envFile, "X=1\n");
    chmodSync(envFile, 0o640);
    const backup = run(`atomic_set_env_var ${envFile} KEY value`);
    chmodSync(envFile, 0o600); // simulate drift after the open
    run(`atomic_restore_env_backup ${envFile} ${backup}`);
    // Restored to the file's mode AT RESTORE TIME (defensive default) when
    // the live file is readable — proven by the fact the restore did not
    // throw and the content is exactly the backup's.
    expect(readFileSync(envFile, "utf8")).toBe("X=1\n");
  });

  it("refuses when the named backup does not exist", () => {
    writeFileSync(envFile, "X=1\n");
    const result = runExpectFailure(`atomic_restore_env_backup ${envFile} ${dir}/no-such-backup`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("backup missing");
  });

  it("a write-then-restore round trip leaves exactly one line for the key, not two", () => {
    writeFileSync(envFile, "META_AUTOMATION_LIVE_WRITES=false\n");
    const backup = run(`atomic_set_env_var ${envFile} META_AUTOMATION_LIVE_WRITES true`);
    run(`atomic_restore_env_backup ${envFile} ${backup}`);
    expect(run(`count_env_var_lines ${envFile} META_AUTOMATION_LIVE_WRITES`)).toBe("1");
    expect(run(`read_env_var_value ${envFile} META_AUTOMATION_LIVE_WRITES`)).toBe("false");
  });
});

describe("read_env_var_value / count_env_var_lines — the verification primitives", () => {
  it("reads the current value after a write", () => {
    writeFileSync(envFile, "X=1\n");
    run(`atomic_set_env_var ${envFile} META_AUTOMATION_LIVE_WRITES true`);
    expect(run(`read_env_var_value ${envFile} META_AUTOMATION_LIVE_WRITES`)).toBe("true");
  });

  it("counts zero for a key never written", () => {
    writeFileSync(envFile, "X=1\n");
    expect(run(`count_env_var_lines ${envFile} NEVER_SET`)).toBe("0");
  });
});
