/**
 * A launch or activation the queue WITHHELD has to come back.
 *
 * `runClaimedProposalExecution` — and, on the manual path for launch and
 * intent-carrying resume rows, the approve route's own settle block — settles a
 * claimed row `failed` for two
 * different facts, and only one of them consumed anything. A dispatch that
 * reached Meta and was refused did — a launch that failed at the ad step still
 * created a campaign and an ad set. A row the gates withheld before the
 * provider did not: the approval expired, the standing mode changed or the
 * write posture closed after the claim, nothing was sent, and the paused
 * hierarchy the row described is still exactly where it was.
 *
 * Both producers treated every `failed` row as consuming, so that second kind
 * left the confirmation queue permanently — the same defect `expired` had, one
 * door along. These cases pin the corrected law in BOTH directions: a proven
 * non-dispatch comes back, and anything that might have reached Meta never
 * does.
 */
import { describe, expect, it } from "vitest";

import { ACTIVATABLE_LAUNCH_INTENT_SQL } from "@/lib/meta/activation-proposal-producer";
import { META_AUTOMATION_PROPOSAL_STATUSES } from "@/lib/meta/automation-proposals";
import { READY_LAUNCH_INTENT_SQL } from "@/lib/meta/launch-proposal-producer";

interface DecidedRow {
  status: string;
  /** Whether `dispatch_started_at` is stamped on that row. */
  dispatchStarted: boolean;
  /**
   * Whether the approval this launch was staged under still stands.
   *
   * Optional, defaulting to `true`, so the cases written before the standing
   * leg existed keep exactly the meaning they were written with: they describe
   * a launch whose approval was never withdrawn.
   */
  approvalStands?: boolean;
}

/**
 * The shipped statement's own verdict on one earlier row, read back out of it.
 *
 * No unit test here may reach a database, so the two arms of the `decided`
 * subquery are extracted and interpreted rather than substring-matched. The
 * interpretation is deliberately lopsided: the status arm MUST be found (a
 * statement without one is not a classification at all and this throws), while
 * the dispatch carve-out is optional and only ever makes a row NON-consuming.
 * So a rewrite this parser cannot read reports "consumes" — which fails the
 * re-offer case loudly and can never turn the dangerous direction green by
 * accident.
 */
function consumesTheIntent(sql: string, row: DecidedRow): boolean {
  const statusArm = /decided\.status\s+(NOT\s+)?IN\s+\(([^)]*)\)/i.exec(sql);
  if (!statusArm) throw new Error("the decided-proposal arm is no longer a status list");
  const listed = statusArm[2]!
    .split(",")
    .map((status) => status.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
  const excludedByStatus = statusArm[1]
    ? !listed.includes(row.status)
    : listed.includes(row.status);
  if (!excludedByStatus) return false;

  /*
    The carve-out now has THREE conditions, not two: the status, the missing
    dispatch stamp, and the approval still standing. The third was added after
    the decision-to-launch seam proved that re-offering a withdrawn-approval
    launch produces a queue row that can only ever be refused.

    Parsed permissively on whitespace but STRICTLY on shape: if the clause is
    rewritten into something this cannot read, `dispatchArm` is null and the row
    reports "consumes". That is the safe direction — a rewrite the parser misses
    fails the re-offer cases loudly instead of quietly greenlighting the
    dangerous one.
  */
  /*
    The carve-out now has THREE conditions, not two: the status, the missing
    dispatch stamp, and the approval still standing. The third was added after
    the decision-to-launch seam proved that re-offering a withdrawn-approval
    launch produces a queue row that can only ever be refused.

    Located by its opening and then read with PAREN BALANCING rather than a
    regex, because the standing leg contains a nested `EXISTS (...)` and a
    naive `\)` would stop inside it. Strict on shape: if the opening is not
    found, the row reports "consumes" — the safe direction, so a rewrite this
    cannot read fails the re-offer cases loudly instead of quietly greenlighting
    the dangerous one.
  */
  const opening =
    /NOT\s*\(\s*decided\.status\s*=\s*'([a-z_]+)'\s+AND\s+decided\.dispatch_started_at\s+IS\s+NULL/i
      .exec(sql);
  if (opening && opening[1] === row.status && !row.dispatchStarted) {
    // Walk from the carve-out's own "(" to its matching ")".
    const openIndex = sql.indexOf("(", opening.index);
    let depth = 0;
    let closeIndex = -1;
    for (let i = openIndex; i < sql.length; i += 1) {
      if (sql[i] === "(") depth += 1;
      else if (sql[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          closeIndex = i;
          break;
        }
      }
    }
    if (closeIndex === -1) return true;
    const clause = sql.slice(openIndex, closeIndex + 1);
    // No standing leg means the carve-out does not depend on the approval.
    if (!/creative_brief_id/i.test(clause)) return false;
    // With one, the row returns to the queue only while the approval stands.
    return row.approvalStands === false;
  }
  return true;
}

const PRODUCERS = [
  ["the launch producer", READY_LAUNCH_INTENT_SQL],
  ["the activation producer", ACTIVATABLE_LAUNCH_INTENT_SQL],
] as const;

for (const [producer, sql] of PRODUCERS) {
  describe(`${producer} re-offers an intent whose row failed before dispatch`, () => {
    it("re-offers a `failed` row that never entered the provider", () => {
      /*
        The withheld outcome: `scheduled-activation-runtime` and the manual
        boundary refuse before the first provider call, the lifecycle finds no
        dispatch and no success, and the row settles `failed` with
        `dispatch_started_at` still NULL. Nothing was created and nothing was
        turned on, so the intent is untouched work.
      */
      expect(consumesTheIntent(sql, { status: "failed", dispatchStarted: false }))
        .toBe(false);
    });

    it("still refuses a `failed` row whose dispatch was entered", () => {
      /*
        The dangerous direction, and the reason the discriminator is the durable
        column rather than the status: the marker is written BEFORE the provider
        call and the call is refused when it cannot be written, so a stamped row
        may have created or activated entities. Re-offering it would loop a
        failing provider write with no backoff.
      */
      expect(consumesTheIntent(sql, { status: "failed", dispatchStarted: true }))
        .toBe(true);
    });

    it("carves out `failed` alone, at either dispatch state", () => {
      /*
        A missing stamp is not a general licence to re-offer. `approved` asserts
        a write landed, `reconcile` means the outcome is UNKNOWN — which is not
        the same as absent — and `dismissed`/`modified` are a person's verdict on
        the offer, which re-raising would override. Only `expired` and the two
        open statuses leave the intent on offer regardless of the stamp.
      */
      const reoffered = META_AUTOMATION_PROPOSAL_STATUSES.filter(
        (status) => !consumesTheIntent(sql, { status, dispatchStarted: false }),
      );
      expect([...reoffered].sort())
        .toEqual(["claimed", "expired", "failed", "pending"]);

      const reofferedAfterDispatch = META_AUTOMATION_PROPOSAL_STATUSES.filter(
        (status) => !consumesTheIntent(sql, { status, dispatchStarted: true }),
      );
      expect([...reofferedAfterDispatch].sort())
        .toEqual(["claimed", "expired", "pending"]);
    });
  });
}

describe("the non-dispatched-failure carve-out", () => {
  it("is the same law for both producers", () => {
    /*
      The two producers keep SEPARATE copies of this arm on purpose — importing
      one from the other breaks `snapshot.test.ts`, which mocks both modules
      independently. This case is what holds the copies equal, so the
      duplication cannot drift into one producer re-offering what the other
      still excludes.
    */
    for (const status of META_AUTOMATION_PROPOSAL_STATUSES) {
      for (const dispatchStarted of [false, true]) {
        expect({
          status,
          dispatchStarted,
          consumes: consumesTheIntent(READY_LAUNCH_INTENT_SQL, { status, dispatchStarted }),
        }).toEqual({
          status,
          dispatchStarted,
          consumes: consumesTheIntent(ACTIVATABLE_LAUNCH_INTENT_SQL, {
            status,
            dispatchStarted,
          }),
        });
      }
    }
  });

  it("reads the durable column, never the receipt's own account of itself", () => {
    /*
      `withheld()` publishes `providerMutationAttempted: false` even for a
      refusal raised after the marker fired, so the receipt cannot arbitrate
      this. `dispatch_started_at` can: it is written before the provider call,
      the call is refused when it cannot be written, and `claimMetaAutomation
      Proposal` resets it to NULL on every claim so it describes THIS attempt.
    */
    for (const sql of [READY_LAUNCH_INTENT_SQL, ACTIVATABLE_LAUNCH_INTENT_SQL]) {
      expect(sql).toContain("decided.dispatch_started_at IS NULL");
      expect(sql).not.toContain("providerMutationAttempted");
      // And it is a column of the row the subquery already scans, not a fact
      // this statement would have to go and fetch.
      expect(sql).toContain("FROM meta_automation_proposals decided");
    }
  });
});

describe("a withdrawn approval is not re-offered", () => {
  /*
    The condition the decision-to-launch seam forced into existence.

    In that chain an operator un-reviews the brief, the sweep refuses with
    `creative_brief_not_reviewed` before touching Meta, and the row settles
    `failed` with no dispatch stamp while the intent stays `prepared`. Under the
    two-condition carve-out that intent came back on the very next projection —
    and would come back on every projection after it, to be refused each time,
    because nothing re-reviews a brief on its own. The seam caught it as a
    launch-row count of 2 where the case expected 1.

    Re-offering must therefore mean "the work can proceed again", not merely
    "nothing was created". Both are required.
  */
  for (const [name, sql] of [
    ["launch", READY_LAUNCH_INTENT_SQL],
    ["activation", ACTIVATABLE_LAUNCH_INTENT_SQL],
  ] as const) {
    it(`keeps the ${name} intent retired while its approval is withdrawn`, () => {
      expect(
        consumesTheIntent(sql, {
          status: "failed",
          dispatchStarted: false,
          approvalStands: false,
        }),
      ).toBe(true);
    });

    it(`re-offers the ${name} intent once the approval stands again`, () => {
      expect(
        consumesTheIntent(sql, {
          status: "failed",
          dispatchStarted: false,
          approvalStands: true,
        }),
      ).toBe(false);
    });

    it(`asks the ${name} producer for the brief's CURRENT review status`, () => {
      /*
        Pinned on the statement, because the whole point is that the producer
        reads the brief as it stands NOW rather than trusting the status it had
        when the intent was staged. `verifyMetaLaunchIntentLineage` refuses on
        exactly this predicate, so this is one leg of that contract rather than
        a rule invented here.
      */
      expect(sql).toContain("meta_creative_briefs standing");
      expect(sql).toContain("standing.status = 'reviewed'");
      expect(sql).toContain("i.creative_brief_id IS NULL");
    });
  }
});
