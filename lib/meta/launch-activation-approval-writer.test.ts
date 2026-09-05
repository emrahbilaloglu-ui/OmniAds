/**
 * Finding 4, the approval writer: the column nothing could fill.
 *
 * `activation_approval_json` shipped with a migration and a validator and no
 * writer, so every row's approval was NULL, every unattended activation
 * refused with `activation_approval_absent`, and the scheduled creative path
 * was closed by an accident of omission rather than by a decision.
 *
 * The builder is where the honesty lives: almost nothing comes from the caller.
 * These cases pin what it takes from the live intent and its receipt, and what
 * it refuses to write.
 */
import { describe, expect, it } from "vitest";

import {
  ACTIVATION_APPROVAL_CONTRACT,
  buildActivationApproval,
  revokeActivationApproval,
  validateActivationApproval,
} from "@/lib/meta/launch-activation-approval";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const APPROVER = "22222222-2222-4222-8222-222222222222";
const INTENT = "33333333-3333-4333-8333-333333333333";
const POLICY = "meta.activation-policy.v1";

const FACTS = {
  id: INTENT,
  businessId: BUSINESS,
  providerAccountId: "act_1",
  operation: "new_campaign" as const,
  requestFingerprint: "a".repeat(64),
};

const IDENTITIES = {
  campaignId: "camp_1",
  adsetIds: ["set_1"],
  adIds: ["ad_1"],
  creativeIds: ["cr_1"],
};

function build(overrides: Partial<Parameters<typeof buildActivationApproval>[0]> = {}) {
  return buildActivationApproval({
    intent: FACTS,
    identities: IDENTITIES,
    approvedScope: "hierarchy",
    approvedBy: APPROVER,
    approvedAt: "2026-09-05T09:00:00.000Z",
    expiresAt: "2026-09-06T09:00:00.000Z",
    approvedAssetVersion: "v1",
    approvedCopyHash: "b".repeat(64),
    policyVersion: POLICY,
    ...overrides,
  });
}

describe("an approval names what the launch actually produced", () => {
  it("takes the payload fingerprint from the live intent, not from the caller", () => {
    const result = build();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approval).toMatchObject({
      contractVersion: ACTIVATION_APPROVAL_CONTRACT,
      requestFingerprint: FACTS.requestFingerprint,
      approvedOperation: "new_campaign",
      approvedDestination: { campaignId: "camp_1", adsetIds: ["set_1"] },
      approvedAssets: [{ creativeId: "cr_1", version: "v1" }],
      revokedAt: null,
    });
  });

  it("is accepted by the validator it was built for", () => {
    const built = build();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    /*
      The point of building it this way: the writer and the reader agree by
      construction rather than by an author keeping two field lists in step.
    */
    const verdict = validateActivationApproval({
      stored: built.approval,
      intent: FACTS,
      identities: IDENTITIES,
      policyVersion: POLICY,
      now: new Date("2026-09-05T10:00:00.000Z"),
    });
    expect(verdict).toMatchObject({ approved: true, scope: "hierarchy" });
  });

  it("is dropped once the payload it approved changes", () => {
    const built = build();
    if (!built.ok) return;
    const verdict = validateActivationApproval({
      stored: built.approval,
      // The operator edited the launch after approving it.
      intent: { ...FACTS, requestFingerprint: "c".repeat(64) },
      identities: IDENTITIES,
      policyVersion: POLICY,
      now: new Date("2026-09-05T10:00:00.000Z"),
    });
    expect(verdict).toEqual({
      approved: false, refusal: "activation_approval_payload_changed",
    });
  });

  it("is dropped once revoked, without losing who approved it", () => {
    const built = build();
    if (!built.ok) return;
    const revoked = revokeActivationApproval(
      built.approval, "2026-09-05T11:00:00.000Z",
    );
    expect(revoked.approvedBy).toBe(APPROVER);
    expect(validateActivationApproval({
      stored: revoked,
      intent: FACTS,
      identities: IDENTITIES,
      policyVersion: POLICY,
      now: new Date("2026-09-05T12:00:00.000Z"),
    })).toEqual({ approved: false, refusal: "activation_approval_revoked" });
  });
});

describe("what it refuses to write", () => {
  it("refuses a hierarchy approval on a launch that joined somebody else's campaign", () => {
    /*
      An add-to-existing launch created one ad inside a live campaign.
      Approving "the hierarchy" there would authorize turning on structure this
      launch never made.
    */
    expect(build({
      intent: { ...FACTS, operation: "add_to_existing" },
      approvedScope: "hierarchy",
    })).toEqual({ ok: false, refusal: "activation_approval_scope_mismatch" });
  });

  it("allows an ad-scoped approval on the same launch", () => {
    const result = build({
      intent: { ...FACTS, operation: "add_to_existing" },
      approvedScope: "ad",
    });
    expect(result.ok).toBe(true);
  });

  it("refuses an approval nobody is named on", () => {
    expect(build({ approvedBy: "operator" }))
      .toEqual({ ok: false, refusal: "activation_approval_approver_absent" });
  });

  it("refuses one that expires before it is given", () => {
    expect(build({ expiresAt: "2026-09-05T08:00:00.000Z" }))
      .toEqual({ ok: false, refusal: "activation_approval_expired" });
  });

  it("refuses one with no copy hash to stand behind", () => {
    expect(build({ approvedCopyHash: "  " }))
      .toEqual({ ok: false, refusal: "activation_approval_asset_mismatch" });
  });

  it("refuses one whose receipt created no ad", () => {
    expect(build({ identities: { ...IDENTITIES, adIds: [] } }))
      .toEqual({ ok: false, refusal: "activation_approval_destination_mismatch" });
  });

  it("writes the WHOLE creative and ad-set set, not the first of each", () => {
    /*
      The route used to hand the builder `adsetIds[0]` and one creative, so a
      launch with three creatives could only ever be approved for one. The sets
      come from the receipt now, which is what makes an unattended run of a
      multi-creative launch approvable at all.
    */
    const result = build({
      identities: {
        ...IDENTITIES,
        adsetIds: ["set_1", "set_2"],
        creativeIds: ["cr_1", "cr_2", "cr_3"],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approval.approvedAssets).toEqual([
      { creativeId: "cr_1", version: "v1" },
      { creativeId: "cr_2", version: "v1" },
      { creativeId: "cr_3", version: "v1" },
    ]);
    expect(result.approval.approvedDestination.adsetIds).toEqual(["set_1", "set_2"]);
    expect(validateActivationApproval({
      stored: result.approval,
      intent: FACTS,
      identities: {
        ...IDENTITIES,
        adsetIds: ["set_1", "set_2"],
        creativeIds: ["cr_1", "cr_2", "cr_3"],
      },
      policyVersion: POLICY,
      now: new Date("2026-09-05T10:00:00.000Z"),
    })).toMatchObject({ approved: true, scope: "hierarchy" });
  });

  it("refuses one whose receipt names no creative", () => {
    expect(build({ identities: { ...IDENTITIES, creativeIds: [] } }))
      .toEqual({ ok: false, refusal: "activation_approval_asset_mismatch" });
  });

  it("refuses a hierarchy approval whose receipt created no ad set", () => {
    expect(build({ identities: { ...IDENTITIES, adsetIds: [] } }))
      .toEqual({ ok: false, refusal: "activation_approval_destination_mismatch" });
  });

  it("refuses one bound to no policy version", () => {
    expect(build({ policyVersion: "" }))
      .toEqual({ ok: false, refusal: "activation_approval_policy_version_unbound" });
  });
});
