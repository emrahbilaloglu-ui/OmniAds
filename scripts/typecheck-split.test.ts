/**
 * PRE-DEPLOY AUDIT — the split typecheck's discovery step must FAIL CLOSED.
 *
 * `typecheck:split` is only as trustworthy as the file list it partitions. If
 * discovery returns a SHORTER list than the real program, every downstream
 * step still succeeds — the partition assertion passes (it compares against
 * the short list), all eight shards compile, and the runner prints
 * "0 diagnostics" over files it never opened. There is no later stage that
 * can catch it, because nothing downstream knows what the list should have
 * been.
 *
 * So the failure has to be caught at the source, and these cases are the
 * source. Each one is a way a real subprocess fails while still leaving
 * parseable text on stdout — which is precisely why "parse stdout and check it
 * is non-empty" was the wrong test.
 */
import { describe, expect, it } from "vitest";

import {
  DiscoveryRefused,
  parseDiscoveryOutput,
  type DiscoverySpawnResult,
} from "@/scripts/typecheck-split";

/** A believable, well-formed listing — the shape every failure case perturbs. */
const GOOD_STDOUT = [
  "lib/meta/release-gates.ts",
  "lib/meta/budget-schema-verification.ts",
  "components/meta/decision-center/BudgetDryRunPanel.tsx",
  "next-env.d.ts",
  "scripts/audits/d082-meta-role-provenance-replay.ts",
  "",
].join("\n");

const ok = (over: Partial<DiscoverySpawnResult> = {}): DiscoverySpawnResult => ({
  status: 0,
  signal: null,
  stdout: GOOD_STDOUT,
  stderr: "",
  ...over,
});

describe("typecheck-split discovery — the happy path is genuinely happy", () => {
  it("returns the sorted, de-duplicated in-repo file list", () => {
    expect(parseDiscoveryOutput(ok())).toEqual([
      "components/meta/decision-center/BudgetDryRunPanel.tsx",
      "lib/meta/budget-schema-verification.ts",
      "lib/meta/release-gates.ts",
      "next-env.d.ts",
      "scripts/audits/d082-meta-role-provenance-replay.ts",
    ]);
  });

  it("drops node_modules and absolute out-of-repo paths without refusing", () => {
    const stdout = [
      "lib/meta/release-gates.ts",
      "/opt/homebrew/lib/node_modules/typescript/lib/lib.es5.d.ts",
      "node_modules/@types/node/index.d.ts",
      "",
    ].join("\n");
    expect(parseDiscoveryOutput(ok({ stdout }))).toEqual(["lib/meta/release-gates.ts"]);
  });
});

describe("typecheck-split discovery — every failure refuses, none is parsed past", () => {
  /*
    THE CASE THAT MOTIVATED ALL OF THIS.

    `tsc` writes the file list to stdout BEFORE it reports a configuration
    error, so "non-zero exit WITH a full-looking stdout" is the ordinary shape
    of a discovery failure, not an exotic one. The old code read that stdout,
    found it non-empty, and proceeded — shipping a green result computed from
    a partial program.
  */
  it("refuses a non-zero exit even when stdout looks complete", () => {
    expect(() =>
      parseDiscoveryOutput(ok({ status: 2, stderr: "error TS5083: Cannot read file 'tsconfig.json'." })),
    ).toThrow(DiscoveryRefused);
    expect(() => parseDiscoveryOutput(ok({ status: 2 }))).toThrow(/exited 2/);
  });

  it("says out loud that a failed discovery's stdout is not parsed", () => {
    try {
      parseDiscoveryOutput(ok({ status: 1 }));
      throw new Error("expected a refusal");
    } catch (error) {
      expect(String(error)).toContain("stdout is NOT parsed after a failed discovery");
    }
  });

  /*
    A SIGNALLED PROCESS. SIGKILL from the OOM killer is the realistic one and
    it is the most dangerous, because it leaves a valid PREFIX: every line
    complete, every path real, and a third of the program missing.
  */
  it("refuses a signalled process, whatever its status or stdout", () => {
    expect(() => parseDiscoveryOutput(ok({ signal: "SIGKILL" }))).toThrow(DiscoveryRefused);
    expect(() => parseDiscoveryOutput(ok({ signal: "SIGKILL" }))).toThrow(/killed by signal SIGKILL/);
    // status null is what Node reports for a signalled child; both are refused.
    expect(() => parseDiscoveryOutput(ok({ status: null, signal: "SIGTERM" }))).toThrow(
      /killed by signal SIGTERM/,
    );
  });

  it("refuses a spawn/ENOBUFS error even with a zero status and good stdout", () => {
    const error = Object.assign(new Error("spawnSync npx ENOBUFS"), { code: "ENOBUFS" });
    expect(() => parseDiscoveryOutput(ok({ error }))).toThrow(/could not run to completion/);
  });

  it("refuses absent, non-string or empty stdout", () => {
    expect(() => parseDiscoveryOutput(ok({ stdout: null }))).toThrow(/no stdout/);
    expect(() => parseDiscoveryOutput(ok({ stdout: undefined as unknown as string }))).toThrow(
      /no stdout/,
    );
    expect(() => parseDiscoveryOutput(ok({ stdout: "" }))).toThrow(/empty output/);
  });

  /*
    TRUNCATION. `maxBuffer` overflow cuts stdout mid-stream, so the last line
    has no newline. Every line before it is valid, which is why length and
    shape checks alone would pass this.
  */
  it("refuses output that is not newline-terminated", () => {
    const truncated = "lib/meta/release-gates.ts\nlib/meta/budget-sche";
    expect(() => parseDiscoveryOutput(ok({ stdout: truncated }))).toThrow(/not newline-terminated/);
  });

  it("refuses lines that are not file paths", () => {
    const noisy = ["lib/meta/release-gates.ts", "error TS2307: Cannot find module", ""].join("\n");
    expect(() => parseDiscoveryOutput(ok({ stdout: noisy }))).toThrow(/not file paths/);

    const unknownExtension = ["lib/meta/release-gates.ts", "docs/notes.md", ""].join("\n");
    expect(() => parseDiscoveryOutput(ok({ stdout: unknownExtension }))).toThrow(/not file paths/);

    const control = ["lib/meta/release-gates.ts", "lib/meta/\u0007bad.ts", ""].join("\n");
    expect(() => parseDiscoveryOutput(ok({ stdout: control }))).toThrow(/not file paths/);

    const padded = ["lib/meta/release-gates.ts", "   lib/meta/spaced.ts", ""].join("\n");
    expect(() => parseDiscoveryOutput(ok({ stdout: padded }))).toThrow(/not file paths/);
  });

  it("refuses a listing with no in-repo files left after filtering", () => {
    const onlyExternal = ["node_modules/typescript/lib/lib.es5.d.ts", ""].join("\n");
    expect(() => parseDiscoveryOutput(ok({ stdout: onlyExternal }))).toThrow(
      /listed no in-repo program files/,
    );
  });

  it("refuses BEFORE inspecting stdout — order matters, not just outcome", () => {
    /*
      If the status check ran after parsing, a non-zero exit whose stdout was
      also malformed would report the malformed-line error, and the operator
      would go looking for a bad path instead of a failed compiler. The
      message must name the exit.
    */
    expect(() => parseDiscoveryOutput({ status: 3, signal: null, stdout: "garbage", stderr: "boom" }))
      .toThrow(/exited 3/);
  });
});
