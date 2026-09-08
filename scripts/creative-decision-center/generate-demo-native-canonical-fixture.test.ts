import { describe, expect, it } from "vitest";
import committedFixture from "@/lib/meta/fixtures/demo-native-canonical-generation.v1.json";
import { getDemoMetaCreatives } from "@/lib/demo-business";
import {
  demoNativeFixtureInputHash,
  stableDemoFixtureJson,
} from "@/lib/meta/demo-native-canonical-contract";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import { buildDemoNativeCanonicalFixture } from "./generate-demo-native-canonical-fixture";

const PROVIDER_ACCOUNT_ID = "act_210009998877";

const DEMO_PIPELINE_CONSUMED_ROW_FIELDS = [
  "real_ad_id",
  "creative_id",
  "account_id",
  "account_name",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "name",
  "effective_status",
  "objective",
  "optimization_goal",
  "currency",
  "launch_date",
  "spend",
  "purchase_value",
  "purchases",
  "roas",
  "cpa",
  "cpm",
  "impressions",
  "link_clicks",
  "landing_page_views",
  "add_to_cart",
  "initiate_checkout",
  "ctr_all",
  "frequency",
  "thumbstop",
  "video25",
  "video50",
  "video75",
  "video100",
  "format",
  "thumbnail_url",
  "image_url",
  "card_preview_url",
] as const satisfies readonly (keyof MetaCreativeApiRow)[];

describe("demo native canonical fixture generator", () => {
  it("reproduces the committed fixture byte-for-byte", () => {
    const generated = `${JSON.stringify(
      JSON.parse(
        stableDemoFixtureJson(buildDemoNativeCanonicalFixture()),
      ),
      null,
      2,
    )}\n`;
    const committed = `${JSON.stringify(committedFixture, null, 2)}\n`;

    expect(generated).toBe(committed);
  });

  it("keeps a Test-cohort Refresh candidate held and confidence-capped after its Cut transform", () => {
    const fixture = buildDemoNativeCanonicalFixture();
    const heldRefresh = fixture.items.find((item) => item.adId === "m-ad-5");

    expect(heldRefresh).toMatchObject({
      lifecycleRole: "test",
      sourceLabel: "keep",
      preAuthorityLabel: "cut",
      heldAction: "cut",
      authorityBlocker: "native_metrics_unavailable",
      decisionState: "blocked",
      confidence: 65,
      buyerAction: null,
      executionAction: null,
    });
    expect(heldRefresh?.badges).toContain("lifecycle_unavailable");
    expect(heldRefresh?.blockerCodes).toContain(
      "refresh_ad_lifecycle_evidence",
    );
  });

  it("uses the canonical server projection for Main-scale semantics while keeping demo execution closed", () => {
    const fixture = buildDemoNativeCanonicalFixture();
    const mainScale = fixture.items.find((item) => item.adId === "m-ad-1");

    // `main` is a RESOLVED campaign role, so its Scale sits in the Act lane
    // like every other resolved role; only `role_unresolved` stays on monitor.
    // Execution stays closed regardless: demo inventory is review evidence.
    expect(mainScale).toMatchObject({
      sourceLabel: "scale",
      lifecycleRole: "main",
      assessment: "proven_winner",
      decisionState: "act",
      buyerAction: "scale",
      buyerLabel: "Scale - Scale budget",
      executionAction: null,
    });
  });

  it.each(DEMO_PIPELINE_CONSUMED_ROW_FIELDS)(
    "binds the consumed Meta creative field %s into the source hash",
    (field) => {
      const rows = structuredClone(
        getDemoMetaCreatives().rows,
      ) as MetaCreativeApiRow[];
      const baselineHash = demoNativeFixtureInputHash(
        PROVIDER_ACCOUNT_ID,
        rows,
      );
      const value = rows[0]![field];
      rows[0] = {
        ...rows[0]!,
        [field]:
          typeof value === "number"
            ? value + 1
            : `${String(value ?? "")}-source-drift`,
      };

      expect(
        demoNativeFixtureInputHash(PROVIDER_ACCOUNT_ID, rows),
      ).not.toBe(baselineHash);
    },
  );
});
