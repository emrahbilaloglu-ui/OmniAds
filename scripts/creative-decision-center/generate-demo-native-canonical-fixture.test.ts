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
  /*
    KNOWN RED, DELIBERATELY NOT REGENERATED.

    Two of the three current generator differences are the correct consequence
    of the ad-grain lifecycle contract: `computeNativeAdLifecycleEvidence`
    (jobs/ad-decisions-job.ts) now fails closed, so the demo's synthetic
    `fatigueStatus`/`lifecyclePosition` inputs are replaced by "unknown"/null.
    m-ad-4 therefore trades `past_peak_unclear_signal` for
    `lifecycle_unavailable` and recovers the -3 past-peak confidence delta
    (72 -> 75), and m-ad-8 loses its `fatigue_watch` badge and suffix. Both are
    honest.

    m-ad-5 is not. It is a `test`-cohort ad that the economic Cut branch had
    just declined (ROAS 2.20 against a 2.5 target, "just above breakeven"), and
    it now publishes an ACTING Cut at `decisionState: "act"` while still
    carrying the blocker `refresh_ad_lifecycle_evidence`, which states that no
    ad-level fatigue verdict exists. The ratio-zones branch that produced it
    asks for a hold (`{ blockedActionType: "refresh", label: "keep" }`,
    gates/ratio-zones.ts), but `finalizeDecision` runs
    `applyTestCohortRefreshOverride` FIRST and then gates the requested hold on
    `preAuthorityLabel === authorityHold.blockedActionType`
    (gates/types.ts:478-487). On a `test` cohort the transform has already
    rewritten `refresh` to `cut`, so that equality fails and the hold is
    discarded: `authorityBlocker` and `blockedActionType` both land null, so
    nothing withholds the Cut that the branch had asked to withhold. This
    fixture's `executionAction` still reads null, but only because demo
    inventory is review-only; on a real account the same row carries no
    authority blocker at all.

    Regenerating would commit that escalation as expected output. The committed
    fixture stays as it is until gates/types.ts preserves the hold across the
    label transform; this test is the tripwire that says so.
  */
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
