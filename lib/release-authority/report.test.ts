import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReleaseAuthorityCanonicalDoc } from "@/lib/release-authority/doc";
import {
  buildReleaseAuthorityReport,
  reconcileReleaseAuthorityMainSha,
  resolveRemoteMainSha,
} from "@/lib/release-authority/report";
import {
  RELEASE_AUTHORITY_IMAGE_NAMESPACE,
  RELEASE_AUTHORITY_LEGACY_IMAGE_NAMESPACE,
  RELEASE_AUTHORITY_LEGACY_WEB_IMAGE,
  RELEASE_AUTHORITY_LEGACY_WORKER_IMAGE,
  RELEASE_AUTHORITY_WEB_IMAGE,
  RELEASE_AUTHORITY_WORKER_IMAGE,
} from "@/lib/release-authority/types";

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

/**
 * The repository was transferred from `erhanrdn/OmniAds` to
 * `emrahbilaloglu-ui/OmniAds`. These assertions are deliberately written
 * against hard-coded post-transfer literals rather than against the constants
 * they are protecting, so reverting the constant fails the suite instead of
 * quietly moving both sides together.
 */
describe("release authority repository identity after the ownership transfer", () => {
  const ORIGINAL_REMOTE_MAIN_OVERRIDE =
    process.env.RELEASE_AUTHORITY_REMOTE_MAIN_SHA;

  beforeEach(() => {
    delete process.env.RELEASE_AUTHORITY_REMOTE_MAIN_SHA;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (typeof ORIGINAL_REMOTE_MAIN_OVERRIDE === "string") {
      process.env.RELEASE_AUTHORITY_REMOTE_MAIN_SHA =
        ORIGINAL_REMOTE_MAIN_OVERRIDE;
    } else {
      delete process.env.RELEASE_AUTHORITY_REMOTE_MAIN_SHA;
    }
  });

  it("reports the new owner as the release repository", () => {
    const report = buildReleaseAuthorityReport({
      currentLiveSha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
      currentMainSha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
      currentMainShaSource: "git_remote",
      nodeEnv: "test",
      generatedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(report.release.repository).toEqual({
      owner: "emrahbilaloglu-ui",
      name: "OmniAds",
      fullName: "emrahbilaloglu-ui/OmniAds",
      branch: "main",
    });
    expect(JSON.stringify(report.release)).not.toContain("erhanrdn");
  });

  it("resolves remote main against the new repository, not the redirecting old one", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requestedUrls.push(String(input));
        return {
          ok: true,
          json: async () => ({
            sha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
          }),
        } as unknown as Response;
      }),
    );

    const resolved = await resolveRemoteMainSha();

    expect(resolved.source).toBe("github_branch_head");
    // GitHub still redirects the pre-transfer path, so a stale literal here
    // would return 200 and a plausible SHA. Assert the exact URL we send.
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/emrahbilaloglu-ui/OmniAds/commits/main",
    ]);
    expect(requestedUrls.join("\n")).not.toContain("erhanrdn");
  });

  it("publishes new images under the new GHCR namespace", () => {
    expect(RELEASE_AUTHORITY_IMAGE_NAMESPACE).toBe(
      "ghcr.io/emrahbilaloglu-ui",
    );
    expect(RELEASE_AUTHORITY_WEB_IMAGE).toBe(
      "ghcr.io/emrahbilaloglu-ui/omniads-web",
    );
    expect(RELEASE_AUTHORITY_WORKER_IMAGE).toBe(
      "ghcr.io/emrahbilaloglu-ui/omniads-worker",
    );
  });

  it("keeps the legacy GHCR namespace so a pre-transfer rollback target stays pullable", () => {
    // Not dead code and not a leftover: every image built before the transfer,
    // including the current rollback target, exists only under this namespace.
    // A find-and-replace that "cleans this up" turns a rollback into a
    // "manifest unknown" at the worst possible moment.
    expect(RELEASE_AUTHORITY_LEGACY_IMAGE_NAMESPACE).toBe("ghcr.io/erhanrdn");
    expect(RELEASE_AUTHORITY_LEGACY_WEB_IMAGE).toBe(
      "ghcr.io/erhanrdn/omniads-web",
    );
    expect(RELEASE_AUTHORITY_LEGACY_WORKER_IMAGE).toBe(
      "ghcr.io/erhanrdn/omniads-worker",
    );
    expect(RELEASE_AUTHORITY_LEGACY_IMAGE_NAMESPACE).not.toBe(
      RELEASE_AUTHORITY_IMAGE_NAMESPACE,
    );
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
