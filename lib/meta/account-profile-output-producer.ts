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
 * warehouse which of the two it is holding and refuses BY NAME rather than
 * stamping a verdict that a later reader would silently withhold.
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

/** {@link AccountScopeCalibrationMaterialisation}, plus "nobody could ask". */
export type AccountProfileMeasuredScopeStatus =
  | AccountScopeCalibrationMaterialisation
  | "unprobed";

/**
 * The named hold a measured scope forces, or `null` when there is none.
 *
 * ONE PLACE, THREE CALLERS. The producer, the reader's expectation and the
 * read-through step all have to agree: a verdict that would be refused when it
 * is produced must not be offered as an expectation either, or the reader would
 * hold the identity of a verdict that was never retained.
 *
 * `materialised` and `unprobed` pass. Everything else is a hold with the reason
 * in its name, because "this account has never been measured" and "the measured
 * facts are an empty pack" are different answers and only the second one is a
 * measurement.
 */
export function accountProfileMeasuredScopeHold(
  status: AccountProfileMeasuredScopeStatus,
): string | null {
  if (status === "materialised" || status === "unprobed") return null;
  return status === "absent"
    ? "account_calibration_scope_not_materialised"
    : "account_calibration_scope_unreadable";
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
          MEASURED, so scoped to the account this verdict is FOR.

          Both readers default to the business's whole Meta footprint — the
          precomputed `scope_id '*'` row, and a runtime aggregate over every
          account the business owns. That default is right for a business-wide
          surface and wrong here: the row this produces is keyed on one
          `provider_account_id` and its fingerprints are what a later reader
          checks the verdict against, so a business-wide reading lets a
          SIBLING account's samples move this account's identity and hand it a
          calibration it has no evidence for. Passing the account makes the
          percentiles, the sample counts and the attributed AOV this account's
          own; an account with none of its own gets zeroes and holds by name,
          which is the honest answer.
        */
        dataSource.getAccountCalibration({
          businessId: scope.businessId,
          asOf: scope.asOfDate,
          providerAccountId: scope.providerAccountId,
        }),
        dataSource.getAccountFunnelCalibration({
          businessId: scope.businessId,
          asOf: scope.asOfDate,
          providerAccountId: scope.providerAccountId,
        }),
      ]);
    /*
      WHICH OF THE TWO EMPTY ANSWERS THIS IS.

      The two measured reads above cannot say. A scoped funnel read that finds
      no materialised scope returns a pack with no formats in it, which is
      byte-identical to the pack a genuinely empty account returns; and a scoped
      calibration read that finds none falls through to a runtime aggregate,
      which is this account's own numbers but recomputed on every read. Stamped
      into `sourceFingerprint`, the first is a constant that can never move and
      the second moves whenever this account's sync writes a row — so the
      verdict retained at projection stops agreeing with the reader's
      expectation hours later, and an account with plenty of evidence is
      withheld for a reason that has nothing to do with its evidence.

      So the warehouse is asked directly. A source that does not model the
      precomputed table has no answer to give and says nothing; the production
      source implements it.
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
 * `null` too when this account's own calibration scope has never been
 * materialised. The identity would be computable — it just would not be an
 * EXPECTATION: half of it would be a live aggregate that has moved since the
 * verdict was retained, so offering it would report a stale disagreement as a
 * commercial one. The producer refuses the same case by name, so no verdict
 * exists for this expectation to be missing from.
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
  constructor(private readonly pinned: AccountProfileRetentionInputs) {
    super();
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
    not have. Each is re-scoped to the account the verdict is for; when the
    account genuinely has none, the answer is empty rather than borrowed.
  */
  override async getAccountCalibrationAllKinds(input: {
    businessId: string;
    asOf: string;
  }): Promise<Record<CalibrationCampaignKind, AccountCalibration | null>> {
    return super.getAccountCalibrationAllKinds({
      ...input,
      providerAccountId: this.pinned.providerAccountId,
    });
  }

  override async getAccountFunnelCalibrationAllKinds(input: {
    businessId: string;
    asOf: string;
  }): Promise<Record<CalibrationCampaignKind, AccountFunnelCalibration | null>> {
    return super.getAccountFunnelCalibrationAllKinds({
      ...input,
      providerAccountId: this.pinned.providerAccountId,
    });
  }

  override async getMetaAttributedAov(input: {
    businessId: string;
    asOf: string;
    windowDays?: number;
  }): Promise<MetaAttributedAovResult> {
    return super.getMetaAttributedAov({
      ...input,
      providerAccountId: this.pinned.providerAccountId,
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
    it was computed from. When this account's own calibration scope has not been
    materialised, half of those facts is a live aggregate and the other half is
    an empty pack that claims to be a measurement — so the row would be written,
    and then withheld at approval as though the account's commercial truth had
    moved. It is refused here instead, with the reason in the name.
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
