/**
 * The producer of the retained account profile output the budget path reads.
 *
 * THE DEFECT THIS CLOSES. `budget-proposal-source-loader.ts` and the execution
 * refresh in `budget-proposal-server-readers.ts` both run
 * `D086_PROFILE_LATEST_SQL` over `engine_v3_account_profile_output` to find the
 * canonical commercial verdict for the exact action being proposed. The table
 * had no migration and no writer: the statement raised 42P01, the loader read
 * that error as `unknown`, and every budget candidate was refused with
 * `composition_sources_unavailable`. The migration now creates the relation;
 * this module is what puts a verdict in it.
 *
 * NOTHING HERE DECIDES ANYTHING. The verdict is
 * `AccountDecisionProfile.hardActionEligibility`, resolved by the canonical
 * engine resolver from the account's own retained facts, and projected for
 * retention by `projectCanonicalProfileOutput` — which copies the boolean and
 * its machine code out of the resolver exactly as produced. An account whose
 * commercial truth does not authorise `scale` retains a row that says so, with
 * the engine's own blocker code on it, and the budget path then refuses.
 *
 * THE IDENTITY THE VERDICT IS STAMPED WITH. A retained verdict is only usable
 * to a later reader if that reader can show the verdict was computed from the
 * inputs that are retained NOW. So the two fingerprints are digests of the
 * exact facts the resolver ran on, split by what kind of fact they are:
 *
 * - `inputFingerprint` — the CONFIGURED side: the business target pack with
 *   both of its clocks, the operator's calibration profile, and the engine
 *   flags. An operator who edits their target ROAS changes this digest.
 * - `sourceFingerprint` — the MEASURED side: the account and funnel
 *   calibration the warehouse computed, the account currency, and the scope
 *   those readings came from. A new day of Meta sales changes this digest.
 *   It deliberately EXCLUDES the store's observed average order value: that
 *   evidence chooses no rung under D091, so it cannot change the verdict, and
 *   a fact that cannot change the verdict must not be able to invalidate a
 *   retained one. It used to be digested here, and the consequence was that a
 *   single new Shopify order answered `retained_profile_source_mismatch` and
 *   discarded an unchanged Meta verdict. See the note at the digest itself.
 *
 * AND THE MEASURED SIDE IS ONE ACCOUNT'S. A business can hold several Meta ad
 * accounts, and the warehouse readers default to all of them: the pooled
 * `scope_id '*'` calibration row, a runtime fallback that aggregates the
 * business, and a live Meta-attributed AOV that does the same. Read that way, a
 * verdict stamped with ONE `provider_account_id` was actually computed from
 * every account the business owns — so a sibling account's samples moved this
 * account's identity, and an account with no evidence of its own was handed a
 * benchmark it had never earned. Every measured read below therefore names the
 * account. The configured side stays at business level, because a target ROAS
 * and a calibration profile are one commercial policy for the business, not a
 * per-account setting.
 *
 * AND THE MEASURED SIDE PREFERS THE DAY'S RETAINED READING TO A LIVE ONE.
 * `lib/creative-decision-engine/jobs/calibration-job.ts` materialises one
 * calibration scope per selected ad account beside the pooled one, so a scoped
 * read is served from a row that is fixed for the day it speaks for — which is
 * what makes the identity below stable enough to be re-derived hours later.
 * When that scope has NOT been materialised the scoped readers still answer:
 * the funnel pack comes back empty and the calibration comes back from a
 * runtime aggregate recomputed on every read. Both are honest about this
 * account, and how usable they are as an IDENTITY depends on why the scope is
 * missing — an empty pack is indistinguishable from a genuinely empty account,
 * and a live aggregate moves the moment the account's own sync writes a row. So
 * this module asks the warehouse which state it is in, BEFORE it reads, and
 * `resolveAccountProfileMeasurementScope` turns the answer into a decision: an
 * account the pass SKIPPED is refused by name, and a warehouse that has written
 * no per-account scope for anybody is served from this account's own rows on
 * the terms set out below.
 *
 * A MISS HAS TWO CAUSES AND ONLY ONE OF THEM IS ABOUT THE ACCOUNT. When
 * sibling accounts of the same business have their own scopes and this one does
 * not, the pass covered the business and skipped this account: the refusal is
 * BY NAME and it says something true about the account. When NO account of the
 * business has one, the per-account dimension has never been written in this
 * warehouse — which is every business's state until the first run of the writer
 * that shipped in 058a1c8f6 — and refusing this account would say nothing about
 * this account while withholding a verdict the previous release served.
 *
 * THAT SECOND STATE IS SERVED FROM THIS ACCOUNT'S OWN POPULATION, NEVER FROM
 * THE BUSINESS'S. It used to be served from the pooled one, on the argument
 * that the pooled reading was what the previous release computed and that
 * labelling it `business_pooled` made it honest. The label was honest and the
 * authority was not: an account with six mature converters beside a sibling
 * with thirty-two was served the pooled thirty-eight, cleared the
 * thirty-creative automation-quality floor its own six cannot, and had that
 * verdict RETAINED under its own `provider_account_id` — where the budget
 * loader and the execution reader re-derived the same pooled fingerprint and
 * accepted it. A sibling's evidence became this account's hard-action
 * eligibility. So the measured reads name this account in this state too, and
 * they are reached one of two ways:
 *
 * - THE POOLED ROWS ARE THIS ACCOUNT'S ROWS, PROVEN. When the warehouse holds
 *   no `meta_creative_daily` row of this business belonging to any other ad
 *   account, the pooled `scope_id '*'` row was computed by the same statement
 *   over exactly this account's rows. There is nothing to borrow, so the reads
 *   take the pooled parameter — which keeps the funnel and by-kind packs the
 *   previous release served. The proof is
 *   `readBusinessAccountPopulationBreadth`, asked of the warehouse rows and not
 *   of the assignment table, because a business can hold rows for an account it
 *   no longer selects.
 *
 *   ON WHAT TERMS IT IS FIXED FOR THE DAY, which is narrower than "always".
 *   `per_account_scopes_unwritten` is reached BOTH by a business whose pooled
 *   `scope_id '*'` row exists and by one with no calibration row at all — the
 *   presence probe deliberately excludes `'*'`, so zero rows lands here too.
 *   Where the pooled row exists the reading comes from it and is fixed for the
 *   day, as stable as a materialised scope. Where it does not,
 *   `getAccountCalibration` falls through to a live pooled aggregate, exactly
 *   as the pooled read has always done in that state, and the reading moves
 *   with the account's own writes. The NUMBERS are this account's either way —
 *   sole account means the same rows — so no authority turns on the
 *   difference; only the identity's stability does.
 * - OTHERWISE, THIS ACCOUNT'S OWN RUNTIME AGGREGATE. The scoped calibration
 *   read misses the precomputed row and falls through to
 *   `ACCOUNT_CALIBRATION_QUERY` filtered to this `provider_account_id`, so the
 *   percentiles, the sample counts and the attributed AOV are computed from
 *   this account's rows and nothing else. The funnel and by-kind packs are
 *   precomputed-only and come back empty, which is honest — nobody has measured
 *   them for this account — and which `hardActionEligibility` does not consult.
 *
 * THE SECOND OF THOSE HAS A VOLATILE IDENTITY, AND THAT IS A DELIBERATE TRADE.
 * A runtime aggregate is recomputed on every read, so this account's own sync
 * writing a row between projection and approval moves `sourceFingerprint` and
 * the retained verdict stops agreeing with the reader's expectation. It is
 * bounded to the window between deploying the per-account writer and the first
 * calibration run, it affects only businesses that genuinely hold several ad
 * accounts, and it is the same behaviour a materialised row already falls back
 * to when its own source freshness has aged out (see the paragraph below on the
 * two readings that still come from the live aggregate). A verdict that is
 * CORRECT and occasionally re-derived is a defensible transitional cost; a
 * verdict that is stable because it was computed from another account's
 * evidence is not.
 *
 * The serve path in `app/api/meta/decisions-workspace/route.ts` resolves its
 * data source from the SAME function, so one response can never carry a
 * business-pooled panel beside an account-scoped retained verdict, or a served
 * verdict where the producer refused.
 *
 * TWO READINGS STILL COME FROM THE LIVE AGGREGATE, AND THEY ARE NAMED HERE
 * RATHER THAN CLAIMED AWAY. A materialised row is declined by
 * `readCalibrationFromTable` when its own source freshness has aged past
 * `STALE_TIER_WARNING_MAX_HOURS`, and when it carries no source freshness at
 * all — which is what an account with nothing in the window gets. Both then
 * fall back to the runtime aggregate for THIS account, so no borrowing occurs
 * and no verdict rests on another account's samples; what can happen is that
 * the day's identity moves when this account's own warehouse rows change before
 * the next calibration pass. The pooled read has always behaved the same way,
 * and closing it means giving the retained row a freshness contract of its own
 * rather than widening this refusal.
 *
 * Both are computed from ONE read of those facts, which is then pinned into the
 * data source the resolver runs against, so the digest and the verdict cannot
 * describe two different readings of the same account. `readAccountProfileRetentionIdentity`
 * recomputes the same digests from the same readers WITHOUT touching the
 * retained table, which is what makes it an external expectation rather than a
 * row checked against itself.
 */
import { createHash } from "node:crypto";
import { deterministicCommercialCutoffMs } from "@/lib/meta/commercial-target-instant";

import { getDb } from "@/lib/db";
import {
  WarehouseDataSource,
  type AccountScopeCalibrationMaterialisation,
  type BusinessAccountPopulationBreadth,
  type BusinessTargetPack,
  type CreativeDecisionDataSource,
  type DecisionCalibrationProfileConfig,
} from "@/lib/creative-decision-engine/data-source";
import { resolveAccountDecisionProfile } from "@/lib/creative-decision-engine/account-decision-profile";
import {
  projectAccountCpaForIdentity,
  projectCommercialTargetPackForIdentity,
  projectProfileConfigForIdentity,
} from "@/lib/creative-decision-engine/commercial-semantic-projection";
import {
  observedShopifyAovIsUsable,
  resolveObservedShopifyAov,
  type ObservedShopifyAovEvidence,
} from "@/lib/creative-decision-engine/shopify-aov-source";
import {
  resolveEngineV3Flags,
  type EngineV3Flags,
} from "@/lib/creative-decision-engine/feature-flags";
import { resolveMinorUnitExponent } from "@/lib/currency/iso-4217-minor-units";
import type {
  AccountCalibration,
  AccountFunnelCalibration,
  CalibrationCampaignKind,
} from "@/lib/creative-decision-engine/types";
import type { MetaAttributedAovResult } from "@/lib/creative-decision-engine/meta-aov-calculator";
import {
  D086_PROFILE_ACTIONS,
  D086_PROFILE_IDENTITY,
  D086_RETENTION_CONTRACT,
  projectCanonicalProfileOutput,
  type CanonicalProfileOutput,
  type D086ProfileAction,
} from "@/lib/meta/budget-readiness-retention";

export const ACCOUNT_PROFILE_OUTPUT_PRODUCER_CONTRACT =
  "meta.account-profile-output-producer.v1" as const;

/** The two digests a retained verdict carries, and a reader re-derives. */
export interface AccountProfileRetentionIdentity {
  inputFingerprint: string;
  sourceFingerprint: string;
}

export interface AccountProfileRetentionScope {
  businessId: string;
  /** One physical ad account. A verdict is never business-wide here. */
  providerAccountId: string;
  /** The day the verdict speaks for. */
  asOfDate: string;
  /** Injectable only so a replay can pin the clock; production omits it. */
  nowIso?: string;
}

/**
 * The exact facts both the verdict and its identity are built from.
 *
 * Read once, digested once, and pinned into the resolver's data source. Every
 * member is a value some other process wrote; nothing here is derived.
 */
export interface AccountProfileRetentionInputs {
  businessId: string;
  providerAccountId: string;
  asOfDate: string;
  accountCurrency: string | null;
  targetPack: BusinessTargetPack | null;
  profileConfig: DecisionCalibrationProfileConfig | null;
  flags: EngineV3Flags;
  accountCalibration: AccountCalibration;
  funnelCalibration: AccountFunnelCalibration;
  observedShopifyAov: ObservedShopifyAovEvidence | null;
  /**
   * Whether the measured facts above came from this account's OWN retained
   * calibration scope, and so whether they are fixed for the day.
   *
   * `unprobed` is not a warehouse state: it is what an injected data source
   * that does not model the precomputed table reports, and it means the
   * question could not be put. Such a source answers the measured reads
   * directly, so its facts are whatever it says they are and this module has
   * nothing to check them against.
   */
  measuredScope: AccountProfileMeasuredScopeStatus;
  /**
   * Whether the business's warehouse rows belong to this account alone.
   *
   * Only consulted while NO account of the business has a calibration scope of
   * its own: it is what decides whether the pooled precomputed row may be read
   * as this account's own measurement (it can, when it was computed from this
   * account's rows and nothing else) or whether the reads must be scoped to the
   * account and answered from a runtime aggregate.
   *
   * `unprobed` is not a warehouse state: it is what this module records when the
   * question was not put — because the calibration-scope state made it
   * irrelevant, or because the data source models no warehouse — and it is
   * never treated as `sole_account`.
   */
  populationBreadth: AccountProfilePopulationBreadth;
}

/** {@link BusinessAccountPopulationBreadth}, plus "the question was not put". */
export type AccountProfilePopulationBreadth =
  | BusinessAccountPopulationBreadth
  | "unprobed";

/**
 * Which population one set of inputs was READ FROM, derived rather than stored.
 *
 * Derived on purpose: a stored copy could disagree with `measuredScope`, and
 * then a verdict would claim a scope its own facts contradict. Every consumer —
 * the identity digest, the pinned data source the resolver runs against, and
 * the serve path — asks this same function of the same status, so there is one
 * answer and no way to hold two.
 */
export function accountProfileInputsMeasurementScope(
  inputs: Pick<
    AccountProfileRetentionInputs,
    "measuredScope" | "populationBreadth" | "providerAccountId" | "asOfDate"
  >,
): AccountProfileMeasurementScope {
  return resolveAccountProfileMeasurementScope({
    status: inputs.measuredScope,
    populationBreadth: inputs.populationBreadth,
    providerAccountId: inputs.providerAccountId,
    asOfDate: inputs.asOfDate,
  });
}

/** {@link AccountScopeCalibrationMaterialisation}, plus "nobody could ask". */
export type AccountProfileMeasuredScopeStatus =
  | AccountScopeCalibrationMaterialisation
  | "unprobed";

/**
 * The named hold a measured scope forces, or `null` when there is none.
 *
 * ONE PLACE, FOUR CALLERS. The producer, the reader's expectation, the
 * read-through step and the serve path in
 * `app/api/meta/decisions-workspace/route.ts` all have to agree: a verdict that
 * would be refused when it is produced must not be offered as an expectation or
 * served on a panel either, or one response carries two commercial verdicts
 * about the same account.
 *
 * `materialised` and `unprobed` pass, and so does
 * `per_account_scopes_unwritten` — see
 * {@link resolveAccountProfileMeasurementScope} for why a warehouse that has
 * never written ANY per-account scope is answered from THIS ACCOUNT'S OWN
 * population rather than refused. That state is a fact about the warehouse and
 * not about the account, so refusing it would blank every healthy account until
 * a cron ran; the answer it gets is measured from its own rows either way.
 *
 * `absent` and `unreadable` hold, with the reason in the name. They are two
 * different reasons and they are never merged: `absent` is the fact that
 * sibling accounts have scopes and this one does not, and `unreadable` is the
 * absence of any fact at all because the probe failed.
 */
export function accountProfileMeasuredScopeHold(
  status: AccountProfileMeasuredScopeStatus,
): string | null {
  if (
    status === "materialised"
    || status === "unprobed"
    || status === "per_account_scopes_unwritten"
  ) {
    return null;
  }
  return status === "absent"
    ? "account_calibration_scope_not_materialised"
    : "account_calibration_scope_unreadable";
}

export const ACCOUNT_PROFILE_MEASUREMENT_SCOPE_CONTRACT =
  "meta.account-profile-measurement-scope.v2" as const;

/**
 * How the population a verdict is measured from is actually reached.
 *
 * `scope` says WHOSE evidence the verdict rests on. This says which read
 * produced it, which is a different question and the one that decides whether
 * the reading is fixed for the day.
 *
 * - `materialised_account_scope` — this account's own precomputed calibration
 *   row. Fixed for the day it speaks for.
 * - `sole_account_pooled_rows` — the business's pooled precomputed row, read as
 *   this account's own because the warehouse holds rows for no other ad account
 *   of this business, so the pooled statement ran over exactly this account's
 *   rows. Fixed for the day, and borrows nothing.
 * - `account_runtime_aggregate` — `ACCOUNT_CALIBRATION_QUERY` filtered to this
 *   `provider_account_id`. This account's own rows, recomputed on every read,
 *   so the identity it produces moves when this account's sync writes.
 * - `business_pooled_rows` — the business's whole Meta footprint, for a caller
 *   that named no physical account. A summary; it is never the basis of a
 *   retained per-account verdict, because the producer requires an account.
 * - `source_answers_directly` — an injected data source that models no
 *   precomputed table answered the measured reads itself.
 * - `withheld` — a hold applies and nothing was read.
 */
export type AccountProfileMeasurementBasis =
  | "materialised_account_scope"
  | "sole_account_pooled_rows"
  | "account_runtime_aggregate"
  | "business_pooled_rows"
  | "source_answers_directly"
  | "withheld";

/**
 * Which population one account's MEASURED facts are read from, how, and whether
 * that state forces a hold.
 *
 * WHAT THIS EXISTS TO STOP. Scoping the measured reads to the selected account
 * was right, and it introduced a second way for an account with ample evidence
 * to be withheld: `engine_v3_account_calibration_daily` had never held a row at
 * any account's own `scope_id` until the writer shipped
 * (`lib/creative-decision-engine/jobs/calibration-job.ts`, commit 058a1c8f6),
 * so on deploy EVERY account's scoped probe misses and every panel holds until
 * the next calibration run. That is the same shape as the Shopify
 * retained-window regression this delivery already repaired once: a refusal
 * that moved from "while a job runs" to "until one runs".
 *
 * AND WHAT THE FIRST ANSWER TO IT GOT WRONG. That bootstrap state used to be
 * answered from the BUSINESS-POOLED population, labelled `business_pooled` and
 * let through — and a label is not an authority boundary. An account with six
 * mature converters beside a sibling with thirty-two was served, and had
 * RETAINED under its own `provider_account_id`, a `scale` verdict that only the
 * pooled thirty-eight could reach. The budget loader and the execution reader
 * re-derived the identical pooled fingerprint and accepted the row. Whatever
 * the payload said about provenance, a sibling's evidence was this account's
 * hard-action eligibility.
 *
 * THE DISTINCTIONS THAT FIX IT, both derived from the warehouse rather than
 * assumed. `readAccountScopeCalibrationMaterialisation` reports whether ANY
 * account-named scope exists for the business, not just this account's; and
 * `readBusinessAccountPopulationBreadth` reports whether the business's
 * warehouse rows belong to this account alone:
 *
 * - Sibling accounts have scopes and this one does not (`absent`). The pass
 *   covered the business and skipped this account — an account whose selection
 *   changed after the run, most commonly. That IS a fact about this account,
 *   its measured facts really are an empty pack beside a live aggregate, and
 *   the named hold is the honest answer.
 * - No account has one (`per_account_scopes_unwritten`). The per-account
 *   dimension does not exist in this warehouse at all, so refusing this account
 *   states nothing about this account and would blank every healthy account
 *   until a cron ran. The verdict is produced — from THIS ACCOUNT'S population,
 *   reached one of two ways. Where the business's rows all belong to this
 *   account, the pooled precomputed row IS this account's measurement and is
 *   read as such (`sole_account_pooled_rows`), which keeps the reading fixed for
 *   the day and keeps the funnel and by-kind packs the previous release served.
 *   Otherwise the reads name the account and fall through to its own runtime
 *   aggregate (`account_runtime_aggregate`).
 *
 * ON WHAT TERMS EACH READING IS STABLE, stated rather than assumed. The
 * materialised and sole-account-pooled bases are served from a precomputed row
 * and are fixed for the day. The runtime aggregate is not: it is recomputed on
 * every read, so a sync write between projection and approval moves the
 * identity and the retained verdict is re-derived. That cost is bounded to
 * multi-account businesses in the window before their first per-account
 * calibration run, and it is the same fallback a materialised row already takes
 * when its own source freshness has aged out. It is preferred to the
 * alternative, which is a stable verdict computed from another account's
 * evidence.
 *
 * ONE FUNCTION, FOUR CALLERS. The producer, the reader's expectation, the
 * read-through step and the serve path in
 * `app/api/meta/decisions-workspace/route.ts` all resolve the scope here, so a
 * response can never carry a differently-measured panel beside a retained
 * verdict, or serve a verdict the producer refused.
 */
export interface AccountProfileMeasurementScope {
  contractVersion: typeof ACCOUNT_PROFILE_MEASUREMENT_SCOPE_CONTRACT;
  /**
   * The calibration-scope state this was decided from, or `null` when the
   * caller named no physical account and the per-account question does not
   * apply.
   */
  materialisation: AccountProfileMeasuredScopeStatus | null;
  /** Whose evidence the measured facts are. */
  scope: "account" | "business_pooled";
  /** The account that population belongs to, or `null` for the business. */
  providerAccountId: string | null;
  /**
   * The `providerAccountId` the measured readers are actually called with.
   *
   * Usually the same as `providerAccountId`. It is `null` — a pooled read — in
   * exactly one case where `scope` is still `"account"`: the business's
   * warehouse rows belong to this account alone, so the pooled row was computed
   * from this account's rows and reading it borrows nothing. Kept as its own
   * field rather than folded into `providerAccountId`, because "whose evidence
   * this is" and "which parameter the SQL was given" are different claims and
   * conflating them is how the pooled reading passed for an account's own.
   */
  readProviderAccountId: string | null;
  /** How that population is reached. */
  basis: AccountProfileMeasurementBasis;
  /** {@link accountProfileMeasuredScopeHold} for this state. */
  hold: string | null;
  /** One sentence naming the state, for an operator rather than a log. */
  why: string;
}

export function resolveAccountProfileMeasurementScope(input: {
  status: AccountProfileMeasuredScopeStatus;
  /**
   * Whether the business's warehouse rows belong to this account alone. Only
   * consulted in the `per_account_scopes_unwritten` state; anything that is not
   * `sole_account` — including a failed probe — sends the reads to the
   * account's own runtime aggregate, which is always correct.
   */
  populationBreadth: AccountProfilePopulationBreadth;
  providerAccountId: string;
  asOfDate: string;
}): AccountProfileMeasurementScope {
  const base = {
    contractVersion: ACCOUNT_PROFILE_MEASUREMENT_SCOPE_CONTRACT,
    materialisation: input.status,
    hold: accountProfileMeasuredScopeHold(input.status),
  } as const;
  if (input.status === "per_account_scopes_unwritten") {
    const sole = input.populationBreadth === "sole_account";
    return {
      ...base,
      scope: "account",
      providerAccountId: input.providerAccountId,
      // The one place a pooled READ carries an account-scoped population, and
      // only because the two are the same rows.
      readProviderAccountId: sole ? null : input.providerAccountId,
      basis: sole ? "sole_account_pooled_rows" : "account_runtime_aggregate",
      why: sole
        ? `no ad account of this business has a calibration scope of its own on or before ${input.asOfDate}, `
          + `and every warehouse row of this business belongs to ${input.providerAccountId}; the business's `
          + "pooled calibration row was therefore computed from this account's rows and nothing else, so it "
          + "is read as this account's own measurement"
        : `no ad account of this business has a calibration scope of its own on or before ${input.asOfDate}, `
          + `and this business holds warehouse rows for more than ${input.providerAccountId}; the measured `
          + "facts below are computed from this account's own rows at read time, and they become a retained "
          + "reading of the same rows on the next calibration run",
    };
  }
  if (input.status === "absent") {
    return {
      ...base,
      scope: "account",
      providerAccountId: input.providerAccountId,
      readProviderAccountId: input.providerAccountId,
      basis: "withheld",
      why:
        `other ad accounts of this business have retained calibration scopes on or before ${input.asOfDate} `
        + `and ${input.providerAccountId} has none, so the calibration pass covered the business and `
        + "skipped this account; no verdict is retained for it and none is served",
    };
  }
  if (input.status === "unreadable") {
    return {
      ...base,
      scope: "account",
      providerAccountId: input.providerAccountId,
      readProviderAccountId: input.providerAccountId,
      basis: "withheld",
      why:
        "the calibration scope probe itself failed, so nothing is known about what the warehouse holds "
        + `for ${input.providerAccountId} on ${input.asOfDate}; this is a failed read and not the fact `
        + "that the account has no scope",
    };
  }
  return {
    ...base,
    scope: "account",
    providerAccountId: input.providerAccountId,
    readProviderAccountId: input.providerAccountId,
    basis:
      input.status === "materialised"
        ? "materialised_account_scope"
        : "source_answers_directly",
    why:
      input.status === "materialised"
        ? `${input.providerAccountId} has its own retained calibration scope on or before ${input.asOfDate}, `
          + "so every measured fact below is this account's own"
        : "this data source does not model the precomputed calibration table, so the scope question could "
          + "not be put; the measured reads name this account and answer for it directly",
  };
}

/**
 * The labelled pooled reading a caller that names NO physical account gets.
 *
 * A business-wide request has no per-account scope question to answer: it is
 * the business's whole Meta footprint by construction, and saying so is more
 * useful than publishing nothing.
 *
 * IT IS A SUMMARY, AND IT CANNOT BECOME AN ACCOUNT'S AUTHORITY — structurally,
 * not by labelling. A commercial verdict only reaches a write through a row in
 * `engine_v3_account_profile_output`, every such row is keyed on one
 * `provider_account_id`, and the only producer of those rows takes an account
 * and measures that account's own population. This function names no account,
 * so no reading it describes is ever retained and no consumer can look one up
 * by it. That is asserted at the route in
 * `app/api/meta/bootstrap-account-population.db.test.ts`.
 */
export function businessPooledMeasurementScope(input: {
  asOfDate: string;
}): AccountProfileMeasurementScope {
  return {
    contractVersion: ACCOUNT_PROFILE_MEASUREMENT_SCOPE_CONTRACT,
    materialisation: null,
    scope: "business_pooled",
    providerAccountId: null,
    readProviderAccountId: null,
    basis: "business_pooled_rows",
    hold: null,
    why:
      `this request names no physical ad account, so the measured facts below are every Meta ad account `
      + `this business owns, pooled together, as of ${input.asOfDate}; it is a business summary and no `
      + "account's write authority is derived from it",
  };
}

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * The value the MEASURED digest carries for one measurement scope.
 *
 * `materialised_account_scope` and `source_answers_directly` are the two bases
 * that existed when this field only knew the word `"account"`, and they still
 * spell it — so every verdict already retained on a materialised scope keeps
 * its identity and is not re-derived by this change. The bootstrap bases are
 * new behaviour and get names of their own, which is what stops a pooled-read
 * verdict and a materialised one from sharing a fingerprint on a business whose
 * numbers happen to be identical.
 */
function measurementIdentityTag(
  measurement: AccountProfileMeasurementScope,
): string {
  return measurement.basis === "materialised_account_scope"
    || measurement.basis === "source_answers_directly"
    ? measurement.scope
    : `${measurement.scope}:${measurement.basis}`;
}

/**
 * The account's own currency, from the assignment the business actually holds.
 *
 * Selected rather than assumed: the store's average order value is only a
 * benchmark for this account when it is denominated in this account's currency,
 * and `resolveObservedShopifyAov` refuses when it is not.
 */
async function readAccountCurrency(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<string | null> {
  const rows = (await getDb().query(
    `SELECT pa.currency
       FROM business_provider_accounts bpa
       JOIN provider_accounts pa ON pa.id = bpa.provider_account_ref_id
      WHERE bpa.business_id = $1
        AND bpa.provider = 'meta'
        AND bpa.provider_account_id = $2
      LIMIT 1`,
    [input.businessId, input.providerAccountId],
  )) as Array<{ currency?: string | null }>;
  const currency = rows[0]?.currency;
  return typeof currency === "string" && currency.trim() !== ""
    ? currency.trim()
    : null;
}

/**
 * Read the facts the verdict rests on. `null` means a read failed, and a read
 * that failed is UNKNOWN — no verdict is produced and no expectation is
 * offered, so every caller fails closed.
 */
export async function readAccountProfileRetentionInputs(
  scope: AccountProfileRetentionScope,
  dataSource: CreativeDecisionDataSource = new WarehouseDataSource(),
): Promise<AccountProfileRetentionInputs | null> {
  try {
    const accountCurrency = await readAccountCurrency(scope);
    const exponent = resolveMinorUnitExponent(accountCurrency);
    /*
      WHICH POPULATION THE MEASURED READS BELOW MAY DRAW FROM, asked BEFORE they
      are made rather than checked after.

      A scoped read cannot say which of two empty answers it is holding. A
      scoped funnel read that finds no materialised scope returns a pack with no
      formats in it, byte-identical to the pack a genuinely empty account
      returns; a scoped calibration read that finds none falls through to a
      runtime aggregate, which is this account's own numbers but recomputed on
      every read. Stamped into `sourceFingerprint`, the first is a constant that
      can never move and the second moves whenever this account's sync writes a
      row — so the verdict retained at projection stops agreeing with the
      reader's expectation hours later, and an account with plenty of evidence
      is withheld for a reason that has nothing to do with its evidence.

      So the warehouse is asked directly, and its answer decides the scope of
      the reads rather than only judging them afterwards. When NO account of
      this business has a scope of its own, the reads are still THIS ACCOUNT'S —
      served from the pooled precomputed row where that row was provably
      computed from this account's rows and nothing else, and otherwise from
      this account's own runtime aggregate.
      `resolveAccountProfileMeasurementScope` owns that decision and the serve
      path resolves its own data source from the same function, so the two
      cannot disagree. A source that does not model the precomputed table has no
      answer to give and says nothing; the production source implements both
      probes.
    */
    const measuredScope: AccountProfileMeasuredScopeStatus =
      dataSource.readAccountScopeCalibrationMaterialisation
        ? await dataSource.readAccountScopeCalibrationMaterialisation({
          businessId: scope.businessId,
          asOf: scope.asOfDate,
          providerAccountId: scope.providerAccountId,
        })
        : "unprobed";
    /*
      The population-equivalence proof, asked only where it can change the
      answer. Everywhere else the account's own scope is either materialised or
      irrelevant, and an unnecessary index probe on `meta_creative_daily` is a
      cost this read does not need to pay.
    */
    const populationBreadth: AccountProfilePopulationBreadth =
      measuredScope === "per_account_scopes_unwritten"
        && dataSource.readBusinessAccountPopulationBreadth
        ? await dataSource.readBusinessAccountPopulationBreadth({
          businessId: scope.businessId,
          providerAccountId: scope.providerAccountId,
        })
        : "unprobed";
    const measurement = resolveAccountProfileMeasurementScope({
      status: measuredScope,
      populationBreadth,
      providerAccountId: scope.providerAccountId,
      asOfDate: scope.asOfDate,
    });
    const [targetPack, profileConfig, flags, accountCalibration, funnelCalibration] =
      await Promise.all([
        dataSource.getBusinessTargetPack({
          businessId: scope.businessId,
          asOf: scope.asOfDate,
        }),
        dataSource.getDecisionCalibrationProfile({
          businessId: scope.businessId,
          channel: "meta",
          objectiveFamily: "sales",
        }),
        resolveEngineV3Flags(scope.businessId),
        /*
          MEASURED, so read from the population this verdict is FOR — which is
          always this account's, and is `measurement.readProviderAccountId`
          rather than the account id itself for exactly one reason: where the
          business's warehouse rows all belong to this account, the pooled
          precomputed row was computed from those same rows, and reading it
          keeps the day's reading fixed without borrowing anything.

          Both readers otherwise default to the business's whole Meta footprint
          — the precomputed `scope_id '*'` row, and a runtime aggregate over
          every account the business owns. That default is right for a
          business-wide surface and wrong here: the row this produces is keyed
          on one `provider_account_id` and its fingerprints are what a later
          reader checks the verdict against, so a business-wide reading would
          let a SIBLING account's samples move this account's identity and hand
          it a calibration it has no evidence for. Naming the account makes the
          percentiles, the sample counts and the attributed AOV this account's
          own; an account with none of its own gets zeroes, which is the honest
          answer.
        */
        dataSource.getAccountCalibration({
          businessId: scope.businessId,
          asOf: scope.asOfDate,
          providerAccountId: measurement.readProviderAccountId,
        }),
        dataSource.getAccountFunnelCalibration({
          businessId: scope.businessId,
          asOf: scope.asOfDate,
          providerAccountId: measurement.readProviderAccountId,
        }),
      ]);
    /*
      DIAGNOSTIC EVIDENCE, gathered when it is worth the query and never a rung.

      The store's average order value chooses no basis anywhere (D091): the
      canonical unit is Meta's own attributed AOV over the target ROAS, and
      `resolveSpendUnit` has no `observed_shopify_aov` rung to reach. What this
      read still produces is CONTEXT — a merchant's settled orders beside Meta's
      attributed ones — carried in `spendUnitEvidence` and shown as clearly
      labelled diagnostic evidence.

      The comment here used to say the read mirrors "the snapshot's own
      benchmark resolution", which stopped being true when the snapshot stopped
      reading the store at all. The short-circuit that remains is kept only
      because a configured target CPA or operator AOV is the state in which the
      contextual comparison is least informative — NOT because either
      suppresses a rung.

      This comment also used to claim the resulting `source_fingerprint`
      asymmetry between those accounts and the rest was "known and deliberate".
      That framing hid a real defect. The value below was digested into the
      MEASURED half of the retention identity, and that half is persisted as
      `engine_v3_account_profile_output.source_fingerprint` — `NOT NULL`, and
      part of the table's UNIQUE key (`lib/migrations.ts`) — then compared for
      agreement by `budget-readiness-retention.ts`, which answers
      `retained_profile_source_mismatch` and discards the retained verdict when
      it moves. So one new Shopify order, or a `status` flip to `stale`, threw
      away a Meta verdict that had not changed. Evidence that chooses no rung
      must not key an identity either; the digest no longer reads it.
    */
    const observedShopifyAov =
      targetPack?.targetCpa || targetPack?.operatorAovAssumption
        ? null
        : await resolveObservedShopifyAov({
          businessId: scope.businessId,
          accountCurrency,
          currencyExponent:
            exponent.status === "resolved" ? exponent.exponent : null,
        });
    return {
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
      asOfDate: scope.asOfDate,
      accountCurrency,
      targetPack,
      profileConfig,
      flags,
      accountCalibration,
      funnelCalibration,
      observedShopifyAov,
      measuredScope,
      populationBreadth,
    };
  } catch {
    return null;
  }
}

/**
 * The identity, from an explicit allowlist of fields.
 *
 * An allowlist rather than "the whole object minus the volatile parts":
 * `AccountCalibration.computedAt` is `new Date()` on every runtime-SQL read and
 * `ObservedShopifyAovEvidence.knowledgeAsOf` is the read's own clock, so
 * digesting either would make the identity differ from itself on two reads of
 * one unchanged account and refuse every verdict ever retained.
 */
export function accountProfileRetentionIdentity(
  inputs: AccountProfileRetentionInputs,
): AccountProfileRetentionIdentity {
  const scope = {
    contract: D086_RETENTION_CONTRACT,
    producer: ACCOUNT_PROFILE_OUTPUT_PRODUCER_CONTRACT,
    profileContract: D086_PROFILE_IDENTITY.profileContract,
    engineEpoch: D086_PROFILE_IDENTITY.engineEpoch,
    engineVersion: D086_PROFILE_IDENTITY.engineVersion,
    businessId: inputs.businessId,
    providerAccountId: inputs.providerAccountId,
    asOfDate: inputs.asOfDate,
  };
  const calibration = inputs.accountCalibration;
  return {
    inputFingerprint: digest({
      ...scope,
      side: "configured",
      /*
        THE SEMANTIC PROJECTION, not the raw pack.

        This enumerated `targetCpa`, `breakEvenCpa`, `operatorAovAssumption`,
        `updatedAt` and `freshness` directly, so on an account governed by its
        Target ROAS a Target-CPA edit — or merely re-saving the pack, which
        moves `updatedAt` on its own — changed `input_fingerprint`. That
        fingerprint is persisted and compared, so the retained verdict then
        failed its agreement check with `retained_profile_input_mismatch` and
        was discarded for an edit that could not have changed the decision.

        Dropping the numbers alone would not have closed it: the row's
        timestamp travels with them and moves on any re-save. The shared
        projection removes both in the governed case and preserves the whole
        pack — CPA, timestamp and all — in the no-Target-ROAS compatibility
        case, where the legacy CPA genuinely is the anchor.
      */
      /*
        ROUND 9 ITEM 2: the projection is given the SAME deterministic cutoff
        the profile was built at, so `targetProvenanceTrusted` inside this
        fingerprint means "trusted AS OF the day this row is about" rather than
        "the timestamp parses". A pack saved after that day is `unknown` here,
        which is the state that closes the hard-action gate — so a retained
        verdict cannot keep an authority grant justified by evidence that did
        not exist when it was minted.
      */
      targetPack: projectCommercialTargetPackForIdentity(
        inputs.targetPack,
        deterministicCommercialCutoffMs(inputs.asOfDate),
      ),
      /*
        AND THE PROFILE CONFIG THROUGH THE SAME DOOR.

        `profileConfig` was digested RAW, and it carries
        `attributionAovAdjustmentMultiplier` — an account knob
        `resolveSpendUnit` pins to 1 on every rung and never writes into
        `SpendUnitEvidence`, precisely so it cannot reach a unit, a threshold,
        an eligibility or a verdict. Hashing the object whole put it into
        retention identity anyway, so typing the one setting the resolver
        deliberately ignores answered `retained_profile_input_mismatch` and
        discarded a verdict it could not have changed. The projection removes
        only that member, only when a Target ROAS governs.
      */
      profileConfig: projectProfileConfigForIdentity(
        inputs.profileConfig ?? null,
        inputs.targetPack,
      ),
      flags: {
        enabled: inputs.flags.enabled,
        surfaceVisible: inputs.flags.surfaceVisible,
        shadowOnly: inputs.flags.shadowOnly,
        presetOverride: inputs.flags.presetOverride,
      },
    }),
    sourceFingerprint: digest({
      ...scope,
      side: "measured",
      /*
        WHICH POPULATION THE MEASURED HALF WAS READ FROM, AND HOW, in the
        digest.

        Two readings can carry the same NUMBERS and still be different evidence.
        A sole-account business's pooled row and its own account scope hold
        identical values, and so does a runtime aggregate over the same rows —
        so without this the three would share a fingerprint and a reader could
        not tell which one a retained verdict rested on. Stamping the basis is
        also what makes each transitional answer end by itself: the first
        calibration run that writes this account's scope changes this value, the
        bootstrap verdict stops matching, and a new one is produced from the
        materialised reading.

        `measurementIdentityTag` keeps the two long-standing bases spelling
        exactly what they spelled before this field learned about the others, so
        a verdict retained on a materialised scope — or by an injected source
        that answers the reads itself — keeps the identity it already had.
      */
      measurementScope: measurementIdentityTag(
        accountProfileInputsMeasurementScope(inputs),
      ),
      accountCurrency: inputs.accountCurrency,
      calibration: {
        campaignKind: calibration.campaignKind ?? null,
        matureCreativeCount: calibration.matureCreativeCount,
        roasP75: calibration.roasP75,
        roasP60: calibration.roasP60,
        refreshRatioP10: calibration.refreshRatioP10,
        lowCtrP10: calibration.lowCtrP10,
        /*
          THE ACCOUNT'S OWN MEASURED CPA, PROJECTED.

          Kept while `resolveSpendUnit`'s governed branch could still fall
          through to the `account_history` rung, where it genuinely chose the
          unit. It cannot any more — that branch answers READY-or-`insufficient`
          — so under a governing Target ROAS a re-measured account CPA moves no
          verdict and must not move `source_fingerprint`, which is persisted and
          compared. Without a Target ROAS the rung is reachable and both fields
          key the digest exactly as before.
        */
        ...projectAccountCpaForIdentity(inputs.targetPack, {
          accountCpaP50: calibration.accountCpaP50,
          accountCpaSampleCount: calibration.accountCpaSampleCount,
        }),
        metaAttributedAovMean90d: calibration.metaAttributedAovMean90d,
        metaAttributedAovPurchaseCount90d:
          calibration.metaAttributedAovPurchaseCount90d,
        metaAttributedRevenue90d: calibration.metaAttributedRevenue90d,
        matureSpendP50: calibration.matureSpendP50,
        matureSpendP75: calibration.matureSpendP75,
        winnerSpendP25: calibration.winnerSpendP25,
        winnerSpendP50: calibration.winnerSpendP50,
        winnerPurchaseP50: calibration.winnerPurchaseP50,
        roasRatioP10: calibration.roasRatioP10,
        roasRatioP25: calibration.roasRatioP25,
        roasRatioP50: calibration.roasRatioP50,
        roasRatioP75: calibration.roasRatioP75,
        metaAovQuality: calibration.metaAovQuality,
      },
      funnelCalibration: inputs.funnelCalibration,
      /*
        `observedShopifyAov` IS DELIBERATELY ABSENT FROM THIS DIGEST.

        D091 makes the store's average order value contextual evidence and
        nothing else: `resolveSpendUnit` has no `observed_shopify_aov` rung, so
        no Shopify number can change `spendUnit`, `spendUnitSource`,
        `spendUnitConfidence`, the eligibility or the verdict. Digesting it
        anyway gave it authority through the back door — this half is persisted
        and compared, so a store-only change answered
        `retained_profile_source_mismatch` and discarded an unchanged Meta
        verdict. That is precisely the provenance mismatch D091 forbids.

        The measured half still moves on every measurement that CAN move the
        verdict: the calibration percentiles and sample counts above, the
        attributed AOV, the funnel calibration, the account currency and the
        measurement scope. The store's reading travels beside them as labelled
        diagnostic evidence in `spendUnitEvidence`, where a reader can see it
        change without it silently invalidating anything.
      */
    }),
  };
}

/**
 * The expectation a READER holds — recomputed from the same facts, with the
 * retained table untouched.
 *
 * `null` on an unreadable input, because an expectation nobody could compute is
 * not an agreement; `classifyRetainedProfile` answers
 * `profile_identity_agreement_unavailable` and the verdict stays review-only.
 *
 * `null` too in the two states {@link accountProfileMeasuredScopeHold} holds
 * on. The identity would be computable — it just would not be an EXPECTATION:
 * half of it would be a live aggregate that has moved since the verdict was
 * retained, so offering it would report a stale disagreement as a commercial
 * one. The producer refuses the same cases by name, so no verdict exists for
 * this expectation to be missing from. A business whose per-account scopes have
 * never been written is NOT one of those states: its facts are this account's
 * own rows, re-derived here by the same reads the producer made, and an
 * expectation is offered normally.
 */
export async function readAccountProfileRetentionIdentity(
  scope: AccountProfileRetentionScope,
): Promise<AccountProfileRetentionIdentity | null> {
  const inputs = await readAccountProfileRetentionInputs(scope);
  if (!inputs) return null;
  return accountProfileMeasuredScopeHold(inputs.measuredScope) === null
    ? accountProfileRetentionIdentity(inputs)
    : null;
}

/**
 * The data source the resolver runs against, with the four reads this module
 * already performed pinned to the values it digested.
 *
 * Without the pin the resolver would read the target pack and the calibration a
 * second time, and a write landing between the two reads would retain a verdict
 * whose stamped identity described a different reading of the account. Every
 * other method is the real warehouse reader, unchanged.
 */
class PinnedInputDataSource extends WarehouseDataSource {
  /**
   * The `providerAccountId` the pinned facts were READ with. Derived from the
   * same function the pinned reads used, never stored, so the unpinned reads
   * below cannot draw from a different population than the pinned ones.
   */
  private readonly measurementProviderAccountId: string | null;

  constructor(private readonly pinned: AccountProfileRetentionInputs) {
    super();
    this.measurementProviderAccountId =
      accountProfileInputsMeasurementScope(pinned).readProviderAccountId;
  }

  override async getBusinessTargetPack(): Promise<BusinessTargetPack | null> {
    return this.pinned.targetPack;
  }

  override async getDecisionCalibrationProfile(): Promise<DecisionCalibrationProfileConfig | null> {
    return this.pinned.profileConfig;
  }

  override async getAccountCalibration(): Promise<AccountCalibration> {
    return this.pinned.accountCalibration;
  }

  override async getAccountFunnelCalibration(): Promise<AccountFunnelCalibration> {
    return this.pinned.funnelCalibration;
  }

  /*
    THE READS THE RESOLVER MAKES THAT THIS MODULE DID NOT PIN.

    `resolveAccountDecisionProfile` does not stop at the two pinned readers: it
    also asks for the kind-segmented baselines and, when the pinned calibration
    carries no attributed AOV, for a LIVE one. Left alone those three run at
    the warehouse default — the whole business — so an account with no
    purchases of its own was handed a sibling's average order value and the
    canonical spend unit came out fully anchored on evidence this account does
    not have. Each is re-scoped exactly as the pinned reads above were scoped —
    `readProviderAccountId`, which names this account except where the pooled
    rows have been proven to BE this account's rows. Mixing the two would put
    one reading's calibration beside another reading's AOV in a single verdict.
    When the account genuinely has no purchases of its own, the answer is empty
    rather than borrowed.
  */
  override async getAccountCalibrationAllKinds(input: {
    businessId: string;
    asOf: string;
  }): Promise<Record<CalibrationCampaignKind, AccountCalibration | null>> {
    return super.getAccountCalibrationAllKinds({
      ...input,
      providerAccountId: this.measurementProviderAccountId,
    });
  }

  override async getAccountFunnelCalibrationAllKinds(input: {
    businessId: string;
    asOf: string;
  }): Promise<Record<CalibrationCampaignKind, AccountFunnelCalibration | null>> {
    return super.getAccountFunnelCalibrationAllKinds({
      ...input,
      providerAccountId: this.measurementProviderAccountId,
    });
  }

  override async getMetaAttributedAov(input: {
    businessId: string;
    asOf: string;
    windowDays?: number;
  }): Promise<MetaAttributedAovResult> {
    return super.getMetaAttributedAov({
      ...input,
      providerAccountId: this.measurementProviderAccountId,
    });
  }
}

export interface AccountProfileProductionResult {
  contract: typeof ACCOUNT_PROFILE_OUTPUT_PRODUCER_CONTRACT;
  produced: boolean;
  identity: AccountProfileRetentionIdentity | null;
  /** One entry per action the projector accepted and this call retained. */
  retained: readonly D086ProfileAction[];
  /** Why an action was not retained. The projector's own blockers, verbatim. */
  refusals: Record<string, readonly string[]>;
}

const UPSERT_ACCOUNT_PROFILE_OUTPUT_SQL = `
INSERT INTO engine_v3_account_profile_output (
  contract, profile_contract, business_id, provider_account_id, action,
  engine_epoch, engine_version, input_fingerprint, source_fingerprint,
  eligible, blocker_code, anchor_source, anchor_confidence, spend_unit,
  commercial_anchor_provenance, as_of_date, effective_at, recorded_at
)
VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, $8, $9,
  $10, $11, $12, $13, $14,
  $15, $16::date, $17::timestamptz, now()
)
ON CONFLICT (business_id, provider_account_id, action, engine_epoch, engine_version,
             input_fingerprint, source_fingerprint, as_of_date)
DO UPDATE SET recorded_at = now()
RETURNING action
`;

/**
 * Resolve the day's verdict for one account and retain it.
 *
 * The verdict is the resolver's. This function reads facts, hands them to
 * `resolveAccountDecisionProfile`, projects each of the three canonical actions
 * through `projectCanonicalProfileOutput`, and writes what the projector
 * accepted. A projector refusal is recorded by name and nothing is written for
 * that action: an action whose verdict could not be projected is ABSENT, which
 * every reader treats as review-only.
 *
 * A re-run for the same day and the same inputs updates `recorded_at` — the
 * verdict was re-observed — and leaves `effective_at` alone, because the day it
 * speaks for has not changed. A re-run after the inputs changed carries
 * different fingerprints and is therefore a different row, which is what makes
 * the identity the reader compares against meaningful.
 */
export async function produceRetainedAccountProfileOutputs(
  scope: AccountProfileRetentionScope,
  /** Already-read facts, so `ensure` does not read the account twice. */
  preRead?: AccountProfileRetentionInputs | null,
): Promise<AccountProfileProductionResult> {
  const refusals: Record<string, readonly string[]> = {};
  const empty = (): AccountProfileProductionResult => ({
    contract: ACCOUNT_PROFILE_OUTPUT_PRODUCER_CONTRACT,
    produced: false,
    identity: null,
    retained: [],
    refusals,
  });

  const inputs = preRead ?? (await readAccountProfileRetentionInputs(scope));
  if (!inputs) {
    refusals.retention_inputs_unreadable = ["the profile inputs could not be read"];
    return empty();
  }
  /*
    A verdict is only worth retaining if a later reader can re-derive the facts
    it was computed from. When the calibration pass has covered this business's
    OTHER accounts and not this one, half of this account's facts is a live
    aggregate and the other half is an empty pack that claims to be a
    measurement — so the row would be written, and then withheld at approval as
    though the account's commercial truth had moved. It is refused here instead,
    with the reason in the name; an unreadable probe refuses under its own,
    different name, because a read that failed is not the fact that a scope is
    missing.

    A business whose per-account scopes have never been written reaches neither
    refusal. That state says nothing about this account, and refusing it would
    withhold a verdict from every healthy account until a calibration run. Its
    measured facts are THIS ACCOUNT'S — the pooled precomputed row where that
    row was provably computed from this account's rows and nothing else, and
    this account's own runtime aggregate otherwise — so a verdict IS produced,
    and the serve path resolves the same population and shows the same one.
  */
  const scopeHold = accountProfileMeasuredScopeHold(inputs.measuredScope);
  if (scopeHold !== null) {
    refusals[scopeHold] = [
      `no retained calibration scope for ${scope.providerAccountId} on ${scope.asOfDate}`,
    ];
    return empty();
  }
  const identity = accountProfileRetentionIdentity(inputs);
  const nowIso = scope.nowIso ?? new Date().toISOString();

  let profile;
  try {
    profile = await resolveAccountDecisionProfile({
      businessId: scope.businessId,
      asOf: scope.asOfDate,
      dataSource: new PinnedInputDataSource(inputs),
      flags: inputs.flags,
      /*
        The store's evidence, only when it was proven usable. An unusable
        reading is passed as `null` rather than as a number with a caveat: the
        spend-unit resolver's next rung is the honest answer then.
      */
      observedShopifyAov: observedShopifyAovIsUsable(inputs.observedShopifyAov)
        ? inputs.observedShopifyAov
        : null,
    });
  } catch {
    refusals.profile_resolution_failed = ["the canonical resolver threw"];
    return { ...empty(), identity };
  }

  /*
    The capture cutoff is the write's own instant, and both clocks precede it.

    `projectCanonicalProfileOutput` refuses a verdict recorded at or after the
    cutoff, so the effective clock is the day this verdict speaks for and the
    recorded clock is a moment before now — never `now` itself, which the
    capture validator reads as a row from the future.
  */
  const effectiveAt = `${scope.asOfDate}T00:00:00.000Z`;
  const recordedAt = new Date(Date.parse(nowIso) - 1_000).toISOString();

  const retained: D086ProfileAction[] = [];
  for (const action of D086_PROFILE_ACTIONS) {
    const outcome = projectCanonicalProfileOutput(profile, action, {
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
      inputFingerprint: identity.inputFingerprint,
      sourceFingerprint: identity.sourceFingerprint,
      effectiveAt,
      recordedAt,
      cutoffIso: nowIso,
    });
    if (!outcome.retained) {
      refusals[`profile_projection_refused:${action}`] = outcome.blockers;
      continue;
    }
    const record: CanonicalProfileOutput = outcome.value;
    const written = (await getDb().query(UPSERT_ACCOUNT_PROFILE_OUTPUT_SQL, [
      record.contract,
      record.profileContract,
      record.businessId,
      record.providerAccountId,
      record.action,
      record.engineEpoch,
      record.engineVersion,
      record.inputFingerprint,
      record.sourceFingerprint,
      record.eligible,
      record.blockerCode,
      record.anchorSource,
      record.anchorConfidence,
      record.spendUnit,
      record.commercialAnchorProvenance,
      record.asOfDate,
      record.effectiveAt,
    ])) as Array<{ action?: string }>;
    if (written.length > 0) retained.push(action);
  }

  return {
    contract: ACCOUNT_PROFILE_OUTPUT_PRODUCER_CONTRACT,
    produced: retained.length > 0,
    identity,
    retained,
    refusals,
  };
}

/**
 * Materialise the day's verdict for this account if the facts it would rest on
 * are not already retained IN FULL, and hand the caller the identity to expect.
 *
 * WHY A READ-THROUGH STEP AND NOT A RECOMPUTE. The retained row is the account
 * DAY's verdict. It is produced once per day per set of inputs, and every later
 * reader — most importantly the approval and scheduled execution paths hours
 * afterwards, which never produce — reads that same row and re-checks it
 * against the inputs of the moment. That re-check is where the retention earns
 * its keep: a target ROAS edited after projection changes the identity, the
 * retained verdict no longer agrees, and the write is refused rather than
 * carried out on commercial truth nobody holds any more.
 *
 * The existence probe is keyed on the FULL identity, so an operator who changes
 * their targets at ten in the morning gets a new verdict for the same day
 * rather than being locked out of the rest of it. A day whose facts have not
 * moved costs one indexed probe of at most three rows and resolves nothing.
 *
 * `null` when the facts could not be read: no verdict is produced, no
 * expectation is offered, and the caller has to refuse.
 */
export async function ensureRetainedAccountProfileOutputs(
  scope: AccountProfileRetentionScope,
): Promise<AccountProfileRetentionIdentity | null> {
  const inputs = await readAccountProfileRetentionInputs(scope);
  if (!inputs) return null;
  // The same hold the producer applies, before anything is probed or written.
  if (accountProfileMeasuredScopeHold(inputs.measuredScope) !== null) return null;
  const identity = accountProfileRetentionIdentity(inputs);

  /*
    THE PROBE ASKS FOR THE COMPLETE ACTION SET, NOT FOR ANY ONE ROW.

    `produceRetainedAccountProfileOutputs` writes one statement per action in
    `D086_PROFILE_ACTIONS` and opens no transaction of its own, so when the
    `scale` upsert lands and a later one fails — a pool timeout, a dropped
    connection, the process going away between two of them — the `scale` row
    stays committed and the call throws with `cut` and `refresh` unwritten. A
    probe that returned on the FIRST row read that identity as materialised
    from then on: production was skipped on every later call,
    `budget-proposal-source-loader.ts` looked up the row for the exact action it
    was proposing, found none for `cut`, and
    `composeBudgetExecutionCandidate` refused the candidate with
    `profile_not_retained` — an eligible action withheld for the rest of that
    account-day, until the inputs moved and made a new identity to probe for.

    Requiring all three sends a partially retained identity back through
    production, which is what completes it: the upsert re-observes the rows that
    already exist (`ON CONFLICT ... DO UPDATE SET recorded_at = now()`) and
    writes the ones that do not. It is preferred here to making the loop atomic
    with `runDbTransaction`, for two reasons, and NOT for the "permanent" one an
    earlier draft gave. A partial set was never permanent: `runMetaSnapshotForBusiness`
    calls `produceRetainedAccountProfileOutputs` UNCONDITIONALLY — no probe — for
    every generation account on every snapshot run, so the next tick already
    healed it. What the old short-circuit actually cost was the window until that
    tick, during which every loader call skipped production and the missing
    action's proposals were withheld.

    The two reasons that do hold: a transaction would only stop NEW partial sets,
    leaving the ones already committed to wait for that tick; and a projector
    refusal leaves an action absent BY DESIGN, so "some rows exist" could never
    have meant "production finished". An identity whose set stays incomplete
    then costs one resolve per call — exactly what an identity with NO rows
    already cost.
    `action = ANY(...)` keeps the read on the identity's own unique index, so it
    stays one probe of at most three rows.
  */
  const existing = (await getDb()
    .query(
      `SELECT action
         FROM engine_v3_account_profile_output
        WHERE business_id = $1 AND provider_account_id = $2
          AND as_of_date = $3::date
          AND engine_epoch = $4 AND engine_version = $5
          AND input_fingerprint = $6 AND source_fingerprint = $7
          AND action = ANY($8::text[])`,
      [
        scope.businessId,
        scope.providerAccountId,
        scope.asOfDate,
        D086_PROFILE_IDENTITY.engineEpoch,
        D086_PROFILE_IDENTITY.engineVersion,
        identity.inputFingerprint,
        identity.sourceFingerprint,
        [...D086_PROFILE_ACTIONS],
      ],
    )
    .catch(() => null)) as Array<{ action?: string | null }> | null;
  // A probe that failed is UNKNOWN, and unknown produces nothing.
  if (existing === null) return null;
  const retained = new Set(existing.map((row) => row.action));
  if (D086_PROFILE_ACTIONS.every((action) => retained.has(action))) return identity;

  await produceRetainedAccountProfileOutputs(scope, inputs);
  return identity;
}
