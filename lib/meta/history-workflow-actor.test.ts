import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * WP12 item 5 — `not_applicable` means "this event had no human actor", and a
 * workflow event always has one.
 *
 * `decision_workflow_events` records acknowledging, deferring, rejecting and
 * reopening: ownership acts, performed by a person, with `actor_user_id`
 * recording who. The History journal hardcoded `NULL, NULL, 'not_applicable'`
 * for that branch, and the adapter renders `not_applicable` as
 * **"No human actor (engine)"** — so every ownership act in the audit trail was
 * attributed to the engine. That inverts the single fact the row exists to
 * carry.
 *
 * Asserted at source level: the branch is one arm of a very large `UNION ALL`
 * whose behavioural coverage needs a database, and what needs pinning here is
 * that the actor columns are wired at all.
 */
const SOURCE = readFileSync("lib/meta/history-read-model.ts", "utf8");

function workflowBranch(): string {
  const start = SOURCE.indexOf("'decision_workflow_events',");
  expect(start, "the workflow branch exists").toBeGreaterThan(0);
  const end = SOURCE.indexOf("UNION ALL", start);
  return SOURCE.slice(start, end === -1 ? SOURCE.length : end);
}

describe("History attributes a workflow event to its operator", () => {
  it("selects the actor id and name, not a null pair", () => {
    const branch = workflowBranch();
    expect(branch).toContain("workflow.actor_user_id::text");
    expect(branch).toContain("workflow_actor.name");
  });

  it("joins the user the id names", () => {
    expect(SOURCE).toContain("LEFT JOIN users workflow_actor");
    expect(SOURCE).toContain("workflow_actor.id = workflow.actor_user_id");
  });

  it("no longer claims the branch has no human actor", () => {
    const branch = workflowBranch();
    expect(branch).not.toContain("'not_applicable'");
  });

  it("reports an unresolvable actor as unavailable, not as absent", () => {
    /**
     * The FK is `ON DELETE SET NULL`, so a departed colleague's rows outlive
     * them. "A person acted and we cannot name them" is a different fact from
     * "no person acted", and only the second is `not_applicable`.
     */
    const branch = workflowBranch();
    expect(branch).toContain(
      "CASE WHEN workflow_actor.id IS NOT NULL THEN 'available' ELSE 'unavailable' END",
    );
  });

  it("carries the before state, not only the after", () => {
    // `toState` alone says where a decision ended up and hides what it was
    // moved from, which is half of what an audit reader needs (WP12 item 7).
    const branch = workflowBranch();
    expect(branch).toContain("'fromState', workflow.from_state");
    expect(branch).toContain("'toState', workflow.to_state");
    expect(branch).toContain("'reasonCode'");
  });

  it("keeps the SQL free of backticks, which would end the template literal", () => {
    // A real defect the first attempt hit: this SQL lives in a TypeScript
    // template literal, and a backtick in a comment terminates the string.
    const branch = workflowBranch();
    expect(branch).not.toContain("`");
  });
});
