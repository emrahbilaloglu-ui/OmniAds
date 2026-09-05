/**
 * Finding 4, the creative family: the queue action nothing raised.
 *
 * `launch` became an allowed `proposed_action` with a CHECK requiring the
 * intent id on the row, and no producer ever wrote one. A validated launch
 * intent sat in `ready` where only the Launchpad screen could see it, so the
 * confirmation queue an operator works from in the morning never mentioned it.
 */
import { describe, expect, it, vi } from "vitest";

import {
  projectMetaLaunchProposals,
  READY_LAUNCH_INTENT_SQL,
  type ReadyLaunchIntentCandidate,
} from "@/lib/meta/launch-proposal-producer";
import { AUTOMATABLE_PROPOSAL_ACTIONS } from "@/lib/meta/automation-proposals";

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
  it("reads only intents that are validated and not yet executed", () => {
    /*
      `prepared` has not passed validation and everything from `executing`
      onwards has already reached a provider. Offering either would be offering
      an action that cannot be taken.
    */
    expect(READY_LAUNCH_INTENT_SQL).toContain("i.status = 'ready'");
    // And it never re-raises one an operator has already decided.
    expect(READY_LAUNCH_INTENT_SQL).toContain("'launch:' || i.id::text");
  });

  it("keeps launch out of the unattended families", () => {
    /*
      Creating an entity with nobody present is a different authorization than
      changing one that already exists. The row exists so an operator sees it,
      not so a scheduler executes it.
    */
    expect([...AUTOMATABLE_PROPOSAL_ACTIONS]).not.toContain("launch");
  });
});
