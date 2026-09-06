/**
 * A launch whose queue row merely EXPIRED has to come back.
 *
 * Both launch-intent producers excluded an intent as soon as any non-undecided
 * row existed for it, and `expired` is non-undecided. A proposal expires 24h
 * after it is raised — and `readMetaAutomationProposalQueue` expires stale rows on
 * every read, so an operator opening the queue is enough to trigger it — after
 * which the intent, still `prepared` and still unstarted, was dropped from every
 * later snapshot. The launch left the confirmation queue permanently instead of
 * being re-evaluated, which is the opposite of what expiry promises ("the next
 * snapshot re-evaluates it").
 *
 * These cases pin the corrected law in BOTH directions: `expired` comes back,
 * and nothing that could have reached Meta ever does.
 */
import { describe, expect, it } from "vitest";

import { ACTIVATABLE_LAUNCH_INTENT_SQL } from "@/lib/meta/activation-proposal-producer";
import { META_AUTOMATION_PROPOSAL_STATUSES } from "@/lib/meta/automation-proposals";
import {
  LAUNCH_INTENT_UNCONSUMED_PROPOSAL_STATUSES,
  READY_LAUNCH_INTENT_SQL,
} from "@/lib/meta/launch-proposal-producer";

/**
 * The statuses the shipped statement actually excludes an intent for.
 *
 * The exclusion is a SQL predicate and no unit test here may reach a database,
 * so the arm is read back OUT of the statement and interpreted rather than
 * substring-matched. A `NOT IN` arm excludes the COMPLEMENT of what it lists,
 * so both spellings are resolved to the same answer — the question is which
 * statuses keep the intent out of the queue, not how the SQL happens to say it.
 */
function excludingStatuses(sql: string): string[] {
  const arm = /decided\.status\s+(NOT\s+)?IN\s+\(([^)]*)\)/i.exec(sql);
  if (!arm) throw new Error("the decided-proposal arm is no longer a status list");
  const listed = arm[2]!
    .split(",")
    .map((status) => status.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
  return arm[1]
    ? META_AUTOMATION_PROPOSAL_STATUSES.filter((status) => !listed.includes(status))
    : listed;
}

const PRODUCERS = [
  ["the launch producer", READY_LAUNCH_INTENT_SQL],
  ["the activation producer", ACTIVATABLE_LAUNCH_INTENT_SQL],
] as const;

for (const [producer, sql] of PRODUCERS) {
  describe(`${producer} re-offers an intent whose row only expired`, () => {
    it("does not treat `expired` as having consumed the intent", () => {
      /*
        `expired` is the one terminal status written with no provider dispatch
        having begun: `expireStaleMetaAutomationProposals` updates only
        `status = 'pending'` rows, and the claim sweep writes `expired` solely on
        its `dispatch_started_at IS NULL` branch — the branch whose meaning is
        "nothing was sent". So an expired row provably created nothing, and the
        work it described is still undone.
      */
      expect(excludingStatuses(sql)).not.toContain("expired");
    });

    it("still refuses every outcome that reached Meta or was a person's verdict", () => {
      /*
        The permissive direction is the dangerous one, so it is pinned exactly.
        `approved` and `failed` both mean the dispatch was entered and the
        provider answered — a launch that failed at the ad step still created a
        campaign and an ad set. `reconcile` means the outcome is UNKNOWN, which
        is not the same as absent. `dismissed` and `modified` are the operator's
        own decision on the offer, and re-raising those overrides a person.
      */
      expect([...excludingStatuses(sql)].sort()).toEqual([
        "approved",
        "dismissed",
        "failed",
        "modified",
        "reconcile",
      ]);
    });

    it("never excludes an intent for a row that is still open", () => {
      // A pending or claimed row holds the slot; the insert's own ON CONFLICT
      // arbiter is what stops a duplicate, not this predicate.
      expect(excludingStatuses(sql)).not.toContain("pending");
      expect(excludingStatuses(sql)).not.toContain("claimed");
    });
  });
}

describe("the unconsumed-status list", () => {
  it("names the exception, so a status added later is consuming by default", () => {
    /*
      Listing the CONSUMING statuses positively would mean a status added to the
      CHECK constraint later silently defaults to non-consuming — the direction
      that re-offers a launch which already created provider entities. Naming
      the short exception list and using it as a `NOT IN` makes the safe reading
      the automatic one, and this pins that the exception is only `expired` on
      top of the two open statuses.
    */
    expect([...LAUNCH_INTENT_UNCONSUMED_PROPOSAL_STATUSES])
      .toEqual(["pending", "claimed", "expired"]);
    // And every one of them is a real status, not a typo the SQL would ignore.
    for (const status of LAUNCH_INTENT_UNCONSUMED_PROPOSAL_STATUSES) {
      expect(META_AUTOMATION_PROPOSAL_STATUSES).toContain(status);
    }
  });

  it("is the same law for both producers", () => {
    // The two producers keep SEPARATE copies of the list on purpose — importing
    // one from the other breaks `snapshot.test.ts`, which mocks both modules
    // independently. This case is what holds the copies equal, so the
    // duplication cannot drift silently.
    expect(excludingStatuses(READY_LAUNCH_INTENT_SQL))
      .toEqual(excludingStatuses(ACTIVATABLE_LAUNCH_INTENT_SQL));
  });
});
