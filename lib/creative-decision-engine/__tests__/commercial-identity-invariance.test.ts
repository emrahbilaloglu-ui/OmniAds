/**
 * A NON-AUTHORITATIVE COMMERCIAL EDIT MOVES NO IDENTITY.
 *
 * Three hash families digest the operator's commercial settings — the canonical
 * evaluation envelope, the native target authority, and the D086 retention
 * fingerprints — and each enumerated its own field list. All three hashed the
 * numbers that, under a governing Target ROAS, choose nothing: the operator's
 * Target CPA, their break-even CPA, their AOV assumption, and the
 * `target_cpa_missing` / `operator_aov_missing` warnings that flip the instant
 * either is typed or cleared.
 *
 * DROPPING THE NUMBERS ALONE IS NOT ENOUGH, and that is the half this file
 * exists to pin. The target pack's `updatedAt` and the authority row's
 * `sourceRowId` / `effectiveAt` / `recordedAt` travel with those numbers and
 * move on ANY re-save. A projection that removed `targetCpa` but kept the row's
 * clock would still move every hash on a CPA-only edit — it would just have
 * stopped saying why.
 *
 * The no-Target-ROAS compatibility case is asserted in the opposite direction:
 * there the legacy Target CPA is the only anchor there is, and it MUST still
 * key identity.
 */
import { describe, expect, it } from "vitest";

import {
  projectCommercialTargetPackForIdentity,
  projectNativeTargetAuthorityForIdentity,
  projectSpendUnitWarningsForIdentity,
  targetRoasGoverns,
} from "@/lib/creative-decision-engine/commercial-semantic-projection";

const stable = (value: unknown) => JSON.stringify(value);

describe("with a governing Target ROAS", () => {
  const governed = {
    targetRoas: 2.2,
    breakEvenRoas: 1.5,
    defaultRiskPosture: "balanced",
  };

  it("is the case these projections branch on", () => {
    expect(targetRoasGoverns(governed)).toBe(true);
  });

  it("projects one target pack whatever CPA is typed beside it", () => {
    const permutations = [
      {},
      { targetCpa: 31 },
      { breakEvenCpa: 44 },
      { operatorAovAssumption: 66 },
      { targetCpa: 31, breakEvenCpa: 44, operatorAovAssumption: 66 },
    ];
    const projected = permutations.map((over) =>
      stable(projectCommercialTargetPackForIdentity({ ...governed, ...over })),
    );
    expect(new Set(projected).size).toBe(1);
  });

  it("ignores the row clock that moves on any re-save", () => {
    /*
      The half a numeric-only fix would miss. Two packs identical except for
      `updatedAt` — exactly what a CPA-only re-save leaves behind — must
      project the same.
    */
    const before = projectCommercialTargetPackForIdentity({
      ...governed,
      targetCpa: 31,
      updatedAt: "2026-09-01T00:00:00.000Z",
      freshness: "fresh",
    });
    const afterCpaOnlyEdit = projectCommercialTargetPackForIdentity({
      ...governed,
      targetCpa: 47,
      updatedAt: "2026-09-07T11:22:33.000Z",
      freshness: "fresh",
    });
    expect(stable(afterCpaOnlyEdit)).toBe(stable(before));
  });

  /*
    ── ROUND 6: PROVENANCE IS NOT A TIMESTAMP ───────────────────────────────
    The case above used to flip `freshness` from `fresh` to `stale` as well and
    still require identity stability. That threw away a fact the engine acts
    on: `resolveSpendUnitProfile` demotes `spendUnitConfidence` to `low` when a
    pack carries no trustworthy timestamp, which turns
    `commercialThresholdEligible` off — the account stops being hard-action
    eligible. An identity blind to that would let a verdict minted while the
    pack was trusted be RETAINED after its provenance became unknown: a stale
    grant of AUTHORITY, not a stale number.

    So the raw clock stays out and a semantic `targetProvenanceTrusted` state
    goes in. It moves only when the provenance verdict moves.
  */
  it("carries the provenance STATE rather than the raw clock", () => {
    const projected = projectCommercialTargetPackForIdentity({
      ...governed,
      updatedAt: "2026-09-01T00:00:00.000Z",
      freshness: "fresh",
    });
    expect(projected).toMatchObject({
      updatedAt: null,
      freshness: null,
      targetProvenanceTrusted: "trusted",
    });
  });

  it.each([
    ["stale", { updatedAt: "2026-09-01T00:00:00.000Z", freshness: "stale" }, "stale"],
    ["unknown freshness", { updatedAt: "2026-09-01T00:00:00.000Z", freshness: "unknown" }, "unknown"],
    ["an absent timestamp", { updatedAt: null, freshness: "fresh" }, "unknown"],
    ["an unparseable timestamp", { updatedAt: "not-a-date", freshness: "fresh" }, "unknown"],
  ])("moves identity when provenance becomes %s", (_name, over, expected) => {
    const trusted = stable(
      projectCommercialTargetPackForIdentity({
        ...governed,
        updatedAt: "2026-09-01T00:00:00.000Z",
        freshness: "fresh",
      }),
    );
    const degraded = projectCommercialTargetPackForIdentity({
      ...governed,
      ...(over as Record<string, unknown>),
    });
    expect(degraded).toMatchObject({ targetProvenanceTrusted: expected });
    expect(stable(degraded)).not.toBe(trusted);
  });

  it("still moves when a ROAS actually changes", () => {
    // The control: the projection must not be inert.
    const moved = projectCommercialTargetPackForIdentity({
      ...governed,
      targetRoas: 2.6,
    });
    expect(stable(moved)).not.toBe(
      stable(projectCommercialTargetPackForIdentity(governed)),
    );
  });

  it("drops the inventory warnings that flip when a CPA is typed", () => {
    const warnings = [
      "target_cpa_missing",
      "operator_aov_missing",
      "meta_aov_unavailable",
    ];
    const projected = projectSpendUnitWarningsForIdentity(warnings, governed);
    expect(projected).toEqual(["meta_aov_unavailable"]);
  });

  it("projects one native authority whatever CPA, row id or clock it carries", () => {
    const base = {
      targetRoas: 2.2,
      breakEvenRoas: 1.5,
      operation: "upsert",
      defaultRiskPosture: "balanced",
    };
    const permutations = [
      { sourceRowId: "row-1", effectiveAt: "2026-09-01T00:00:00.000Z", recordedAt: "2026-09-01T00:00:00.000Z" },
      { sourceRowId: "row-2", targetCpa: 31, effectiveAt: "2026-09-05T00:00:00.000Z", recordedAt: "2026-09-05T09:00:00.000Z" },
      { sourceRowId: "row-3", breakEvenCpa: 44, operatorAovAssumption: 66, effectiveAt: "2026-09-07T00:00:00.000Z", recordedAt: "2026-09-07T10:00:00.000Z" },
    ];
    const projected = permutations.map((over) =>
      stable(projectNativeTargetAuthorityForIdentity({ ...base, ...over })),
    );
    expect(new Set(projected).size).toBe(1);
  });

  it("refuses the pre-fix behaviour, so this cannot pass vacuously", () => {
    // Before the projection the raw rows differed, and the raw rows are what
    // was hashed. If the projection ever became the identity function again,
    // these would differ and the assertions above would fail with it.
    const a = { ...governed, sourceRowId: "row-1", targetCpa: 31 };
    const b = { ...governed, sourceRowId: "row-2", targetCpa: 47 };
    expect(stable(a)).not.toBe(stable(b));
    expect(
      stable(projectNativeTargetAuthorityForIdentity(a)),
    ).toBe(stable(projectNativeTargetAuthorityForIdentity(b)));
  });
});

describe("without a Target ROAS, the legacy CPA still keys identity", () => {
  const legacy = { targetRoas: null, defaultRiskPosture: "balanced" };

  it("is not the governed case", () => {
    expect(targetRoasGoverns(legacy)).toBe(false);
  });

  it("keeps the target pack whole, CPA and clock included", () => {
    const withCpa = projectCommercialTargetPackForIdentity({
      ...legacy,
      targetCpa: 31,
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    const withDifferentCpa = projectCommercialTargetPackForIdentity({
      ...legacy,
      targetCpa: 47,
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(withCpa?.targetCpa).toBe(31);
    // The compatibility half: here the CPA IS the anchor, so it must move the
    // identity. Blanking it would make two genuinely different accounts share
    // a fingerprint.
    expect(stable(withDifferentCpa)).not.toBe(stable(withCpa));
  });

  it("keeps the native authority whole too", () => {
    const one = projectNativeTargetAuthorityForIdentity({
      ...legacy,
      sourceRowId: "row-1",
      targetCpa: 31,
    });
    const two = projectNativeTargetAuthorityForIdentity({
      ...legacy,
      sourceRowId: "row-1",
      targetCpa: 47,
    });
    expect(one?.targetCpa).toBe(31);
    expect(stable(two)).not.toBe(stable(one));
  });

  it("keeps the CPA inventory warning, which is about the anchor that governs", () => {
    expect(
      projectSpendUnitWarningsForIdentity(["target_cpa_missing"], legacy),
    ).toEqual(["target_cpa_missing"]);
  });
});
