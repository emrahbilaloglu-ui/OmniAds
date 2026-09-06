/**
 * The manual bid approval must actually be able to read the live cap.
 *
 * `executeMetaAutomationProposal` takes `readBidBaseline` as an INJECTED
 * dependency — the executor may not reach the provider itself — and treats an
 * absent reader as a refusal (`bid_baseline_reader_unavailable`), never as
 * "the baseline still holds". That is the right default for the executor and a
 * trap for its caller: a route that adds the compare-and-set to the executor
 * and forgets to supply the reader turns EVERY manual bid approval into a
 * refusal. Worse than inert — `bid` is settled `failed` and the operator's
 * proposal is consumed with no remedy.
 *
 * That is exactly what happened while addressing the review finding that asked
 * for this compare-and-set, which is why the wiring is pinned here rather than
 * left to the next reader to notice.
 *
 * WHY SOURCE TEXT AND NOT A DRIVEN ROUTE. The confirmation-queue route needs a
 * session, an account scope, a claimed row and a provider double before it will
 * execute anything, and no seam in this repository drives a BID row through the
 * manual executor — `ephemeral-postgres-economics-bid-chain-seam-child.ts`
 * approves a BUDGET row through `runClaimedProposalExecution`, a different
 * entry point. Until such a seam exists this asserts the two facts that the
 * regression actually consisted of, in the same style as the sibling
 * `budget-activation-route.test.ts`. It is a guard against a specific
 * disconnection, not a substitute for end-to-end coverage, and it should be
 * replaced by a driven case when one is written.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { readProposalBidBaseline } from "@/lib/meta/budget-proposal-write-context";

const ROUTE = readFileSync(
  "app/api/meta/automation/proposals/route.ts",
  "utf8",
);
const EXECUTOR = readFileSync(
  "lib/meta/automation-proposal-execution.ts",
  "utf8",
);

describe("the confirmation queue supplies the bid baseline reader", () => {
  it("passes readBidBaseline into the executor", () => {
    expect(ROUTE).toContain("readBidBaseline:");
    expect(ROUTE).toContain("readProposalBidBaseline({");
    // Resolved from the reader's own arguments rather than from the enclosing
    // proposal, so the executor decides which entity is compared.
    expect(ROUTE).toContain("async ({ providerAccountId, adsetId }) =>");
  });

  it("keeps the executor's absent-reader refusal, which is what makes the wiring load-bearing", () => {
    expect(EXECUTOR).toContain(
      'if (!input.readBidBaseline) return withheldBid("bid_baseline_reader_unavailable")',
    );
  });

  it("marks a bid at its own boundary, because it can refuse before any provider call", () => {
    // The compare-and-set withholds ahead of the handler, so stamping a
    // dispatch first would leave a row reading as though a provider write may
    // have been attempted when nothing was sent.
    expect(ROUTE).toContain('|| input.proposal.proposedAction === "bid"');
  });

  it("reaches the write client only through the sanctioned module", () => {
    /*
      `automation-write-path.test.ts` asserts that no module in this subsystem
      names the Meta write client — it greps the source text, so even a mention
      in a comment trips it. This case states the other half: the reader the
      route injects is a real exported function, so the indirection is a real
      module boundary rather than a name that happens not to match the grep.
    */
    expect(typeof readProposalBidBaseline).toBe("function");
    expect(ROUTE).toContain(
      'from "@/lib/meta/budget-proposal-write-context"',
    );
  });
});
