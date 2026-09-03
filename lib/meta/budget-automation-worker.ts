/**
 * D088 — the scheduled entry point for canonical budget proposals.
 *
 * It shares the manual path rather than forking it: the same claim, the same
 * executor, the same journal. Its only additional responsibility is to refuse
 * to start, which under current defaults is all it ever does.
 *
 * A proposal it cannot claim is skipped, never executed. An unclaimed execution
 * is exactly the double-write the claim exists to prevent.
 */
export const BUDGET_SWEEP_CONTRACT = "meta.budget-automation-sweep.v1" as const;

export const BUDGET_SWEEP_BLOCKERS = [
  "release_gate_closed",
  "auto_execution_disabled",
  "dry_run_guardrail",
  /*
    D088 C3: two refusals the sweep decides BEFORE it claims anything — the
    activation was proven for a different provider account, or the admin whose
    authority a scheduled write acts under is absent, revoked or not a real
    user id. Either one stops the group with zero claims and zero provider
    contact.
  */
  "account_not_activated",
  "enabling_actor_absent",
] as const;
export type BudgetSweepBlocker = (typeof BUDGET_SWEEP_BLOCKERS)[number];

export interface BudgetSweepDeps {
  businessId: string;
  providerAccountId: string;
  releaseGateOpen: boolean;
  autoExecutionEnabled: boolean;
  dryRunOnly: boolean;
  listEligibleProposals(): Promise<ReadonlyArray<{ id: string }>>;
  /** The EXISTING atomic claim. `null` means somebody else won the row. */
  claim(proposalId: string): Promise<string | null>;
  /** The SAME executor manual review calls. */
  executeProposal(input: { proposalId: string; claimToken: string }): Promise<{
    ok: boolean;
    receipt: { withheld?: string | null };
  }>;
}

export interface BudgetSweepReport {
  contract: typeof BUDGET_SWEEP_CONTRACT;
  ran: boolean;
  blockers: readonly BudgetSweepBlocker[];
  considered: number;
  executed: number;
  skipped: number;
  withheld: number;
  /** Claimed, dispatched, and did NOT land. Never folded into `executed`. */
  failed: number;
}

export async function runBudgetAutomationSweep(
  deps: BudgetSweepDeps,
): Promise<BudgetSweepReport> {
  const blockers: BudgetSweepBlocker[] = [];
  if (deps?.releaseGateOpen !== true) blockers.push("release_gate_closed");
  if (deps?.autoExecutionEnabled !== true) blockers.push("auto_execution_disabled");
  if (deps?.dryRunOnly === true) blockers.push("dry_run_guardrail");

  if (blockers.length > 0) {
    /*
      Inert. It does not even LIST proposals: enumerating work it may not do
      would put an eligible-looking set in front of an operator who cannot act
      on it, and would query for nothing.
    */
    return {
      contract: BUDGET_SWEEP_CONTRACT,
      ran: false,
      blockers: Object.freeze(blockers),
      considered: 0, executed: 0, skipped: 0, withheld: 0,
      failed: 0,
    };
  }

  const proposals = await deps.listEligibleProposals();
  let executed = 0;
  let skipped = 0;
  let withheld = 0;
  let failed = 0;
  for (const proposal of proposals) {
    const claimToken = await deps.claim(proposal.id);
    if (!claimToken) {
      skipped += 1;
      continue;
    }
    const result = await deps.executeProposal({ proposalId: proposal.id, claimToken });
    /*
      PRE-DEPLOY AUDIT — three outcomes, three counters.

      A failed execution was counted as `executed`, so the number the cron
      response shows an operator overstated how many budget writes actually
      landed: an account whose every write failed reported the same
      `executed` count as one where every write succeeded.
    */
    if (result.ok) executed += 1;
    else if (result.receipt?.withheld) withheld += 1;
    else failed += 1;
  }
  return {
    contract: BUDGET_SWEEP_CONTRACT,
    ran: true,
    blockers: [],
    considered: proposals.length,
    executed,
    skipped,
    withheld,
    failed,
  };
}
