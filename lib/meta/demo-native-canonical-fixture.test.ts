import { describe, expect, it } from "vitest";
import { getDemoMetaCreatives, DEMO_BUSINESS_ID } from "@/lib/demo-business";
import { readDemoNativeCanonicalDecisionInventory } from "@/lib/meta/demo-native-canonical-fixture";
import { projectCanonicalNativeAdDecisionToBriefing } from "@/app/api/creatives/briefing/canonical-projection";
import {
  hasNativeDecisionOriginLineage,
  isCutPrimaryAction,
} from "@/components/creatives/briefing/action-handlers";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";

const PROVIDER_ACCOUNT_ID = "act_210009998877";

describe("demo native canonical fixture", () => {
  it("serves all demo ads from a hash-bound, synthetic review-only inventory", () => {
    const rows = getDemoMetaCreatives().rows as MetaCreativeApiRow[];
    const inventory = readDemoNativeCanonicalDecisionInventory({
      businessId: DEMO_BUSINESS_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      rows,
    });

    expect(inventory.status).toBe("available");
    if (inventory.status !== "available") return;
    expect(inventory.items).toHaveLength(rows.length);
    expect(inventory.generation.expectedAdCount).toBe(rows.length);
    expect(inventory.generation.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      inventory.items.every(
        (decision) =>
          decision.sourceAuthority?.status ===
            "demo_synthetic_review_only" &&
          decision.sourceAuthority.actionEligible === false &&
          decision.sourceAuthority.authorizedAction === null &&
          decision.identityResolution?.adActionEligible === false,
      ),
    ).toBe(true);
  });

  it("shows an engine-derived Cut for review but cannot expose provider execution", () => {
    const rows = getDemoMetaCreatives().rows as MetaCreativeApiRow[];
    const inventory = readDemoNativeCanonicalDecisionInventory({
      businessId: DEMO_BUSINESS_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      rows,
    });
    expect(inventory.status).toBe("available");
    if (inventory.status !== "available") return;
    const decision = inventory.items.find(
      (item) => item.sourceDecision.label === "cut",
    );
    expect(decision).toBeDefined();
    const row = rows.find((item) => item.real_ad_id === decision!.parentChain.ad!.id);
    const projection = projectCanonicalNativeAdDecisionToBriefing({
      decision: decision!,
      row,
    });

    expect(projection).toMatchObject({
      lane: "watching",
      card: {
        label: "cut",
        primary: { kind: "review" },
        sourceDecisionAuthorityStatus: "demo_synthetic_review_only",
        sourceDecisionActionEligible: false,
        sourceDecisionAuthorizedAction: null,
      },
    });
    expect(isCutPrimaryAction(projection!.card)).toBe(false);
    expect(hasNativeDecisionOriginLineage(projection!.card)).toBe(false);
  });

  it("fails the whole fixture closed when a demo source row drifts", () => {
    const rows = (
      getDemoMetaCreatives().rows as MetaCreativeApiRow[]
    ).map((row, index) =>
      index === 0 ? { ...row, spend: row.spend + 1 } : row,
    );
    const inventory = readDemoNativeCanonicalDecisionInventory({
      businessId: DEMO_BUSINESS_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      rows,
    });

    expect(inventory).toEqual({
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: "demo_fixture_input_hash_mismatch",
    });
  });
});
