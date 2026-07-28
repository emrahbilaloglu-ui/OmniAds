import { beforeEach, describe, expect, it, vi } from "vitest";
import { RELEASE_AUTHORITY_REPOSITORY } from "@/lib/release-authority/types";

vi.mock("@/lib/release-authority/report", () => ({
  getReleaseAuthorityReport: vi.fn(),
}));

const reportModule = await import("@/lib/release-authority/report");
const { GET } = await import("@/app/api/release-authority/route");

function buildPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "release-authority.v1",
    generatedAt: "2026-04-11T00:00:00.000Z",
    runtime: {
      nodeEnv: "production",
      currentLiveSha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
      currentLiveShaSource: "build_runtime",
      currentMainSha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
      currentMainShaSource: "github_branch_head",
    },
    release: {
      // Deliberately the real constant, not a copy: the assertions below check
      // the served identity against a hard-coded post-transfer literal, so this
      // fixture is what carries a reverted constant into the response.
      repository: RELEASE_AUTHORITY_REPOSITORY,
      deployUrl: "https://adsecute.com",
      buildInfoUrl: "https://adsecute.com/api/build-info",
      releaseAuthorityUrl: "https://adsecute.com/api/release-authority",
      previousKnownGoodSha: "3c13c44772ee510c67cfabc6b77ab05dae33b039",
      previousKnownGoodSource: "docs/meta-rollout-record-2026-04-07.md",
      featureAuthoritySource: {
        manifestModule: "lib/release-authority/inventory.ts",
        apiRoute: "/api/release-authority",
        adminRoute: "/admin/release-authority",
        canonicalDoc: "docs/v3-01-release-authority.md",
      },
    },
    verdicts: {
      liveVsMain: {
        status: "aligned",
        summary: "Current live SHA matches remote main.",
        blocking: false,
      },
      docsVsRuntime: {
        status: "aligned",
        summary: "Authority docs explicitly cover the current surfaces.",
        blocking: false,
      },
      flagsVsRuntime: {
        status: "aligned",
        summary: "Flag posture is aligned.",
        blocking: false,
      },
      liveMainDocs: {
        status: "aligned",
        summary: "Live, main, docs, and flag posture are aligned.",
        blocking: false,
      },
      overall: {
        status: "aligned",
        summary: "One release authority explains the baseline.",
        blocking: false,
      },
    },
    surfaces: [
      {
        id: "meta_decision_os",
        label: "Meta Decision OS",
        area: "meta",
        repositoryState: "merged",
        runtimeState: "live",
        docsState: "current",
        flagPosture: {
          mode: "enabled",
          flagKeys: ["META_DECISION_OS_V1"],
          summary: "Meta Decision OS is globally enabled.",
        },
        driftState: "aligned",
        driftReasons: [],
        references: [],
        notes: [],
      },
    ],
    unresolvedDriftItems: [],
    carryForward: {
      summary: "1 accepted carry-forward gap remains and must stay literal in the authority docs.",
      acceptanceGaps: [
        {
          id: "command-center-execution-live-canary-gap",
          surfaceId: "command_center_execution_apply_rollback",
          label: "Command Center apply / rollback proof carry-forward",
          status: "accepted_gap",
          proofLevel: "apply:provider_validated, rollback:provider_validated",
          detail:
            "Repo proof is provider-validated, but a live canary artifact chain is still outstanding.",
          nextRequirement:
            "Capture one narrow supported canary path with approve, apply, post-validate, and rollback artifacts.",
        },
      ],
    },
    reviewOrder: ["Review release identity first."],
    ...overrides,
  };
}

describe("GET /api/release-authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an aligned authority payload when live and main match", async () => {
    vi.mocked(reportModule.getReleaseAuthorityReport).mockResolvedValue(
      buildPayload() as never,
    );

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(payload.verdicts.liveVsMain.status).toBe("aligned");
  });

  it("returns drifted release identity when live and main differ", async () => {
    vi.mocked(reportModule.getReleaseAuthorityReport).mockResolvedValue(
      buildPayload({
        runtime: {
          nodeEnv: "production",
          currentLiveSha: "f6ca8358e1bb415b2b44b414b5a5c3340ee75df0",
          currentLiveShaSource: "build_runtime",
          currentMainSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          currentMainShaSource: "github_branch_head",
        },
        verdicts: {
          liveVsMain: {
            status: "drifted",
            summary:
              "Current live SHA differs from remote main.",
            blocking: true,
          },
          docsVsRuntime: {
            status: "aligned",
            summary: "Authority docs explicitly cover the current surfaces.",
            blocking: false,
          },
          flagsVsRuntime: {
            status: "aligned",
            summary: "Flag posture is aligned.",
            blocking: false,
          },
          liveMainDocs: {
            status: "drifted",
            summary: "Live, main, docs, or flag posture still drift.",
            blocking: true,
          },
          overall: {
            status: "drifted",
            summary: "Release authority still contains explainable drift.",
            blocking: true,
          },
        },
        unresolvedDriftItems: [
          {
            id: "release-live-vs-main",
            scope: "release",
            status: "drifted",
            detail: "Current live SHA differs from remote main.",
          },
        ],
      }) as never,
    );

    const response = await GET();
    const payload = await response.json();

    expect(payload.verdicts.liveVsMain.status).toBe("drifted");
    expect(payload.unresolvedDriftItems).toHaveLength(1);
  });

  it("preserves docs drift details from the authority report", async () => {
    vi.mocked(reportModule.getReleaseAuthorityReport).mockResolvedValue(
      buildPayload({
        verdicts: {
          liveVsMain: {
            status: "aligned",
            summary: "Current live SHA matches remote main.",
            blocking: false,
          },
          docsVsRuntime: {
            status: "drifted",
            summary: "1 surface still has docs posture drift.",
            blocking: true,
          },
          flagsVsRuntime: {
            status: "aligned",
            summary: "Flag posture is aligned.",
            blocking: false,
          },
          liveMainDocs: {
            status: "drifted",
            summary: "Live, main, docs, or flag posture still drift.",
            blocking: true,
          },
          overall: {
            status: "drifted",
            summary: "Release authority still contains explainable drift.",
            blocking: true,
          },
        },
        surfaces: [
          {
            id: "copies",
            label: "/platforms/meta/copies",
            area: "copy",
            repositoryState: "merged",
            runtimeState: "live",
            docsState: "missing",
            flagPosture: null,
            driftState: "drifted",
            driftReasons: ["Authority docs are missing for this surface."],
            references: [],
            notes: [],
          },
        ],
        unresolvedDriftItems: [
          {
            id: "surface-copies",
            scope: "docs",
            status: "drifted",
            surfaceId: "copies",
            detail: "Authority docs are missing for this surface.",
          },
        ],
      }) as never,
    );

    const response = await GET();
    const payload = await response.json();

    expect(payload.surfaces[0].docsState).toBe("missing");
    expect(payload.verdicts.docsVsRuntime.status).toBe("drifted");
  });

  it("returns allowlist-gated surfaces explicitly", async () => {
    vi.mocked(reportModule.getReleaseAuthorityReport).mockResolvedValue(
      buildPayload({
        surfaces: [
          {
            id: "meta_decision_os",
            label: "Meta Decision OS",
            area: "meta",
            repositoryState: "merged",
            runtimeState: "flagged",
            docsState: "current",
            flagPosture: {
              mode: "allowlist",
              flagKeys: [
                "META_DECISION_OS_V1",
                "META_DECISION_OS_CANARY_BUSINESSES",
              ],
              summary:
                "Meta Decision OS is enabled through a business allowlist.",
            },
            driftState: "aligned",
            driftReasons: [],
            references: [],
            notes: [],
          },
        ],
      }) as never,
    );

    const response = await GET();
    const payload = await response.json();

    expect(payload.surfaces[0].runtimeState).toBe("flagged");
    expect(payload.surfaces[0].flagPosture.mode).toBe("allowlist");
  });

  it("serves the post-transfer repository identity", async () => {
    vi.mocked(reportModule.getReleaseAuthorityReport).mockResolvedValue(
      buildPayload() as never,
    );

    const response = await GET();
    const payload = await response.json();

    // Hard-coded on purpose. The repository was transferred from
    // erhanrdn/OmniAds to emrahbilaloglu-ui/OmniAds; anything consuming this
    // route (post-deploy verification, the admin panel, the canonical doc)
    // treats this field as the answer to "where does this release come from".
    // Deriving the expectation from the constant would make the check vacuous.
    expect(payload.release.repository).toEqual({
      owner: "emrahbilaloglu-ui",
      name: "OmniAds",
      fullName: "emrahbilaloglu-ui/OmniAds",
      branch: "main",
    });
    expect(JSON.stringify(payload.release.repository)).not.toContain(
      "erhanrdn",
    );
  });

  it("includes the previous known-good SHA in the canonical response", async () => {
    vi.mocked(reportModule.getReleaseAuthorityReport).mockResolvedValue(
      buildPayload() as never,
    );

    const response = await GET();
    const payload = await response.json();

    expect(payload.release.previousKnownGoodSha).toBe(
      "3c13c44772ee510c67cfabc6b77ab05dae33b039",
    );
  });
});
