/**
 * D088 C2 — the production source loader the budget producer uses.
 *
 * It reads the same seams the runtime does, for a candidate that has no
 * proposal row yet: current observations, the account time zone, the retained
 * role and profile verdicts, the persisted control posture, and the measured
 * journal history.
 *
 * ## The projection-time baseline (D088 C3)
 *
 * C2 hard-coded `providerBaseline: null` and called that a design, which made
 * the producer unable to emit a row under ANY posture: the composition root
 * refuses without a baseline, so `projectMetaBudgetProposals` refused every
 * candidate it was ever handed. A D085 preview that cannot see what the account
 * currently holds is not a preview of anything.
 *
 * So this loader takes ONE GET-only baseline, through the same account
 * write-context boundary the approval route uses, and only when the account's
 * own persisted posture permits any provider contact at all: a persisted
 * control row, both kill switches clear, write endpoints not blocked, a
 * configured budget policy, and a live write context for the exact account.
 * With this repository's defaults none of that holds — there is no control row
 * — so a default run performs zero provider GETs and zero POSTs, and the
 * composition refuses with `provider_baseline_unavailable`.
 *
 * The read is GET-only and is NOT the baseline a write is issued against:
 * execution reads again, independently, and compares-and-sets immediately
 * before its POST.
 */
import { getDb } from "@/lib/db";
import { META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES } from "@/lib/meta/automation-proposals";
import { readMetaEntityBudgetState } from "@/lib/meta/ads-write";
import { buildMetaBudgetWriteContextForProposal } from "@/lib/meta/budget-proposal-write-context";
import {
  getMetaAutomationControlPlane,
  type MetaAutomationGuardrails,
} from "@/lib/meta/automation-control-plane";
import {
  D086_ACCOUNT_TIMEZONE_SQL,
  D086_PROFILE_LATEST_SQL,
  D086_PROFILE_MAX_AGE_MS,
  D086_STATE_BUDGET_SQL,
} from "@/lib/meta/budget-readiness-read-model";
import {
  classifyRetainedProfile,
  expectedProfileIdentity,
} from "@/lib/meta/budget-readiness-retention";
import {
  campaignContextAuthorityResolverVersion,
  isCampaignContextResolverAuthorityValidated,
} from "@/lib/creative-decision-engine/campaign-context/source";
import { resolveCampaignRoleAuthority } from "@/lib/meta/campaign-role-authority";
import { readMeasuredBudgetHistory } from "@/lib/meta/budget-proposal-server-readers";
import { CANONICAL_PROFILE_CONTRACT } from "@/lib/meta/budget-proposal-dry-run";
import {
  projectBudgetPolicySafety,
  projectionWriteSafety,
} from "@/lib/meta/budget-write-safety-projection";
import type { BudgetCompositionSources } from "@/lib/meta/budget-execution-composition";
import type { TypedBudgetCandidate } from "@/lib/meta/budget-proposal-producer";

export async function loadBudgetCompositionSourcesForCandidate(
  candidate: TypedBudgetCandidate,
): Promise<Omit<BudgetCompositionSources, "proposalId" | "claimToken"> | null> {
  const businessId = candidate.businessId;
  const providerAccountId = candidate.providerAccountId;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const observations = (await getDb().query(
    D086_STATE_BUDGET_SQL, [businessId, providerAccountId, nowIso, 500],
  ).catch(() => null)) as Array<Record<string, unknown>> | null;
  const zoneRows = (await getDb().query(
    D086_ACCOUNT_TIMEZONE_SQL, [businessId, providerAccountId],
  ).catch(() => null)) as Array<{ account_timezone?: string | null }> | null;
  const control = await getMetaAutomationControlPlane({
    businessId, providerAccountId,
  }).catch(() => null);
  const history = await readMeasuredBudgetHistory({
    businessId, providerAccountId,
    entityGrain: candidate.scopeType,
    entityId: candidate.scopeId,
    intendedAmountMinor: candidate.targetAmountMinor,
    nowMs,
  });
  const roleRows = (await getDb().query(
    /* business_id and campaign_id are SELECTED, not assumed: the resolver
       re-checks the composite scope against the request, and a row relabelled
       with the id we asked for cannot be cross-checked at all. */
    `SELECT business_id, campaign_id, provider_account_id,
            as_of_date::text AS as_of_date, inferred_kind,
            kind_source, confidence_class, resolver_version
       FROM engine_v3_campaign_role_authority
      WHERE business_id = $1 AND campaign_id = $2
      ORDER BY as_of_date DESC, recorded_at DESC LIMIT 25`,
    [businessId, candidate.scopeType === "campaign"
      ? candidate.scopeId : candidate.parentCampaignId ?? ""],
  ).catch(() => null)) as Array<Record<string, string | null>> | null;

  // A read that failed is UNKNOWN, and unknown raises nothing.
  if (observations === null || zoneRows === null || roleRows === null || !control) {
    return null;
  }
  const roleCampaignId = candidate.scopeType === "campaign"
    ? candidate.scopeId : candidate.parentCampaignId;
  if (!roleCampaignId) return null;
  const roleResolution = resolveCampaignRoleAuthority({
    request: {
      businessId, providerAccountId, campaignId: roleCampaignId,
      asOfDate: nowIso.slice(0, 10), maxEvidenceAgeDays: 60,
    },
    evidence: roleRows.map((row) => ({
      // The ROW's own identity, so the resolver can refuse a foreign one.
      businessId: String(row.business_id ?? ""),
      providerAccountId: row.provider_account_id ?? null,
      campaignId: String(row.campaign_id ?? ""),
      asOfDate: String(row.as_of_date ?? ""),
      inferredKind: row.inferred_kind ?? null,
      kindSource: row.kind_source ?? null,
      confidenceClass: row.confidence_class ?? null,
      resolverVersion: row.resolver_version ?? null,
    })) as never,
    identities: [{ businessId, providerAccountId, campaignId: roleCampaignId }] as never,
    isResolverVersionValidated: isCampaignContextResolverAuthorityValidated,
  });

  /*
    THE SUBJECT ROW, and the budget field it actually carries.

    The GET below asks for one field on one entity. Which field is a retained
    fact, not a choice: an entity with a daily amount is on a daily budget. If
    the retained row carries neither, the field is unknown and nothing is read.
  */
  const subjectRow = observations.find(
    (row) => row.grain === candidate.scopeType && String(row.entity_id) === candidate.scopeId,
  ) ?? null;
  const rawDaily = candidate.scopeType === "campaign"
    ? subjectRow?.campaign_daily_budget_raw : subjectRow?.adset_daily_budget_raw;
  const rawLifetime = candidate.scopeType === "campaign"
    ? subjectRow?.campaign_lifetime_budget_raw : subjectRow?.adset_lifetime_budget_raw;
  const budgetField: "daily_budget" | "lifetime_budget" | null =
    rawDaily !== null && rawDaily !== undefined ? "daily_budget"
    : rawLifetime !== null && rawLifetime !== undefined ? "lifetime_budget"
    : null;

  const guardrailsForPolicy = control.businessControl.guardrails;
  /*
    THE ONLY GATE ON PROVIDER CONTACT AT PROJECTION.

    Every clause is a persisted posture fact. With no control row — this
    repository's default — `source` is `"default"` and the whole expression is
    false, so no context is built and no request leaves the process.
  */
  const providerContactPermitted =
    control.businessControl.source === "persisted"
    && control.globalKillSwitch.engaged === false
    && control.businessControl.killSwitchEngaged === false
    && control.execution.writeEndpointsBlocked === false
    && guardrailsForPolicy.budgetMinHoursBetweenChanges !== null
    && guardrailsForPolicy.budgetMaxChangesPer7d !== null
    && guardrailsForPolicy.budgetMaxAccountConcentrationPct !== null
    && budgetField !== null;

  const writeContext = providerContactPermitted
    ? await buildMetaBudgetWriteContextForProposal({ businessId, providerAccountId })
      .catch(() => null)
    : null;
  const baselineRead = writeContext
    ? await readMetaEntityBudgetState(writeContext, {
      entityId: candidate.scopeId,
      budgetField: budgetField!,
      accountCurrency: writeContext.accountCurrency,
    }).catch(() => ({ ok: false as const, reason: "read_failed" }))
    : null;
  const baseline = baselineRead?.ok === true ? baselineRead : null;

  /*
    THE MEASURED CONFLICT.

    C2 declared `flag(false, "no execution claim exists at projection time")`,
    which reported UNKNOWN for a condition nobody had looked at. What matters
    at projection is whether another row already holds an open claim on this
    exact decision key; a read that fails stays unknown and blocks.
  */
  const claimRows = (await getDb().query(
    `SELECT count(*)::int AS open_claims
       FROM meta_automation_proposals
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND decision_key = $3
        AND claim_token IS NOT NULL
        AND status = ANY($4::text[])`,
    [businessId, providerAccountId,
      `${candidate.scopeType}:${candidate.scopeId}`,
      [...META_AUTOMATION_PROPOSAL_UNDECIDED_STATUSES]],
  ).catch(() => null)) as Array<{ open_claims?: number }> | null;

  /*
    THE EXACT ACTION ROW, classified by its own canonical classifier.

    C2 read the aggregate `profile_output_retention` readiness dimension and
    treated "this account's profile output is retained" as "this action is
    commercially eligible". They are different claims: retention is about rows
    existing, eligibility is about what the `scale` (or `cut`) row says.
  */
  const profileAction = candidate.recommendedAction === "increase_budget"
    ? "scale" : "cut";
  const profileRows = (await getDb().query(
    D086_PROFILE_LATEST_SQL, [businessId, providerAccountId],
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
        effectiveAt: profileRow.effective_at ?? null,
        recordedAt: profileRow.recorded_at ?? null,
      },
      {
        ...expectedProfileIdentity(candidate.evidence),
        nowIso, maxAgeMs: D086_PROFILE_MAX_AGE_MS,
      },
    )
    : null;
  const profileReady = profileVerdict?.usable === true;
  const guardrails: MetaAutomationGuardrails = control.businessControl.guardrails;
  const policySafety = projectBudgetPolicySafety({
    currentAmountMinor: baseline?.amountMinor ?? null,
    intendedAmountMinor: candidate.targetAmountMinor,
    nowMs,
    policy: {
      maxChangePercent: guardrails.maxBudgetIncreasePct,
      minHoursBetweenChanges: guardrails.budgetMinHoursBetweenChanges,
      maxChangesPer7d: guardrails.budgetMaxChangesPer7d,
      maxAccountConcentrationPercent: guardrails.budgetMaxAccountConcentrationPct,
    },
    history,
  });
  const flag = (clear: boolean, why: string) => ({
    state: clear ? ("clear" as const) : ("unknown" as const),
    source: "meta_automation_business_controls",
    asOf: control.businessControl.updatedAt?.slice(0, 10) ?? null,
    why,
  });

  return {
    businessId,
    providerAccountId,
    ownerGrain: candidate.scopeType,
    entityId: candidate.scopeId,
    parentCampaignId: candidate.parentCampaignId,
    actorUserId: "meta_budget_proposal_producer",
    observations,
    accountTimeZone: zoneRows[0]?.account_timezone ?? null,
    intent: {
      verb: candidate.recommendedAction,
      intendedAmountMinor: candidate.targetAmountMinor,
      percent: null,
    },
    // The canonical RESOLVER's verdict, exactly as the runtime reads it.
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
    profileRetained: profileReady,
    // Measured, prospective, and `null` when the population is not provable.
    changeHistory: history,
    /* The goal of the EXACT ad set being changed. `observations[0]` is
     * merely the first row the account read returned. */
    optimizationGoal: typeof (observations ?? []).find((o) => o.grain === candidate.scopeType && String(o.entity_id) === candidate.scopeId)?.optimization_goal === "string"
      ? ((observations ?? []).find((o) => o.grain === candidate.scopeType && String(o.entity_id) === candidate.scopeId)?.optimization_goal as string) : null,
    /* ONE GET-only read, or nothing at all. Never a synthesised baseline. */
    providerBaseline: baseline
      ? {
        entityId: baseline.entityId,
        providerAccountId: baseline.providerAccountId,
        budgetField: baseline.budgetField,
        amountMinor: baseline.amountMinor,
        currency: baseline.currency,
        readAtMs: baseline.readAtMs,
      }
      : null,
    nowMs,
    safety: {
      killSwitch: flag(
        control.globalKillSwitch.engaged === false
        && control.businessControl.killSwitchEngaged === false,
        "global and business kill switches",
      ),
      admission: flag(control.businessControl.source === "persisted",
        "persisted control row"),
      cap: policySafety.cap,
      cooldown: policySafety.cooldown,
      conflict: flag(
        claimRows !== null && Number(claimRows[0]?.open_claims ?? -1) === 0,
        "measured open claims on this decision key",
      ),
    },
    /* Measured where this row's evidence decides, declared where the approval
       path does. Nothing here asserts a step on its own authority. */
    writeSafety: projectionWriteSafety({
      roleReady: roleResolution.satisfiesRoleAuthority,
      profileReady: profileReady,
      baselineFresh: baseline !== null,
      killSwitchClear: control.globalKillSwitch.engaged === false
        && control.businessControl.killSwitchEngaged === false,
      requireResolvedCampaignRole: guardrails.requireResolvedCampaignRole,
      requireCommercialAnchor: guardrails.requireCommercialAnchor,
    }),
    commercial: {
      profileContractVersion: CANONICAL_PROFILE_CONTRACT,
      businessId, providerAccountId,
      sourceStatus: profileReady ? "resolved" : "unavailable",
      selectedAction: candidate.recommendedAction === "increase_budget" ? "scale" : "cut",
      eligible: profileReady ? true : null,
      code: profileVerdict?.reason ?? null,
      reason: profileVerdict?.reason ?? null,
      blockerCodes: profileVerdict?.reason ? [profileVerdict.reason] : [],
      evidenceFloorsClear: profileReady,
      changeSafetyClear: roleResolution.satisfiesRoleAuthority,
    },
    /* The persisted decision's OWN hash and OWN clock, both selected with the
       candidate. Neither is the snapshot day, and neither is a fingerprint of
       something this process just built. */
    decision: {
      id: candidate.recId,
      hash: candidate.decisionHash,
      version: candidate.engineVersion,
      decidedAt: candidate.decisionAt,
      maxAgeSeconds: 86_400,
    },
    casBaseline: null,
    preflight: null,
    preflightEvidence: null,
    rawIntent: null,
  };
}
