/**
 * D087 — the exact budget write request, parsed rather than trusted.
 *
 * Every field here is a RETAINED fact from the accepted chain: D083's canonical
 * budget fact supplies the owner, the field, the amount unit, the currency and
 * its exponent; D086's attested universe supplies the run and snapshot the
 * baseline came from; D085 supplies the proposal identity. Nothing is defaulted
 * and nothing is derived from a name, so a request that cannot prove one of
 * them is refused rather than completed.
 *
 * The parser is TOTAL over `unknown`. A caller may hand it anything.
 */
import {
  BUDGET_FIELDS,
  BUDGET_OWNER_GRAINS,
  type BudgetField,
  type BudgetOwnerGrain,
} from "@/lib/meta/budget-intent-contract";
import { strictInstantMs } from "@/lib/meta/point-in-time-policy";
import { D087_BUDGET_WRITE_CONTRACT } from "@/lib/meta/budget-write-capability";

export const BUDGET_WRITE_REQUEST_CONTRACT = D087_BUDGET_WRITE_CONTRACT;

/**
 * The owner modes a write may act on. `mixed` and `unknown` are absent by
 * construction: a budget whose owner is not proven has no legal target.
 */
export const PROVEN_OWNER_MODES = ["campaign_budget_optimization", "adset_budget"] as const;
export type ProvenOwnerMode = (typeof PROVEN_OWNER_MODES)[number];

/** The owner grain each proven mode may target, and only that one. */
const OWNER_GRAIN_FOR_MODE: Readonly<Record<ProvenOwnerMode, BudgetOwnerGrain>> =
  Object.freeze({
    campaign_budget_optimization: "campaign",
    adset_budget: "adset",
  });

export const BUDGET_WRITE_REFUSALS = [
  "request_not_an_object",
  "contract_version_unrecognised",
  "unknown_field_present",
  "invalid_proposal_identity",
  "invalid_idempotency_key",
  "actor_absent",
  "invalid_scope",
  "invalid_owner_grain",
  "owner_mode_not_proven",
  "owner_grain_mismatch",
  "parent_campaign_absent",
  "unsupported_budget_field",
  "invalid_amount",
  "currency_not_retained",
  "exponent_not_retained",
  "currency_registry_not_retained",
  "baseline_not_retained",
  "baseline_field_mismatch",
  "invalid_evidence_clock",
] as const;
export type BudgetWriteRefusalCode = (typeof BUDGET_WRITE_REFUSALS)[number];

export interface BudgetWriteBaseline {
  /** The retained amount this proposal was built against. Null is not a baseline. */
  amountMinor: number;
  budgetField: BudgetField;
  capturedAt: string;
  /** D086's attested run and snapshot. Both are required provenance. */
  sourceRunId: string;
  sourceSnapshotId: string;
  /*
    D088 C3: the Graph API version that produced this baseline. A budget read
    under one API version is not interchangeable evidence for a write issued
    under another, so the version travels with the amount it describes.
  */
  providerApiVersion: string;
}

export interface BudgetWriteScope {
  businessId: string;
  providerAccountId: string;
  ownerGrain: BudgetOwnerGrain;
  entityId: string;
  parentCampaignId: string | null;
}

export interface BudgetWriteRequest {
  contractVersion: typeof BUDGET_WRITE_REQUEST_CONTRACT;
  proposalId: string;
  idempotencyKey: string;
  actor: { userId: string };
  scope: BudgetWriteScope;
  ownerMode: ProvenOwnerMode;
  budgetField: BudgetField;
  intendedAmountMinor: number;
  currency: string;
  currencyExponent: number;
  currencyRegistryVersion: string;
  baseline: BudgetWriteBaseline;
  evidenceAsOf: string;
  evidenceAsOfMs: number;
}

export type BudgetWriteParse =
  | { ok: true; request: BudgetWriteRequest }
  | { ok: false; code: BudgetWriteRefusalCode; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;

/** Exactly the keys a request may carry. An extra key is a different contract. */
const ALLOWED_KEYS = new Set([
  "contractVersion", "proposalId", "idempotencyKey", "actor", "scope", "ownerMode",
  "budgetField", "intendedAmountMinor", "currency", "currencyExponent",
  "currencyRegistryVersion", "baseline", "evidenceAsOf",
  /*
    The parser's OWN derived field. Parsing must be idempotent: the executor
    re-parses the request it is handed, and a parser whose output its own input
    check rejects would refuse every request that had already been validated.
  */
  "evidenceAsOfMs",
]);
const ALLOWED_SCOPE_KEYS = new Set([
  "businessId", "providerAccountId", "ownerGrain", "entityId", "parentCampaignId",
]);
const ALLOWED_BASELINE_KEYS = new Set([
  "amountMinor", "budgetField", "capturedAt", "sourceRunId", "sourceSnapshotId",
  "providerApiVersion",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** A positive, exact, safe integer. Nothing else is an amount. */
const isMinorAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const refuse = (code: BudgetWriteRefusalCode, message: string): BudgetWriteParse =>
  ({ ok: false, code, message });

export function parseBudgetWriteRequest(value: unknown): BudgetWriteParse {
  if (!isRecord(value)) {
    return refuse("request_not_an_object", "A budget write request must be an object.");
  }
  if (value.contractVersion !== BUDGET_WRITE_REQUEST_CONTRACT) {
    return refuse(
      "contract_version_unrecognised",
      `Expected ${BUDGET_WRITE_REQUEST_CONTRACT}.`,
    );
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      return refuse("unknown_field_present", `The request carries an unknown field ${key}.`);
    }
  }
  if (!nonEmpty(value.proposalId) || !UUID.test(value.proposalId)) {
    return refuse("invalid_proposal_identity", "proposalId must be a UUID.");
  }
  if (!nonEmpty(value.idempotencyKey)) {
    return refuse("invalid_idempotency_key", "idempotencyKey must be a non-empty string.");
  }
  const actor = value.actor;
  if (!isRecord(actor) || !nonEmpty(actor.userId)) {
    return refuse("actor_absent", "A budget write must name the actor requesting it.");
  }

  const scope = value.scope;
  if (!isRecord(scope)) return refuse("invalid_scope", "scope must be an object.");
  for (const key of Object.keys(scope)) {
    if (!ALLOWED_SCOPE_KEYS.has(key)) {
      return refuse("unknown_field_present", `scope carries an unknown field ${key}.`);
    }
  }
  if (!nonEmpty(scope.businessId) || !nonEmpty(scope.providerAccountId)
    || !nonEmpty(scope.entityId)) {
    return refuse("invalid_scope", "The scope must name a business, an account and an entity.");
  }
  if (!BUDGET_OWNER_GRAINS.includes(scope.ownerGrain as BudgetOwnerGrain)) {
    return refuse("invalid_owner_grain", "ownerGrain must be campaign or adset.");
  }
  const ownerGrain = scope.ownerGrain as BudgetOwnerGrain;
  const parentCampaignId = scope.parentCampaignId === null
    || scope.parentCampaignId === undefined
    ? null
    : nonEmpty(scope.parentCampaignId) ? scope.parentCampaignId.trim() : "";
  if (parentCampaignId === "") {
    return refuse("invalid_scope", "parentCampaignId must be a non-empty string or null.");
  }
  if (ownerGrain === "campaign" && parentCampaignId !== null) {
    return refuse("invalid_scope", "A campaign target has no parent campaign.");
  }
  if (ownerGrain === "adset" && parentCampaignId === null) {
    return refuse("parent_campaign_absent", "An ad-set target must name its parent campaign.");
  }
  if (parentCampaignId !== null && parentCampaignId === scope.entityId.trim()) {
    return refuse("invalid_scope", "An ad set cannot be its own parent campaign.");
  }

  if (!PROVEN_OWNER_MODES.includes(value.ownerMode as ProvenOwnerMode)) {
    return refuse(
      "owner_mode_not_proven",
      "Only a proven campaign_budget_optimization or adset_budget owner may be written.",
    );
  }
  const ownerMode = value.ownerMode as ProvenOwnerMode;
  if (OWNER_GRAIN_FOR_MODE[ownerMode] !== ownerGrain) {
    return refuse(
      "owner_grain_mismatch",
      `A ${ownerMode} budget lives on the ${OWNER_GRAIN_FOR_MODE[ownerMode]}, not the ${ownerGrain}.`,
    );
  }

  if (!BUDGET_FIELDS.includes(value.budgetField as BudgetField)) {
    return refuse("unsupported_budget_field", "budgetField must be daily_budget or lifetime_budget.");
  }
  const budgetField = value.budgetField as BudgetField;

  if (!isMinorAmount(value.intendedAmountMinor)) {
    return refuse(
      "invalid_amount",
      "intendedAmountMinor must be a positive, exact, safe integer of minor units.",
    );
  }
  if (!nonEmpty(value.currency) || !CURRENCY.test(value.currency)) {
    return refuse("currency_not_retained", "The retained ISO-4217 currency is required.");
  }
  if (typeof value.currencyExponent !== "number"
    || !Number.isInteger(value.currencyExponent)
    || value.currencyExponent < 0 || value.currencyExponent > 4) {
    return refuse("exponent_not_retained", "The captured minor-unit exponent is required.");
  }
  if (!nonEmpty(value.currencyRegistryVersion)) {
    return refuse(
      "currency_registry_not_retained",
      "The registry version the exponent was captured under is required.",
    );
  }

  const baseline = value.baseline;
  if (!isRecord(baseline)) {
    return refuse("baseline_not_retained", "A compare-and-set baseline is required.");
  }
  for (const key of Object.keys(baseline)) {
    if (!ALLOWED_BASELINE_KEYS.has(key)) {
      return refuse("unknown_field_present", `baseline carries an unknown field ${key}.`);
    }
  }
  if (!isMinorAmount(baseline.amountMinor)
    || !nonEmpty(baseline.sourceRunId) || !nonEmpty(baseline.sourceSnapshotId)
    || !nonEmpty(baseline.providerApiVersion)
    || !nonEmpty(baseline.capturedAt) || strictInstantMs(baseline.capturedAt) === null) {
    return refuse(
      "baseline_not_retained",
      "The baseline must carry a retained amount, its run, its snapshot, "
      + "the API version that produced it and a real clock.",
    );
  }
  if (baseline.budgetField !== budgetField) {
    return refuse(
      "baseline_field_mismatch",
      "The baseline must be the same budget field the write intends to change.",
    );
  }

  if (!nonEmpty(value.evidenceAsOf)) {
    return refuse("invalid_evidence_clock", "evidenceAsOf is required.");
  }
  const evidenceAsOfMs = strictInstantMs(value.evidenceAsOf);
  if (evidenceAsOfMs === null) {
    return refuse("invalid_evidence_clock", "evidenceAsOf must be a real instant.");
  }

  return {
    ok: true,
    request: {
      contractVersion: BUDGET_WRITE_REQUEST_CONTRACT,
      proposalId: value.proposalId.trim(),
      idempotencyKey: value.idempotencyKey.trim(),
      actor: { userId: actor.userId.trim() },
      scope: {
        businessId: scope.businessId.trim(),
        providerAccountId: scope.providerAccountId.trim(),
        ownerGrain,
        entityId: scope.entityId.trim(),
        parentCampaignId,
      },
      ownerMode,
      budgetField,
      intendedAmountMinor: value.intendedAmountMinor,
      currency: value.currency,
      currencyExponent: value.currencyExponent,
      currencyRegistryVersion: value.currencyRegistryVersion.trim(),
      baseline: {
        amountMinor: baseline.amountMinor,
        budgetField,
        capturedAt: baseline.capturedAt.trim(),
        sourceRunId: baseline.sourceRunId.trim(),
        sourceSnapshotId: baseline.sourceSnapshotId.trim(),
        providerApiVersion: baseline.providerApiVersion.trim(),
      },
      evidenceAsOf: value.evidenceAsOf.trim(),
      evidenceAsOfMs,
    },
  };
}

/**
 * The deterministic idempotency identity of a write.
 *
 * Two requests that intend the same change to the same field of the same entity
 * from the same proposal are the same attempt; anything else is a different one
 * and must not reuse the key.
 */
export function budgetWriteIdempotencyIdentity(request: BudgetWriteRequest): string {
  return [
    request.contractVersion,
    request.scope.businessId,
    request.scope.providerAccountId,
    request.scope.ownerGrain,
    request.scope.entityId,
    request.budgetField,
    String(request.intendedAmountMinor),
    request.currency,
    String(request.baseline.amountMinor),
    request.proposalId,
  ].join("|");
}
