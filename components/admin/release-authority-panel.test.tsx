import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReleaseAuthorityPanel } from "@/components/admin/release-authority-panel";
import {
  RELEASE_AUTHORITY_REPOSITORY,
  type ReleaseAuthorityReport,
} from "@/lib/release-authority/types";

const report: ReleaseAuthorityReport = {
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
    // The real constant, so a reverted repository identity actually reaches the
    // rendered panel instead of being masked by a stale local copy.
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
      summary: "Authority docs cover the current surfaces.",
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
      references: [
        {
          kind: "api",
          path: "app/api/meta/decision-os/route.ts",
          label: "Meta Decision OS route",
        },
      ],
      notes: ["Deterministic decision surface remains live."],
    },
    {
      id: "legacy_meta_alias",
      label: "Legacy Meta Alias",
      area: "legacy",
      repositoryState: "merged",
      runtimeState: "legacy",
      docsState: "current",
      flagPosture: null,
      driftState: "aligned",
      driftReasons: [],
      references: [
        {
          kind: "alias",
          path: "app/(dashboard)/meta/page.tsx",
          label: "/meta -> /platforms/meta",
        },
      ],
      notes: ["Legacy redirect remains intentionally visible."],
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
  reviewOrder: [
    "Review release identity first.",
    "Review the feature matrix next.",
  ],
};

describe("ReleaseAuthorityPanel", () => {
  it("renders the release authority summary and feature matrix", () => {
    const html = renderToStaticMarkup(<ReleaseAuthorityPanel report={report} />);

    expect(html).toContain("Release Authority");
    expect(html).toContain("Current Live SHA");
    expect(html).toContain("Meta Decision OS");
    expect(html).toContain("Legacy Meta Alias");
    expect(html).toContain("GPT Review Order");
    expect(html).toContain("/api/release-authority");
  });

  it("renders the post-transfer repository identity", () => {
    const html = renderToStaticMarkup(<ReleaseAuthorityPanel report={report} />);

    // Hard-coded post-transfer literal: an operator reading this panel must be
    // able to see which repository the running release claims to come from, and
    // the check must fail if the identity is reverted to the pre-transfer owner.
    expect(html).toContain("emrahbilaloglu-ui/OmniAds");
    expect(html).not.toContain("erhanrdn");
  });
});
