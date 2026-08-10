import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertReplayOutputPlan,
  buildRepositoryContentManifest,
  parseArgs,
  resolveReplayProfileDimensions,
  resolveReplayRepositoryOutputExclusions,
} from "@/scripts/creative-decision-center/native-ad-account-aov-authority-replay";

describe("native-ad current-day replay provenance", () => {
  it("uses the immutable source receipt when an account legitimately has zero calibration cells", () => {
    expect(
      resolveReplayProfileDimensions({
        sliceKey: "business\u0000account\u0000cutoff",
        cells: [],
        sourceDimensionProof: {
          sourceAccountTimezone: "America/Chicago",
          sourceAccountCurrency: "usd",
        },
      }),
    ).toEqual({
      accountTimezone: "America/Chicago",
      accountCurrency: "USD",
    });

    expect(() =>
      resolveReplayProfileDimensions({
        sliceKey: "business\u0000account\u0000cutoff",
        cells: [
          {
            key: {
              accountTimezone: "UTC",
              accountCurrency: "USD",
            },
          },
        ],
        sourceDimensionProof: {
          sourceAccountTimezone: "America/Chicago",
          sourceAccountCurrency: "USD",
        },
      }),
    ).toThrow("contradict the immutable source dimensions");
  });

  it("binds tracked and untracked source content while excluding declared outputs", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "adsecute-replay-provenance-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
      writeFileSync(
        join(repoRoot, "tracked.ts"),
        "export const tracked = 1;\n",
      );
      writeFileSync(
        join(repoRoot, "cut-policy.ts"),
        "export const cutPolicy = 1;\n",
      );
      execFileSync("git", ["add", "tracked.ts"], { cwd: repoRoot });

      const beforeOutput = buildRepositoryContentManifest(repoRoot, [
        "proof.json",
      ]);
      expect(beforeOutput).toMatchObject({
        trackedFileCount: 1,
        untrackedFileCount: 1,
        missingTrackedFileCount: 0,
      });

      writeFileSync(join(repoRoot, "proof.json"), "first artifact\n");
      const afterOutput = buildRepositoryContentManifest(repoRoot, [
        "proof.json",
      ]);
      expect(afterOutput.manifestSha256).toBe(beforeOutput.manifestSha256);

      writeFileSync(
        join(repoRoot, "cut-policy.ts"),
        "export const cutPolicy = 2;\n",
      );
      const afterUntrackedSourceMutation = buildRepositoryContentManifest(
        repoRoot,
        ["proof.json"],
      );
      expect(afterUntrackedSourceMutation.manifestSha256).not.toBe(
        afterOutput.manifestSha256,
      );

      execFileSync("git", ["add", "cut-policy.ts"], { cwd: repoRoot });
      const afterTrackingStatusChange = buildRepositoryContentManifest(
        repoRoot,
        ["proof.json"],
      );
      expect(afterTrackingStatusChange).toMatchObject({
        trackedFileCount: 2,
        untrackedFileCount: 0,
      });
      expect(afterTrackingStatusChange.manifestSha256).not.toBe(
        afterUntrackedSourceMutation.manifestSha256,
      );

      writeFileSync(
        join(repoRoot, "tracked.ts"),
        "export const tracked = 2;\n",
      );
      const afterTrackedSourceMutation = buildRepositoryContentManifest(
        repoRoot,
        ["proof.json"],
      );
      expect(afterTrackedSourceMutation.manifestSha256).not.toBe(
        afterTrackingStatusChange.manifestSha256,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("excludes every explicitly declared sibling proof and checksum from one frozen manifest", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "adsecute-replay-outputs-"));
    try {
      const focused =
        "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-focused.json";
      const population =
        "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-population.json";
      const legacy =
        "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-16-compact.json";
      const args = parseArgs([
        "--as-of=2026-07-18",
        "--json-out=/tmp/native-ad-full.json",
        `--compact-json-out=${join(repoRoot, focused)}`,
        `--provenance-exclude=${join(repoRoot, population)}`,
        `--provenance-exclude=${join(repoRoot, legacy)}`,
        "--stdout=none",
      ]);

      expect(
        resolveReplayRepositoryOutputExclusions(repoRoot, args),
      ).toEqual([
        legacy,
        `${legacy}.tmp`,
        legacy.replace(/\.json$/, ".sha256"),
        focused,
        `${focused}.tmp`,
        focused.replace(/\.json$/, ".sha256"),
        population,
        `${population}.tmp`,
        population.replace(/\.json$/, ".sha256"),
      ]);
      expect(() =>
        resolveReplayRepositoryOutputExclusions(repoRoot, {
          ...args,
          provenanceExcludePaths: ["/tmp/outside.json"],
        }),
      ).toThrow("must be files inside the repository");
      expect(() =>
        resolveReplayRepositoryOutputExclusions(repoRoot, {
          ...args,
          provenanceExcludePaths: [join(repoRoot, "lib/source.ts")],
        }),
      ).toThrow("only sibling replay JSON outputs");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses to retain a compact proof without its full row evidence", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "adsecute-replay-output-plan-"));
    try {
      expect(() =>
        assertReplayOutputPlan(
          {
            jsonOut: null,
            compactJsonOut: join(
              repoRoot,
              "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-focused.json",
            ),
            stdoutMode: "none",
          },
          repoRoot,
        ),
      ).toThrow("--compact-json-out requires --json-out");

      expect(() =>
        assertReplayOutputPlan(
          {
            jsonOut: join(repoRoot, "full.json"),
            compactJsonOut: join(
              repoRoot,
              "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-focused.json",
            ),
            stdoutMode: "none",
          },
          repoRoot,
        ),
      ).toThrow("full --json-out row artifact must stay outside");

      expect(() =>
        assertReplayOutputPlan(
          {
            jsonOut: join(tmpdir(), "native-ad-full-row-evidence.json"),
            compactJsonOut: join(
              repoRoot,
              "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-focused.json",
            ),
            stdoutMode: "none",
          },
          repoRoot,
        ),
      ).not.toThrow();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
