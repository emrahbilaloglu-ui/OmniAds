import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db";
import { NATIVE_AD_DB_BATCH_SIZE } from "../batching";
import {
  adDecisionStabilityKey,
  applyLabelHysteresis,
  readPreviousPublishedAdLabels,
  stabilizeDecisionLabel,
  type PreviousPublishedLabel,
} from "../decision-stability";
import type { DecisionLabel, DecisionOutput } from "../types";

function runSequence(rawLabels: DecisionLabel[]): {
  published: DecisionLabel[];
  suppressedDays: number[];
} {
  const published: DecisionLabel[] = [];
  const suppressedDays: number[] = [];
  let previous: PreviousPublishedLabel | null = null;
  rawLabels.forEach((raw, day) => {
    const result = applyLabelHysteresis(raw, previous);
    published.push(result.publishedLabel);
    if (result.suppressed) suppressedDays.push(day);
    previous = {
      publishedLabel: result.publishedLabel,
      rawLabel: result.rawLabel,
    };
  });
  return { published, suppressedDays };
}

describe("hard-label hysteresis (named live flip cases 2026-07-04..06)", () => {
  it("keeps prior labels separate when an external account/ad identity is reused by another ref", async () => {
    const businessId = "00000000-0000-4000-8000-000000000101";
    const firstRef = "00000000-0000-4000-8000-000000000121";
    const secondRef = "00000000-0000-4000-8000-000000000122";
    const query = vi.fn(async () =>
      [firstRef, secondRef].map((providerAccountRefId, index) => ({
        source_snapshot_id: `00000000-0000-4000-8000-00000000020${index + 1}`,
        provider_account_ref_id: providerAccountRefId,
        provider_account_id: "act-reused",
        decision_entity_type: "ad",
        decision_entity_id: "ad-reused",
        source_as_of_date: "2026-07-13",
        source_computed_at: "2026-07-13T03:10:00.000Z",
        source_engine_version: "engine-v3-native-ad.v1",
        label: index === 0 ? "keep" : "diagnose",
        raw_label: index === 0 ? "scale" : "diagnose",
        source_evaluation_id: `00000000-0000-4000-8000-00000000021${index + 1}`,
        source_input_hash: String(index + 1).repeat(64),
        source_decision_hash: String(index + 3).repeat(64),
      })),
    );
    const db = Object.assign(vi.fn(), { query }) as unknown as DbClient;
    const identities = [firstRef, secondRef].map((providerAccountRefId) => ({
      providerAccountRefId,
      providerAccountId: "act-reused",
      decisionEntityType: "ad" as const,
      decisionEntityId: "ad-reused",
    }));

    const result = await readPreviousPublishedAdLabels(
      {
        businessId,
        asOf: "2026-07-14",
        identities,
        scopeType: "account",
        scopeId: "act-reused",
      },
      db,
    );

    expect(result.size).toBe(2);
    expect(
      result.get(
        adDecisionStabilityKey({
          businessId,
          providerAccountRefId: firstRef,
          providerAccountId: "act-reused",
          decisionEntityType: "ad",
          decisionEntityId: "ad-reused",
          scopeType: "account",
          scopeId: "act-reused",
        }),
      ),
    ).toMatchObject({ providerAccountRefId: firstRef, publishedLabel: "keep" });
    expect(
      result.get(
        adDecisionStabilityKey({
          businessId,
          providerAccountRefId: secondRef,
          providerAccountId: "act-reused",
          decisionEntityType: "ad",
          decisionEntityId: "ad-reused",
          scopeType: "account",
          scopeId: "act-reused",
        }),
      ),
    ).toMatchObject({
      providerAccountRefId: secondRef,
      publishedLabel: "diagnose",
    });
  });

  it("reads large native hysteresis identity sets in bounded batches", async () => {
    const query = vi.fn(async (_query: string, params?: unknown[]) => {
      const batch = JSON.parse(String(params?.[2])) as Array<{
        provider_account_ref_id: string;
        provider_account_id: string;
        decision_entity_id: string;
      }>;
      if (batch.length !== 1) return [];
      return [
        {
          source_snapshot_id: "00000000-0000-4000-8000-000000000201",
          provider_account_ref_id: batch[0]!.provider_account_ref_id,
          provider_account_id: batch[0]!.provider_account_id,
          decision_entity_type: "ad",
          decision_entity_id: batch[0]!.decision_entity_id,
          source_as_of_date: "2026-07-13",
          source_computed_at: "2026-07-13T03:10:00.000Z",
          source_engine_version: "engine-v3-native-ad.v1",
          label: "keep",
          raw_label: "scale",
          source_evaluation_id: "00000000-0000-4000-8000-000000000202",
          source_input_hash: "a".repeat(64),
          source_decision_hash: "b".repeat(64),
        },
      ];
    });
    const db = Object.assign(vi.fn(), { query }) as unknown as DbClient;
    const identities = Array.from(
      { length: NATIVE_AD_DB_BATCH_SIZE + 1 },
      (_, index) => ({
        providerAccountRefId: "00000000-0000-4000-8000-000000000121",
        providerAccountId: "act-1",
        decisionEntityType: "ad" as const,
        decisionEntityId: `ad-${index + 1}`,
      }),
    );

    const result = await readPreviousPublishedAdLabels(
      {
        businessId: "00000000-0000-4000-8000-000000000101",
        asOf: "2026-07-14",
        identities,
        scopeType: "account",
        scopeId: "act-1",
      },
      db,
    );
    expect(result.size).toBe(1);
    expect(Array.from(result.values())[0]).toMatchObject({
      decisionEntityId: `ad-${NATIVE_AD_DB_BATCH_SIZE + 1}`,
      publishedLabel: "keep",
      rawLabel: "scale",
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(
      query.mock.calls.map(
        ([, params]) => JSON.parse(String(params?.[2])).length,
      ),
    ).toEqual([NATIVE_AD_DB_BATCH_SIZE, 1]);
  });

  it("IwaStore 946471284944193: scale->keep->scale round trip is suppressed", () => {
    const { published, suppressedDays } = runSequence([
      "scale",
      "keep",
      "scale",
    ]);
    expect(published).toEqual(["keep", "keep", "keep"]);
    expect(suppressedDays).toEqual([0, 2]);
  });

  it("TheSwaf 1962656064410174: cut->keep->cut round trip is suppressed", () => {
    const { published, suppressedDays } = runSequence(["cut", "keep", "cut"]);
    expect(published).toEqual(["keep", "keep", "keep"]);
    expect(suppressedDays).toEqual([0, 2]);
  });

  it("Tiles 25889037484086563: keep->cut->keep round trip is suppressed", () => {
    const { published, suppressedDays } = runSequence(["keep", "cut", "keep"]);
    expect(published).toEqual(["keep", "keep", "keep"]);
    expect(suppressedDays).toEqual([1]);
  });

  it("exits a previously published hard action immediately when current evidence becomes soft", () => {
    const result = applyLabelHysteresis("keep", {
      publishedLabel: "cut",
      rawLabel: "cut",
    });
    expect(result).toEqual({
      publishedLabel: "keep",
      rawLabel: "keep",
      suppressed: false,
    });
  });

  it("entering a hard label also requires confirmation", () => {
    const { published } = runSequence(["keep", "cut", "cut"]);
    expect(published).toEqual(["keep", "keep", "cut"]);
  });

  it("treats refresh as a hard action that requires confirmation", () => {
    const { published } = runSequence(["keep", "refresh", "refresh"]);
    expect(published).toEqual(["keep", "keep", "refresh"]);
  });

  it("neutralizes a direct hard-action switch until the new action confirms", () => {
    const first = applyLabelHysteresis("cut", {
      publishedLabel: "scale",
      rawLabel: "scale",
    });
    const second = applyLabelHysteresis("cut", {
      publishedLabel: first.publishedLabel,
      rawLabel: first.rawLabel,
    });
    expect([first.publishedLabel, second.publishedLabel]).toEqual([
      "keep",
      "cut",
    ]);
  });

  it("publishes a safety diagnosis immediately instead of resurrecting the previous hard action", () => {
    const result = applyLabelHysteresis("diagnose", {
      publishedLabel: "scale",
      rawLabel: "scale",
    });
    expect(result.publishedLabel).toBe("diagnose");
    expect(result.suppressed).toBe(false);
  });

  it("soft-to-soft transitions publish immediately", () => {
    const { published, suppressedDays } = runSequence([
      "test_more",
      "keep",
      "diagnose",
    ]);
    expect(published).toEqual(["test_more", "keep", "diagnose"]);
    expect(suppressedDays).toEqual([]);
  });

  it("no previous snapshot holds a hard label at canonical keep", () => {
    const result = applyLabelHysteresis("cut", null);
    expect(result.publishedLabel).toBe("keep");
    expect(result.rawLabel).toBe("cut");
    expect(result.suppressed).toBe(true);
  });

  it("uses canonical keep rather than a previous diagnostic label for pending hard entry", () => {
    const result = applyLabelHysteresis("scale", {
      publishedLabel: "diagnose",
      rawLabel: "diagnose",
    });
    expect(result).toEqual({
      publishedLabel: "keep",
      rawLabel: "scale",
      suppressed: true,
    });
  });

  it("old snapshots without raw_label still exit a hard action immediately", () => {
    const result = applyLabelHysteresis("keep", {
      publishedLabel: "cut",
      rawLabel: null,
    });
    expect(result.publishedLabel).toBe("keep");
    expect(result.suppressed).toBe(false);
  });
});

describe("stabilizeDecisionLabel", () => {
  const baseDecision: DecisionOutput = {
    creativeId: "c-1",
    creativeName: "C1",
    label: "keep",
    reason: "Recovered above target in the recent window.",
    confidence: 75,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.2,
    ratioToTarget: 0.7,
    badges: [],
    metrics: { spend: 1000, purchases: 5, roas: 1.5, recent7dRoas: 2.4 },
    preAuthorityLabel: "keep",
    authorityBlocker: null,
    engineVersion: "v3-test",
    generatedAt: "2026-07-06T00:00:00.000Z",
  };

  it("publishes a non-hard pending state with held-action provenance", () => {
    const scaleDecision: DecisionOutput = {
      ...baseDecision,
      label: "scale",
      preAuthorityLabel: "scale",
      reason: "Winner evidence supports promotion.",
    };
    const { decision, rawLabel, suppressed } = stabilizeDecisionLabel(
      scaleDecision,
      {
        publishedLabel: "keep",
        rawLabel: "keep",
      },
    );
    expect(suppressed).toBe(true);
    expect(rawLabel).toBe("scale");
    expect(decision.label).toBe("keep");
    expect(decision.blockedActionType).toBe("scale");
    expect(decision.reason).toContain("No hard action is published");
    expect(
      decision.badges.some((badge) => badge.type === "pending_transition"),
    ).toBe(true);
  });

  it("treats post-authority label as raw hysteresis input without losing provenance", () => {
    const staleScaleDecision: DecisionOutput = {
      ...baseDecision,
      label: "keep",
      preAuthorityLabel: "scale",
      authorityBlocker: "source_freshness",
      blockedActionType: "scale",
      reason: "Scale verdict held until evidence is fresh.",
    };

    const result = stabilizeDecisionLabel(staleScaleDecision, {
      publishedLabel: "keep",
      rawLabel: "keep",
    });

    expect(result.rawLabel).toBe("keep");
    expect(result.suppressed).toBe(false);
    expect(result.decision).toMatchObject({
      label: "keep",
      preAuthorityLabel: "scale",
      authorityBlocker: "source_freshness",
      blockedActionType: "scale",
    });
  });

  it("does not accrue D036 while recent evidence holds Cut and starts only after the hold clears", () => {
    const heldCut: DecisionOutput = {
      ...baseDecision,
      label: "test_more",
      preAuthorityLabel: "cut",
      authorityBlocker: "recent_recovery_unverifiable",
      blockedActionType: "cut",
      reason: "Cut held until recent break-even evidence is sufficient.",
    };

    const held = stabilizeDecisionLabel(heldCut, {
      publishedLabel: "keep",
      rawLabel: "keep",
    });
    expect(held).toMatchObject({ rawLabel: "test_more", suppressed: false });
    expect(held.decision).toMatchObject({
      label: "test_more",
      preAuthorityLabel: "cut",
      authorityBlocker: "recent_recovery_unverifiable",
      blockedActionType: "cut",
    });
    expect(held.decision.badges.map((badge) => badge.type)).not.toContain(
      "pending_transition",
    );

    const unblockedCut: DecisionOutput = {
      ...baseDecision,
      label: "cut",
      preAuthorityLabel: "cut",
      reason: "Recent evidence confirms the economic loss.",
    };
    const firstUnblocked = stabilizeDecisionLabel(unblockedCut, {
      publishedLabel: held.decision.label,
      rawLabel: held.rawLabel,
    });
    expect(firstUnblocked).toMatchObject({ rawLabel: "cut", suppressed: true });
    expect(firstUnblocked.decision.label).toBe("keep");
    expect(
      firstUnblocked.decision.badges.map((badge) => badge.type),
    ).toContain("pending_transition");

    const confirmed = stabilizeDecisionLabel(unblockedCut, {
      publishedLabel: firstUnblocked.decision.label,
      rawLabel: firstUnblocked.rawLabel,
    });
    expect(confirmed).toMatchObject({ rawLabel: "cut", suppressed: false });
    expect(confirmed.decision.label).toBe("cut");
  });

  it("returns the complete current safety decision without hysteresis suppression", () => {
    const safetyDecision: DecisionOutput = {
      ...baseDecision,
      label: "diagnose",
      reason: "Policy review blocks performance action.",
      badges: [
        {
          type: "policy_blocked",
          label: "Policy block",
          severity: "warning",
        },
      ],
    };
    const result = stabilizeDecisionLabel(safetyDecision, {
      publishedLabel: "scale",
      rawLabel: "scale",
    });

    expect(result.suppressed).toBe(false);
    expect(result.decision).toBe(safetyDecision);
    expect(result.decision.label).toBe("diagnose");
  });

  it("returns the decision untouched when not suppressed", () => {
    const { decision, suppressed } = stabilizeDecisionLabel(baseDecision, {
      publishedLabel: "keep",
      rawLabel: "keep",
    });
    expect(suppressed).toBe(false);
    expect(decision).toBe(decision);
    expect(decision.badges).toHaveLength(0);
  });
});
