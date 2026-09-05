/**
 * The approval that lets something be turned on without an operator present.
 *
 * A launch intent may only ever create PAUSED entities — the table's own CHECK
 * says so, and that is what keeps creating and activating separate. So the
 * intent proves nothing about activation, and an unattended path that treated
 * a successful creation as permission to publish would be inventing an
 * authorization nobody gave.
 *
 * This is that authorization, written down. Four loose fields could not carry
 * it: an approval has to name the exact payload it approved, or a payload
 * edited after the fact would inherit the approval given to a different one.
 * So the fingerprint is compared against the intent's CURRENT value, and a
 * mismatch drops the approval rather than repairing it.
 *
 * Every refusal is a named code. "Not approved" and "approved for something
 * else" are different sentences, and the operator has to be able to read which
 * one happened.
 */
export const ACTIVATION_APPROVAL_CONTRACT =
  "meta.launch-activation-approval.v1" as const;

export type ActivationApprovalRefusal =
  | "activation_approval_absent"
  | "activation_approval_malformed"
  | "activation_approval_contract_unknown"
  | "activation_approval_business_mismatch"
  | "activation_approval_account_mismatch"
  | "activation_approval_intent_mismatch"
  | "activation_approval_payload_changed"
  | "activation_approval_operation_mismatch"
  | "activation_approval_scope_mismatch"
  | "activation_approval_asset_mismatch"
  | "activation_approval_destination_mismatch"
  | "activation_approval_expired"
  | "activation_approval_revoked"
  | "activation_approval_approver_absent"
  | "activation_approval_policy_version_unbound";

export interface ActivationApproval {
  contractVersion: typeof ACTIVATION_APPROVAL_CONTRACT;
  businessId: string;
  providerAccountId: string;
  launchIntentId: string;
  /** Must equal the intent's own current fingerprint, character for character. */
  requestFingerprint: string;
  approvedOperation: "add_to_existing" | "new_campaign";
  /** `ad` activates one ad; `hierarchy` also activates the campaign and ad set. */
  approvedScope: "ad" | "hierarchy";
  approvedAsset: { creativeId: string; version: string };
  approvedCopy: { hash: string };
  approvedDestination: { campaignId: string; adsetId: string | null };
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  policyVersion: string;
}

/** What the intent itself says, read fresh at dispatch. */
export interface ActivationIntentFacts {
  id: string;
  businessId: string;
  providerAccountId: string;
  operation: "add_to_existing" | "new_campaign";
  requestFingerprint: string;
}

/** What the receipt actually created, so an approval cannot name other entities. */
export interface ActivationReceiptIdentities {
  campaignId: string | null;
  adsetId: string | null;
  adIds: readonly string[];
  creativeId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function timeOf(value: unknown): number | null {
  const text = str(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export type ActivationApprovalVerdict =
  | { approved: true; approval: ActivationApproval; scope: "ad" | "hierarchy" }
  | { approved: false; refusal: ActivationApprovalRefusal };

/**
 * Validate a stored approval against the live intent and its receipt.
 *
 * Ordered so the cheapest and most specific refusal comes first: an absent
 * approval is the ordinary case (every intent starts that way) and must not
 * cost a shape walk.
 */
export function validateActivationApproval(input: {
  stored: unknown;
  intent: ActivationIntentFacts;
  identities: ActivationReceiptIdentities;
  policyVersion: string;
  now?: Date;
}): ActivationApprovalVerdict {
  if (input.stored === null || input.stored === undefined) {
    return { approved: false, refusal: "activation_approval_absent" };
  }
  if (typeof input.stored !== "object" || Array.isArray(input.stored)) {
    return { approved: false, refusal: "activation_approval_malformed" };
  }
  const raw = input.stored as Record<string, unknown>;
  if (str(raw.contractVersion) !== ACTIVATION_APPROVAL_CONTRACT) {
    return { approved: false, refusal: "activation_approval_contract_unknown" };
  }

  const businessId = str(raw.businessId);
  const providerAccountId = str(raw.providerAccountId);
  const launchIntentId = str(raw.launchIntentId);
  const requestFingerprint = str(raw.requestFingerprint);
  const approvedBy = str(raw.approvedBy);
  const approvedAt = str(raw.approvedAt);
  const policyVersion = str(raw.policyVersion);
  const operation = str(raw.approvedOperation);
  const scope = str(raw.approvedScope);
  const asset = raw.approvedAsset as { creativeId?: unknown; version?: unknown } | null;
  const copy = raw.approvedCopy as { hash?: unknown } | null;
  const destination = raw.approvedDestination as
    { campaignId?: unknown; adsetId?: unknown } | null;

  if (
    !businessId || !providerAccountId || !launchIntentId || !requestFingerprint
    || !approvedAt || !policyVersion
    || !asset || !str(asset.creativeId) || !str(asset.version)
    || !copy || !str(copy.hash)
    || !destination || !str(destination.campaignId)
    || (operation !== "add_to_existing" && operation !== "new_campaign")
    || (scope !== "ad" && scope !== "hierarchy")
  ) {
    return { approved: false, refusal: "activation_approval_malformed" };
  }
  // The approver is a person, and the column that records them is a UUID.
  if (!approvedBy || !UUID.test(approvedBy)) {
    return { approved: false, refusal: "activation_approval_approver_absent" };
  }
  if (businessId !== input.intent.businessId) {
    return { approved: false, refusal: "activation_approval_business_mismatch" };
  }
  if (providerAccountId !== input.intent.providerAccountId) {
    return { approved: false, refusal: "activation_approval_account_mismatch" };
  }
  if (launchIntentId !== input.intent.id) {
    return { approved: false, refusal: "activation_approval_intent_mismatch" };
  }
  /*
    The payload has to be the one that was approved.

    This is the whole reason the fingerprint is stored rather than assumed: an
    intent whose request changed after approval is a different request, and
    carrying the old approval forward would activate something nobody read.
  */
  if (requestFingerprint !== input.intent.requestFingerprint) {
    return { approved: false, refusal: "activation_approval_payload_changed" };
  }
  if (operation !== input.intent.operation) {
    return { approved: false, refusal: "activation_approval_operation_mismatch" };
  }
  if (policyVersion !== input.policyVersion) {
    return { approved: false, refusal: "activation_approval_policy_version_unbound" };
  }

  if (str(raw.revokedAt) !== null) {
    return { approved: false, refusal: "activation_approval_revoked" };
  }
  const now = (input.now ?? new Date()).getTime();
  const expiresAt = timeOf(raw.expiresAt);
  // An approval with no readable expiry has no end, which is not an approval.
  if (expiresAt === null || expiresAt <= now) {
    return { approved: false, refusal: "activation_approval_expired" };
  }
  const approvedAtMs = timeOf(approvedAt);
  if (approvedAtMs === null || approvedAtMs > now) {
    return { approved: false, refusal: "activation_approval_malformed" };
  }

  /*
    And it must name the entities that were actually created.

    The receipt is the record of what exists. An approval pointing at a
    creative or a campaign the intent did not produce would authorize a write
    against something outside its own lineage.
  */
  if (
    input.identities.creativeId !== null
    && str(asset.creativeId) !== input.identities.creativeId
  ) {
    return { approved: false, refusal: "activation_approval_asset_mismatch" };
  }
  if (
    input.identities.campaignId !== null
    && str(destination.campaignId) !== input.identities.campaignId
  ) {
    return { approved: false, refusal: "activation_approval_destination_mismatch" };
  }
  const approvedAdsetId = str(destination.adsetId);
  if (
    input.identities.adsetId !== null
    && approvedAdsetId !== null
    && approvedAdsetId !== input.identities.adsetId
  ) {
    return { approved: false, refusal: "activation_approval_destination_mismatch" };
  }
  /*
    Scope is not a label on the approval alone: an `ad` approval cannot turn on
    a campaign that the launch itself created paused. A new hierarchy needs the
    wider scope to have been approved explicitly.
  */
  if (scope === "ad" && input.intent.operation === "new_campaign") {
    return { approved: false, refusal: "activation_approval_scope_mismatch" };
  }

  return {
    approved: true,
    scope,
    approval: {
      contractVersion: ACTIVATION_APPROVAL_CONTRACT,
      businessId,
      providerAccountId,
      launchIntentId,
      requestFingerprint,
      approvedOperation: operation,
      approvedScope: scope,
      approvedAsset: {
        creativeId: str(asset.creativeId)!,
        version: str(asset.version)!,
      },
      approvedCopy: { hash: str(copy.hash)! },
      approvedDestination: {
        campaignId: str(destination.campaignId)!,
        adsetId: approvedAdsetId,
      },
      approvedBy,
      approvedAt,
      expiresAt: str(raw.expiresAt)!,
      revokedAt: null,
      policyVersion,
    },
  };
}
