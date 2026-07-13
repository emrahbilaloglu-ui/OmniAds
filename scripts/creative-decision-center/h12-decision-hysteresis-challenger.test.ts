import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  instrumentNativeReplaySource,
  verifyNativeArtifactSourceHash,
} from "./h12-decision-hysteresis-challenger";

describe("H12 native replay instrumentation", () => {
  it("creates a daily, baseline-only, sequence-emitting adapter without editing source", () => {
    const path = resolve(
      process.cwd(),
      "scripts/creative-decision-center/native-ad-grain-paired-replay.ts",
    );
    const source = readFileSync(path, "utf8");
    const instrumented = instrumentNativeReplaySource(source);
    expect(instrumented).toContain("const DECISION_COOLDOWN_DAYS = 1;");
    expect(instrumented).toContain(
      "const variants = [buildAdChallengerGrid()[0]!];",
    );
    expect(instrumented).toContain("h12SequenceRows: cohortRows.map");
    expect(instrumented).toContain("OUTCOME_WINDOWS.map");
    expect(instrumented).toContain("row.outcomes[windowDays]");
    expect(source).toContain("const DECISION_COOLDOWN_DAYS = 7;");
  });

  it("fails closed when an instrumentation anchor is absent", () => {
    expect(() =>
      instrumentNativeReplaySource("export const unrelated = true"),
    ).toThrow("instrumentation anchor missing");
  });

  it("fails closed when the current native source differs from its artifact receipt", () => {
    const source = "export const native = true;";
    const hash = createHash("sha256").update(source).digest("hex");
    const artifact = {
      contractVersion: "fixture",
      input: {
        startDate: "2025-12-01",
        decisionEndDate: "2026-06-27",
        outcomeCeiling: "2026-07-11",
      },
      coverage: {},
      lineage: { scriptContentHash: hash, manifestSetHash: "a".repeat(64) },
    };
    expect(verifyNativeArtifactSourceHash({ source, artifact })).toBe(hash);
    expect(() =>
      verifyNativeArtifactSourceHash({
        source: `${source}\n// changed`,
        artifact,
      }),
    ).toThrow("source hash mismatch");
  });
});
import { createHash } from "node:crypto";
