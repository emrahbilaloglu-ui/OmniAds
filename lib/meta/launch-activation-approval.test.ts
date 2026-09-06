import { describe, expect, it } from "vitest";

import {
  ACTIVATION_APPROVAL_CONTRACT,
  validateActivationApproval,
  type ActivationIntentFacts,
  type ActivationReceiptIdentities,
} from "@/lib/meta/launch-activation-approval";

const APPROVER = "22222222-2222-4222-8222-222222222222";
const POLICY = "meta.activation-policy.v1";
const NOW = new Date("2026-09-05T10:00:00.000Z");

const INTENT: ActivationIntentFacts = {
  id: "33333333-3333-4333-8333-333333333333",
  businessId: "11111111-1111-4111-8111-111111111111",
  providerAccountId: "act_1",
  operation: "add_to_existing",
  requestFingerprint: "a".repeat(64),
};

const IDENTITIES: ActivationReceiptIdentities = {
  campaignId: "camp_1",
  adsetIds: ["set_1"],
  adIds: ["ad_1"],
  creativeIds: ["cr_1"],
};

function approval(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: ACTIVATION_APPROVAL_CONTRACT,
    businessId: INTENT.businessId,
    providerAccountId: INTENT.providerAccountId,
    launchIntentId: INTENT.id,
    requestFingerprint: INTENT.requestFingerprint,
    approvedOperation: "add_to_existing",
    approvedScope: "ad",
    approvedAssets: [{ creativeId: "cr_1", version: "v3" }],
    approvedCopy: { hash: "b".repeat(64) },
    approvedDestination: { campaignId: "camp_1", adsetIds: ["set_1"] },
    approvedBy: APPROVER,
    approvedAt: "2026-09-05T09:00:00.000Z",
    expiresAt: "2026-09-06T09:00:00.000Z",
    revokedAt: null,
    policyVersion: POLICY,
    ...overrides,
  };
}

function check(stored: unknown, extra: Partial<{
  intent: ActivationIntentFacts;
  identities: ActivationReceiptIdentities;
}> = {}) {
  return validateActivationApproval({
    stored,
    intent: extra.intent ?? INTENT,
    identities: extra.identities ?? IDENTITIES,
    policyVersion: POLICY,
    now: NOW,
  });
}

describe("creating something paused is not permission to turn it on", () => {
  it("refuses an intent with no approval at all", () => {
    // The ordinary case: every intent starts here, and it means operator-only.
    expect(check(null)).toEqual({
      approved: false, refusal: "activation_approval_absent",
    });
  });

  it("accepts a complete, current approval", () => {
    const verdict = check(approval());
    expect(verdict.approved).toBe(true);
    if (verdict.approved) expect(verdict.scope).toBe("ad");
  });
});

describe("an approval is for one exact payload", () => {
  it("drops when the request was edited after approval", () => {
    /*
      The single most important case. An intent whose payload changed is a
      different request; carrying the approval forward would activate something
      nobody read.
    */
    expect(check(approval(), {
      intent: { ...INTENT, requestFingerprint: "c".repeat(64) },
    })).toEqual({ approved: false, refusal: "activation_approval_payload_changed" });
  });

  it("refuses an approval naming a creative the launch did not produce", () => {
    expect(check(approval({
      approvedAssets: [{ creativeId: "cr_other", version: "v3" }],
    }))).toEqual({ approved: false, refusal: "activation_approval_asset_mismatch" });
  });

  it("refuses an approval that covers only the first of several creatives", () => {
    /*
      The defect the set form exists for. A launch built from three creatives
      used to be bound by a document naming one of them, and the ads made from
      the other two were turned on unattended under an authorization that never
      mentioned them. Containment is asked against what the receipt says exists.
    */
    expect(check(approval(), {
      identities: { ...IDENTITIES, creativeIds: ["cr_1", "cr_2", "cr_3"] },
    })).toEqual({ approved: false, refusal: "activation_approval_asset_mismatch" });
  });

  it("accepts one that names every creative the launch produced", () => {
    const verdict = check(
      approval({
        approvedAssets: [
          { creativeId: "cr_1", version: "v3" },
          { creativeId: "cr_2", version: "v3" },
          { creativeId: "cr_3", version: "v3" },
        ],
      }),
      { identities: { ...IDENTITIES, creativeIds: ["cr_1", "cr_2", "cr_3"] } },
    );
    expect(verdict.approved).toBe(true);
  });

  it("refuses an approval that covers only the first of several ad sets", () => {
    expect(check(
      approval({ approvedOperation: "new_campaign", approvedScope: "hierarchy" }),
      {
        intent: { ...INTENT, operation: "new_campaign" },
        identities: { ...IDENTITIES, adsetIds: ["set_1", "set_2"] },
      },
    )).toEqual({
      approved: false, refusal: "activation_approval_destination_mismatch",
    });
  });

  it("accepts one that names both ad sets", () => {
    const verdict = check(
      approval({
        approvedOperation: "new_campaign",
        approvedScope: "hierarchy",
        approvedDestination: { campaignId: "camp_1", adsetIds: ["set_1", "set_2"] },
      }),
      {
        intent: { ...INTENT, operation: "new_campaign" },
        identities: { ...IDENTITIES, adsetIds: ["set_1", "set_2"] },
      },
    );
    expect(verdict.approved).toBe(true);
  });

  it("refuses a hierarchy approval that names no ad set at all", () => {
    // It turns ad sets on. Naming none of them is not a narrower approval.
    expect(check(
      approval({
        approvedOperation: "new_campaign",
        approvedScope: "hierarchy",
        approvedDestination: { campaignId: "camp_1", adsetIds: [] },
      }),
      { intent: { ...INTENT, operation: "new_campaign" } },
    )).toEqual({
      approved: false, refusal: "activation_approval_destination_mismatch",
    });
  });

  it("refuses an approval pointing at another campaign", () => {
    expect(check(approval({
      approvedDestination: { campaignId: "camp_other", adsetIds: ["set_1"] },
    }))).toEqual({
      approved: false, refusal: "activation_approval_destination_mismatch",
    });
  });

  it("refuses one account's approval for another account", () => {
    expect(check(approval({ providerAccountId: "act_999" }))).toEqual({
      approved: false, refusal: "activation_approval_account_mismatch",
    });
  });
});

describe("an approval ends", () => {
  it("refuses an expired one", () => {
    expect(check(approval({ expiresAt: "2026-09-05T09:59:00.000Z" }))).toEqual({
      approved: false, refusal: "activation_approval_expired",
    });
  });

  it("refuses one with no readable expiry, rather than treating it as endless", () => {
    expect(check(approval({ expiresAt: null }))).toEqual({
      approved: false, refusal: "activation_approval_expired",
    });
  });

  it("refuses a revoked one", () => {
    expect(check(approval({ revokedAt: "2026-09-05T09:30:00.000Z" }))).toEqual({
      approved: false, refusal: "activation_approval_revoked",
    });
  });
});

describe("scope is not a label the approval gives itself", () => {
  it("refuses an ad-scoped approval for a launch that created its own campaign", () => {
    /*
      A new hierarchy's campaign and ad set were created paused by the same
      launch. Approving "the ad" cannot silently authorize turning on the
      campaign the operator has never seen deliver.
    */
    expect(check(approval({ approvedOperation: "new_campaign" }), {
      intent: { ...INTENT, operation: "new_campaign" },
    })).toEqual({ approved: false, refusal: "activation_approval_scope_mismatch" });
  });

  it("accepts an explicit hierarchy approval for that same launch", () => {
    const verdict = check(
      approval({ approvedOperation: "new_campaign", approvedScope: "hierarchy" }),
      { intent: { ...INTENT, operation: "new_campaign" } },
    );
    expect(verdict.approved).toBe(true);
    if (verdict.approved) expect(verdict.scope).toBe("hierarchy");
  });

  it("refuses an approval whose operation differs from the intent's", () => {
    expect(check(approval({
      approvedOperation: "new_campaign", approvedScope: "hierarchy",
    }))).toEqual({
      approved: false, refusal: "activation_approval_operation_mismatch",
    });
  });
});

describe("the shape has to be the shape", () => {
  it("refuses an unknown contract version", () => {
    expect(check(approval({ contractVersion: "meta.something.v9" }))).toEqual({
      approved: false, refusal: "activation_approval_contract_unknown",
    });
  });

  it("refuses a v1 document rather than reinterpreting its single asset", () => {
    /*
      A v1 approval said nothing about the creatives it did not name. Reading
      that silence as consent is the defect the set form replaces, so the
      contract moved with the shape and the old document is simply unknown.
    */
    expect(check({
      ...approval(),
      contractVersion: "meta.launch-activation-approval.v1",
      approvedAssets: undefined,
      approvedAsset: { creativeId: "cr_1", version: "v3" },
      approvedDestination: { campaignId: "camp_1", adsetId: "set_1" },
    })).toEqual({
      approved: false, refusal: "activation_approval_contract_unknown",
    });
  });

  it("refuses an empty approved-asset list", () => {
    expect(check(approval({ approvedAssets: [] }))).toEqual({
      approved: false, refusal: "activation_approval_malformed",
    });
  });

  it("refuses an approver who is not a user id", () => {
    expect(check(approval({ approvedBy: "the automation" }))).toEqual({
      approved: false, refusal: "activation_approval_approver_absent",
    });
  });

  it("refuses a policy version the running code does not implement", () => {
    expect(check(approval({ policyVersion: "meta.activation-policy.v0" }))).toEqual({
      approved: false, refusal: "activation_approval_policy_version_unbound",
    });
  });

  it("refuses a non-object", () => {
    expect(check("approved")).toEqual({
      approved: false, refusal: "activation_approval_malformed",
    });
    expect(check([approval()])).toEqual({
      approved: false, refusal: "activation_approval_malformed",
    });
  });

  it("refuses an approval dated in the future", () => {
    expect(check(approval({ approvedAt: "2026-09-05T10:30:00.000Z" }))).toEqual({
      approved: false, refusal: "activation_approval_malformed",
    });
  });
});
