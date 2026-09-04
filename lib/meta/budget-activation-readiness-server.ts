/**
 * Fresh, server-owned activation readiness for automatic Meta budget writes.
 *
 * Both the activation route and the Automation surface consume this reader so
 * the UI cannot advertise a ceremony that the route is guaranteed to refuse.
 * Every failed read stays fail-closed and becomes a named blocker.
 */
import { getDb } from "@/lib/db";
import { getMetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import {
  evaluateBudgetAutomationReadiness,
  type BudgetActivationReadinessInput,
  type BudgetActivationReadinessVerdict,
} from "@/lib/meta/budget-activation";
import { readBudgetReadiness } from "@/lib/meta/budget-readiness-read-model";
import { readMetaReleaseGates } from "@/lib/meta/release-gates";
import { campaignContextAuthorityResolverVersion }
  from "@/lib/creative-decision-engine/campaign-context/source";

export interface BudgetActivationServerRead {
  readiness: BudgetActivationReadinessInput;
  verdict: BudgetActivationReadinessVerdict;
  /** Optimistic version of the exact control row used for this verdict. */
  controlUpdatedAt: string | null;
}

async function readRows<T extends Record<string, unknown>>(
  text: string,
  params: unknown[],
): Promise<T[] | null> {
  try {
    return await getDb().query<T>(text, params);
  } catch {
    return null;
  }
}

export async function readBudgetActivationServerRead(input: {
  businessId: string;
  providerAccountId: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<BudgetActivationServerRead> {
  const accountScopeExact = input.businessId.trim() !== ""
    && input.providerAccountId.trim() !== "";
  const gates = readMetaReleaseGates(input.env ?? process.env);

  const controlPromise = accountScopeExact
    ? getMetaAutomationControlPlane({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
    }).catch(() => null)
    : Promise.resolve(null);
  const schemaPromise = accountScopeExact
    ? readRows<Record<string, unknown>>(
      `SELECT
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema='public' AND table_name='meta_budget_write_journal'
             AND column_name = ANY($1::text[]))                       AS journal_columns,
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema='public' AND table_name='meta_automation_proposals'
             AND column_name = 'budget_envelope_json')                AS envelope_column,
         (SELECT count(*) FROM pg_constraint
           WHERE conrelid = 'meta_automation_proposals'::regclass
             AND contype = 'c'
             AND conname = 'meta_automation_proposals_action_budget_check'
             AND pg_get_constraintdef(oid) LIKE '%proposed_action%'
             AND pg_get_constraintdef(oid) LIKE '%''budget''%')       AS action_constraint,
         (SELECT count(*) FROM pg_indexes
           WHERE schemaname='public'
             AND indexname='meta_budget_write_journal_occurrence')    AS occurrence_index`,
      [[
        "id", "proposal_id", "idempotency_key", "request_fingerprint",
        "before_amount_minor", "intended_amount_minor", "readback_amount_minor",
        "result_class", "rollback_eligible",
      ]],
    )
    : Promise.resolve(null);
  const openWorkPromise = accountScopeExact
    ? readRows<{ reconciles: number; claims: number }>(
      `SELECT
         count(*) FILTER (WHERE status = 'reconcile')::int AS reconciles,
         count(*) FILTER (WHERE status = 'claimed')::int AS claims
       FROM meta_automation_proposals
       WHERE business_id = $1::uuid AND provider_account_id = $2`,
      [input.businessId, input.providerAccountId],
    )
    : Promise.resolve(null);
  const retentionPromise = accountScopeExact
    ? readBudgetReadiness(getDb(), {
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      nowIso: (input.now ?? new Date()).toISOString(),
      approvedResolverVersion: campaignContextAuthorityResolverVersion(),
    }).catch(() => null)
    : Promise.resolve(null);

  const [control, schemaProof, openWork, retention] = await Promise.all([
    controlPromise,
    schemaPromise,
    openWorkPromise,
    retentionPromise,
  ]);
  const journalReady = schemaProof !== null
    && Number(schemaProof[0]?.journal_columns ?? 0) === 9
    && Number(schemaProof[0]?.envelope_column ?? 0) === 1
    && Number(schemaProof[0]?.action_constraint ?? 0) >= 1
    && Number(schemaProof[0]?.occurrence_index ?? 0) === 1;
  const dimensionReady = (key: string) =>
    retention?.dimensions.find((dimension) => dimension.key === key)?.status === "ready";

  const readiness: BudgetActivationReadinessInput = {
    controlRowPersisted: control?.businessControl.source === "persisted",
    globalGateOpen: gates.automationLiveWrites === true,
    businessStopClear: control?.businessControl.killSwitchEngaged === false
      && control?.globalKillSwitch.engaged === false,
    budgetDecisionMode:
      control?.decisionTypeModes.find((mode) => mode.decisionType === "budget")?.mode
      ?? "manual",
    dryRunGuardrailLifted: control?.businessControl.guardrails.dryRunOnly === false,
    canonicalFactRetentionReady: dimensionReady("budget_fact_retention"),
    profileRetentionReady: dimensionReady("profile_output_retention"),
    automaticRoleRetentionReady: dimensionReady("role_authority_retention"),
    accountScopeExact,
    journalSchemaReady: journalReady,
    // A failed read is UNKNOWN, represented by -1 so it cannot equal zero.
    unresolvedReconciliations: openWork === null
      ? -1 : Number(openWork[0]?.reconciles ?? 0),
    openClaims: openWork === null ? -1 : Number(openWork[0]?.claims ?? 0),
  };

  return {
    readiness,
    verdict: evaluateBudgetAutomationReadiness(readiness),
    controlUpdatedAt: control?.businessControl.updatedAt ?? null,
  };
}
