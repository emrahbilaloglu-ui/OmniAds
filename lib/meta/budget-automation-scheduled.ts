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
import { resolveEffectiveMetaModes } from "@/lib/meta/automation-control-plane";
import { decisionTypeForProposedAction } from "@/lib/meta/scheduled-action-execution";
import { readEffectiveMetaWriteGovernance } from "@/lib/meta/automation-control-plane";
import {
  BUDGET_SWEEP_CONTRACT,
  runBudgetAutomationSweep,
  type BudgetSweepReport,
} from "@/lib/meta/budget-automation-worker";
import { createBudgetProposalServerRuntime } from "@/lib/meta/budget-proposal-server-runtime";
import { createScheduledStatusRuntime } from "@/lib/meta/scheduled-status-runtime";
import { createBudgetServerReaders } from "@/lib/meta/budget-proposal-server-readers";
import { buildMetaBudgetWriteContextForProposal } from "@/lib/meta/budget-proposal-write-context";
import {
  AUTOMATABLE_PROPOSAL_ACTIONS,
  claimScheduledMetaAutomationProposal,
  forceMetaAutomationProposalReconcile,
  markMetaAutomationProposalDispatchStarted,
  settleMetaAutomationProposal,
  sweepStaleMetaAutomationProposalClaims,
  type MetaAutomationProposal,
  providerDispatchFacts,
} from "@/lib/meta/automation-proposals";
import { appendMetaAutomationReconciliationReceipt }
  from "@/lib/meta/automation-reconciliation";
import { writeActivityLedgerRow } from "@/lib/meta/automation-control-plane";
import { runClaimedProposalExecution } from "@/lib/meta/budget-execution-lifecycle";

/** `claimed_by`, `decided_by` and `actor_user_id` are all UUID columns. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BudgetAutomationJobResult =
  | { skipped: true; reason: string }
  | { skipped: false; businesses: number; reports: BudgetSweepReport[] };

/*
  Re-exported from the queue module, which is where it has to live: the atomic
  claim counts these families and the sweep dispatches them, and two lists
  would drift into a cap that bounds less than it says.
*/
export { AUTOMATABLE_PROPOSAL_ACTIONS };

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
  const nowIso = Number.isFinite(now.getTime()) ? now.toISOString() : null;
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

  /*
    PR #272 review — the bound account travels WITH the enablement query.

    The queue query below used to run once per business and group whatever it
    found by `provider_account_id` in JS, which meant `LIMIT 100` was applied
    across every account's rows BEFORE this business's one active account was
    even known. An inactive or unbound account with 100+ older pending rows
    could fill the page and starve the active account's proposals out of every
    sweep indefinitely. Reading the exact single-account binding here, and
    requiring it non-null, lets the queue query below filter to THAT account
    before LIMIT instead of after.
  */
  const enabled = (await getDb().query(
    `SELECT business_id::text AS business_id,
            auto_execution_provider_account_id AS provider_account_id
       FROM meta_automation_business_controls
      WHERE auto_execution_enabled = TRUE
        AND kill_switch_engaged = FALSE
        AND auto_execution_provider_account_id IS NOT NULL`,
  ).catch(() => [])) as Array<{ business_id: string; provider_account_id: string }>;
  if (enabled.length === 0) return { skipped: true, reason: "no_business_enabled" };

  const reports: BudgetSweepReport[] = [];
  for (const row of enabled) {
    // Defense in depth: the query above already requires this, but a caller
    // must never be able to reach the claim/write path below on a null binding.
    if (!row.provider_account_id) continue;
    const providerAccountId = row.provider_account_id;

    const writeContext = await buildMetaBudgetWriteContextForProposal({
      businessId: row.business_id, providerAccountId,
    });
    /*
      A missing context is transient/unknown, not a decision about the
      proposal. Stop BEFORE claim: otherwise the runtime reports
      composition_blocked and the lifecycle terminally settles a perfectly
      valid pending proposal as failed even though no provider call occurred.
    */
    if (!writeContext) {
      reports.push({
        contract: BUDGET_SWEEP_CONTRACT,
        ran: false,
        blockers: ["write_context_unavailable"],
        considered: 0,
        executed: 0,
        skipped: 0,
        withheld: 0,
        failed: 0,
      });
      continue;
    }
    /*
      Which action families this business has actually armed.

      The sweep used to hard-code `budget`, so an operator who set the pause
      family to auto got nothing: the executor for it existed, the standing mode
      was persisted, and no query ever asked. The modes are read here — once per
      business, before any claim — and a business with none on auto is skipped
      without touching the queue at all.
    */
    const modes = await resolveEffectiveMetaModes(row.business_id).catch(
      () => null,
    );
    if (!modes) {
      reports.push({
        contract: BUDGET_SWEEP_CONTRACT,
        ran: false,
        blockers: ["decision_type_modes_unreadable"],
        considered: 0, executed: 0, skipped: 0, withheld: 0, failed: 0,
      });
      continue;
    }
    const autoActions = AUTOMATABLE_PROPOSAL_ACTIONS.filter(
      (action) => modes[decisionTypeForProposedAction(action)] === "auto",
    );
    if (autoActions.length === 0) continue;

    /*
      The FRESH control-plane verdict for this business and account. C1 asserted
      `releaseGateOpen: true` / `autoExecutionEnabled: true` here without
      proving the standing mode, the persisted enablement, the business stop or
      the dry-run guardrail.

      It is read for one of the ARMED families, because the posture read
      includes a standing-mode question and a question needs a subject. Every
      family in `autoActions` answers `auto` by construction, so which one is
      named cannot change the verdict; naming none would silently ask about
      whichever family the fail-closed default happened to pick. Each row is
      re-checked against its own family later, twice.
    */
    const verdict = await createBudgetServerReaders({
      businessId: row.business_id,
      actorUserId: BUDGET_SWEEP_ACTOR,
      writeContext,
    }).readGates({
      proposal: {
        businessId: row.business_id,
        providerAccountId,
        proposedAction: autoActions[0],
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

      PR #272 review: still required even though the enablement query above
      already filtered to this exact account — the binding it read could have
      changed in the gap between that read and this one, and a fresh, unmocked
      re-check is the only thing that catches it.
    */
    const enablingActor = verdict.enablingActorUserId ?? "";
    if (!UUID_PATTERN.test(enablingActor)
      || verdict.enabledProviderAccountId !== providerAccountId) {
      reports.push({
        contract: BUDGET_SWEEP_CONTRACT,
        ran: false,
        blockers: [!UUID_PATTERN.test(enablingActor)
          ? "enabling_actor_absent" : "account_not_activated"],
        considered: 0,
        executed: 0,
        skipped: 0,
        withheld: 0,
        failed: 0,
      });
      continue;
    }
    const activationControlVersion = verdict.activationControlVersion ?? "";
    if (activationControlVersion.trim() === "") {
      reports.push({
        contract: BUDGET_SWEEP_CONTRACT,
        ran: false,
        blockers: ["activation_provenance_absent"],
        considered: 0,
        executed: 0,
        skipped: 0,
        withheld: 0,
        failed: 0,
      });
      continue;
    }

    const dailyCap = verdict.dailyAutoActionCap;
    if (!Number.isSafeInteger(dailyCap) || (dailyCap ?? 0) <= 0 || nowIso === null) {
      reports.push({
        contract: BUDGET_SWEEP_CONTRACT,
        ran: false,
        blockers: ["daily_auto_action_cap_unavailable"],
        considered: 0,
        executed: 0,
        skipped: 0,
        withheld: 0,
        failed: 0,
      });
      continue;
    }
    /*
      Expired claims must be classified BEFORE this preliminary count. A
      markerless crashed attempt is safe to requeue; one whose dispatch marker
      exists becomes reconcile. If the sweep itself is unavailable, the cap is
      unknown and unattended execution stops here rather than assuming space.

      The claim helper repeats this transition under its advisory transaction
      lock immediately before the authoritative cap count.
    */
    const staleClaims = await sweepStaleMetaAutomationProposalClaims({
      businessId: row.business_id,
      now,
    }).catch(() => null);
    if (!staleClaims?.ran) {
      reports.push({
        contract: BUDGET_SWEEP_CONTRACT,
        ran: false,
        blockers: ["stale_claim_sweep_unavailable"],
        considered: 0,
        executed: 0,
        skipped: 0,
        withheld: 0,
        failed: 0,
      });
      continue;
    }
    /*
      Approved scheduled receipts are the durable source. Current claims and
      recent reconciliation holds also reserve capacity, so a second cron run
      cannot treat an in-flight or ambiguous write as an empty slot. The claim
      helper repeats this count under a transaction-scoped advisory lock; this
      first read only bounds the page and provides an early, named refusal.
    */
    const usageRows = (await getDb().query(
      `SELECT count(*)::int AS used
         FROM meta_automation_proposals
        WHERE business_id = $1::uuid
          AND provider_account_id = $2
          -- The same families the claim helper counts, so the early refusal and
          -- the atomic reservation cannot disagree about what a slot is.
          AND proposed_action = ANY($4::text[])
          AND (
            (status = 'approved'
              AND decided_at >= $3::timestamptz - interval '24 hours'
              AND receipt_json->>'executionKind' = 'scheduled')
            OR status = 'claimed'
            OR (status = 'reconcile'
              AND COALESCE(decided_at, claimed_at, updated_at)
                >= $3::timestamptz - interval '24 hours')
          )`,
      [row.business_id, providerAccountId, nowIso,
        [...AUTOMATABLE_PROPOSAL_ACTIONS]],
    ).catch(() => null)) as Array<{ used: number }> | null;
    const used = usageRows === null ? null : Number(usageRows[0]?.used);
    if (!Number.isSafeInteger(used) || (used ?? -1) < 0) {
      reports.push({
        contract: BUDGET_SWEEP_CONTRACT,
        ran: false,
        blockers: ["daily_auto_action_cap_unavailable"],
        considered: 0,
        executed: 0,
        skipped: 0,
        withheld: 0,
        failed: 0,
      });
      continue;
    }
    const remaining = Math.max(0, dailyCap! - used!);
    if (remaining === 0) {
      reports.push({
        contract: BUDGET_SWEEP_CONTRACT,
        ran: false,
        blockers: ["daily_auto_action_cap_reached"],
        considered: 0,
        executed: 0,
        skipped: 0,
        withheld: 0,
        failed: 0,
      });
      continue;
    }
    /*
      The database page itself is bounded by the remaining allowance. This is
      before claim and before provider contact; a cap of three cannot turn
      into a hundred attempted money-changing actions in one sweep.
    */
    const pending = (await getDb().query(
      `SELECT id::text AS id
         FROM meta_automation_proposals
        WHERE business_id = $1::uuid
          AND provider_account_id = $2
          AND proposed_action = ANY($4::text[])
          -- Ad-grain rows are operator-approved. Their write records an
          -- immutable per-attempt event and re-proves the creative identity
          -- through a path this sweep does not drive; claiming one here would
          -- terminally fail a row an operator could still act on.
          AND scope_type IN ('campaign', 'adset')
          AND status = 'pending'
          AND expires_at > now()
        ORDER BY created_at
        LIMIT $3`,
      [row.business_id, providerAccountId, remaining, autoActions],
    ).catch(() => null)) as Array<{ id: string }> | null;
    // An unread queue is unknown, and unknown does nothing.
    if (pending === null) continue;
    const proposalIds = pending.map((proposal) => proposal.id);

    const readers = createBudgetServerReaders({
      businessId: row.business_id,
      // The enabling admin, not a sentinel: this is who the write is by.
      actorUserId: enablingActor,
      writeContext,
    });
    const budgetRuntime = createBudgetProposalServerRuntime(readers);
    /*
      Status changes do not go through the manual HTTP handler.

      That handler stamps `manual_operator_v1` and an explicit confirmation,
      which are true of an approval and false of a sweep. Driving the write
      primitive directly keeps the action log honest about which authority
      acted, and the primitive's pre-POST hook is where this path re-proves
      that authority after the claim.
    */
    const statusRuntime = createScheduledStatusRuntime({
      ctx: writeContext,
      readGates: async ({ proposal }) => {
        /*
          The reader's type makes most of the posture optional, so absence is
          normalised HERE rather than inside the authority check. Every default
          below is the closed one: a field nobody wrote is not permission.
        */
        const gates = await readers.readGates({ proposal });
        return {
          releaseGateOpen: gates.releaseGateOpen === true,
          autoExecutionEnabled: gates.autoExecutionEnabled === true,
          enabledProviderAccountId: gates.enabledProviderAccountId ?? null,
          enablingActorUserId: gates.enablingActorUserId ?? null,
          activationControlVersion: gates.activationControlVersion ?? null,
          dryRunOnly: gates.dryRunOnly !== false,
        };
      },
      /*
        Re-read, not the `modes` above. The whole point of the boundary check
        is that the operator can change their mind in the seconds a claim and
        a composition take.
      */
      readMode: async ({ proposal }) => {
        const current = await resolveEffectiveMetaModes(proposal.businessId)
          .catch(() => null);
        if (!current) return null;
        return current[decisionTypeForProposedAction(proposal.proposedAction)];
      },
    });
    const runtimeFor = (proposal: MetaAutomationProposal) =>
      proposal.proposedAction === "budget" ? budgetRuntime : statusRuntime;

    const claimedProposals = new Map<string, MetaAutomationProposal>();
    reports.push(await runBudgetAutomationSweep({
      businessId: row.business_id,
      providerAccountId,
      releaseGateOpen: verdict.releaseGateOpen,
      autoExecutionEnabled: verdict.autoExecutionEnabled,
      dryRunOnly: verdict.dryRunOnly !== false,
      listEligibleProposals: async () => proposalIds.map((id) => ({ id })),
      claim: async (proposalId) => {
        const claim = await claimScheduledMetaAutomationProposal({
          businessId: row.business_id,
          providerAccountId,
          proposalId,
          // The enabling admin holds the claim: `claimed_by` is a UUID
          // column and the authority for this write is theirs.
          claimedBy: enablingActor,
          expectedEnablingActorUserId: enablingActor,
          expectedActivationControlVersion: activationControlVersion,
          dailyAutoActionCap: dailyCap!,
          now,
        }).catch(() => null);
        if (claim?.status !== "claimed") return null;
        claimedProposals.set(claim.claimToken, claim.proposal);
        return claim.claimToken;
      },
      /*
        The SAME lifecycle manual approval runs: mark, execute, settle,
        reconcile, ledger. C1 called the runtime directly and could strand a
        row as `claimed` with no receipt anybody could read.
      */
      executeProposal: async ({ proposalId, claimToken }) => {
        const proposal = claimedProposals.get(claimToken) ?? null;
        if (!proposal) {
          return { ok: false, receipt: { withheld: "proposal_absent" } };
        }
        const lifecycle = await runClaimedProposalExecution({
          businessId: row.business_id,
          providerAccountId,
          proposal,
          claimToken,
          actorUserId: enablingActor,
          executionKind: "scheduled",
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
          }),
          forceReconcile: (reconcileInput) =>
            forceMetaAutomationProposalReconcile(reconcileInput),
          recordReconciliation: async ({ proposal, claimToken, receipt }) => {
            const recorded = await appendMetaAutomationReconciliationReceipt({
              businessId: proposal.businessId,
              proposalId: proposal.id,
              providerAccountId: proposal.providerAccountId,
              decisionKey: proposal.decisionKey,
              proposedAction: proposal.proposedAction,
              claimToken,
              reason: "settle_failed_after_dispatch",
              facts: providerDispatchFacts({
                dispatchStarted: true,
                outcomeKnown: false,
                ok: false,
                dryRun: receipt.dryRun === true,
              }),
              receipt,
            });
            return recorded.status !== "unavailable";
          },
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
          execute: async (beforeProviderPost) => runtimeFor(proposal)({
            proposal,
            dryRunOnly: verdict.dryRunOnly !== false,
            claimToken,
            authorization: {
              kind: "scheduled",
              expectedEnablingActorUserId: enablingActor,
              expectedActivationControlVersion: activationControlVersion,
            },
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

  return { skipped: false, businesses: enabled.length, reports };
}
