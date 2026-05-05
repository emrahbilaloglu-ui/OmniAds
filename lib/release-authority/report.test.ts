import { beforeEach, describe, expect, it } from "vitest";
import { buildReleaseAuthorityReport } from "@/lib/release-authority/report";

const ENV_KEYS = [
  "META_DECISION_OS_V1",
  "META_DECISION_OS_CANARY_BUSINESSES",
  "CREATIVE_DECISION_OS_V1",
  "CREATIVE_DECISION_OS_CANARY_BUSINESSES",
  "COMMAND_CENTER_V1",
  "COMMAND_CENTER_CANARY_BUSINESSES",
  "COMMAND_CENTER_EXECUTION_V1",
  "META_EXECUTION_APPLY_ENABLED",
  "META_EXECUTION_KILL_SWITCH",
  "META_EXECUTION_CANARY_BUSINESSES",
] as const;

const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

describe("release authority report", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      const value = ORIGINAL_ENV[key];
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  });

  it("marks live and main as aligned when the SHAs match", () => {
    const report = buildReleaseAuthorityReport({
      currentLiveSha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
      currentMainSha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
      currentMainShaSource: "git_remote",
      nodeEnv: "test",
      generatedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(report.verdicts.liveVsMain.status).toBe("aligned");
    expect(report.verdicts.docsVsRuntime.status).toBe("aligned");
    expect(report.verdicts.flagsVsRuntime.status).toBe("aligned");
    expect(report.unresolvedDriftItems).toEqual([]);
  });

  it("surfaces live vs main drift when the SHAs differ", () => {
    const report = buildReleaseAuthorityReport({
      currentLiveSha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
      currentMainSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      currentMainShaSource: "git_remote",
      nodeEnv: "test",
      generatedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(report.verdicts.liveVsMain.status).toBe("drifted");
    expect(report.unresolvedDriftItems.map((item) => item.id)).toContain(
      "release-live-vs-main",
    );
  });

  it("keeps archived Meta Decision OS legacy even when old flags are set", () => {
    process.env.META_DECISION_OS_V1 = "true";
    process.env.META_DECISION_OS_CANARY_BUSINESSES = "biz_1,biz_2";

    const report = buildReleaseAuthorityReport({
      currentLiveSha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
      currentMainSha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
      currentMainShaSource: "git_remote",
      nodeEnv: "test",
      generatedAt: "2026-04-11T00:00:00.000Z",
    });

    const surface = report.surfaces.find((entry) => entry.id === "meta_decision_os");
    expect(surface?.runtimeState).toBe("legacy");
    expect(surface?.flagPosture).toBeNull();
    expect(JSON.stringify(surface)).not.toContain("biz_1");
  });

  it("keeps archived apply and rollback legacy even when old gates are set", () => {
    process.env.COMMAND_CENTER_EXECUTION_V1 = "true";
    process.env.META_EXECUTION_APPLY_ENABLED = "false";

    const report = buildReleaseAuthorityReport({
      currentLiveSha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
      currentMainSha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
      currentMainShaSource: "git_remote",
      nodeEnv: "test",
      generatedAt: "2026-04-11T00:00:00.000Z",
    });

    const surface = report.surfaces.find(
      (entry) => entry.id === "command_center_execution_apply_rollback",
    );
    expect(surface?.runtimeState).toBe("legacy");
    expect(surface?.flagPosture).toBeNull();
    expect(surface?.driftState).toBe("aligned");
  });
});
