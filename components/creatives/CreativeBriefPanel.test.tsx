import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import type { MetaCreativeBrief } from "@/lib/meta/creative-brief-contract";
import { CreativeBriefPanel } from "./CreativeBriefPanel";

const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const BRIEF_ID = "11111111-1111-4111-8111-111111111111";

function decisionCard(
  overrides: Partial<BriefingCreativeCard> = {},
): BriefingCreativeCard {
  return {
    creativeId: "creative_1",
    sourceDecisionSnapshotId: SNAPSHOT_ID,
    sourceDecisionSnapshotMatch: "matched",
    ...overrides,
  } as BriefingCreativeCard;
}

function reviewedBrief(): MetaCreativeBrief {
  return {
    contractVersion: "meta-creative-brief.v1",
    id: BRIEF_ID,
    businessId: "business_1",
    providerAccountId: "act_1",
    sourceDecision: {
      decisionId: "decision_1",
      snapshotId: SNAPSHOT_ID,
      creativeId: "creative_1",
      engineVersion: "v3-test",
      snapshotAsOf: "2026-07-10",
      scopeType: "account",
      scopeId: "*",
      publishedLabel: "scale",
      rawLabel: "scale",
      reason: "Verified evidence",
      badges: [],
      trigger: "creative_studio_detail",
    },
    content: {
      keep: "Keep the hook.",
      change: "Change the proof order.",
      next: "Test a shorter opening.",
    },
    status: "reviewed",
    version: 2,
    createdBy: "user_1",
    updatedBy: "user_1",
    reviewedBy: "user_1",
    createdAt: "2026-07-10T09:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
    reviewedAt: "2026-07-10T10:00:00.000Z",
  };
}

describe("CreativeBriefPanel", () => {
  it("withholds creation when no account-scoped snapshot reconciles", () => {
    const html = renderToStaticMarkup(
      <CreativeBriefPanel
        businessId="business_1"
        providerAccountId="act_1"
        creativeId="creative_1"
        decisionCard={decisionCard({
          sourceDecisionSnapshotId: null,
          sourceDecisionSnapshotMatch: "unavailable",
        })}
        existingBrief={null}
        onBriefChanged={vi.fn()}
      />,
    );

    expect(html).toContain("Brief creation is withheld");
    expect(html).toContain("source snapshot unavailable");
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(5);
    expect(html).not.toContain("Open in Launchpad");
  });

  it("links only a clean reviewed brief into account-bound Launchpad lineage", () => {
    const html = renderToStaticMarkup(
      <CreativeBriefPanel
        businessId="business_1"
        providerAccountId="act_1"
        creativeId="creative_1"
        decisionCard={decisionCard()}
        existingBrief={reviewedBrief()}
        onBriefChanged={vi.fn()}
      />,
    );

    expect(html).toContain("It never changes the engine label");
    expect(html).toContain("Open in Launchpad");
    expect(html).toContain("providerAccountId=act_1");
    expect(html).toContain(`creativeBriefId=${BRIEF_ID}`);
    expect(html).toContain(`sourceDecisionSnapshotId=${SNAPSHOT_ID}`);
    expect(html).toContain(`brief ${BRIEF_ID} · v2 · source ${SNAPSHOT_ID}`);
  });

  it("keeps an older brief editable without pretending its source moved", () => {
    const html = renderToStaticMarkup(
      <CreativeBriefPanel
        businessId="business_1"
        providerAccountId="act_1"
        creativeId="creative_1"
        decisionCard={decisionCard({
          sourceDecisionSnapshotId: "33333333-3333-4333-8333-333333333333",
        })}
        existingBrief={reviewedBrief()}
        onBriefChanged={vi.fn()}
      />,
    );

    expect(html).toContain("immutable source remains historical");
    expect(html).toContain(SNAPSHOT_ID);
  });
});
