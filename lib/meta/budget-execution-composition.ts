/**
 * D088 — the one server-owned composition root for a concrete budget candidate.
 *
 * Everything a budget write needs is assembled here, once, from retained
 * evidence: the canonical fact through the shared D083 boundary, the exact
 * intent verb and amount, the automatic role authority, the measured change
 * history and a fresh provider baseline. It then asks D085 for the accepted
 * dry-run/receipt and derives the durable D087 request from the SAME validated
 * facts — never from D085's preview key, which is a preview identity and must
 * never become a durable one.
 *
 * It has no authority of its own. It reads, it refuses by name, and it calls
 * nothing: no provider, no database, no clock. Whatever cannot be proven from
 * the facts handed to it is a blocker, never a default.
 */
import { createHash } from "node:crypto";

import { buildCanonicalBudgetFact, type CanonicalBudgetFact } from "@/lib/meta/budget-fact";
import { toBudgetObservation } from "@/lib/meta/budget-observation-projection";
import {
  comparePreflight,
  readbackFingerprint,
  type PreflightProjection,
} from "@/lib/meta/provider-readback-contract";
import type { BudgetField, BudgetOwnerGrain } from "@/lib/meta/budget-intent-contract";
import {
  buildBudgetProposalDryRun,
  META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
  CANONICAL_BUDGET_FACT_CONTRACT,
  type BudgetProposalDryRun,
  type CommercialVerdictBinding,
  type SafetyPosture,
} from "@/lib/meta/budget-proposal-dry-run";
import { D087_BUDGET_TRANSPORT_CAPABILITY } from "@/lib/meta/budget-write-capability";
import {
  parseBudgetWriteRequest,
  BUDGET_WRITE_REQUEST_CONTRACT,
  type BudgetWriteRequest,
} from "@/lib/meta/budget-write-request";
import type { BudgetWriteProviderBaseline } from "@/lib/meta/budget-write-preflight";

/** D085's own posture shapes. A caller must supply real ones. */
export type DryRunSafetyPosture = SafetyPosture;
export type DryRunCommercialBinding = CommercialVerdictBinding;

export const D088_COMPOSITION_CONTRACT = "meta.budget-execution-composition.v1" as const;

/**
 * The EXACT intent verbs. A generic `scale`/`cut` decision label is not one of
 * them: mapping a commercial action onto a budget direction is precisely the
 * inference D088 forbids, because a Scale verdict does not say by how much or
 * even that money is the lever.
 */
export const D088_BUDGET_INTENT_VERBS = ["increase_budget", "decrease_budget"] as const;
export type BudgetIntentVerb = (typeof D088_BUDGET_INTENT_VERBS)[number];

export const D088_COMPOSITION_BLOCKERS = [
  "no_retained_observation",
  "observation_scope_mismatch",
  "observation_entity_mismatch",
  "observation_not_projectable",
  "account_timezone_unknown",
  "canonical_fact_not_action_bearing",
  "owner_mode_not_proven",
  "owner_grain_mismatch",
  "intent_verb_not_canonical",
  "intent_amount_absent",
  "intent_amount_invalid",
  "intent_direction_contradicts_amount",
  "role_authority_not_automatic",
  "role_authority_absent",
  "profile_not_retained",
  "change_history_unknown",
  "provider_baseline_unavailable",
  "provider_baseline_disagrees_with_retained_fact",
  "durable_request_not_constructible",
  /*
    An ad-set CAS projection is invalid without the optimization goal, and the
    goal is a provider fact the observation must carry. Refusing by name beats
    emitting a projection the readback contract will reject.
  */
  "optimization_goal_not_captured",
  /*
    D088 C3: the canonical fact's own PROVENANCE is the evidence a write is
    based on. C2 discarded it and restated `subject[0]` clocks and today's
    date instead, so a proposal could carry evidence identities that belonged
    to a different row than the one whose amount it was about to change.
  */
  "canonical_fact_provenance_incomplete",
  /* The resolver's as-of IS the authority evidence date. Absent is unknown. */
  "role_authority_as_of_unknown",
] as const;
export type BudgetCompositionBlocker = (typeof D088_COMPOSITION_BLOCKERS)[number];

export interface BudgetCompositionRole {
  kind: string;
  /** Only `automatic` role authority may reach a write. */
  source: string;
  resolverVersion: string | null;
  /*
    D088 C3: the RESOLVER's own findings. C2 hard-coded a high confidence,
    today's as-of and `satisfiesRoleAuthority: true` here, which asserted the
    exact judgements the canonical resolver exists to make.
  */
  confidence: string | null;
  asOf: string | null;
  accountScoped: boolean;
  satisfiesRoleAuthority: boolean;
  producer: string;
  authorityBlockers: readonly string[];
}

export interface BudgetCompositionIntent {
  verb: string;
  intendedAmountMinor: number | null;
  percent: number | null;
}

export interface BudgetCompositionHistory {
  lastChangeAtMs: number | null;
  changesInLast7d: number;
  accountConcentrationPercent: number;
}

export interface BudgetCompositionSources {
  businessId: string;
  providerAccountId: string;
  ownerGrain: BudgetOwnerGrain;
  entityId: string;
  parentCampaignId: string | null;
  /** The existing proposal and its atomic claim. The durable identity. */
  proposalId: string;
  claimToken: string;
  actorUserId: string;
  /** Rows exactly as the shared current-read returns them. */
  observations: readonly Record<string, unknown>[];
  accountTimeZone: string | null;
  intent: BudgetCompositionIntent;
  role: BudgetCompositionRole | null;
  profileRetained: boolean;
  /** MEASURED. `null` is unknown, never zero. */
  changeHistory: BudgetCompositionHistory | null;
  providerBaseline: BudgetWriteProviderBaseline | null;
  /** Required for an ad set: the readback projection is invalid without it. */
  optimizationGoal?: string | null;
  /*
    D088 C1: the REAL D085 inputs, supplied by the caller.

    These were hard-coded to `safety: null` / `writeSafety: {}` / a synthesised
    commercial verdict, which made a positive path permanently impossible: D085
    can only answer `would_write_available` when the safety posture and the
    write-safety steps are actually presented to it. They are required rather
    than optional, so a caller cannot re-create the dead seam by omission.
  */
  safety: DryRunSafetyPosture;
  writeSafety: Record<string, "satisfied" | "missing" | "not_applicable">;
  commercial: DryRunCommercialBinding;
  decision: { id: string | null; hash: string | null; version: string | null;
    decidedAt: string | null; maxAgeSeconds: number };
  casBaseline: unknown;
  preflight: unknown;
  /** `null` means DERIVE from the fresh read this function already holds. */
  preflightEvidence: {
    rawAttempt: unknown; evaluatedAt: string | null; baselineFingerprint: string | null;
  } | null;
  rawIntent: unknown;
  nowMs: number;
}

export interface BudgetCompositionResult {
  contract: typeof D088_COMPOSITION_CONTRACT;
  blockers: readonly BudgetCompositionBlocker[];
  canonicalFact: CanonicalBudgetFact | null;
  /** The accepted D085 preview, assembled BEFORE the durable request. */
  dryRun: BudgetProposalDryRun | null;
  request: BudgetWriteRequest | null;
  requestFingerprint: string | null;
  /** True only when the facts AND D085 both permit it. Never true today. */
  executable: boolean;
}

/**
 * The DURABLE identity of an execution attempt.
 *
 * Bound to the existing proposal and its atomic claim, plus the exact request
 * fingerprint — so a retry of the same claim is the same attempt, and any
 * change to what is being written is a different one. D085's preview key is
 * deliberately not an input: a preview identity that became durable would let a
 * preview authorise a write.
 */
export function durableIdempotencyKeyFor(input: {
  proposalId: string;
  claimToken: string;
  fingerprint: string;
}): string {
  return `d088:${input.proposalId}:${input.claimToken}:${input.fingerprint.slice(0, 32)}`;
}

const OWNER_GRAIN_FOR_MODE: Readonly<Record<string, BudgetOwnerGrain>> = Object.freeze({
  campaign_owned: "campaign",
  adset_owned: "adset",
});

/**
 * D083 names the field `daily`/`lifetime`; the intent and write contracts name
 * it `daily_budget`/`lifetime_budget`. One explicit translation, so an
 * ambiguous or unobserved field cannot become a writable one by coincidence.
 */
const WRITE_FIELD_FOR_FACT_FIELD: Readonly<Record<string, BudgetField>> = Object.freeze({
  daily: "daily_budget",
  lifetime: "lifetime_budget",
});

const isNonEmptyText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const fingerprintOf = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function composeBudgetExecutionCandidate(
  sources: BudgetCompositionSources,
): BudgetCompositionResult {
  const blockers: BudgetCompositionBlocker[] = [];
  const add = (blocker: BudgetCompositionBlocker) => {
    if (!blockers.includes(blocker)) blockers.push(blocker);
  };
  const refuse = (): BudgetCompositionResult => ({
    contract: D088_COMPOSITION_CONTRACT,
    blockers: Object.freeze(blockers),
    canonicalFact: null,
    dryRun: null,
    request: null,
    requestFingerprint: null,
    executable: false,
  });

  // --- 1. the retained observations, through the SHARED projector -----------
  if (!Array.isArray(sources.observations) || sources.observations.length === 0) {
    add("no_retained_observation");
    return refuse();
  }
  for (const row of sources.observations) {
    if (row.business_id !== sources.businessId
      || row.provider_account_id !== sources.providerAccountId) {
      add("observation_scope_mismatch");
    }
  }
  const observations = sources.observations
    .map((row) => toBudgetObservation(
      { ...row, entity_type: row.grain },
      {
        businessId: String(row.business_id ?? sources.businessId),
        providerAccountId: String(row.provider_account_id ?? sources.providerAccountId),
      },
    ))
    .filter((o): o is NonNullable<typeof o> => o !== null);
  if (observations.length === 0) {
    add("observation_not_projectable");
    return refuse();
  }
  const subject = observations.filter(
    (o) => o.entityGrain === sources.ownerGrain && o.entityId === sources.entityId,
  );
  if (subject.length === 0) {
    add("observation_entity_mismatch");
    return refuse();
  }
  if (blockers.length > 0) return refuse();

  if (!sources.accountTimeZone || sources.accountTimeZone.trim() === "") {
    add("account_timezone_unknown");
    return refuse();
  }

  // --- 2. the CANONICAL fact. D083 decides; nothing here re-decides. -------
  const parentObservations = sources.ownerGrain === "adset" && sources.parentCampaignId
    ? observations.filter(
      (o) => o.entityGrain === "campaign" && o.entityId === sources.parentCampaignId,
    )
    : [];
  const asOf = new Date(sources.nowMs).toISOString().slice(0, 10);
  const fact = buildCanonicalBudgetFact({
    businessId: sources.businessId,
    providerAccountId: sources.providerAccountId,
    entityGrain: sources.ownerGrain,
    entityId: sources.entityId,
    parentCampaignId: sources.ownerGrain === "adset" ? sources.parentCampaignId : null,
    pit: {
      asOf,
      timeZone: sources.accountTimeZone,
      requireRecordedByCutoff: true,
    },
    entityObservations: subject,
    parentObservations,
  });

  const ownerGrainFromFact = fact.ownerGrain;
  if (ownerGrainFromFact === null) {
    add("owner_mode_not_proven");
  } else if (ownerGrainFromFact !== sources.ownerGrain) {
    add("owner_grain_mismatch");
  }
  if (!fact.intentReady || WRITE_FIELD_FOR_FACT_FIELD[fact.budgetField] === undefined
    || fact.bindingAmountRaw === null
    || fact.currency === null || fact.currencyExponent === null
    || fact.currencyRegistryVersion === null) {
    add("canonical_fact_not_action_bearing");
  }

  // --- 3. the EXACT intent. No generic label becomes a direction. ----------
  if (!(D088_BUDGET_INTENT_VERBS as readonly string[]).includes(sources.intent?.verb ?? "")) {
    add("intent_verb_not_canonical");
  }
  const intended = sources.intent?.intendedAmountMinor ?? null;
  if (intended === null || intended === undefined) {
    add("intent_amount_absent");
  } else if (!Number.isSafeInteger(intended) || intended <= 0) {
    add("intent_amount_invalid");
  }

  // --- 4. automatic role authority, a retained profile, measured history ----
  if (!sources.role) add("role_authority_absent");
  else if (sources.role.source !== "automatic") add("role_authority_not_automatic");
  if (sources.profileRetained !== true) add("profile_not_retained");
  if (!sources.changeHistory) add("change_history_unknown");

  // --- 5. the fresh provider baseline --------------------------------------
  const baseline = sources.providerBaseline;
  if (!baseline) add("provider_baseline_unavailable");

  if (blockers.length > 0) return refuse();

  const currentMinorUnits = Number(fact.bindingAmountRaw);
  if (!Number.isSafeInteger(currentMinorUnits) || currentMinorUnits <= 0) {
    add("canonical_fact_not_action_bearing");
    return refuse();
  }
  /*
    The retained fact and the fresh read must agree about what the account
    holds. They are two independent observations of one number, and a
    disagreement means one of them is describing something else.
  */
  if (baseline!.amountMinor !== currentMinorUnits
    || baseline!.budgetField !== WRITE_FIELD_FOR_FACT_FIELD[fact.budgetField]
    || baseline!.currency !== fact.currency
    || baseline!.entityId !== sources.entityId
    || baseline!.providerAccountId !== sources.providerAccountId) {
    add("provider_baseline_disagrees_with_retained_fact");
    return refuse();
  }
  if (sources.ownerGrain === "adset"
    && (sources.optimizationGoal ?? "").trim() === "") {
    add("optimization_goal_not_captured");
    return refuse();
  }
  const direction = sources.intent.verb === "increase_budget" ? "increase" : "decrease";
  if ((direction === "increase" && intended! <= currentMinorUnits)
    || (direction === "decrease" && intended! >= currentMinorUnits)) {
    add("intent_direction_contradicts_amount");
    return refuse();
  }

  const budgetField = WRITE_FIELD_FOR_FACT_FIELD[fact.budgetField]!;

  /*
    The change PERCENT, derived from the two amounts that are already proven.

    D081's validator requires a percent on its approved ladder, and a caller
    that has only the target amount (the producer does) had no way to supply
    one — so every projected candidate was rejected as `null%`. This is
    arithmetic over the canonical current amount and the decision's exact
    target, not an inference: if the result is off the ladder, the canonical
    validator refuses, which is the gate doing its job.
  */
  const derivedPercent = Math.abs((intended! - currentMinorUnits) / currentMinorUnits) * 100;
  const changePercent = sources.intent.percent ?? derivedPercent;

  /*
    THE CHOSEN FACT'S OWN PROVENANCE.

    D083 already decided WHICH row binds the amount — for a CBO ad set that is
    the parent campaign's row, not the subject's. Every clock, hash and API
    version below is read off that decision rather than off `subject[0]`, which
    is merely the first row that happened to match the subject.
  */
  const ownerProv = fact.ownerProvenance;
  const subjectProv = fact.subjectProvenance;
  const parentProv = fact.parentProvenance;
  const roleAsOfDay = (sources.role?.asOf ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(roleAsOfDay)) {
    add("role_authority_as_of_unknown");
    return refuse();
  }
  if (!ownerProv || !subjectProv
    || ownerProv.effectiveAtMs === null || ownerProv.recordedAtMs === null
    || !isNonEmptyText(ownerProv.observedOn) || !isNonEmptyText(subjectProv.observedOn)
    || !isNonEmptyText(ownerProv.stateHash) || !isNonEmptyText(subjectProv.stateHash)
    || !isNonEmptyText(ownerProv.sourceRunId) || !isNonEmptyText(ownerProv.sourceSnapshotId)
    || !isNonEmptyText(ownerProv.providerApiVersion)
    || (sources.ownerGrain === "adset" && (!parentProv || !isNonEmptyText(parentProv.observedOn)))) {
    add("canonical_fact_provenance_incomplete");
    return refuse();
  }
  /*
    The window the evidence actually spans: the days the rows this fact was
    built from were observed on, not a single synthetic "today to today".
  */
  const evidenceDays = [ownerProv.observedOn!, subjectProv.observedOn!]
    .concat(parentProv?.observedOn ? [parentProv.observedOn] : [])
    .map((day) => day.slice(0, 10))
    .sort();
  const scheduleStart = fact.schedule.startTime;
  const scheduleEnd = fact.schedule.endTime;

  // --- 6. D085 FIRST, under the D087 transport capability ------------------
  /*
    ONE projection, used as the CAS baseline, as the raw attempt's evidence and
    as the fingerprint's subject. Three derivations of the same fact could
    disagree; one cannot.
  */
  const casBaselineProjection: PreflightProjection = {
    providerAccountId: sources.providerAccountId,
    entityGrain: sources.ownerGrain,
    entityId: sources.entityId,
    parentCampaignId: sources.parentCampaignId,
    budgetField,
    budgetMinorUnits: currentMinorUnits,
    ownerMode: ownerGrainFromFact === "campaign"
      ? "campaign_budget_optimization" : "adset_budget",
    effectiveStatus: fact.subjectEffectiveStatus,
    scheduleStart,
    scheduleEnd,
    optimizationGoal: sources.optimizationGoal ?? null,
  };

  const rawAttempt = {
    status: "succeeded" as const,
    observedAt: new Date(baseline!.readAtMs).toISOString(),
    projection: casBaselineProjection,
  };
  const derivedPreflight = comparePreflight(casBaselineProjection, rawAttempt, {
    evaluatedAt: new Date(sources.nowMs).toISOString(),
    maxAgeSeconds: 300,
  });

  const dryRun = buildBudgetProposalDryRun({
    contractVersion: META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
    decision: sources.decision,
    scope: {
      businessId: sources.businessId, business: sources.businessId,
      providerAccountId: sources.providerAccountId,
      entityGrain: sources.ownerGrain, entityId: sources.entityId,
      parentCampaignId: sources.parentCampaignId,
      accountIsWriteScope: true,
      accountSelectionWhy: "the account this proposal was raised for",
    },
    direction,
    percent: changePercent,
    accountCurrency: fact.currency,
    currencyExponent: fact.currencyExponent,
    currencyRegistryVersion: fact.currencyRegistryVersion,
    unitConfidence: "exact",
    role: {
      role: sources.role!.kind, source: "system_inferred",
      resolverVersion: sources.role!.resolverVersion,
      // The resolver's findings, carried verbatim.
      confidence: sources.role!.confidence,
      asOf: sources.role!.asOf,
      accountScoped: sources.role!.accountScoped,
      satisfiesRoleAuthority: sources.role!.satisfiesRoleAuthority,
      authorityBlockers: sources.role!.authorityBlockers,
      producer: sources.role!.producer,
      campaignId: sources.ownerGrain === "campaign"
        ? sources.entityId : sources.parentCampaignId,
      businessId: sources.businessId, providerAccountId: sources.providerAccountId,
      resolved: true, why: "resolved from automatic role authority",
    },
    budgetFact: {
      contractVersion: CANONICAL_BUDGET_FACT_CONTRACT,
      available: true,
      currentMinorUnits,
      budgetField,
      ownerMode: ownerGrainFromFact === "campaign"
        ? "campaign_budget_optimization" : "adset_budget",
      scheduleStart, scheduleEnd,
      observedAt: new Date(ownerProv.effectiveAtMs!).toISOString(),
      capturedAt: new Date(ownerProv.recordedAtMs!).toISOString(),
      lineage: "canonical",
      availabilityWhy: "projected through the shared canonical boundary",
    },
    // The RETAINED profile verdict, as the caller read it.
    commercial: sources.commercial,
    safety: sources.safety,
    // The D087 TRANSPORT capability, which is what a real write would use.
    capability: D087_BUDGET_TRANSPORT_CAPABILITY,
    /* The canonical validator RE-DERIVES the intent from this, so it is built
       from the same facts rather than asserted alongside them. */
    rawIntent: sources.rawIntent ?? {
      contractVersion: "meta.budget-intent.v1",
      scope: {
        businessId: sources.businessId,
        providerAccountId: sources.providerAccountId,
        entityGrain: sources.ownerGrain,
        entityId: sources.entityId,
        parentCampaignId: sources.parentCampaignId,
      },
      ownerMode: ownerGrainFromFact === "campaign"
        ? "campaign_budget_optimization" : "adset_budget",
      budgetField,
      observedDailyMinorUnits: budgetField === "daily_budget" ? currentMinorUnits : null,
      observedLifetimeMinorUnits: budgetField === "lifetime_budget" ? currentMinorUnits : null,
      lifetimeSchedule: budgetField === "lifetime_budget" && scheduleStart && scheduleEnd
        ? { startDate: scheduleStart.slice(0, 10), endDate: scheduleEnd.slice(0, 10) }
        : null,
      direction,
      percent: changePercent,
      accountCurrency: fact.currency,
      originDate: asOf,
      // The day the OWNER row was true, the PIT day this fact was read as of,
      // and the day the role resolver actually resolved. Three real clocks.
      effectiveAsOf: ownerProv.observedOn!.slice(0, 10),
      knowledgeAsOf: fact.pit.asOf,
      authorityEvidenceAsOf: roleAsOfDay,
      maxAuthorityEvidenceAgeDays: 60,
      sourceFingerprints: {
        configStateHash: subjectProv.stateHash!,
        ownerStateHash: ownerProv.stateHash!,
        roleAuthorityHash: fingerprintOf(sources.role),
      },
      evidenceWindow: { from: evidenceDays[0]!, to: evidenceDays[evidenceDays.length - 1]! },
      targetSource: null,
      authorityStatus: "authorised",
      blockerCodes: [],
    },
    knownBindings: [{
      businessId: sources.businessId, providerAccountId: sources.providerAccountId,
    }],
    intent: null,
    intentRejections: [],
    /*
      DERIVED, not asked for.

      The CAS baseline and the preflight comparison are statements about the
      fresh provider read this function already holds, so a caller supplying
      them would be restating what is right here — and supplying `null` (as the
      first draft did) made a positive path impossible for a reason that had
      nothing to do with the account. A caller may still override.
    */
    casBaseline: sources.casBaseline ?? casBaselineProjection,
    /*
      DERIVED by the contract itself. A hand-written summary is a claim about
      what `comparePreflight` would say; D085 re-runs it and refuses any
      difference, so the only correct summary is the one it produces.
    */
    preflight: sources.preflight ?? derivedPreflight,
    preflightEvidence: sources.preflightEvidence ?? {
      /*
        The RAW attempt, in the canonical shape: a succeeded read carries the
        projection it produced, and the baseline fingerprint is taken over that
        same projection — so the comparison can re-derive it rather than
        believe an assertion. C1 published a hash of three ad-hoc fields, which
        matched nothing.
      */
      rawAttempt,
      evaluatedAt: new Date(sources.nowMs).toISOString(),
      baselineFingerprint: readbackFingerprint(casBaselineProjection),
    },
    writeSafety: sources.writeSafety,
    originDate: asOf,
    knowledgeAsOf: new Date(sources.nowMs).toISOString(),
  } as never);

  // --- 7. the DURABLE request, from the same validated facts ---------------
  const draft = {
    contractVersion: BUDGET_WRITE_REQUEST_CONTRACT,
    proposalId: sources.proposalId,
    idempotencyKey: "pending",
    actor: { userId: sources.actorUserId },
    scope: {
      businessId: sources.businessId,
      providerAccountId: sources.providerAccountId,
      ownerGrain: sources.ownerGrain,
      entityId: sources.entityId,
      parentCampaignId: sources.ownerGrain === "adset" ? sources.parentCampaignId : null,
    },
    ownerMode: OWNER_GRAIN_FOR_MODE[fact.ownerMode] === "campaign"
      ? "campaign_budget_optimization" : "adset_budget",
    budgetField,
    intendedAmountMinor: intended!,
    currency: fact.currency!,
    currencyExponent: fact.currencyExponent!,
    currencyRegistryVersion: fact.currencyRegistryVersion!,
    baseline: {
      amountMinor: currentMinorUnits,
      budgetField,
      /* The OWNER row's own capture clock and run identity — the evidence this
         write is actually based on. A `nowMs` fallback would have claimed the
         evidence was captured at the moment the proposal was composed. */
      capturedAt: new Date(ownerProv.recordedAtMs!).toISOString(),
      sourceRunId: ownerProv.sourceRunId!,
      sourceSnapshotId: ownerProv.sourceSnapshotId!,
      /* The Graph API version that produced it: a budget read from v19.0 and
         one from v23.0 are not interchangeable evidence. */
      providerApiVersion: ownerProv.providerApiVersion!,
    },
    evidenceAsOf: new Date(ownerProv.recordedAtMs!).toISOString(),
  };
  const requestFingerprint = fingerprintOf({ ...draft, idempotencyKey: null });
  const parsed = parseBudgetWriteRequest({
    ...draft,
    idempotencyKey: durableIdempotencyKeyFor({
      proposalId: sources.proposalId,
      claimToken: sources.claimToken,
      fingerprint: requestFingerprint,
    }),
  });
  if (!parsed.ok) {
    add("durable_request_not_constructible");
    return {
      contract: D088_COMPOSITION_CONTRACT,
      blockers: Object.freeze(blockers),
      canonicalFact: fact,
      dryRun,
      request: null,
      requestFingerprint,
      executable: false,
    };
  }

  return {
    contract: D088_COMPOSITION_CONTRACT,
    blockers: Object.freeze(blockers),
    canonicalFact: fact,
    dryRun,
    request: parsed.request,
    requestFingerprint,
    /*
      D085's own verdict is the gate. It is not `would_write_available` in this
      environment, so nothing composed here is executable today — which is the
      honest answer, not a placeholder.
    */
    executable: blockers.length === 0 && dryRun.status === "would_write_available",
  };
}
