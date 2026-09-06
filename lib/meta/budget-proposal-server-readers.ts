/**
 * D088 C1 — the REAL readers the budget runtime uses.
 *
 * Each one reads an existing seam: the shared current-observation statement,
 * the account context, the D087 journal, the existing control plane and release
 * gates, and the existing Meta read boundary. None of them invents a fact: when
 * a read cannot establish something, it returns `null`/`false` and the
 * composition root or the preflight refuses by name.
 *
 * These are the readers the approval route passes today. They are not a
 * placeholder — under current retained data and current controls they resolve
 * to "not available" and "gates closed", which is exactly the honest answer.
 */
import { getDb } from "@/lib/db";
import { getMetaAccountContext } from "@/lib/meta/account-context";
import {
  getMetaAutomationControlPlane,
  readEffectiveMetaWriteGovernance,
  type MetaAutomationDecisionTypeMode,
  type MetaAutomationGuardrails,
} from "@/lib/meta/automation-control-plane";
import { campaignContextAuthorityResolverVersion }
  from "@/lib/creative-decision-engine/campaign-context/source";
import type { WriteSafetyStep } from "@/lib/meta/write-safety-contract";
import type { BudgetWritePolicy } from "@/lib/meta/budget-write-preflight";
import { readMetaReleaseGates } from "@/lib/meta/release-gates";
import { readMetaEntityBudgetState } from "@/lib/meta/ads-write";
import type { MetaBudgetWriteContext } from "@/lib/meta/budget-proposal-write-context";
import {
  D086_STATE_BUDGET_SQL,
  D086_ACCOUNT_TIMEZONE_SQL,
  D086_COMPLETE_RUN_SQL,
  D086_PROFILE_LATEST_SQL,
  D086_PROFILE_MAX_AGE_MS,
  attestCompleteRun,
} from "@/lib/meta/budget-readiness-read-model";
import {
  classifyRetainedProfile,
  reconcileProfileIdentityExpectation,
  D086_COHORT_LANE,
  D086_COHORT_SCOPES,
  expectedProfileIdentity,
} from "@/lib/meta/budget-readiness-retention";
import { resolveCampaignRoleAuthority } from "@/lib/meta/campaign-role-authority";
import { decisionTypeForProposal }
  from "@/lib/meta/scheduled-action-execution";
import { isCampaignContextResolverAuthorityValidated }
  from "@/lib/creative-decision-engine/campaign-context/source";
import { declaredFamilyStatus } from "@/lib/meta/budget-write-safety-projection";
import { WRITE_SAFETY_STEPS } from "@/lib/meta/write-safety-contract";
import { CANONICAL_PROFILE_CONTRACT } from "@/lib/meta/budget-proposal-dry-run";
import { readAccountProfileRetentionIdentity } from "@/lib/meta/account-profile-output-producer";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import type { BudgetCompositionSources } from "@/lib/meta/budget-execution-composition";
import type { BudgetServerRuntimeReaders } from "@/lib/meta/budget-proposal-server-runtime";
import type { BudgetWriteDeps } from "@/lib/meta/budget-write-execution";
import {
  BUDGET_WRITE_JOURNAL_CONTRACT,
  type BudgetWriteJournal,
  type BudgetWriteJournalRow,
} from "@/lib/meta/budget-write-execution";
import { updateEntityBudget } from "@/lib/meta/ads-write";
import { randomUUID } from "node:crypto";
import { projectBudgetPolicySafety }
  from "@/lib/meta/budget-write-safety-projection";

/** The D087 journal, on its registered table. */
export function createBudgetWriteJournal(): BudgetWriteJournal {
  const sql = getDb();
  const map = (row: Record<string, unknown>): BudgetWriteJournalRow => ({
    id: String(row.id),
    contract: String(row.contract),
    proposalId: String(row.proposal_id),
    idempotencyKey: String(row.idempotency_key),
    requestFingerprint: String(row.request_fingerprint),
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    ownerGrain: row.owner_grain as BudgetWriteJournalRow["ownerGrain"],
    entityId: String(row.entity_id),
    parentCampaignId: row.parent_campaign_id === null ? null : String(row.parent_campaign_id),
    budgetField: row.budget_field as BudgetWriteJournalRow["budgetField"],
    currency: String(row.currency),
    currencyExponent: Number(row.currency_exponent),
    actorUserId: String(row.actor_user_id),
    beforeAmountMinor: row.before_amount_minor === null ? null : Number(row.before_amount_minor),
    intendedAmountMinor: Number(row.intended_amount_minor),
    readbackAmountMinor: row.readback_amount_minor === null
      ? null : Number(row.readback_amount_minor),
    providerAttempted: row.provider_attempted === true,
    providerHttpStatus: row.provider_http_status === null
      ? null : Number(row.provider_http_status),
    resultClass: row.result_class as BudgetWriteJournalRow["resultClass"],
    blockers: Array.isArray(row.blockers_json) ? (row.blockers_json as string[]) : [],
    rollbackEligible: row.rollback_eligible === true,
    rolledBackAt: row.rolled_back_at === null ? null : Date.parse(String(row.rolled_back_at)),
    requestedAtMs: Date.parse(String(row.requested_at)),
    completedAtMs: row.completed_at === null ? null : Date.parse(String(row.completed_at)),
  });

  return {
    async findByIdempotency(key, businessId, providerAccountId) {
      const rows = (await sql.query(
        `SELECT * FROM meta_budget_write_journal
          WHERE business_id=$1 AND provider_account_id=$2 AND idempotency_key=$3`,
        [businessId, providerAccountId, key],
      )) as Array<Record<string, unknown>>;
      return rows[0] ? map(rows[0]) : null;
    },
    async findById(id) {
      const rows = (await sql.query(
        `SELECT * FROM meta_budget_write_journal WHERE id=$1::uuid`, [id],
      )) as Array<Record<string, unknown>>;
      return rows[0] ? map(rows[0]) : null;
    },
    async open(row) {
      // The unique occurrence index is what makes a lost race a refusal.
      const rows = (await sql.query(
        `INSERT INTO meta_budget_write_journal (
           id, contract, proposal_id, idempotency_key, request_fingerprint,
           business_id, provider_account_id, owner_grain, entity_id,
           parent_campaign_id, budget_field, currency, currency_exponent,
           actor_user_id, before_amount_minor, intended_amount_minor,
           readback_amount_minor, provider_attempted, provider_http_status,
           result_class, blockers_json, rollback_eligible, requested_at, completed_at
         ) VALUES (
           $1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14::uuid, $15, $16, $17, $18, $19, $20, $21::jsonb, $22,
           to_timestamp($23 / 1000.0), CASE WHEN $24::bigint IS NULL THEN NULL
             ELSE to_timestamp($24 / 1000.0) END
         ) RETURNING *`,
        [
          row.id, row.contract, row.proposalId, row.idempotencyKey, row.requestFingerprint,
          row.businessId, row.providerAccountId, row.ownerGrain, row.entityId,
          row.parentCampaignId, row.budgetField, row.currency, row.currencyExponent,
          row.actorUserId, row.beforeAmountMinor, row.intendedAmountMinor,
          row.readbackAmountMinor, row.providerAttempted, row.providerHttpStatus,
          row.resultClass, JSON.stringify(row.blockers), row.rollbackEligible,
          row.requestedAtMs, row.completedAtMs,
        ],
      )) as Array<Record<string, unknown>>;
      if (!rows[0]) throw new Error("journal open returned no row");
      return map(rows[0]);
    },
    async complete(id, patch) {
      const rows = (await sql.query(
        `UPDATE meta_budget_write_journal SET
           provider_attempted = COALESCE($2, provider_attempted),
           provider_http_status = COALESCE($3, provider_http_status),
           result_class = COALESCE($4, result_class),
           readback_amount_minor = COALESCE($5, readback_amount_minor),
           before_amount_minor = COALESCE($6, before_amount_minor),
           blockers_json = COALESCE($7::jsonb, blockers_json),
           rollback_eligible = COALESCE($8, rollback_eligible),
           rolled_back_at = CASE WHEN $9::bigint IS NULL THEN rolled_back_at
             ELSE to_timestamp($9 / 1000.0) END,
           completed_at = CASE WHEN $10::bigint IS NULL THEN completed_at
             ELSE to_timestamp($10 / 1000.0) END
         WHERE id = $1::uuid RETURNING *`,
        [
          id, patch.providerAttempted ?? null, patch.providerHttpStatus ?? null,
          patch.resultClass ?? null, patch.readbackAmountMinor ?? null,
          patch.beforeAmountMinor ?? null,
          patch.blockers ? JSON.stringify(patch.blockers) : null,
          patch.rollbackEligible ?? null, patch.rolledBackAt ?? null,
          patch.completedAtMs ?? null,
        ],
      )) as Array<Record<string, unknown>>;
      if (!rows[0]) throw new Error("journal complete matched no row");
      return map(rows[0]);
    },
  };
}


/**
 * D088 C3 — the measured change history AND the prospective account share.
 *
 * One helper, used by the composition sources and by the D087 write deps, so
 * the number the preflight compares against and the number the surface reports
 * cannot disagree. It returns `null` whenever the population cannot be proven
 * complete: an unprovable denominator is not a small one.
 */
/**
 * The control row's own day, from a value the driver hands back as a Date.
 *
 * `MetaAutomationBusinessControl.updatedAt` is typed `string | null` and the
 * control plane assigns `row.updated_at` straight from the query, which the
 * Postgres driver returns as a `Date` for a `timestamptz`. Calling `.slice` on
 * it threw inside a reader whose failures degrade to "sources unavailable", so
 * the crash looked like an absent fact. Nothing here invents a day: an
 * unparseable clock stays `null`.
 */
function controlUpdatedDay(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? value.toISOString().slice(0, 10) : null;
  }
  return typeof value === "string" && value.length >= 10
    ? value.slice(0, 10) : null;
}

/**
 * A retained TIMESTAMPTZ, as the strict classifier expects to receive it.
 *
 * `classifyRetainedProfile` reads clocks with an ISO-instant regex, and the
 * Postgres driver hands a `timestamptz` column back as a `Date` — so a
 * perfectly good retained verdict was answered
 * `retained_profile_recorded_malformed` and every budget candidate refused.
 * `as_of_date` is already cast to text in the statement itself; these two are
 * not, and casting them there would change a shared read model. Anything that
 * is neither a Date nor a string is passed through untouched, so a genuinely
 * malformed clock is still refused by name.
 */
function retainedInstant(value: unknown): unknown {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  return value ?? null;
}

export async function readMeasuredBudgetHistory(input: {
  businessId: string;
  providerAccountId: string;
  entityGrain: "campaign" | "adset";
  entityId: string;
  intendedAmountMinor: number;
  nowMs: number;
}): Promise<{
  lastChangeAtMs: number | null;
  changesInLast7d: number;
  accountConcentrationPercent: number;
} | null> {
  if (!input.entityId || !(input.intendedAmountMinor > 0)
    || !Number.isFinite(input.nowMs)) return null;
  const nowIso = new Date(input.nowMs).toISOString();
  const db = getDb();
  const attestationRows = (await db.query(
    D086_COMPLETE_RUN_SQL,
    [input.businessId, input.providerAccountId, nowIso,
      D086_COHORT_LANE, [...D086_COHORT_SCOPES]],
  ).catch(() => null)) as Array<Record<string, unknown>> | null;
  if (attestationRows === null) return null;
  const attestation = attestCompleteRun(attestationRows);
  if (!attestation.attested) return null;

  const population = (await getDb().query(
    `WITH latest AS (
       SELECT DISTINCT ON (entity_type, entity_id)
              entity_type, entity_id, presence, budget_origin,
              campaign_daily_budget_raw, campaign_lifetime_budget_raw,
              adset_daily_budget_raw, adset_lifetime_budget_raw
         FROM meta_entity_state_history
        WHERE business_id = $1 AND provider_account_id = $2
          AND entity_type IN ('campaign', 'adset')
          AND captured_at <= $5::timestamptz
        ORDER BY entity_type, entity_id, observed_at DESC, captured_at DESC,
                 created_at DESC, id DESC
     ), present AS (
       SELECT * FROM latest WHERE presence = 'present'
     ), owners AS (
       SELECT entity_type, entity_id,
              ((campaign_daily_budget_raw IS NOT NULL AND campaign_daily_budget_raw <> '')::int
               + (campaign_lifetime_budget_raw IS NOT NULL AND campaign_lifetime_budget_raw <> '')::int
               + (adset_daily_budget_raw IS NOT NULL AND adset_daily_budget_raw <> '')::int
               + (adset_lifetime_budget_raw IS NOT NULL AND adset_lifetime_budget_raw <> '')::int)
                AS owned_field_count,
              COALESCE(
                NULLIF(campaign_daily_budget_raw, '')::numeric,
                NULLIF(campaign_lifetime_budget_raw, '')::numeric,
                NULLIF(adset_daily_budget_raw, '')::numeric,
                NULLIF(adset_lifetime_budget_raw, '')::numeric
              ) AS owned_minor
         FROM present
        WHERE budget_origin IN ('campaign', 'adset')
     )
     SELECT count(*)::int AS owner_rows,
            count(*) FILTER (
              WHERE owned_minor IS NULL OR owned_minor <= 0 OR owned_field_count <> 1
            )::int AS unpriced_rows,
            sum(owned_minor) AS total_minor,
            sum(owned_minor) FILTER (
              WHERE entity_type = $4 AND entity_id = $3
            ) AS subject_minor,
            max(owned_minor) FILTER (
              WHERE NOT (entity_type = $4 AND entity_id = $3)
            ) AS max_other_minor,
            (SELECT count(*) FROM present
              WHERE budget_origin IS NULL
                 OR budget_origin NOT IN ('campaign', 'adset', 'not_applicable'))::int
              AS unknown_origin_rows,
            (SELECT jsonb_agg(entity_type || ':' || entity_id
                              ORDER BY entity_type, entity_id)
               FROM present) AS present_identities
       FROM owners`,
    [input.businessId, input.providerAccountId, input.entityId,
      input.entityGrain, nowIso],
  ).catch(() => null)) as Array<{
    owner_rows: number; unpriced_rows: number;
    total_minor: string | null; subject_minor: string | null;
    max_other_minor: string | null;
    unknown_origin_rows: number;
    present_identities: unknown;
  }> | null;
  const changes = (await getDb().query(
    `SELECT max(extract(epoch from requested_at) * 1000)::bigint AS last_change_ms,
            count(*) FILTER (
              WHERE requested_at > $4::timestamptz - interval '7 days'
                AND requested_at <= $4::timestamptz
            )::int AS in_7d
       FROM meta_budget_write_journal
      WHERE business_id = $1 AND provider_account_id = $2
        AND entity_id = $3 AND result_class = 'verified'
        AND requested_at <= $4::timestamptz`,
    [input.businessId, input.providerAccountId, input.entityId, nowIso],
  ).catch(() => null)) as Array<{
    last_change_ms: string | null; in_7d: number;
  }> | null;
  if (population === null || changes === null) return null;
  const row = population[0];
  const expectedIdentities = [
    ...(attestation.runs.campaign?.memberIds ?? []).map((id) => `campaign:${id}`),
    ...(attestation.runs.adset?.memberIds ?? []).map((id) => `adset:${id}`),
  ].sort();
  const actualIdentities = Array.isArray(row?.present_identities)
    ? row.present_identities.filter((id): id is string => typeof id === "string").sort()
    : null;
  if (!row || actualIdentities === null
    || actualIdentities.length !== expectedIdentities.length
    || actualIdentities.some((id, index) => id !== expectedIdentities[index])
    || Number(row.unknown_origin_rows) !== 0
    || Number(row.owner_rows) <= 0 || Number(row.unpriced_rows) !== 0) return null;
  const total = row.total_minor === null ? Number.NaN : Number(row.total_minor);
  if (!Number.isFinite(total) || total <= 0) return null;
  const subject = row.subject_minor === null ? Number.NaN : Number(row.subject_minor);
  if (!Number.isFinite(subject) || subject <= 0) return null;
  const maxOther = row.max_other_minor === null ? 0 : Number(row.max_other_minor);
  if (!Number.isFinite(maxOther) || maxOther < 0) return null;
  // PROSPECTIVE: the proposed target replaces the subject in both terms.
  const prospectiveTotal = total - subject + input.intendedAmountMinor;
  if (!(prospectiveTotal > 0)) return null;
  const prospectiveLargestOwner = Math.max(input.intendedAmountMinor, maxOther);
  return {
    lastChangeAtMs: changes[0]?.last_change_ms === null
      || changes[0]?.last_change_ms === undefined
      ? null : Number(changes[0].last_change_ms),
    changesInLast7d: Number(changes[0]?.in_7d ?? 0),
    accountConcentrationPercent: (prospectiveLargestOwner / prospectiveTotal) * 100,
  };
}

export interface BudgetServerReadersInput {
  businessId: string;
  actorUserId: string;
  /**
   * Built by the caller from the existing credential boundary, or null.
   *
   * PR #272 review: the BUDGET refinement, so the account's verified currency
   * travels with the credential rather than being taken from a request.
   */
  writeContext: MetaBudgetWriteContext | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * The readers the route hands to the runtime.
 *
 * `loadCompositionSources` returns `null` the moment a fact is unavailable —
 * which is what happens today for every account, because no retained decision
 * carries a typed budget intent and no proposal carries an envelope.
 */
export function createBudgetServerReaders(
  input: BudgetServerReadersInput,
): BudgetServerRuntimeReaders {
  return {
    async readGates({ proposal }) {
      /*
        D088 C2: the FULL posture, from the persisted control plane.

        C1 read the global gate and one column and called that "gates open". The
        budget decision mode, the business STOP, the dry-run guardrail and the
        control row's own provenance are all conditions of a budget write, and a
        read that fails must close the gate rather than default it open.
      */
      const gates = readMetaReleaseGates(input.env ?? process.env);
      const control = await getMetaAutomationControlPlane({
        businessId: proposal.businessId,
        providerAccountId: proposal.providerAccountId,
      }).catch(() => null);
      if (!control) {
        return {
          releaseGateOpen: false, autoExecutionEnabled: false, dryRunOnly: true,
          enablingActorUserId: null, enabledProviderAccountId: null,
          activationControlVersion: null,
          dailyAutoActionCap: null,
        };
      }
      /*
        D088 C3: activation is EXACT-ACCOUNT, and it names the admin who
        persisted it. One account's typed confirmation must not enable another,
        and a scheduled execution with no enabling actor has no authority to
        act under.
      */
      const activation = (await getDb().query(
        `SELECT controls.auto_execution_provider_account_id,
                controls.updated_at::text AS activation_control_version,
                CASE WHEN EXISTS (
                  SELECT 1 FROM memberships m
                   WHERE m.user_id = controls.auto_execution_enabled_by
                     AND m.business_id = controls.business_id
                     AND m.role = 'admin'
                     AND m.status = 'active'
                ) THEN controls.auto_execution_enabled_by::text
                  ELSE NULL END AS enabling_actor_user_id
           FROM meta_automation_business_controls controls
          WHERE controls.business_id = $1::uuid`,
        [proposal.businessId],
      ).catch(() => null)) as Array<{
        auto_execution_provider_account_id: string | null;
        enabling_actor_user_id: string | null;
        activation_control_version: string | null;
      }> | null;
      /*
        The standing mode of THIS row's family, not always the budget one.

        These readers were written when `budget` was the only action the sweep
        could take, so the family was a literal. It is now the queue's whole
        vocabulary: an operator who set the pause family to auto and left budget
        manual would otherwise have every pause refused as
        `auto_execution_disabled` — a sentence about a decision they never made.
        For a budget row this resolves to `budget` exactly as before.

        It is resolved from the whole row rather than from the verb, because a
        `resume` row that turns on what a launch created belongs to the creative
        family and nothing but its launch lineage says so. This is the one place
        `autoExecutionEnabled` below learns which mode to consult, so reading the
        verb here would let an operator who armed unattended pausing dispatch an
        activation they never armed.
      */
      const standingMode = control.decisionTypeModes
        .find(
          (mode: MetaAutomationDecisionTypeMode) =>
            mode.decisionType === decisionTypeForProposal(proposal),
        )
        ?.mode ?? null;
      const persisted = control.businessControl.source === "persisted";
      return {
        releaseGateOpen:
          gates.automationLiveWrites === true
          && control.globalKillSwitch.engaged === false
          && control.businessControl.killSwitchEngaged === false
          && control.execution.writeEndpointsBlocked === false,
        /*
          PRE-DEPLOY AUDIT: a READ-ONLY business is never swept.

          The manual approval route refuses any business whose readiness tier
          is not `manual_review`; the unattended path read no tier at all, so a
          business deliberately placed in `read_only` — the tier whose whole
          meaning is "do not write here" — was still eligible for a scheduled
          budget write. Refusing that tier is a tightening only: it cannot
          enable anything, and `manual_review` (the schema default and every
          current row) is unaffected.
        */
        autoExecutionEnabled:
          persisted
          && control.businessControl.autoExecutionEnabled === true
          && control.businessControl.readinessTier !== "read_only"
          && standingMode === "auto",
        // The PERSISTED guardrail, not a restatement of the global gate.
        dryRunOnly: control.businessControl.guardrails.dryRunOnly !== false,
        enablingActorUserId: activation?.[0]?.enabling_actor_user_id ?? null,
        enabledProviderAccountId:
          activation?.[0]?.auto_execution_provider_account_id ?? null,
        activationControlVersion:
          activation?.[0]?.activation_control_version ?? null,
        dailyAutoActionCap: control.businessControl.guardrails.dailyAutoActionCap,
      };
    },

    async loadCompositionSources({ proposal, claimToken, explicitlyApproved }) {
      const envelope = proposal.budgetEnvelope;
      if (!envelope || !input.writeContext) return null;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      /*
        D088 C2: every value below is READ. C1 invented the role from a non-null
        `recId`, the profile from a non-null engine version, the concentration
        from nothing, and declared every safety flag clear. A read that fails is
        `null`/`unknown` here, and the composition root or the preflight refuses
        by name.
      */

      /*
        D088 C3 — the CANONICAL role resolver, over the exact campaign.

        C2 read one row and asserted `confidence: "high"`, today's as-of and
        `satisfiesRoleAuthority: true`. The resolver owns those judgements: it
        weighs the retained source, the confidence class, the evidence age, the
        account scope and the approved resolver version, and returns blockers
        when any of them fails.
      */
      const roleCampaignId = envelope.ownerGrain === "campaign"
        ? envelope.entityId : envelope.parentCampaignId;
      if (!roleCampaignId) return null;
      const roleEvidence = (await getDb().query(
        `SELECT business_id, provider_account_id, campaign_id, as_of_date::text AS as_of_date,
                inferred_kind, kind_source, confidence_class, resolver_version
           FROM engine_v3_campaign_role_authority
          WHERE business_id = $1 AND campaign_id = $2
          ORDER BY as_of_date DESC, recorded_at DESC
          LIMIT 25`,
        [proposal.businessId, roleCampaignId],
      ).catch(() => null)) as Array<Record<string, unknown>> | null;
      if (roleEvidence === null) return null;
      const roleResolution = resolveCampaignRoleAuthority({
        request: {
          businessId: proposal.businessId,
          providerAccountId: proposal.providerAccountId,
          campaignId: roleCampaignId,
          asOfDate: nowIso.slice(0, 10),
          maxEvidenceAgeDays: 60,
        },
        evidence: roleEvidence.map((row) => ({
          businessId: String(row.business_id),
          providerAccountId: row.provider_account_id === null
            ? null : String(row.provider_account_id),
          campaignId: String(row.campaign_id),
          asOfDate: String(row.as_of_date),
          inferredKind: row.inferred_kind === null ? null : String(row.inferred_kind),
          kindSource: row.kind_source === null ? null : String(row.kind_source),
          confidenceClass: row.confidence_class === null
            ? null : String(row.confidence_class),
          resolverVersion: row.resolver_version === null
            ? null : String(row.resolver_version),
        })) as never,
        identities: [{
          businessId: proposal.businessId,
          providerAccountId: proposal.providerAccountId,
          campaignId: roleCampaignId,
        }] as never,
        isResolverVersionValidated: isCampaignContextResolverAuthorityValidated,
      });

      /*
        The EXACT action row, classified by its own canonical classifier. An
        aggregate "retention is ready" verdict is not a commercial eligibility
        for THIS action on THIS account.
      */
      const profileAction = envelope.intentVerb === "increase_budget" ? "scale" : "cut";
      /*
        The expectation, RE-DERIVED at execution time and never produced here.

        This path only ever reads. The verdict it needs was retained when the
        proposal was projected; what execution has to establish is that the
        verdict still describes this account — so the identity is re-derived
        from the commercial-truth and calibration readers now. A target ROAS
        edited between projection and approval moves that identity, the retained
        verdict stops agreeing, and the write is withheld. A verdict that was
        never produced is simply absent, and absent is review-only.
      */
      const retainedInputIdentity = await readAccountProfileRetentionIdentity({
        businessId: proposal.businessId,
        providerAccountId: proposal.providerAccountId,
        asOfDate: envelope.snapshotDate,
      }).catch(() => null);
      const profileRows = (await getDb().query(
        D086_PROFILE_LATEST_SQL,
        [proposal.businessId, proposal.providerAccountId],
      ).catch(() => null)) as Array<Record<string, unknown>> | null;
      if (profileRows === null) return null;
      const profileRow = profileRows.find((row) => row.action === profileAction) ?? null;
      const profileVerdict = profileRow
        ? classifyRetainedProfile(
          {
            contract: profileRow.contract ?? null,
            profileContract: profileRow.profile_contract ?? null,
            businessId: profileRow.business_id ?? null,
            providerAccountId: profileRow.provider_account_id ?? null,
            action: profileRow.action ?? null,
            engineEpoch: profileRow.engine_epoch ?? null,
            engineVersion: profileRow.engine_version ?? null,
            inputFingerprint: profileRow.input_fingerprint ?? null,
            sourceFingerprint: profileRow.source_fingerprint ?? null,
            eligible: profileRow.eligible ?? null,
            blockerCode: profileRow.blocker_code ?? null,
            asOfDate: profileRow.as_of_date ?? null,
            effectiveAt: retainedInstant(profileRow.effective_at),
            recordedAt: retainedInstant(profileRow.recorded_at),
          },
          {
            /* The decision's own expectation where the row carries one, and
               the identity of the inputs retained now. Both must agree. */
            ...reconcileProfileIdentityExpectation(
              expectedProfileIdentity(
                (proposal.evidenceRef as { evidence?: unknown } | null)?.evidence,
              ),
              retainedInputIdentity,
            ),
            nowIso, maxAgeMs: D086_PROFILE_MAX_AGE_MS,
          },
        )
        : null;
      /*
        Trusted and eligible are different claims. A well-formed retained
        verdict that says `eligible: false` with a canonical blocker code on it
        is trustworthy AND is a refusal; reporting the classifier's trust as the
        commercial verdict would have executed a write the engine withheld.
      */
      const profileTrusted = profileVerdict?.usable === true;
      const profileEligible = profileTrusted && profileRow?.eligible === true;
      const profileBlockerCode = profileTrusted && profileRow?.eligible === false
        && typeof profileRow.blocker_code === "string"
        ? profileRow.blocker_code
        : profileVerdict?.reason ?? null;

      const control = await getMetaAutomationControlPlane({
        businessId: proposal.businessId,
        providerAccountId: proposal.providerAccountId,
      }).catch(() => null);

      const observations = (await getDb().query(
        D086_STATE_BUDGET_SQL,
        [proposal.businessId, proposal.providerAccountId, nowIso, 500],
      ).catch(() => null)) as Array<Record<string, unknown>> | null;
      const zoneRows = (await getDb().query(
        D086_ACCOUNT_TIMEZONE_SQL, [proposal.businessId, proposal.providerAccountId],
      ).catch(() => null)) as Array<{ account_timezone?: string | null }> | null;

      // The measured history and the prospective share, from one helper.
      const history = await readMeasuredBudgetHistory({
        businessId: proposal.businessId,
        providerAccountId: proposal.providerAccountId,
        entityGrain: envelope.ownerGrain,
        entityId: envelope.entityId,
        intendedAmountMinor: envelope.intendedAmountMinor,
        nowMs,
      });

      const baseline = await readMetaEntityBudgetState(input.writeContext, {
        entityId: envelope.entityId,
        budgetField: envelope.budgetField,
        accountCurrency: input.writeContext.accountCurrency,
      }).catch(() => ({ ok: false as const, reason: "read_failed" }));

      // A failed read is UNKNOWN, and unknown blocks.
      if (observations === null || zoneRows === null || !control) {
        return null;
      }

      /*
        THE KNOWLEDGE INSTANT, TAKEN AFTER EVERY READ — not before them.

        It travels into the composition as the point-in-time knowledge cutoff
        and as the preflight's evaluation instant, and the provider baseline is
        read above, many awaits after this reader started. Stamping it at entry
        dated the account's own fresh read after the moment the proposal claims
        to know anything, and D085 refused with `capture_after_knowledge_cutoff`
        and a contradictory preflight summary. The queries above keep the entry
        cutoff, so evidence is read as of the earlier instant and knowledge is
        as of the later one.
      */
      const knowledgeMs = Math.max(
        nowMs, baseline.ok ? baseline.readAtMs : 0, Date.now(),
      );
      const guardrails = control.businessControl.guardrails;
      const policySafety = projectBudgetPolicySafety({
        currentAmountMinor: baseline.ok ? baseline.amountMinor : null,
        intendedAmountMinor: envelope.intendedAmountMinor,
        nowMs,
        policy: {
          maxChangePercent: guardrails.maxBudgetIncreasePct,
          minHoursBetweenChanges: guardrails.budgetMinHoursBetweenChanges,
          maxChangesPer7d: guardrails.budgetMaxChangesPer7d,
          maxAccountConcentrationPercent: guardrails.budgetMaxAccountConcentrationPct,
          maxAmountMinor: guardrails.perActionSpendCeilingMinor,
          currency: guardrails.perActionSpendCeilingCurrency,
          spendCeilingValid: guardrails.perActionSpendCeilingValid,
        },
        currency: baseline.ok ? baseline.currency : null,
        history,
      });
      const flagFor = (clear: boolean, why: string) => ({
        state: clear ? ("clear" as const) : ("unknown" as const),
        source: "meta_automation_business_controls",
        asOf: controlUpdatedDay(control.businessControl.updatedAt),
        why,
      });

      const sources: Omit<BudgetCompositionSources, "proposalId" | "claimToken"> = {
        businessId: proposal.businessId,
        providerAccountId: proposal.providerAccountId,
        ownerGrain: envelope.ownerGrain,
        entityId: envelope.entityId,
        parentCampaignId: envelope.parentCampaignId,
        actorUserId: input.actorUserId,
        observations,
        accountTimeZone: zoneRows[0]?.account_timezone ?? null,
        intent: {
          verb: envelope.intentVerb,
          intendedAmountMinor: envelope.intendedAmountMinor,
          percent: envelope.currentAmountMinor > 0
            ? Math.abs((envelope.intendedAmountMinor - envelope.currentAmountMinor)
              / envelope.currentAmountMinor) * 100
            : null,
        },
        // The RESOLVER's verdict, or nothing at all.
        role: roleResolution.satisfiesRoleAuthority && roleResolution.role
          ? {
            kind: roleResolution.role,
            source: "automatic",
            resolverVersion: campaignContextAuthorityResolverVersion(),
            confidence: roleResolution.confidence,
            asOf: roleResolution.provenance.evidenceAsOf,
            accountScoped: roleResolution.provenance.accountScope !== "absent",
            satisfiesRoleAuthority: roleResolution.satisfiesRoleAuthority,
            producer: roleResolution.provenance.producer,
            authorityBlockers: roleResolution.blockers,
          }
          : null,
        // The EXACT action row's own classification.
        profileRetained: profileEligible,
        // `null` when the population could not be proven. Unknown blocks.
        changeHistory: history,
        /* The goal of the EXACT ad set being changed. `observations[0]` is
         * merely the first row the account read returned. */
        optimizationGoal: typeof (observations ?? []).find((o) => o.grain === envelope.ownerGrain && String(o.entity_id) === envelope.entityId)?.optimization_goal === "string"
          ? ((observations ?? []).find((o) => o.grain === envelope.ownerGrain && String(o.entity_id) === envelope.entityId)?.optimization_goal as string) : null,
        providerBaseline: baseline.ok
          ? {
            entityId: baseline.entityId,
            providerAccountId: baseline.providerAccountId,
            budgetField: baseline.budgetField,
            amountMinor: baseline.amountMinor,
            currency: baseline.currency,
            readAtMs: baseline.readAtMs,
          }
          : null,
        nowMs: knowledgeMs,
        /*
          Safety is READ from the persisted posture. `clear` means the control
          plane says so; anything a control row does not establish is `unknown`,
          which D085 treats as unverified rather than as permission.
        */
        safety: {
          killSwitch: flagFor(
            control.globalKillSwitch.engaged === false
            && control.businessControl.killSwitchEngaged === false,
            "global and business kill switches",
          ),
          admission: flagFor(
            control.businessControl.source === "persisted"
            && control.execution.writeEndpointsBlocked === false,
            "persisted control row and write-endpoint posture",
          ),
          cap: policySafety.cap,
          cooldown: policySafety.cooldown,
          conflict: flagFor(
            /* THIS attempt's claim, not the row's copy from before it was
               taken. The manual route reads the row, then claims it. */
            typeof claimToken === "string" && claimToken.trim() !== "",
            "this attempt holds the exclusive execution claim",
          ),
        },
        /*
          Write-safety steps are SATISFIED only where the persisted guardrail
          says the requirement is met; everything else is `missing`, because an
          unmet requirement and an unread one are both "not satisfied".
        */
        writeSafety: Object.fromEntries(WRITE_SAFETY_STEPS.map((step) => [
          step,
          writeSafetyStatus(step, {
            guardrails,
            roleReady: roleResolution.satisfiesRoleAuthority,
            profileReady: profileEligible,
            baselineFresh: baseline.ok,
            killSwitchClear: control.globalKillSwitch.engaged === false
              && control.businessControl.killSwitchEngaged === false,
            /* The authorization THIS attempt carries, decided by the runtime
               above: an operator's confirmation, or the account-bound
               automatic enablement. */
            explicitlyApproved: explicitlyApproved === true,
            claimHeld: typeof claimToken === "string" && claimToken.trim() !== "",
          }),
        ])),
        commercial: {
          profileContractVersion: CANONICAL_PROFILE_CONTRACT,
          businessId: proposal.businessId,
          providerAccountId: proposal.providerAccountId,
          // `resolved` only when the retained verdict is trusted AND eligible.
          sourceStatus: profileEligible ? "resolved" : "unavailable",
          selectedAction: profileAction,
          eligible: profileEligible ? true : null,
          code: profileBlockerCode,
          reason: profileBlockerCode,
          blockerCodes: profileBlockerCode ? [profileBlockerCode] : [],
          evidenceFloorsClear: profileEligible,
          changeSafetyClear: roleResolution.satisfiesRoleAuthority,
        },
        /*
          D088 C3: the DECISION's own identity.

          C2 used `envelope.fingerprint` — a hash of the envelope this server
          built — as the decision hash, and the approval/creation clock as the
          decision clock. Both described the proposal, not the decision it came
          from, so a re-projection of the same decision produced a different
          "decision hash" and an approval an hour later moved the "decision
          time". Both are carried on the envelope, server-owned and canonical,
          and re-checked when the row is read.
        */
        decision: {
          id: proposal.recId,
          hash: envelope.decisionHash,
          version: envelope.engineVersion,
          decidedAt: envelope.decisionAt,
          maxAgeSeconds: 86_400,
        },
        casBaseline: null,
        preflight: null,
        preflightEvidence: null,
        rawIntent: null,
      };
      return sources;
    },

    async writeDeps({ proposal, claimToken, providerWriteAuthorized }) {
      const governance = await readEffectiveMetaWriteGovernance({
        businessId: proposal.businessId,
      }).catch(() => null);
      const accountContext = await getMetaAccountContext(proposal.businessId).catch(() => null);
      const control = await getMetaAutomationControlPlane({
        businessId: proposal.businessId,
        providerAccountId: proposal.providerAccountId,
      }).catch(() => null);
      const verified = await this.readGates({ proposal });
      const measured = await readMeasuredBudgetHistory({
        businessId: proposal.businessId,
        providerAccountId: proposal.providerAccountId,
        entityGrain: proposal.budgetEnvelope?.ownerGrain ?? "campaign",
        entityId: proposal.budgetEnvelope?.entityId ?? "",
        intendedAmountMinor: proposal.budgetEnvelope?.intendedAmountMinor ?? 0,
        nowMs: Date.now(),
      });

      const deps: BudgetWriteDeps = {
        journal: createBudgetWriteJournal(),
        nowMs: () => Date.now(),
        newId: () => randomUUID(),
        actor: {
          userId: input.actorUserId,
          businessId: proposal.businessId,
          authenticated: true,
          writeScopeBound: Boolean(accountContext?.accountProfiles[proposal.providerAccountId]),
          selectedProviderAccountId: proposal.providerAccountId,
        },
        /*
          PR #272 review: the account's verified currency, or "" when there is
          no write context to take one from. Empty refuses in the adapter; it
          is never substituted with the request's own claim.
        */
        accountCurrency: input.writeContext?.accountCurrency ?? "",
        governance: {
          verified: governance?.verified === true,
          writeBlocked: governance?.writeBlocked !== false,
          killSwitchEngaged: governance?.killSwitchEngaged !== false,
          blockReason: governance?.blockReason ?? null,
        },
        /*
          D088 C2: the VERIFIED posture, not a constant. C1 hard-coded `false`
          here, which meant the executor's own enablement gate could never be
          exercised even after a deliberate activation — the runtime would have
          passed its gate and then D087 would have refused for a reason that was
          not true.
        */
        /*
          D088 C3: "may this execution reach the provider", as decided by the
          runtime that knows which authorization it holds. C2 read the
          business's automatic-execution flag here, which made every manual
          approval fail the preflight as `automation_disabled` while automatic
          execution was off — the exact posture a manual approval exists for.
        */
        automationEnabled: providerWriteAuthorized === true
          && verified.releaseGateOpen === true
          && verified.dryRunOnly === false,
        capability: (await import("@/lib/meta/budget-write-capability"))
          .D087_BUDGET_TRANSPORT_CAPABILITY,
        // The PERSISTED guardrails, translated into the D087 policy shape.
        policy: policyFromGuardrails(control?.businessControl.guardrails ?? null),
        history: measured,
        readProviderBaseline: async (probe) => {
          /*
            One live GET per attempt, taken by the executor itself.

            This used to be answered from a copy read a few milliseconds
            earlier, because `executeBudgetWrite` sampled its clock before
            calling this reader and its preflight then refused any baseline
            stamped after that clock — so on a real account, where a provider
            GET takes longer than zero milliseconds, every budget write was
            refused as `provider_baseline_stale` without a single POST. That
            ordering is fixed at source (the clock is now sampled after the
            read), so the workaround is gone and the baseline this attempt
            compares against is genuinely the freshest one.
          */
          if (!input.writeContext) return null;
          const read = await readMetaEntityBudgetState(input.writeContext, {
            entityId: probe.entityId,
            budgetField: probe.budgetField,
            accountCurrency: input.writeContext.accountCurrency,
          });
          return read.ok
            ? {
              entityId: read.entityId, providerAccountId: read.providerAccountId,
              budgetField: read.budgetField, amountMinor: read.amountMinor,
              currency: read.currency, readAtMs: read.readAtMs,
            }
            : null;
        },
        writeBudget: async (write) => {
          if (!input.writeContext) {
            return {
              ok: false, httpStatus: 503, providerMutationAttempted: false,
              error: { code: "write_context_unavailable", message: "No Meta write context." },
              responsePayload: null, verificationPayload: null,
            };
          }
          return updateEntityBudget(input.writeContext, write);
        },
      };
      void claimToken;
      return deps;
    },
  };
}

/**
 * Which write-safety steps a PERSISTED guardrail actually establishes.
 *
 * `satisfied` only where a real fact says so. Everything else is `missing` —
 * an unmet requirement and an unread one are the same thing to a gate.
 */
function writeSafetyStatus(
  step: WriteSafetyStep,
  facts: {
    guardrails: MetaAutomationGuardrails;
    roleReady: boolean;
    profileReady: boolean;
    baselineFresh: boolean;
    killSwitchClear: boolean;
    explicitlyApproved: boolean;
    claimHeld: boolean;
  },
): "satisfied" | "missing" | "not_applicable" {
  switch (step) {
    /*
      PRE-DEPLOY AUDIT: these four are properties of the PATH, not of this
      row, and the old comment justified them with "the route's own boundary"
      — a boundary the scheduled sweep never crosses. They are now read from
      the canonical `automation_proposal_approval` family declaration, the
      same source the projection path uses, so a family that stops
      implementing one reports it here instead of being asserted satisfied by
      this function.
    */
    case "exact_business_access":
    case "exact_physical_provider_account":
    case "explicit_action_origin":
    case "exact_target_identity":
      return declaredFamilyStatus(step);
    case "exact_role_and_posture":
      return facts.guardrails.requireResolvedCampaignRole
        ? (facts.roleReady ? "satisfied" : "missing")
        : (facts.roleReady ? "satisfied" : "not_applicable");
    case "parent_hierarchy_and_policy":
      return facts.guardrails.requireCommercialAnchor
        ? (facts.profileReady ? "satisfied" : "missing")
        : (facts.profileReady ? "satisfied" : "not_applicable");
    case "fresh_provider_or_current_state_read":
    case "persisted_preflight":
    case "preflight_age_and_no_provider_contact_disclosure":
    case "independent_provider_readback":
    case "exact_identity_and_state_verification":
      // All four rest on the same fresh read the adapter re-checks.
      return facts.baselineFresh ? "satisfied" : "missing";
    case "server_side_kill_switch":
      return facts.killSwitchClear ? "satisfied" : "missing";
    case "typed_or_explicit_confirmation":
      // An approved proposal IS the explicit confirmation.
      return facts.explicitlyApproved ? "satisfied" : "missing";
    case "durable_idempotency_claim":
    case "at_most_one_provider_post":
    case "immutable_attempt_receipt":
    case "durable_terminal_receipt_or_reconciliation_marker":
      // The claim token and the D087 journal establish these structurally.
      return facts.claimHeld ? "satisfied" : "missing";
    case "rollback_or_compensation_record":
      return facts.baselineFresh ? "satisfied" : "missing";
    default:
      return "missing";
  }
}

/** The persisted guardrails, in the D087 policy shape. Absent means unknown. */
function policyFromGuardrails(
  guardrails: MetaAutomationGuardrails | null,
): BudgetWritePolicy | null {
  if (!guardrails) return null;
  if (!Number.isFinite(guardrails.maxBudgetIncreasePct)
    || guardrails.maxBudgetIncreasePct <= 0) return null;
  /*
    D088 C3: EXPLICIT keys only. C2 derived a cooldown from the daily action cap
    and hard-coded a 100% concentration ceiling, which is not a limit at all.
    An unconfigured business has no budget policy, and no policy blocks.
  */
  if (guardrails.budgetMinHoursBetweenChanges === null) return null;
  if (guardrails.budgetMaxChangesPer7d === null) return null;
  if (guardrails.budgetMaxAccountConcentrationPct === null) return null;
  if (guardrails.perActionSpendCeilingValid !== true) return null;
  const spendCeilingCleared = guardrails.perActionSpendCeilingMinor === null
    && guardrails.perActionSpendCeilingCurrency === null;
  const spendCeilingSet = Number.isSafeInteger(
    guardrails.perActionSpendCeilingMinor,
  ) && (guardrails.perActionSpendCeilingMinor ?? 0) > 0
    && typeof guardrails.perActionSpendCeilingCurrency === "string"
    && /^[A-Z]{3}$/.test(guardrails.perActionSpendCeilingCurrency);
  if (!spendCeilingCleared && !spendCeilingSet) return null;
  return {
    maxChangePercent: guardrails.maxBudgetIncreasePct,
    minHoursBetweenChanges: guardrails.budgetMinHoursBetweenChanges,
    maxChangesPer7d: guardrails.budgetMaxChangesPer7d,
    maxAccountConcentrationPercent: guardrails.budgetMaxAccountConcentrationPct,
    maxBaselineAgeMinutes: 60,
    maxAmountMinor: guardrails.perActionSpendCeilingMinor,
    currency: guardrails.perActionSpendCeilingCurrency,
  };
}

export { BUDGET_WRITE_JOURNAL_CONTRACT };
