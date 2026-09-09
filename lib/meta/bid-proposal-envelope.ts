/**
 * The amount a queued bid row is about, bound to that row.
 *
 * A queue row carries a verb ("bid"), a target id and a sentence an operator
 * reads. None of that is a number, so an executor handed such a row would have
 * to decide for itself how far to move a cost cap — which is why unattended bid
 * execution was excluded instead of built. This is the missing fact, persisted
 * beside the row and fingerprinted so it cannot be moved onto another one.
 *
 * It follows the budget envelope deliberately: the same identity binding, the
 * same decision lineage, the same fingerprint discipline. What it adds is the
 * bid strategy, because the same number written onto an ad set whose strategy
 * changed is not the same instruction — a cap of 1320 under `cost_cap` and
 * under a bid cap mean different things to the auction.
 */
import { createHash } from "node:crypto";

import { metaBidAmountDirectionForRecommendationType } from "@/lib/meta/bid-intent-contract";

export const BID_PROPOSAL_ENVELOPE_CONTRACT =
  "meta.bid-proposal-envelope.v1" as const;

export interface BidProposalEnvelope {
  contract: typeof BID_PROPOSAL_ENVELOPE_CONTRACT;
  /** The row this envelope belongs to. An envelope on another row is refused. */
  proposalId: string;
  businessId: string;
  providerAccountId: string;
  /** A bid amount lives on an ad set. There is no campaign-grain bid write. */
  entityId: string;
  parentCampaignId: string | null;
  /** Re-proved against a fresh provider read immediately before the write. */
  bidStrategyType: string;
  direction: "increase" | "decrease";
  percent: number;
  currentMinorUnits: number;
  proposedMinorUnits: number;
  currency: string;
  currencyExponent: number;
  /** The typed intent's own key, so the two records name one operation. */
  intentKey: string;
  /** The decision's own lineage. Never this envelope's own identity. */
  recId: string;
  recType: string;
  snapshotDate: string;
  engineVersion: string;
  decisionAt: string;
  /** sha256 over exactly the fields above, in a fixed order. */
  fingerprint: string;
}

type BidEnvelopeFields = Omit<BidProposalEnvelope, "fingerprint" | "contract">;

function fingerprintFor(fields: BidEnvelopeFields): string {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries({ contract: BID_PROPOSAL_ENVELOPE_CONTRACT, ...fields })
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export function buildBidProposalEnvelope(
  fields: BidEnvelopeFields,
): BidProposalEnvelope {
  return {
    contract: BID_PROPOSAL_ENVELOPE_CONTRACT,
    ...fields,
    fingerprint: fingerprintFor(fields),
  };
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readInteger(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Read one back, fail-closed.
 *
 * Every refusal returns null rather than a partial envelope: an executor that
 * received "most of" a bid change would still have to guess the rest, which is
 * the exact state this file exists to make impossible. The fingerprint is
 * recomputed, so a value edited in the database no longer parses.
 */
export function parseBidProposalEnvelope(value: unknown): BidProposalEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.contract !== BID_PROPOSAL_ENVELOPE_CONTRACT) return null;

  const direction = source.direction;
  if (direction !== "increase" && direction !== "decrease") return null;

  const parentRaw = source.parentCampaignId;
  const parentCampaignId =
    parentRaw === null ? null
      : typeof parentRaw === "string" && parentRaw.trim() ? parentRaw.trim()
        : undefined;
  if (parentCampaignId === undefined) return null;

  const fields = {
    proposalId: readString(source, "proposalId"),
    businessId: readString(source, "businessId"),
    providerAccountId: readString(source, "providerAccountId"),
    entityId: readString(source, "entityId"),
    parentCampaignId,
    bidStrategyType: readString(source, "bidStrategyType"),
    direction,
    percent: readInteger(source, "percent"),
    currentMinorUnits: readInteger(source, "currentMinorUnits"),
    proposedMinorUnits: readInteger(source, "proposedMinorUnits"),
    currency: readString(source, "currency"),
    currencyExponent: readInteger(source, "currencyExponent"),
    intentKey: readString(source, "intentKey"),
    recId: readString(source, "recId"),
    recType: readString(source, "recType"),
    snapshotDate: readString(source, "snapshotDate"),
    engineVersion: readString(source, "engineVersion"),
    decisionAt: readString(source, "decisionAt"),
  };
  for (const [key, entry] of Object.entries(fields)) {
    if (key === "parentCampaignId") continue;
    if (entry === null) return null;
  }
  const typed = fields as BidEnvelopeFields;
  if (typed.proposedMinorUnits <= 0 || typed.currentMinorUnits <= 0) return null;
  if (typed.currencyExponent < 0 || typed.currencyExponent > 4) return null;
  if (
    metaBidAmountDirectionForRecommendationType(typed.recType)
      !== typed.direction
  ) return null;
  /*
    The arithmetic has to hold on its own.

    A percent and two amounts that disagree describe two different changes, and
    an executor would apply whichever one it happened to read.
  */
  const expected = Math.round(
    typed.currentMinorUnits * (1 + (typed.direction === "increase" ? 1 : -1) * typed.percent / 100),
  );
  if (expected !== typed.proposedMinorUnits) return null;
  if (fingerprintFor(typed) !== source.fingerprint) return null;
  return { contract: BID_PROPOSAL_ENVELOPE_CONTRACT, ...typed, fingerprint: String(source.fingerprint) };
}

/**
 * The envelope is only this row's if it names this row.
 *
 * The row's identity is the authority; the JSON is a payload that travelled
 * beside it. Anything else lets an envelope for one ad set be executed against
 * another, which is a real bid change on an entity nobody proposed one for.
 */
export function bidEnvelopeForProposalRow(
  envelope: BidProposalEnvelope | null,
  row: {
    id: string;
    businessId: string;
    providerAccountId: string;
    scopeType: string;
    scopeId: string;
    recId: string | null;
    recType: string | null;
    snapshotDate: string;
    engineVersion: string | null;
  },
): BidProposalEnvelope | null {
  if (!envelope) return null;
  if (row.scopeType !== "adset") return null;
  if (
    envelope.proposalId !== row.id
    || envelope.businessId !== row.businessId
    || envelope.providerAccountId !== row.providerAccountId
    || envelope.entityId !== row.scopeId
    || envelope.recId !== row.recId
    || envelope.recType !== row.recType
    || envelope.snapshotDate !== row.snapshotDate
    || envelope.engineVersion !== row.engineVersion
  ) {
    return null;
  }
  return envelope;
}
