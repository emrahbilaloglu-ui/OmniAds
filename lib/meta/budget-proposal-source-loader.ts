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
  reconcileProfileIdentityExpectation,
} from "@/lib/meta/budget-readiness-retention";
import { ensureRetainedAccountProfileOutputs } from "@/lib/meta/account-profile-output-producer";
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
  /*
    THE DAY'S VERDICT, MATERIALISED BEFORE IT IS READ.

    `engine_v3_account_profile_output` had no writer at all, so this read found
    nothing on every account and the candidate was refused with
    `composition_sources_unavailable` — the budget arm inert for a reason no
    surface could show. This is the first production consumer on the chain, so
    it is where the day's verdict is materialised: the producer resolves the
    canonical `AccountDecisionProfile` from this account's own retained facts
    and retains what it says, including a verdict that withholds the action.
    Nothing is invented — an account whose facts cannot be read produces no row,
    the read below finds nothing, and this loader refuses exactly as it did.

    It runs once per account-day per set of inputs; a day whose facts have not
    moved costs one indexed lookup. The identity it hands back is the
    expectation the classifier checks the retained row against, and it is
    re-derived from the commercial-truth and calibration readers rather than
    from the row itself.
  */
  const retainedInputIdentity = await ensureRetainedAccountProfileOutputs({
    businessId,
    providerAccountId,
    asOfDate: candidate.snapshotDate,
  }).catch(() => null);
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
        effectiveAt: retainedInstant(profileRow.effective_at),
        recordedAt: retainedInstant(profileRow.recorded_at),
      },
      {
        ...reconcileProfileIdentityExpectation(
          expectedProfileIdentity(candidate.evidence),
          retainedInputIdentity,
        ),
        nowIso, maxAgeMs: D086_PROFILE_MAX_AGE_MS,
      },
    )
    : null;
  /*
    USABLE AND ELIGIBLE ARE DIFFERENT CLAIMS, and this used to conflate them.

    `classifyRetainedProfile` answers whether the retained verdict can be
    trusted — right contract, right engine identity, agreeing fingerprints,
    coherent clocks, a boolean paired with a canonical code. A well-formed
    verdict that says `eligible: false` with the engine's own blocker code on it
    is perfectly trustworthy and is a REFUSAL. Reporting `usable` as the
    commercial verdict would have declared every such account eligible the
    moment the retained table started carrying rows, which is the direction that
    costs money.
  */
  const profileTrusted = profileVerdict?.usable === true;
  const profileEligible = profileTrusted && profileRow?.eligible === true;
  const profileBlockerCode = profileTrusted && profileRow?.eligible === false
    && typeof profileRow.blocker_code === "string"
    ? profileRow.blocker_code
    : profileVerdict?.reason ?? null;
  const guardrails: MetaAutomationGuardrails = control.businessControl.guardrails;
  const policySafety = projectBudgetPolicySafety({
    currentAmountMinor: baseline?.amountMinor ?? null,
    intendedAmountMinor: candidate.targetAmountMinor,
    currency: baseline?.currency ?? null,
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
    history,
  });
  /*
    The control row's own day, from a value the driver hands back as a Date.

    `MetaAutomationBusinessControl.updatedAt` is typed `string | null`, and the
    control plane assigns `row.updated_at` straight from the query — which the
    Postgres driver returns as a `Date` for a `timestamptz` column. Calling
    `.slice` on it threw, and because the whole budget projection is wrapped in
    a `catch` that degrades to "the queue was not projected", the failure was
    invisible until a candidate got far enough to reach this line. Nothing here
    invents a day: an unparseable clock stays `null`.
  */
  const controlUpdatedDay = (value: unknown): string | null => {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime())
        ? value.toISOString().slice(0, 10) : null;
    }
    return typeof value === "string" && value.length >= 10
      ? value.slice(0, 10) : null;
  };
  const flag = (clear: boolean, why: string) => ({
    state: clear ? ("clear" as const) : ("unknown" as const),
    source: "meta_automation_business_controls",
    asOf: controlUpdatedDay(control.businessControl.updatedAt),
    why,
  });

  const knowledgeMs = Math.max(nowMs, baseline?.readAtMs ?? 0, Date.now());

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
    profileRetained: profileEligible,
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
    /*
      THE KNOWLEDGE INSTANT, TAKEN AFTER EVERY READ — not before them.

      `nowMs` travels into the composition as the point-in-time knowledge cutoff
      AND as the preflight's evaluation instant, and the provider baseline is
      read here, several awaits after this function started. Stamping the
      cutoff at entry therefore dated the account's own fresh read *after* the
      moment the proposal claims to know anything, and D085 refused every
      candidate with `capture_after_knowledge_cutoff`,
      `preflight_observation_after_cutoff` and a contradictory preflight
      summary. Nothing about the account was wrong; the clock was.

      Every query above still uses the entry cutoff, so evidence is read as of
      the earlier instant and the composition's knowledge is as of the later
      one — which is the correct ordering, not a widened window.
    */
    nowMs: knowledgeMs,
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
      profileReady: profileEligible,
      baselineFresh: baseline !== null,
      killSwitchClear: control.globalKillSwitch.engaged === false
        && control.businessControl.killSwitchEngaged === false,
      requireResolvedCampaignRole: guardrails.requireResolvedCampaignRole,
      requireCommercialAnchor: guardrails.requireCommercialAnchor,
    }),
    commercial: {
      profileContractVersion: CANONICAL_PROFILE_CONTRACT,
      businessId, providerAccountId,
      sourceStatus: profileEligible ? "resolved" : "unavailable",
      selectedAction: candidate.recommendedAction === "increase_budget" ? "scale" : "cut",
      /* The RETAINED row's own boolean, never the classifier's trust verdict. */
      eligible: profileEligible ? true : null,
      code: profileBlockerCode,
      reason: profileBlockerCode,
      blockerCodes: profileBlockerCode ? [profileBlockerCode] : [],
      evidenceFloorsClear: profileEligible,
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
