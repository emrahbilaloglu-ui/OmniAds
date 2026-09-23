/**
 * The FIELD-level boundary of the historical config repair.
 *
 * The day proof (`sourceProvesWholeProviderDay`) is a property of the
 * entity-day. Whether a particular column may be dated to that day is a
 * property of the column, and the two used to be one decision. That collapse
 * produced both failure directions in the same dry run:
 *
 *   - a column rode into the manifest on a proof that did not cover it
 *     (ColorFull's inferred `bidStrategyType`), and
 *   - a whole business was blocked by it, because apply is bound to one
 *     manifest hash and cannot take a subset.
 *
 * These cases pin the split: refused fields are named and reported, admitted
 * fields still go through, and a receipt whose day proof is vacuous produces
 * nothing at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMetaCampaignDailyRange = vi.fn();
const getMetaAdSetDailyRange = vi.fn();
const repairCampaignRowsFromSnapshots = vi.fn();
const repairAdSetRowsFromSnapshots = vi.fn();

vi.mock("@/lib/meta/warehouse", () => ({
  getMetaCampaignDailyRange: (...args: unknown[]) => getMetaCampaignDailyRange(...args),
  getMetaAdSetDailyRange: (...args: unknown[]) => getMetaAdSetDailyRange(...args),
}));
vi.mock("@/lib/meta/serving", () => ({
  repairCampaignRowsFromSnapshots: (...args: unknown[]) => repairCampaignRowsFromSnapshots(...args),
  repairAdSetRowsFromSnapshots: (...args: unknown[]) => repairAdSetRowsFromSnapshots(...args),
}));
vi.mock("@/lib/meta/config-repair-write", () => ({
  applyMetaConfigRepairChanges: vi.fn(),
  verifyPreviouslyAppliedMetaConfigRepair: vi.fn(),
}));

import {
  isSameProviderReceipt,
  metaRepairFieldAdmission,
  repairMetaWarehouseTruthRange,
} from "@/lib/meta/repair";

const DAY = "2026-07-25";
const TZ = "Europe/Istanbul";

/** An observation shaped exactly as `serving.ts` hands one to the repair. */
function observation(overrides: {
  fieldScope: string[];
  observedFieldScope: string[];
  observedAt?: string;
  sourceSnapshotId?: string;
  corroboratingSourceSnapshotId?: string;
  sourceObservationId?: string | null;
  corroboratingObservationId?: string | null;
}) {
  const id = overrides.sourceSnapshotId ?? "source-1";
  return {
    id,
    accountId: "act_1",
    accountTimezone: TZ,
    capturedAt: overrides.observedAt ?? `${DAY}T17:42:14.637Z`,
    sourceKind: "meta_raw_snapshots" as const,
    providerObservation: {
      kind: "provider_config_receipt" as const,
      sourceSnapshotId: id,
      /* Receipt identity, distinct from the deduplicated content id above. */
      sourceObservationId: overrides.sourceObservationId === undefined
        ? "receipt-1" : overrides.sourceObservationId,
      observedAt: overrides.observedAt ?? `${DAY}T17:42:14.637Z`,
      entityUpdatedAt: "2026-04-13T14:49:25+0300",
      corroboratingSourceSnapshotId:
        overrides.corroboratingSourceSnapshotId ?? "confirm-1",
      corroboratingObservationId: overrides.corroboratingObservationId === undefined
        ? "receipt-2" : overrides.corroboratingObservationId,
      corroboratingObservedAt: "2026-07-28T04:08:19.751Z",
      normalizationVersion: 2,
      fieldScope: overrides.fieldScope,
      observedFieldScope: overrides.observedFieldScope,
    },
  };
}

const FULL_SCOPE = [
  "id", "campaign_id", "updated_time", "optimization_goal",
  "promoted_object{pixel_id,custom_event_type}", "bid_amount", "daily_budget",
];

/*
  ── ONE RULE, USED BY THE DAY PROOF AND BY THE APPLY GUARD ───────────────────
  Content ids are shared by payload deduplication; receipt ids are not. The
  apply guard reads the manifest about to be written rather than the observation
  it came from, so the rule is one exported predicate instead of two ternaries
  that could drift.
*/
describe("when two witnesses are the same provider receipt", () => {
  it("accepts a shared content id with two distinct receipts", () => {
    /* The Silveristic shape, verified read-only on production. */
    expect(isSameProviderReceipt({
      sourceSnapshotId: "0d629df6", corroboratingSourceSnapshotId: "0d629df6",
      sourceObservationId: "e5511bab", corroboratingObservationId: "c86e1e4b",
    })).toBe(false);
  });

  it("refuses one receipt standing as both witnesses", () => {
    expect(isSameProviderReceipt({
      sourceSnapshotId: "0d629df6", corroboratingSourceSnapshotId: "0d629df6",
      sourceObservationId: "e5511bab", corroboratingObservationId: "e5511bab",
    })).toBe(true);
  });

  it("accepts two receipts even when their content ids differ", () => {
    expect(isSameProviderReceipt({
      sourceSnapshotId: "content-1", corroboratingSourceSnapshotId: "content-2",
      sourceObservationId: "receipt-1", corroboratingObservationId: "receipt-2",
    })).toBe(false);
  });

  it("falls back to the content id when a receipt id is unknown", () => {
    /* Legacy snapshot-only rows: same content, unprovable as distinct reads. */
    expect(isSameProviderReceipt({
      sourceSnapshotId: "legacy-1", corroboratingSourceSnapshotId: "legacy-1",
      sourceObservationId: null, corroboratingObservationId: null,
    })).toBe(true);
    expect(isSameProviderReceipt({
      sourceSnapshotId: "legacy-1", corroboratingSourceSnapshotId: "legacy-2",
      sourceObservationId: null, corroboratingObservationId: null,
    })).toBe(false);
  });

  it("falls back when only ONE side carries a receipt id", () => {
    /* A known id and an unknown one cannot be compared as receipts. */
    expect(isSameProviderReceipt({
      sourceSnapshotId: "mixed-1", corroboratingSourceSnapshotId: "mixed-1",
      sourceObservationId: "receipt-1", corroboratingObservationId: null,
    })).toBe(true);
  });
});

describe("which field a dated receipt may write", () => {
  const row = { date: DAY, accountTimezone: TZ };

  it("admits a field the receipt requested and the provider stated", () => {
    expect(metaRepairFieldAdmission({
      field: "optimizationGoal",
      source: observation({ fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE }),
      row,
    })).toBeNull();
  });

  /*
    ── THE INFERRED BID STRATEGY ───────────────────────────────────────────────
    With `bid_strategy` absent, `normalizeBidStrategy` reports "manual_bid" from
    a bare `bid_amount`. Right for a live entity; unsound as history, because
    "absent" there also covers "never requested".
  */
  it.each(["bidStrategyType", "bidValue", "bidValueFormat"])(
    "refuses %s when the provider never stated a bid strategy",
    (field) => {
      expect(metaRepairFieldAdmission({
        field,
        source: observation({ fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE }),
        row,
      })).toBe("bid_strategy_not_observed");
    },
  );

  it("refuses a bid field that was REQUESTED but came back absent", () => {
    /* A requested-and-absent field is an observed absence, not a licence to
       infer a strategy from the amount that did come back. */
    expect(metaRepairFieldAdmission({
      field: "bidStrategyType",
      source: observation({
        fieldScope: [...FULL_SCOPE, "bid_strategy"],
        observedFieldScope: FULL_SCOPE,
      }),
      row,
    })).toBe("bid_strategy_not_observed");
  });

  it("admits a bid field when the strategy was requested AND stated", () => {
    const scope = [...FULL_SCOPE, "bid_strategy"];
    expect(metaRepairFieldAdmission({
      field: "bidStrategyType",
      source: observation({ fieldScope: scope, observedFieldScope: scope }),
      row,
    })).toBeNull();
  });

  /*
    ── THE BUDGET CLOCK ────────────────────────────────────────────────────────
    Meta documents `updated_time` by exclusion, and daily/lifetime budget are
    two of the three write classes named as NOT advancing it. So an unmoved
    clock cannot date a budget to a day, and the day-closing witness sits
    minutes after midnight in ~99% of the measured rows.
  */
  it.each(["dailyBudget", "lifetimeBudget", "isBudgetMixed"])(
    "refuses %s when the day's opening was never observed",
    (field) => {
      expect(metaRepairFieldAdmission({
        field,
        source: observation({
          fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE,
          observedAt: `${DAY}T17:42:14.637Z`,
        }),
        row,
      })).toBe("budget_day_opening_unobserved");
    },
  );

  it("admits a budget observed at or before the day's opening", () => {
    /* The rule is a condition, not a ban: an observation that opens the day
       satisfies it without any change here. 2026-07-25 in Istanbul opens at
       2026-07-24T21:00Z. */
    expect(metaRepairFieldAdmission({
      field: "dailyBudget",
      source: observation({
        fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE,
        observedAt: "2026-07-24T21:00:00.000Z",
      }),
      row,
    })).toBeNull();
  });

  it("refuses a budget when the observation clock is unreadable", () => {
    expect(metaRepairFieldAdmission({
      field: "dailyBudget",
      source: observation({
        fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE,
        observedAt: "not-an-instant",
      }),
      row,
    })).toBe("budget_day_opening_unobserved");
  });

  it("refuses both classes when there is no observation at all", () => {
    expect(metaRepairFieldAdmission({ field: "bidValue", source: undefined, row }))
      .toBe("bid_strategy_not_observed");
    expect(metaRepairFieldAdmission({ field: "dailyBudget", source: undefined, row }))
      .toBe("budget_day_opening_unobserved");
  });
});

describe("the manifest carries the safe fields and names the refused ones", () => {
  const stored = {
    businessId: "biz-1", providerAccountId: "act_1", date: DAY,
    accountTimezone: TZ, adsetId: "a1", campaignId: "c1",
    optimizationGoal: null, customEventType: null, pixelId: null,
    customConversionId: null, promotedObjectJson: null,
    bidStrategyType: null, bidValue: null, bidValueFormat: null,
    dailyBudget: null, lifetimeBudget: null,
    isBudgetMixed: false, isConfigMixed: false, isOptimizationGoalMixed: false,
    isBidStrategyMixed: false, isBidValueMixed: false,
  };
  /* What the receipt would fill: two sound fields, one inferred bid label, one
     budget the clock cannot date. This is ColorFull's ad set in miniature. */
  const filled = {
    ...stored,
    optimizationGoal: "Offsite Conversions",
    customEventType: "PURCHASE",
    bidStrategyType: "manual_bid",
    bidValue: 2000,
    bidValueFormat: "currency",
    dailyBudget: 1300,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getMetaCampaignDailyRange.mockResolvedValue([]);
    repairCampaignRowsFromSnapshots.mockResolvedValue([]);
    getMetaAdSetDailyRange.mockResolvedValue([stored]);
  });

  async function run(source: ReturnType<typeof observation>) {
    repairAdSetRowsFromSnapshots.mockImplementation(async (input: {
      onObservation?: (key: string, value: unknown) => void;
    }) => {
      input.onObservation?.(`act_1:${DAY}:a1`, source);
      return [filled];
    });
    return await repairMetaWarehouseTruthRange({
      businessId: "biz-1", startDate: DAY, endDate: DAY, dryRun: true,
    }) as {
      manifest: Array<{ field: string; newValue: unknown }>;
      withheldFields: Array<{ field: string; refusal: string; proposedValue: unknown }>;
      withheldByReason: Record<string, number>;
      adsetRowsChanged: number;
      manifestHash: string;
    };
  }

  it("keeps the sound fields and withholds only the unsupportable ones", async () => {
    const result = await run(observation({
      fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE,
    }));
    expect(result.manifest.map((change) => change.field).sort())
      .toEqual(["customEventType", "optimizationGoal"]);
    /* The whole entity is NOT blocked by the fields that were refused. */
    expect(result.adsetRowsChanged).toBe(1);
  });

  it("names every refusal, with its rule and the value it would have written", async () => {
    const result = await run(observation({
      fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE,
    }));
    expect(result.withheldFields.map((entry) => [entry.field, entry.refusal]).sort())
      .toEqual([
        ["bidStrategyType", "bid_strategy_not_observed"],
        ["bidValue", "bid_strategy_not_observed"],
        ["bidValueFormat", "bid_strategy_not_observed"],
        ["dailyBudget", "budget_day_opening_unobserved"],
      ]);
    expect(result.withheldByReason).toEqual({
      bid_strategy_not_observed: 3,
      budget_day_opening_unobserved: 1,
    });
    /* The proposed value is kept so a reviewer can judge the refusal itself. */
    expect(result.withheldFields.find((entry) => entry.field === "bidStrategyType")?.proposedValue)
      .toBe("manual_bid");
  });

  it("never writes an inferred bid strategy, whatever else the receipt proves", async () => {
    const result = await run(observation({
      fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE,
    }));
    expect(result.manifest.some((change) => change.newValue === "manual_bid")).toBe(false);
    expect(result.manifest.some((change) => change.field.startsWith("bid"))).toBe(false);
  });

  /*
    ── A WITNESS IS A RECEIPT, NOT A PAYLOAD ──────────────────────────────────
    Silveristic 2026-09-11, verified read-only on production: source e5511bab
    and witness c86e1e4b are separate observation rows 6.5 minutes apart that
    SHARE canonical snapshot 0d629df6, one of 211 observations on it. Comparing
    content ids threw that real witness away; comparing receipt ids keeps it.
  */
  it("accepts a witness that shares the content id but is another receipt", async () => {
    const result = await run(observation({
      fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE,
      sourceSnapshotId: "0d629df6", corroboratingSourceSnapshotId: "0d629df6",
      sourceObservationId: "e5511bab", corroboratingObservationId: "c86e1e4b",
    }));
    expect(result.manifest.map((change) => change.field).sort())
      .toEqual(["customEventType", "optimizationGoal"]);
    expect(result.adsetRowsChanged).toBe(1);
  });

  it("carries both receipt identities into the manifest", async () => {
    const result = await run(observation({
      fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE,
      sourceSnapshotId: "0d629df6", corroboratingSourceSnapshotId: "0d629df6",
      sourceObservationId: "e5511bab", corroboratingObservationId: "c86e1e4b",
    })) as unknown as { manifest: Array<{ source: Record<string, unknown> }> };
    for (const change of result.manifest) {
      expect(change.source.sourceObservationId).toBe("e5511bab");
      expect(change.source.corroboratingObservationId).toBe("c86e1e4b");
      /* The content id is still reported, and is legitimately the same. */
      expect(change.source.sourceSnapshotId).toBe("0d629df6");
    }
  });

  it("produces nothing when the witness is the SAME receipt", async () => {
    const result = await run(observation({
      fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE,
      sourceSnapshotId: "0d629df6", corroboratingSourceSnapshotId: "0d629df6",
      sourceObservationId: "same-receipt", corroboratingObservationId: "same-receipt",
    }));
    expect(result.manifest).toEqual([]);
    expect(result.withheldFields).toEqual([]);
    expect(result.adsetRowsChanged).toBe(0);
  });

  it("falls back to the content id when a receipt has no observation row", async () => {
    /* Legacy snapshot-only receipts cannot be shown to be different GETs, so an
       unknown receipt identity is treated as possibly-the-same. */
    const result = await run(observation({
      fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE,
      sourceSnapshotId: "legacy-1", corroboratingSourceSnapshotId: "legacy-1",
      sourceObservationId: null, corroboratingObservationId: null,
    }));
    expect(result.manifest).toEqual([]);
    expect(result.adsetRowsChanged).toBe(0);
  });

  it("still admits a legacy pair whose content ids differ", async () => {
    const result = await run(observation({
      fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE,
      sourceSnapshotId: "legacy-1", corroboratingSourceSnapshotId: "legacy-2",
      sourceObservationId: null, corroboratingObservationId: null,
    }));
    expect(result.manifest.map((change) => change.field).sort())
      .toEqual(["customEventType", "optimizationGoal"]);
  });

  it("changes the manifest hash when a field is withheld", async () => {
    /* The hash binds the apply, so it must move when the manifest does - and it
       must NOT move for the withheld report, which apply never touches. */
    const refused = await run(observation({
      fieldScope: FULL_SCOPE, observedFieldScope: FULL_SCOPE,
    }));
    const scope = [...FULL_SCOPE, "bid_strategy"];
    const admitted = await run(observation({
      fieldScope: scope, observedFieldScope: scope,
    }));
    expect(admitted.manifest.map((change) => change.field)).toContain("bidStrategyType");
    expect(admitted.manifestHash).not.toBe(refused.manifestHash);
  });
});
