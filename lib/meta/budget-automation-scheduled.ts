/**
 * D088 C1 — the scheduled entry point, wired the way this repository schedules
 * work: an `IfDue` function the existing `/api/sync/cron` route calls.
 *
 * It is registered, and it is inert. Under current defaults it returns before
 * listing or claiming anything, and it makes zero provider calls. When the
 * migrations are applied, the retained facts accrue and the existing release
 * gate and control row are deliberately opened, this same function begins doing
 * work with no source change.
 */
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { readMetaReleaseGates } from "@/lib/meta/release-gates";
import { readEffectiveMetaWriteGovernance } from "@/lib/meta/automation-control-plane";
import {
  BUDGET_SWEEP_CONTRACT,
  runBudgetAutomationSweep,
  type BudgetSweepReport,
} from "@/lib/meta/budget-automation-worker";
import { createBudgetProposalServerRuntime } from "@/lib/meta/budget-proposal-server-runtime";
import { createBudgetServerReaders } from "@/lib/meta/budget-proposal-server-readers";
import { buildMetaWriteContextForProposal } from "@/lib/meta/budget-proposal-write-context";
import {
  claimMetaAutomationProposal,
  markMetaAutomationProposalDispatchStarted,
  readMetaAutomationProposal,
  settleMetaAutomationProposal,
} from "@/lib/meta/automation-proposals";
import { writeActivityLedgerRow } from "@/lib/meta/automation-control-plane";
import { runClaimedProposalExecution } from "@/lib/meta/budget-execution-lifecycle";

/** `claimed_by`, `decided_by` and `actor_user_id` are all UUID columns. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BudgetAutomationJobResult =
  | { skipped: true; reason: string }
  | { skipped: false; businesses: number; reports: BudgetSweepReport[] };

/** The system actor a scheduled execution is attributed to. */
export const BUDGET_SWEEP_ACTOR = "meta_budget_automation_sweep" as const;

/**
 * `decided_by` on the proposal row is a plain text column, so the sweep names
 * itself there. The ledger's `created_by` is a user FK and takes `null`.
 */
export const BUDGET_SWEEP_ACTOR_USER = BUDGET_SWEEP_ACTOR;

/**
 * Run the sweep for every business whose controls permit it.
 *
 * The gate order is deliberate: the cheapest global fact first, so a closed
 * release gate costs one environment read and no database work at all.
 */
export async function runMetaBudgetAutomationSweepIfDue(
  now = new Date(),
): Promise<BudgetAutomationJobResult> {
  void now;
  const gates = readMetaReleaseGates(process.env);
  if (gates.automationLiveWrites !== true) {
    return { skipped: true, reason: "release_gate_closed" };
  }

  const readiness = await getDbSchemaReadiness({
    tables: [
      "meta_automation_proposals",
      "meta_automation_business_controls",
      "meta_budget_write_journal",
    ],
  }).catch(() => null);
  if (!readiness?.ready) return { skipped: true, reason: "schema_not_ready" };

  const enabled = (await getDb().query(
    `SELECT business_id::text AS business_id
       FROM meta_automation_business_controls
      WHERE auto_execution_enabled = TRUE
        AND kill_switch_engaged = FALSE`,
  ).catch(() => [])) as Array<{ business_id: string }>;
  if (enabled.length === 0) return { skipped: true, reason: "no_business_enabled" };

  const reports: BudgetSweepReport[] = [];
  for (const row of enabled) {
    /*
      D088 C2: PER PROVIDER ACCOUNT.

      C1 took the first pending row's account id and used it for every proposal
      in the business — so a second account's rows would have been executed
      against the first account's credentials. Rows are grouped, and each group
      is proven on its own.
    */
    const pending = (await getDb().query(
      `SELECT id::text AS id, provider_account_id
         FROM meta_automation_proposals
        WHERE business_id = $1::uuid
          AND proposed_action = 'budget'
          AND status = 'pending'
          AND expires_at > now()
        ORDER BY provider_account_id, created_at
        LIMIT 100`,
      [row.business_id],
    ).catch(() => null)) as Array<{ id: string; provider_account_id: string }> | null;
    // An unread queue is unknown, and unknown does nothing.
    if (pending === null) continue;

    const byAccount = new Map<string, string[]>();
    for (const proposal of pending) {
      byAccount.set(proposal.provider_account_id, [
        ...(byAccount.get(proposal.provider_account_id) ?? []), proposal.id,
      ]);
    }

    for (const [providerAccountId, proposalIds] of byAccount) {
      const writeContext = await buildMetaWriteContextForProposal({
        businessId: row.business_id, providerAccountId,
      });
      /*
        The FRESH control-plane verdict for this business and account, read
        before anything else. C1 asserted `releaseGateOpen: true` /
        `autoExecutionEnabled: true` here without proving the budget mode, the
        persisted enablement, the business stop or the dry-run guardrail.
      */
      const verdict = await createBudgetServerReaders({
        businessId: row.business_id,
        actorUserId: BUDGET_SWEEP_ACTOR,
        writeContext,
      }).readGates({
        proposal: {
          businessId: row.business_id, providerAccountId,
        } as never,
      });

      /*
        D088 C3: the AUTHORIZING IDENTITY, before any claim.

        A scheduled execution acts under the admin who typed the activation
        phrase for THIS account. `claimed_by`, `decided_by` and the journal's
        `actor_user_id` are UUID columns, so C2's `meta_budget_automation_sweep`
        sentinel could only ever fail at the database — after the row had been
        claimed. Absent, revoked or malformed identity, or an activation proven
        for a different account, stops this group before it claims anything and
        before any provider contact.
      */
      const enablingActor = verdict.enablingActorUserId ?? "";
      if (!UUID_PATTERN.test(enablingActor)
        || verdict.enabledProviderAccountId !== providerAccountId) {
        reports.push({
          contract: BUDGET_SWEEP_CONTRACT,
          ran: false,
          blockers: [!UUID_PATTERN.test(enablingActor)
            ? "enabling_actor_absent" : "account_not_activated"],
          considered: proposalIds.length,
          executed: 0,
          skipped: proposalIds.length,
          withheld: 0,
      failed: 0,
        });
        continue;
      }

      const readers = createBudgetServerReaders({
        businessId: row.business_id,
        // The enabling admin, not a sentinel: this is who the write is by.
        actorUserId: enablingActor,
        writeContext,
      });
      const runtime = createBudgetProposalServerRuntime(readers);

      reports.push(await runBudgetAutomationSweep({
        businessId: row.business_id,
        providerAccountId,
        releaseGateOpen: verdict.releaseGateOpen,
        autoExecutionEnabled: verdict.autoExecutionEnabled,
        dryRunOnly: verdict.dryRunOnly !== false,
        listEligibleProposals: async () => proposalIds.map((id) => ({ id })),
        claim: async (proposalId) => {
          const claim = await claimMetaAutomationProposal({
            businessId: row.business_id,
            providerAccountId,
            proposalId,
            // The enabling admin holds the claim: `claimed_by` is a UUID
            // column and the authority for this write is theirs.
            claimedBy: enablingActor,
          }).catch(() => null);
          return claim?.status === "claimed" ? claim.claimToken : null;
        },
        /*
          The SAME lifecycle manual approval runs: mark, execute, settle,
          reconcile, ledger. C1 called the runtime directly and could strand a
          row as `claimed` with no receipt anybody could read.
        */
        executeProposal: async ({ proposalId, claimToken }) => {
          const proposal = await readMetaAutomationProposal({
            businessId: row.business_id, providerAccountId, proposalId,
          }).catch(() => null);
          if (!proposal) {
            return { ok: false, receipt: { withheld: "proposal_absent" } };
          }
          const lifecycle = await runClaimedProposalExecution({
            businessId: row.business_id,
            providerAccountId,
            proposal,
            claimToken,
            actorUserId: enablingActor,
            markDispatchStarted: async (marked) =>
              Boolean(await markMetaAutomationProposalDispatchStarted({
                businessId: marked.businessId,
                proposalId: marked.proposalId,
                claimToken: marked.claimToken,
              }).catch(() => null)),
            settle: async (settleInput) => settleMetaAutomationProposal({
              businessId: settleInput.businessId,
              proposalId: settleInput.proposalId,
              status: settleInput.status,
              // The settle records the sweep, not a person.
              // The persisted enabling ADMIN. A text sentinel would fail a
              // UUID column, and attributing the change to nobody is worse.
              decidedBy: enablingActor,
              decisionNote: null,
              receipt: settleInput.receipt,
              claimToken: settleInput.claimToken,
            }).catch(() => null),
            recordLedger: async (entry) => {
              await writeActivityLedgerRow({
                businessId: row.business_id,
                activityType: entry.activityType,
                severity: entry.severity,
                message: entry.message,
                payload: entry.payload,
                // Nobody requested this; the actor is the sweep itself.
                userId: null,
                actorKind: "system",
                entityType: proposal.scopeType,
                entityId: proposal.scopeId,
                resultStatus: entry.severity === "success" ? "applied" : "failed",
                resultReceiptId: claimToken,
              }).catch(() => undefined);
            },
            execute: async (beforeProviderPost) => runtime({
              proposal,
              dryRunOnly: verdict.dryRunOnly !== false,
              claimToken,
              authorization: { kind: "scheduled" },
              beforeProviderPost,
            }),
          });
          return {
            ok: lifecycle.ok,
            receipt: { withheld: lifecycle.receipt.withheld },
          };
        },
      }));
    }
  }

  return { skipped: false, businesses: enabled.length, reports };
}
