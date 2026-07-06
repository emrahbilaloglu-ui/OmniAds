import { beforeEach, describe, expect, it } from "vitest";
import { buildReleaseAuthorityCanonicalDoc } from "@/lib/release-authority/doc";
import {
  buildReleaseAuthorityReport,
  reconcileReleaseAuthorityMainSha,
} from "@/lib/release-authority/report";

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

describe("reconcileReleaseAuthorityMainSha", () => {
  const LIVE_SHA = "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0";
  const OTHER_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  function buildUnresolvedReport() {
    return buildReleaseAuthorityReport({
      currentLiveSha: LIVE_SHA,
      currentMainSha: null,
      currentMainShaSource: "unresolved",
      nodeEnv: "test",
      generatedAt: "2026-04-11T00:00:00.000Z",
    });
  }

  it("fills in an unresolved main SHA and aligns when it matches live", () => {
    const report = buildUnresolvedReport();
    expect(report.verdicts.liveVsMain.status).toBe("unknown");
    expect(report.unresolvedDriftItems.map((item) => item.id)).toContain(
      "release-live-vs-main",
    );

    const reconciled = reconcileReleaseAuthorityMainSha(report, {
      currentMainSha: LIVE_SHA,
      currentMainShaSource: "git_remote",
    });

    expect(reconciled.runtime.currentMainSha).toBe(LIVE_SHA);
    expect(reconciled.runtime.currentMainShaSource).toBe("git_remote");
    expect(reconciled.verdicts.liveVsMain.status).toBe("aligned");
    expect(reconciled.verdicts.liveMainDocs.status).toBe("aligned");
    expect(reconciled.verdicts.overall.status).toBe("aligned");
    expect(reconciled.unresolvedDriftItems).toEqual([]);
  });

  it("produces the same canonical doc as a report that resolved main directly", () => {
    const reconciled = reconcileReleaseAuthorityMainSha(
      buildUnresolvedReport(),
      {
        currentMainSha: LIVE_SHA,
        currentMainShaSource: "git_remote",
      },
    );
    const directlyAligned = buildReleaseAuthorityReport({
      currentLiveSha: LIVE_SHA,
      currentMainSha: LIVE_SHA,
      currentMainShaSource: "git_remote",
      nodeEnv: "test",
      generatedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(buildReleaseAuthorityCanonicalDoc(reconciled)).toBe(
      buildReleaseAuthorityCanonicalDoc(directlyAligned),
    );
  });

  it("keeps genuine drift blocking when the reconciled main SHA differs from live", () => {
    const reconciled = reconcileReleaseAuthorityMainSha(
      buildUnresolvedReport(),
      {
        currentMainSha: OTHER_SHA,
        currentMainShaSource: "git_remote",
      },
    );

    expect(reconciled.verdicts.liveVsMain.status).toBe("drifted");
    expect(reconciled.verdicts.overall.status).toBe("drifted");
    expect(reconciled.unresolvedDriftItems[0]).toMatchObject({
      id: "release-live-vs-main",
      status: "drifted",
    });
  });

  it("never overwrites a report that already resolved remote main", () => {
    const report = buildReleaseAuthorityReport({
      currentLiveSha: LIVE_SHA,
      currentMainSha: OTHER_SHA,
      currentMainShaSource: "github_branch_head",
      nodeEnv: "test",
      generatedAt: "2026-04-11T00:00:00.000Z",
    });

    const reconciled = reconcileReleaseAuthorityMainSha(report, {
      currentMainSha: LIVE_SHA,
      currentMainShaSource: "git_remote",
    });

    expect(reconciled).toBe(report);
    expect(reconciled.verdicts.liveVsMain.status).toBe("drifted");
  });

  it("ignores checker SHAs that are not full commit SHAs", () => {
    const report = buildUnresolvedReport();
    const reconciled = reconcileReleaseAuthorityMainSha(report, {
      currentMainSha: "not-a-sha",
      currentMainShaSource: "git_remote",
    });

    expect(reconciled).toBe(report);
    expect(reconciled.verdicts.liveVsMain.status).toBe("unknown");
  });
});
