/**
 * Finding 4, the creative family: the queue action nothing raised.
 *
 * `launch` became an allowed `proposed_action` with a CHECK requiring the
 * intent id on the row, and no producer ever wrote one. A staged launch intent
 * sat where only the Launchpad screen could see it, so the confirmation queue
 * an operator works from in the morning never mentioned it.
 *
 * The producer then shipped selecting `ready`, which turned out to be a state
 * nothing rests in, and inserting against an arbiter that could never fire.
 * These cases pin the corrected law rather than the shipped mistake.
 */
import { describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";

import {
  projectMetaLaunchProposals,
  READY_LAUNCH_INTENT_SQL,
  type ReadyLaunchIntentCandidate,
} from "@/lib/meta/launch-proposal-producer";
import { AUTOMATABLE_PROPOSAL_ACTIONS } from "@/lib/meta/automation-proposals";

/*
  The INSERT is read from source rather than executed: the arbiter is a property
  of the statement, and asserting it against a database double would only prove
  what the double was told to say.
*/
const insertLaunchProposalRowSource = readFileSync(
  "lib/meta/launch-proposal-producer.ts",
  "utf8",
);

const BUSINESS = "11111111-1111-4111-8111-111111111111";

function candidate(
  overrides: Partial<ReadyLaunchIntentCandidate> = {},
): ReadyLaunchIntentCandidate {
  return {
    intentId: "33333333-3333-4333-8333-333333333333",
    businessId: BUSINESS,
    providerAccountId: "act_1",
    operation: "new_campaign",
    createdAt: "2026-09-05T08:00:00.000Z",
    grain: "campaign",
    entityLabel: "September test — broad",
    ...overrides,
  };
}

describe("a validated intent reaches the queue", () => {
  it("raises one row per ready intent, labelled by what it will create", async () => {
    const inserted: Array<{ actionLabel: string; intentId: string }> = [];
    const result = await projectMetaLaunchProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-05",
      readCreativeMode: async () => "semi_auto",
      listCandidates: async () => [
        candidate(),
        candidate({
          intentId: "44444444-4444-4444-8444-444444444444",
          operation: "add_to_existing",
          grain: "ad",
        }),
      ],
      insertProposal: async (input) => {
        inserted.push({
          actionLabel: input.actionLabel,
          intentId: input.candidate.intentId,
        });
        return input.candidate.intentId;
      },
    });

    expect(result.projected).toBe(2);
    // The verb names the act, and the act is always "create it paused".
    expect(inserted.map((row) => row.actionLabel))
      .toEqual(["Create paused ad", "Create paused ad"]);
  });

  it("raises nothing while the creative mode is manual", async () => {
    const insert = vi.fn(async () => "id");
    const result = await projectMetaLaunchProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-05",
      readCreativeMode: async () => "manual",
      listCandidates: async () => [candidate()],
      insertProposal: insert,
    });
    expect(result.refusals).toEqual({ creative_mode_manual: 1 });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("what the producer will not do", () => {
  it("reads only intents that are STAGED and resting, never one mid-flight", () => {
    /*
      The producer used to select `ready` on the reasoning that `ready` meant
      "validated". It does not mean anything an operator can act on: `ready` is
      written by the validation recorder and consumed by the executing
      transition inside ONE HTTP request, so it is a millisecond-long transient
      in the middle of a create. `prepared` with no start time is the state an
      intent actually rests in, and it is the only state the execution service
      will accept.
    */
    expect(READY_LAUNCH_INTENT_SQL).toContain("i.status = 'prepared'");
    expect(READY_LAUNCH_INTENT_SQL).toContain("i.started_at IS NULL");
    expect(READY_LAUNCH_INTENT_SQL).not.toContain("i.status = 'ready'");
    /*
      And decision lineage, which is what tells a STAGED intent from the
      Launchpad wizard's own: the wizard writes a `prepared` intent and executes
      it in the same request, so without this the queue would race the operator
      for their own in-flight launch.
    */
    expect(READY_LAUNCH_INTENT_SQL).toContain("i.source_decision_id IS NOT NULL");
    expect(READY_LAUNCH_INTENT_SQL).toContain("i.creative_brief_id IS NOT NULL");
    // And it never re-raises one an operator has already decided.
    expect(READY_LAUNCH_INTENT_SQL).toContain("'launch:' || i.id::text");
  });

  it("arbitrates the insert on the index that can actually fire", () => {
    /*
      The projection index includes `rec_type`, which is NULL on every launch
      row, and NULL is distinct from NULL in a unique index — so that arbiter
      could never match and a second insert for the same intent raised on the
      open-slot index instead. The throw was swallowed at the BATCH level by
      the snapshot, so one duplicate silently dropped every remaining
      candidate and the failure looked like "the producer found nothing".
    */
    const sql = String(insertLaunchProposalRowSource);
    expect(sql).toContain(
      "ON CONFLICT (business_id, provider_account_id, decision_key, proposed_action)",
    );
    expect(sql).toContain("WHERE status IN ('pending', 'claimed', 'reconcile')");
  });

  it("absorbs one candidate's conflict and still projects the rest", async () => {
    const seen: string[] = [];
    const result = await projectMetaLaunchProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-05",
      readCreativeMode: async () => "auto",
      listCandidates: async () => [
        candidate({ intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
        candidate({ intentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
        candidate({ intentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
      ],
      insertProposal: async (input) => {
        seen.push(input.candidate.intentId);
        if (input.candidate.intentId.startsWith("bbbb")) {
          throw new Error(
            'duplicate key value violates unique constraint "uq_meta_automation_proposals_open_slot"',
          );
        }
        return input.candidate.intentId;
      },
    });

    // Every candidate was still attempted, and only the clashing one is lost.
    expect(seen).toHaveLength(3);
    expect(result.projected).toBe(2);
    expect(result.refusals).toEqual({ insert_conflicted: 1 });
  });

  it("puts launch in the unattended families, behind the Launchpad gate", () => {
    /*
      The old law said creating an entity with nobody present is a different
      authorization than changing one that already exists. That was true, and
      the authorization it named now exists and can be pointed at: the creative
      standing mode on `auto`, the separate META_LAUNCHPAD_EXECUTION gate open
      with no missing safety step, and the intent's own operator-staged payload
      replayed unchanged. So the action is dispatchable — and, just as
      importantly, COUNTED against the daily cap that bounds money-moving work.
    */
    expect([...AUTOMATABLE_PROPOSAL_ACTIONS]).toContain("launch");
    /*
      And the sweep drops it from the armed page when the Launchpad gate is
      shut, rather than claiming it and withholding it: a withheld outcome
      settles the row `failed`, so claiming under a closed gate would destroy
      rows an operator could still approve by hand.
    */
    const sweep = readFileSync(
      "lib/meta/budget-automation-scheduled.ts",
      "utf8",
    );
    expect(sweep).toContain('if (action === "launch" && !launchpadCreateOpen) return false;');
    expect(sweep).toContain('missingSteps(writeFamily("launchpad_create")).length === 0');
  });
});
