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
} from "@/lib/creative-decision-engine/types";
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
        dataSource.getAccountCalibration({
          businessId: scope.businessId,
          asOf: scope.asOfDate,
        }),
        dataSource.getAccountFunnelCalibration({
          businessId: scope.businessId,
          asOf: scope.asOfDate,
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
 */
export async function readAccountProfileRetentionIdentity(
  scope: AccountProfileRetentionScope,
): Promise<AccountProfileRetentionIdentity | null> {
  const inputs = await readAccountProfileRetentionInputs(scope);
  return inputs ? accountProfileRetentionIdentity(inputs) : null;
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
