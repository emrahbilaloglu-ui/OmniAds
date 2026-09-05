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
 * It also has to name a SET. The v1 document held one creative and one ad set,
 * and a launch may create several of each: an unattended run of a three-
 * creative launch could only ever be approved for one of them, so either the
 * other two were turned on under an authorization that never mentioned them,
 * or the whole launch was refused. Both are wrong answers to a question the
 * document simply could not ask. v2 holds the sets, and the receipt's own
 * creatives and ad sets must be a SUBSET of what was approved — approving more
 * than the launch produced is harmless, approving less is a refusal.
 *
 * The contract version moved with the shape. A v1 document is refused as an
 * unknown contract rather than reinterpreted: its single `approvedAsset` said
 * nothing about the creatives it did not name, and reading silence as consent
 * is exactly the defect this replaces.
 *
 * Every refusal is a named code. "Not approved" and "approved for something
 * else" are different sentences, and the operator has to be able to read which
 * one happened.
 */
export const ACTIVATION_APPROVAL_CONTRACT =
  "meta.launch-activation-approval.v2" as const;

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

export interface ActivationApprovedAsset {
  creativeId: string;
  version: string;
}

export interface ActivationApproval {
  contractVersion: typeof ACTIVATION_APPROVAL_CONTRACT;
  businessId: string;
  providerAccountId: string;
  launchIntentId: string;
  /** Must equal the intent's own current fingerprint, character for character. */
  requestFingerprint: string;
  approvedOperation: "add_to_existing" | "new_campaign";
  /** `ad` activates the ads; `hierarchy` also activates the campaign and ad sets. */
  approvedScope: "ad" | "hierarchy";
  /** Every creative this approval covers. Never empty. */
  approvedAssets: ActivationApprovedAsset[];
  approvedCopy: { hash: string };
  /** Every ad set this approval covers; empty means "none named". */
  approvedDestination: { campaignId: string; adsetIds: string[] };
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
  adsetIds: readonly string[];
  adIds: readonly string[];
  creativeIds: readonly string[];
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

/** Distinct, trimmed, order preserved. Used for both the sets in the document. */
function idSet(values: readonly unknown[]): string[] {
  const found: string[] = [];
  for (const value of values) {
    const text = str(value);
    if (text && !found.includes(text)) found.push(text);
  }
  return found;
}

function readApprovedAssets(value: unknown): ActivationApprovedAsset[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const assets: ActivationApprovedAsset[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as { creativeId?: unknown; version?: unknown };
    const creativeId = str(record.creativeId);
    const version = str(record.version);
    if (!creativeId || !version) return null;
    if (assets.some((asset) => asset.creativeId === creativeId)) continue;
    assets.push({ creativeId, version });
  }
  return assets.length > 0 ? assets : null;
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
  const assets = readApprovedAssets(raw.approvedAssets);
  const copy = raw.approvedCopy as { hash?: unknown } | null;
  const destination = raw.approvedDestination as
    { campaignId?: unknown; adsetIds?: unknown } | null;
  const approvedAdsetIds =
    destination && Array.isArray(destination.adsetIds)
      ? idSet(destination.adsetIds)
      : null;

  if (
    !businessId || !providerAccountId || !launchIntentId || !requestFingerprint
    || !approvedAt || !policyVersion
    || !assets
    || !copy || !str(copy.hash)
    || !destination || !str(destination.campaignId) || approvedAdsetIds === null
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

    The receipt is the record of what exists, so the test is containment in
    that direction: every creative and every ad set the launch produced has to
    appear in the approval. An approval that names extra ids authorizes
    nothing extra — the plan only ever walks the receipt — but an approval
    missing one is exactly the hole this file exists to close.
  */
  const approvedCreativeIds = assets.map((asset) => asset.creativeId);
  const unapprovedCreative = input.identities.creativeIds.find(
    (creativeId) => !approvedCreativeIds.includes(creativeId),
  );
  if (unapprovedCreative !== undefined) {
    return { approved: false, refusal: "activation_approval_asset_mismatch" };
  }
  if (
    input.identities.campaignId !== null
    && str(destination.campaignId) !== input.identities.campaignId
  ) {
    return { approved: false, refusal: "activation_approval_destination_mismatch" };
  }
  /*
    An empty approved ad-set list names none, and an `ad`-scoped approval of an
    add-to-existing launch legitimately has none to name — the ad set already
    existed and belongs to somebody else. Containment is therefore only asked
    when the approval names ad sets at all.
  */
  if (approvedAdsetIds.length > 0) {
    const unapprovedAdset = input.identities.adsetIds.find(
      (adsetId) => !approvedAdsetIds.includes(adsetId),
    );
    if (unapprovedAdset !== undefined) {
      return { approved: false, refusal: "activation_approval_destination_mismatch" };
    }
  } else if (scope === "hierarchy" && input.identities.adsetIds.length > 0) {
    // A hierarchy approval turns ad sets on. It has to have named them.
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
      approvedAssets: assets,
      approvedCopy: { hash: str(copy.hash)! },
      approvedDestination: {
        campaignId: str(destination.campaignId)!,
        adsetIds: approvedAdsetIds,
      },
      approvedBy,
      approvedAt,
      expiresAt: str(raw.expiresAt)!,
      revokedAt: null,
      policyVersion,
    },
  };
}

/**
 * Build an approval from the intent and its receipt, or refuse.
 *
 * The reader and the migration existed and nothing could write one, so the
 * column was permanently NULL and the unattended activation path could only
 * ever refuse. This is the writer, and it is deliberately not a setter: every
 * field that could be wrong is taken from the live intent and the receipt
 * rather than from the caller, so an approval cannot be created for a payload,
 * a destination or an asset that this launch did not produce.
 *
 * The caller supplies only what is genuinely theirs to decide: the scope, who
 * approved, when it expires, and the copy hash they reviewed. The creative and
 * ad-set sets come from the receipt, which is why an approval always covers
 * the whole launch and never a first-listed slice of it.
 */
export function buildActivationApproval(input: {
  intent: ActivationIntentFacts;
  identities: ActivationReceiptIdentities;
  approvedScope: "ad" | "hierarchy";
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  approvedAssetVersion: string;
  approvedCopyHash: string;
  policyVersion: string;
}):
  | { ok: true; approval: ActivationApproval }
  | { ok: false; refusal: ActivationApprovalRefusal } {
  if (!UUID.test(input.approvedBy)) {
    return { ok: false, refusal: "activation_approval_approver_absent" };
  }
  const approvedAt = timeOf(input.approvedAt);
  const expiresAt = timeOf(input.expiresAt);
  if (approvedAt === null || expiresAt === null || expiresAt <= approvedAt) {
    // An approval that expires before it is given is not an approval.
    return { ok: false, refusal: "activation_approval_expired" };
  }
  if (!str(input.policyVersion)) {
    return { ok: false, refusal: "activation_approval_policy_version_unbound" };
  }
  const creativeIds = idSet(input.identities.creativeIds);
  const version = str(input.approvedAssetVersion);
  if (creativeIds.length === 0 || !version) {
    return { ok: false, refusal: "activation_approval_asset_mismatch" };
  }
  if (!str(input.approvedCopyHash)) {
    return { ok: false, refusal: "activation_approval_asset_mismatch" };
  }
  /*
    A hierarchy approval needs a hierarchy to name.

    An `add_to_existing` launch created one ad inside somebody else's campaign;
    approving "the hierarchy" there would authorize turning on structure this
    launch never made.
  */
  const campaignId = str(input.identities.campaignId);
  if (!campaignId) {
    return { ok: false, refusal: "activation_approval_destination_mismatch" };
  }
  if (
    input.approvedScope === "hierarchy"
    && input.intent.operation !== "new_campaign"
  ) {
    return { ok: false, refusal: "activation_approval_scope_mismatch" };
  }
  const adsetIds = idSet(input.identities.adsetIds);
  if (input.approvedScope === "hierarchy" && adsetIds.length === 0) {
    // Nothing to turn on between the campaign and the ads.
    return { ok: false, refusal: "activation_approval_destination_mismatch" };
  }
  if (input.identities.adIds.length === 0) {
    return { ok: false, refusal: "activation_approval_destination_mismatch" };
  }
  return {
    ok: true,
    approval: {
      contractVersion: ACTIVATION_APPROVAL_CONTRACT,
      businessId: input.intent.businessId,
      providerAccountId: input.intent.providerAccountId,
      launchIntentId: input.intent.id,
      // Taken from the live intent, so an approval always names the payload
      // that exists right now. A later edit changes the fingerprint and the
      // validator drops this approval rather than repairing it.
      requestFingerprint: input.intent.requestFingerprint,
      approvedOperation: input.intent.operation,
      approvedScope: input.approvedScope,
      approvedAssets: creativeIds.map((creativeId) => ({
        creativeId,
        version: version,
      })),
      approvedCopy: { hash: input.approvedCopyHash.trim() },
      approvedDestination: { campaignId, adsetIds },
      approvedBy: input.approvedBy,
      approvedAt: new Date(approvedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      revokedAt: null,
      policyVersion: input.policyVersion,
    },
  };
}

/** Revoking is a write of its own, so a stored approval is never edited away. */
export function revokeActivationApproval(
  approval: ActivationApproval,
  revokedAt: string,
): ActivationApproval {
  return { ...approval, revokedAt };
}
