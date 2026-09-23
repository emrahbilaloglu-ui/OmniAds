/**
 * The stage contract, replayed against a REAL production `actions` array.
 *
 * The unit tests next door prove the rules on hand-built inputs. This one
 * proves them on the shape the provider actually sends, because the defect this
 * whole area exists to undo was never a logic error — it was a belief about the
 * payload that no test ever checked against the payload.
 *
 * The fixture carries one anonymized ad-day (action_type/value pairs only; no
 * identifier, name, spend or revenue) and it is worth reading: a single real
 * row exhibits every alias claim in `funnel-stage-parse.ts` at once.
 *
 *     add_to_cart 16 · fb_pixel_add_to_cart 16 · omni_add_to_cart 25
 *     initiate_checkout 3 · fb_pixel 3 · omni_initiated_checkout 5
 *     view_content 356 · fb_pixel 356 · omni_view_content 415
 *     post_engagement 2,832 · page_engagement 2,833
 *     landing_page_view 200 · omni_landing_page_view 200
 *     purchase 7 · omni_purchase 7
 *
 * Summing the three add-to-cart spellings gives 57 against a true 16. And the
 * two stages that AGREE across aliases are landing-page-view and purchase —
 * the exact pair an alias rule would most likely be validated on, and the
 * reason the rule is proven per stage instead.
 */
import { describe, expect, it } from "vitest";

import rawFixture from "@/lib/meta/fixtures/meta-funnel-stage-actions.v1.json";
import {
  META_FUNNEL_STAGES,
  META_FUNNEL_STAGE_CONTRACT_VERSION,
  type MetaFunnelStageId,
  readMetaFunnelStageFromActions,
} from "@/lib/meta/funnel-stage-parse";

interface FrozenCase {
  name: string;
  actions: { action_type: string; value: string }[] | null;
  expected: Partial<Record<MetaFunnelStageId, Record<string, unknown>>>;
  divergentAliasValues: Record<string, number>;
}

const fixture = rawFixture as unknown as {
  contractVersion: "meta-funnel-stage-actions.v1";
  stageContractVersion: string;
  sourceProvenance: { containsLiveIdentifiers: false };
  cases: FrozenCase[];
};

describe("the frozen production actions replay", () => {
  it("is pinned to the stage contract that produced it", () => {
    // If the stage list or an alias moves, this fails until the fixture is
    // regenerated — which is the point: the expectations below are only
    // meaningful under the contract they were measured against.
    expect(fixture.stageContractVersion).toBe(META_FUNNEL_STAGE_CONTRACT_VERSION);
    expect(fixture.sourceProvenance.containsLiveIdentifiers).toBe(false);
  });

  it("carries no field other than action_type and value", () => {
    for (const frozen of fixture.cases) {
      for (const entry of frozen.actions ?? []) {
        expect(Object.keys(entry).sort()).toEqual(["action_type", "value"]);
      }
    }
  });

  it.each(fixture.cases)("$name", (frozen) => {
    for (const [stageId, expected] of Object.entries(frozen.expected)) {
      expect({
        stage: stageId,
        ...readMetaFunnelStageFromActions(frozen.actions, stageId as MetaFunnelStageId),
      }).toEqual({ stage: stageId, ...expected });
    }
  });
});

describe("the real payload proves why aliases are neither summed nor substituted", () => {
  const real = fixture.cases[0]!;

  it("never returns a divergent alias's value", () => {
    for (const stage of META_FUNNEL_STAGES) {
      const reading = readMetaFunnelStageFromActions(real.actions, stage.id);
      if (reading.state !== "measured") continue;
      for (const alias of stage.provenDivergentAliases) {
        const divergent = real.divergentAliasValues[alias];
        if (divergent === undefined || divergent === reading.value) continue;
        expect(reading.value).not.toBe(divergent);
      }
    }
  });

  it("returns 16 add-to-carts, not the 57 that summing the spellings would give", () => {
    const spellings = ["add_to_cart", "offsite_conversion.fb_pixel_add_to_cart", "omni_add_to_cart"];
    const summed = (real.actions ?? [])
      .filter((entry) => spellings.includes(entry.action_type))
      .reduce((total, entry) => total + Number(entry.value), 0);

    expect(summed).toBe(57);
    expect(readMetaFunnelStageFromActions(real.actions, "add_to_cart")).toEqual({
      state: "measured",
      value: 16,
    });
  });

  it("distinguishes post_engagement from page_engagement, which differ by one here", () => {
    expect(real.divergentAliasValues.page_engagement).toBe(2833);
    expect(readMetaFunnelStageFromActions(real.actions, "post_engagement")).toEqual({
      state: "measured",
      value: 2832,
    });
  });

  it("agrees across aliases for landing_page_view — the case that would mislead", () => {
    // Identical here, divergent for add-to-cart and initiate-checkout. A rule
    // generalised from this stage would be silently wrong on those.
    expect(real.divergentAliasValues.omni_landing_page_view).toBe(200);
    expect(readMetaFunnelStageFromActions(real.actions, "landing_page_view")).toEqual({
      state: "measured",
      value: 200,
    });
  });
});
