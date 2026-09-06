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
 *   calibration the warehouse computed, the store's observed average order
 *   value evidence, and the account currency. A new day of sales changes this
 *   digest.
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
 * AND THE MEASURED SIDE HAS TO BE THE DAY'S RETAINED READING, NOT A LIVE ONE.
 * `lib/creative-decision-engine/jobs/calibration-job.ts` materialises one
 * calibration scope per selected ad account beside the pooled one, so a scoped
 * read is served from a row that is fixed for the day it speaks for — which is
 * what makes the identity below stable enough to be re-derived hours later.
 * When that scope has NOT been materialised the scoped readers still answer:
 * the funnel pack comes back empty and the calibration comes back from a
 * runtime aggregate recomputed on every read. Both are honest about this
 * account and neither is usable as an identity — an empty pack is
 * indistinguishable from a genuinely empty account, and a live aggregate moves
 * the moment the account's own sync writes a row. So this module asks the
 * warehouse which of the two it is holding, BEFORE it reads, and
 * `resolveAccountProfileMeasurementScope` turns the answer into a decision.
 *
 * A MISS HAS TWO CAUSES AND ONLY ONE OF THEM IS ABOUT THE ACCOUNT. When
 * sibling accounts of the same business have their own scopes and this one does
 * not, the pass covered the business and skipped this account: the refusal is
 * BY NAME and it says something true about the account. When NO account of the
 * business has one, the per-account dimension has never been written in this
 * warehouse — which is every business's state until the first run of the writer
 * that shipped in 058a1c8f6 — and refusing this account would say nothing about
 * this account while withholding a verdict the previous release served. In that
 * state the measured reads take their long-standing POOLED meaning, the
 * warehouse state they were read under is recorded in `measuredScope`, and the
 * identity below carries the population it implies — so nothing can read the
 * result as this account's own measurement, and the pooled verdict stops being
 * the latest one as soon as the pass writes this account's scope and a
 * differently-identified verdict is retained beside it.
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

import { getDb } from "@/lib/db";
import {
  WarehouseDataSource,
  type AccountScopeCalibrationMaterialisation,
  type BusinessTargetPack,
  type CreativeDecisionDataSource,
  type DecisionCalibrationProfileConfig,
} from "@/lib/creative-decision-engine/data-source";
import { resolveAccountDecisionProfile } from "@/lib/creative-decision-engine/account-decision-profile";
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
}

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
    "measuredScope" | "providerAccountId" | "asOfDate"
  >,
): AccountProfileMeasurementScope {
  return resolveAccountProfileMeasurementScope({
    status: inputs.measuredScope,
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
 * never written ANY per-account scope is answered from the pooled population
 * rather than refused.
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
  "meta.account-profile-measurement-scope.v1" as const;

/**
 * Which population one account's MEASURED facts are read from, why, and whether
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
 * THE DISTINCTION THAT FIXES IT, and it is derivable from the warehouse rather
 * than assumed. `readAccountScopeCalibrationMaterialisation` reports whether
 * ANY account-named scope exists for the business, not just this account's:
 *
 * - Sibling accounts have scopes and this one does not (`absent`). The pass
 *   covered the business and skipped this account — an account whose selection
 *   changed after the run, most commonly. That IS a fact about this account,
 *   its measured facts really are an empty pack beside a live aggregate, and
 *   the named hold is the honest answer.
 * - No account has one (`per_account_scopes_unwritten`). The per-account
 *   dimension does not exist in this warehouse at all, so refusing this account
 *   states nothing about this account. The previous release's answer here was
 *   the POOLED read, and continuing to serve it is not a regression. It is
 *   served as what it is: `scope: "business_pooled"`, with
 *   `providerAccountId: null`, so no reader can mistake it for this account's
 *   own measurement. It stops the moment the pass writes this account's scope,
 *   because the probe is re-run on every read and the retained identity carries
 *   the scope (see `accountProfileRetentionIdentity`).
 *
 * ON WHAT TERMS THE POOLED READ IS STABLE, stated rather than assumed. Where
 * the pass has written the business's `scope_id '*'` row — every business it
 * has ever covered — the pooled read is served from that row and is fixed for
 * the day. Where it has not, the pooled read falls through to the runtime
 * aggregate, exactly as the pooled read has ALWAYS done in that state; this
 * changes nothing about it, and the paragraph above on the two readings that
 * still come from the live aggregate covers it unchanged. What matters for the
 * contradiction this module exists to prevent is that the serve path and the
 * producer read the SAME population, and they do.
 *
 * The pooled reading is NOT an account-scoped answer wearing a different label.
 * On a multi-account business it really is the pooled population, which is why
 * it is named in every payload that carries it and why it lasts exactly one
 * calibration run.
 */
export interface AccountProfileMeasurementScope {
  contractVersion: typeof ACCOUNT_PROFILE_MEASUREMENT_SCOPE_CONTRACT;
  /** The warehouse fact this was decided from. */
  materialisation: AccountProfileMeasuredScopeStatus;
  /** Which population the measured reads draw from. */
  scope: "account" | "business_pooled";
  /** The account those reads name, or `null` for the business's footprint. */
  providerAccountId: string | null;
  /** {@link accountProfileMeasuredScopeHold} for this state. */
  hold: string | null;
  /** One sentence naming the state, for an operator rather than a log. */
  why: string;
}

export function resolveAccountProfileMeasurementScope(input: {
  status: AccountProfileMeasuredScopeStatus;
  providerAccountId: string;
  asOfDate: string;
}): AccountProfileMeasurementScope {
  const base = {
    contractVersion: ACCOUNT_PROFILE_MEASUREMENT_SCOPE_CONTRACT,
    materialisation: input.status,
    hold: accountProfileMeasuredScopeHold(input.status),
  } as const;
  if (input.status === "per_account_scopes_unwritten") {
    return {
      ...base,
      scope: "business_pooled",
      providerAccountId: null,
      why:
        `no ad account of this business has a calibration scope of its own on or before ${input.asOfDate}, `
        + "so the per-account dimension has never been written here; the measured facts below are the "
        + "business's whole Meta footprint pooled together, which is what the previous release read, and "
        + "they become this account's own on the next calibration run",
    };
  }
  if (input.status === "absent") {
    return {
      ...base,
      scope: "account",
      providerAccountId: input.providerAccountId,
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
    why:
      input.status === "materialised"
        ? `${input.providerAccountId} has its own retained calibration scope on or before ${input.asOfDate}, `
          + "so every measured fact below is this account's own"
        : "this data source does not model the precomputed calibration table, so the scope question could "
          + "not be put; the measured reads name this account and answer for it directly",
  };
}

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

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
      the reads rather than only judging them afterwards: when NO account of
      this business has a scope of its own, the pooled population is the one
      this verdict has always been computed from, on the same terms it always
      had. `resolveAccountProfileMeasurementScope` owns that decision and the
      serve path resolves its own data source from the same function, so the two
      cannot disagree. A source that does not model the precomputed table has no
      answer to give and says nothing; the production source implements it.
    */
    const measuredScope: AccountProfileMeasuredScopeStatus =
      dataSource.readAccountScopeCalibrationMaterialisation
        ? await dataSource.readAccountScopeCalibrationMaterialisation({
          businessId: scope.businessId,
          asOf: scope.asOfDate,
          providerAccountId: scope.providerAccountId,
        })
        : "unprobed";
    const measurement = resolveAccountProfileMeasurementScope({
      status: measuredScope,
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
          MEASURED, so scoped to the account this verdict is FOR — in every
          state but the one where no account of the business has a scope yet,
          where `measurement.providerAccountId` is null and both readers take
          their long-standing business-wide meaning.

          Both readers default to the business's whole Meta footprint — the
          precomputed `scope_id '*'` row, and a runtime aggregate over every
          account the business owns. That default is right for a business-wide
          surface and wrong for an account that HAS a scope of its own: the row
          this produces is keyed on one `provider_account_id` and its
          fingerprints are what a later reader checks the verdict against, so a
          business-wide reading would let a SIBLING account's samples move this
          account's identity and hand it a calibration it has no evidence for.
          Naming the account makes the percentiles, the sample counts and the
          attributed AOV this account's own; an account with none of its own
          gets zeroes, which is the honest answer.
        */
        dataSource.getAccountCalibration({
          businessId: scope.businessId,
          asOf: scope.asOfDate,
          providerAccountId: measurement.providerAccountId,
        }),
        dataSource.getAccountFunnelCalibration({
          businessId: scope.businessId,
          asOf: scope.asOfDate,
          providerAccountId: measurement.providerAccountId,
        }),
      ]);
    /*
      The store's evidence is consulted only when no configured unit exists,
      exactly as the snapshot's own benchmark resolution does it. ROAS stays
      the only required commercial target: a target CPA or an operator AOV
      short-circuits this read, and their absence is not a blocker.
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
      targetPack: inputs.targetPack
        ? {
          targetCpa: inputs.targetPack.targetCpa ?? null,
          targetRoas: inputs.targetPack.targetRoas ?? null,
          breakEvenCpa: inputs.targetPack.breakEvenCpa ?? null,
          breakEvenRoas: inputs.targetPack.breakEvenRoas ?? null,
          operatorAovAssumption: inputs.targetPack.operatorAovAssumption ?? null,
          defaultRiskPosture: inputs.targetPack.defaultRiskPosture ?? null,
          updatedAt: inputs.targetPack.updatedAt ?? null,
          freshness: inputs.targetPack.freshness ?? null,
        }
        : null,
      profileConfig: inputs.profileConfig ?? null,
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
        WHICH POPULATION THE MEASURED HALF WAS READ FROM, in the digest.

        A single-account business's pooled reading and its account-scoped
        reading are usually the same NUMBERS, so without this the two would
        share a fingerprint and a verdict computed from the business's pooled
        footprint would be indistinguishable from one computed from the
        account's own retained scope. They are different evidence and they get
        different identities. It is also what makes the transitional answer stop
        by itself: the first calibration run that writes this account's scope
        changes this value, so the pooled verdict no longer matches and a new
        one is produced from the account's own facts.
      */
      measurementScope: accountProfileInputsMeasurementScope(inputs).scope,
      accountCurrency: inputs.accountCurrency,
      calibration: {
        campaignKind: calibration.campaignKind ?? null,
        matureCreativeCount: calibration.matureCreativeCount,
        roasP75: calibration.roasP75,
        roasP60: calibration.roasP60,
        refreshRatioP10: calibration.refreshRatioP10,
        lowCtrP10: calibration.lowCtrP10,
        accountCpaP50: calibration.accountCpaP50,
        accountCpaSampleCount: calibration.accountCpaSampleCount,
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
      observedShopifyAov: inputs.observedShopifyAov
        ? {
          status: inputs.observedShopifyAov.status,
          window: inputs.observedShopifyAov.window,
          zoneName: inputs.observedShopifyAov.zoneName,
          orderCount: inputs.observedShopifyAov.orderCount,
          currency: inputs.observedShopifyAov.currency,
          currencyExponent: inputs.observedShopifyAov.currencyExponent,
          revenueMinor: inputs.observedShopifyAov.revenueMinor,
          aovMinor: inputs.observedShopifyAov.aovMinor,
          observedAt: inputs.observedShopifyAov.observedAt,
        }
        : null,
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
 * never been written is NOT one of those states: its facts are the pooled
 * reading, as re-derivable as they have always been, and an expectation is
 * offered normally.
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
  /** The population the pinned facts were read from. Derived, never stored. */
  private readonly measurementProviderAccountId: string | null;

  constructor(private readonly pinned: AccountProfileRetentionInputs) {
    super();
    this.measurementProviderAccountId =
      accountProfileInputsMeasurementScope(pinned).providerAccountId;
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
    not have. Each is re-scoped to the population the pinned facts above were
    read from — the account the verdict is for, or, while no account of the
    business has a scope of its own, the business's pooled footprint. Mixing the
    two would put a pooled calibration beside an account-scoped AOV in one
    verdict. When the account genuinely has none of its own, the answer is empty
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
    refusal. Its measured facts are the pooled reading — the same one the
    previous release computed this verdict from, re-derivable on exactly the
    terms it already had — so a verdict IS produced, and the serve path resolves
    the same population and shows the same one.
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
 * are not already retained, and hand the caller the identity to expect.
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
 * moved costs one indexed lookup and resolves nothing.
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

  const existing = (await getDb()
    .query(
      `SELECT 1 AS present
         FROM engine_v3_account_profile_output
        WHERE business_id = $1 AND provider_account_id = $2
          AND as_of_date = $3::date
          AND engine_epoch = $4 AND engine_version = $5
          AND input_fingerprint = $6 AND source_fingerprint = $7
        LIMIT 1`,
      [
        scope.businessId,
        scope.providerAccountId,
        scope.asOfDate,
        D086_PROFILE_IDENTITY.engineEpoch,
        D086_PROFILE_IDENTITY.engineVersion,
        identity.inputFingerprint,
        identity.sourceFingerprint,
      ],
    )
    .catch(() => null)) as Array<{ present?: number }> | null;
  // A probe that failed is UNKNOWN, and unknown produces nothing.
  if (existing === null) return null;
  if (existing.length > 0) return identity;

  await produceRetainedAccountProfileOutputs(scope, inputs);
  return identity;
}
