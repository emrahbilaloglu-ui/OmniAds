import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCreativeDecisionCenterV21Blockers,
  buildCreativeDecisionCenterV21Coverage,
  buildCreativeDecisionCenterV21DataReadinessReport,
  runCreativeDecisionCenterV21DataReadiness,
} from "./creative-decision-center-v21-data-readiness";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Creative Decision Center V2.1 data readiness", () => {
  it("reports missing V2.1 proof fields without mutating runtime behavior", () => {
    const coverage = buildCreativeDecisionCenterV21Coverage([
      {
        spend: 100,
        purchases: 2,
        impressions: 5000,
        roas: 1.4,
        cpa: 50,
        campaignStatus: "ACTIVE",
        adsetStatus: "ACTIVE",
      },
    ]);

    expect(coverage.find((item) => item.field === "spend")?.status).toBe("ready");
    expect(coverage.find((item) => item.field === "firstSpendAt")?.status).toBe("missing");
    expect(coverage.find((item) => item.field === "reviewStatus")?.status).toBe("missing");
    expect(coverage.find((item) => item.field === "spend24h")?.status).toBe("missing");
    expect(buildCreativeDecisionCenterV21Blockers(coverage)).toEqual(
      expect.arrayContaining([
        "fix_delivery requires active status plus spend24h/impressions24h proof",
        "fix_policy requires review/effective status and policy reason proof",
        "watch_launch requires firstSeenAt/firstSpendAt launch basis",
      ]),
    );
  });

  it("builds fixture-mode reports when DATABASE_URL is absent", () => {
    const report = buildCreativeDecisionCenterV21DataReadinessReport({
      generatedAt: "2026-04-30T00:00:00.000Z",
      source: "fixture",
      liveStatus: {
        attempted: false,
        source: "fixture",
        readOnly: true,
        reason: "DATABASE_URL is not set; no live DB/snapshot read was attempted.",
        missingEnv: ["DATABASE_URL"],
        snapshotId: null,
      },
      rows: [],
    });

    expect(report.readOnly).toBe(true);
    expect(report.liveStatus.attempted).toBe(false);
    expect(report.liveStatus.missingEnv).toEqual(["DATABASE_URL"]);
    expect(report.coverage.every((item) => item.status === "missing")).toBe(true);
    expect(report.notes.join(" ")).toContain("does not mutate");
  });

  it("writes live-status and coverage explicitly without requiring production secrets", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const outputDir = mkdtempSync(join(tmpdir(), "cdc-v21-readiness-"));
    tempDirs.push(outputDir);

    try {
      const report = await runCreativeDecisionCenterV21DataReadiness({
        outputDir,
        now: "2026-04-30T00:00:00.000Z",
      });
      const liveStatus = JSON.parse(
        readFileSync(join(outputDir, "live-status.json"), "utf8"),
      ) as typeof report.liveStatus;
      const coverage = JSON.parse(
        readFileSync(join(outputDir, "data-readiness-coverage.json"), "utf8"),
      ) as typeof report;

      expect(liveStatus).toEqual(report.liveStatus);
      expect(coverage.liveStatus).toEqual(report.liveStatus);
      expect(liveStatus.readOnly).toBe(true);
      expect(liveStatus.attempted).toBe(false);
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });

  it("keeps the readiness script read-only by static guard", () => {
    const source = readFileSync(
      "scripts/creative-decision-center-v21-data-readiness.ts",
      "utf8",
    );

    expect(source).not.toMatch(
      /\bINSERT\s+INTO\b|\bUPDATE\s+\w|\bDELETE\s+FROM\b|\bUPSERT\b/i,
    );
    expect(source).not.toContain("saveCreativeDecisionOsSnapshot");
    expect(source).not.toContain("/api/creatives/decision-os");
    expect(source).not.toContain("POST");
  });
});
