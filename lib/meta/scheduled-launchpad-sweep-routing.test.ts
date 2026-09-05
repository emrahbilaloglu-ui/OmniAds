/**
 * The one hazard adding these two families creates, pinned in the sweep itself.
 *
 * `resume` was already an automatable family, and `decisionTypeForProposedAction`
 * maps it to the PAUSE mode. So the instant an activation producer raises a
 * `resume` row, the shipped sweep would have armed it from the standing mode
 * for pausing and sent it to the ordinary status runtime — one entity, no
 * approval check, no ordering, no route back to the intent — and an ad reading
 * ACTIVE under a paused campaign would have been reported as done.
 *
 * These are source assertions on purpose. What is being pinned is the ORDER of
 * a routing expression and the shape of a page query, and running the sweep
 * against a database double would only prove what the double was told.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sweep = readFileSync("lib/meta/budget-automation-scheduled.ts", "utf8");

describe("an activation row can never reach a status runtime", () => {
  it("routes on the ROW's lineage before either grain test", () => {
    const routing = sweep.slice(
      sweep.indexOf("const runtimeFor ="),
      sweep.indexOf("const claimedProposals"),
    );
    expect(routing).toContain('proposal.proposedAction === "launch"');
    expect(routing).toContain(
      'proposal.proposedAction === "resume" && proposal.launchIntentId',
    );
    // The lineage test must come BEFORE the ad-grain test and the status
    // fall-through; either of those would resume one entity on its own.
    expect(routing.indexOf("proposal.launchIntentId"))
      .toBeLessThan(routing.indexOf('proposal.scopeType === "ad"'));
    expect(routing.indexOf("activationRuntime"))
      .toBeLessThan(routing.indexOf("adRuntime"));
  });

  it("resolves the standing mode from the row, never from the verb", () => {
    // The re-read at the claim boundary. `decisionTypeForProposedAction` would
    // answer `pause` for an activation.
    expect(sweep).toContain("current[decisionTypeForProposal(proposal)]");
  });
});

describe("ineligible rows are kept OUT of the page, not withheld after the claim", () => {
  it("drops launch from the armed families while Launchpad's gate is shut", () => {
    /*
      A withheld outcome settles the queue row `failed`. Claiming a launch under
      a closed gate and then refusing it would destroy, every ten minutes, rows
      an operator could still have approved by hand.
    */
    expect(sweep).toContain(
      'if (action === "launch" && !launchpadCreateOpen) return false;',
    );
    expect(sweep).toContain(
      'readMetaReleaseGates(process.env).launchpadExecution === true',
    );
    expect(sweep).toContain(
      'missingSteps(writeFamily("launchpad_create")).length === 0',
    );
  });

  it("admits an intent-lineage resume only when a stored approval exists", () => {
    /*
      NULL activation_approval_json is every intent's default and means
      operator-only. The binding check is still the approval validator at
      dispatch; this keeps the unapproved row from being claimed and destroyed
      before an operator ever sees it.
    */
    const pending = sweep.slice(
      sweep.indexOf("const pending = ("),
      sweep.indexOf("// An unread queue is unknown"),
    );
    expect(pending).toContain("i.activation_approval_json IS NOT NULL");
    expect(pending).toContain("launch_intent_id IS NULL");
    expect(pending).toContain("proposed_action <> 'resume'");
    // Still scoped to this business, so one workspace's approval can never
    // admit another's row.
    expect(pending).toContain(
      "i.business_id = meta_automation_proposals.business_id",
    );
  });

  it("asks the per-account verdict about the family that is actually armed", () => {
    /*
      `resume` is the one action whose family cannot be read off the verb, so a
      bare `resume` probe would ask about pausing and answer
      `auto_execution_disabled` for a business that armed exactly the creative
      family these rows belong to.
    */
    expect(sweep).toContain("const probeLaunchLineage = autoActions[0] === \"resume\"");
    expect(sweep).toContain("launchIntentId: probeLaunchLineage,");
  });
});
