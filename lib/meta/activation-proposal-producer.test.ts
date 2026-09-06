/**
 * The other half of the launch story: created, and still switched off.
 *
 * A launch intent may only create PAUSED entities, so a successful launch is a
 * receipt for something nobody can see. Nothing raised a queue row for it and
 * the Launchpad receipt has no activation control, so a created campaign could
 * sit off indefinitely with nothing anywhere reminding the operator.
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import {
  ACTIVATABLE_LAUNCH_INTENT_SQL,
  activationActionLabel,
  projectMetaActivationProposals,
  type ActivatableLaunchIntentCandidate,
} from "@/lib/meta/activation-proposal-producer";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const INTENT = "33333333-3333-4333-8333-333333333333";

const producerSource = readFileSync(
  "lib/meta/activation-proposal-producer.ts",
  "utf8",
);

function candidate(
  overrides: Partial<ActivatableLaunchIntentCandidate> = {},
): ActivatableLaunchIntentCandidate {
  return {
    intentId: INTENT,
    businessId: BUSINESS,
    providerAccountId: "act_9",
    operation: "new_campaign",
    grain: "campaign",
    entityId: "120",
    entityLabel: "September test — broad",
    identities: { campaignId: "120", adsetId: "121", adIds: ["122"] },
    approvalPresent: false,
    createdAt: "2026-09-05T08:00:00.000Z",
    ...overrides,
  };
}

describe("what the producer raises", () => {
  it("raises one row per activatable intent, at the grain that launch owns", async () => {
    const inserted: Array<{ label: string; grain: string; entityId: string }> = [];
    const result = await projectMetaActivationProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-05",
      listCandidates: async () => [
        candidate(),
        candidate({
          intentId: "44444444-4444-4444-8444-444444444444",
          operation: "add_to_existing",
          grain: "ad",
          entityId: "122",
          identities: { campaignId: "900", adsetId: "901", adIds: ["122"] },
        }),
      ],
      insertProposal: async (input) => {
        inserted.push({
          label: input.actionLabel,
          grain: input.candidate.grain,
          entityId: input.candidate.entityId,
        });
        return input.candidate.intentId;
      },
    });

    expect(result.projected).toBe(2);
    /*
      A new-campaign launch owns its whole hierarchy, so the row points at the
      campaign. An add-to-existing launch joined somebody else's live ad set and
      owns only the ad it added — pointing its row at the campaign would offer
      to turn on somebody else's structure on the strength of one added ad.
    */
    expect(inserted.map((row) => row.grain)).toEqual(["campaign", "ad"]);
    expect(inserted.map((row) => row.entityId)).toEqual(["120", "122"]);
    /*
      And the tag names the sequence rather than the verb. The shared
      `proposalActionLabel` renders `resume` as "Resume campaign"/"Resume ad
      set" — it has no ad grain, so it would name the wrong entity here.
    */
    expect(inserted.map((row) => row.label))
      .toEqual(["Activate launch", "Activate new ad"]);
  });

  it("raises the row whether or not an approval exists", async () => {
    /*
      NULL `activation_approval_json` means operator-only, which is every
      intent's default. That is a statement about UNATTENDED dispatch, not about
      whether the operator should be told — and the sweep's own page filter is
      what keeps an unapproved one out of the unattended path.
    */
    const evidence: boolean[] = [];
    const result = await projectMetaActivationProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-05",
      listCandidates: async () => [
        candidate({ approvalPresent: false }),
        candidate({
          intentId: "55555555-5555-4555-8555-555555555555",
          approvalPresent: true,
        }),
      ],
      insertProposal: async (input) => {
        evidence.push(input.candidate.approvalPresent);
        return input.candidate.intentId;
      },
    });

    expect(result.projected).toBe(2);
    expect(evidence).toEqual([false, true]);
  });

  it("absorbs one candidate's insert conflict and still projects the rest", async () => {
    const seen: string[] = [];
    const result = await projectMetaActivationProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-05",
      listCandidates: async () => [
        candidate({ intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
        candidate({ intentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
        candidate({ intentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
      ],
      insertProposal: async (input) => {
        seen.push(input.candidate.intentId);
        if (input.candidate.intentId.startsWith("bbbb")) {
          throw new Error("duplicate key value violates unique constraint");
        }
        return input.candidate.intentId;
      },
    });

    expect(seen).toHaveLength(3);
    expect(result.projected).toBe(2);
    expect(result.refusals).toEqual({ insert_conflicted: 1 });
  });
});

describe("what the candidate query will and will not offer", () => {
  it("reads only launches that produced something", async () => {
    // `prepared`, `executing` and `failed` created nothing to turn on;
    // `partially_succeeded` created entities that are off and can still be
    // completed, because activation only ever changes a status.
    expect(ACTIVATABLE_LAUNCH_INTENT_SQL)
      .toContain("i.status IN ('succeeded', 'partially_succeeded')");
  });

  it("stops offering one that is already delivering, and only then", async () => {
    /*
      A blocked or ambiguous activation receipt leaves work an operator may
      still want to finish, and a half-activated hierarchy is exactly the row
      that must not vanish from the queue.
    */
    expect(ACTIVATABLE_LAUNCH_INTENT_SQL).toContain(
      "COALESCE((i.activation_receipt_json ->> 'delivering')::boolean, FALSE) = FALSE",
    );
  });

  it("never re-raises one an operator has already decided", async () => {
    expect(ACTIVATABLE_LAUNCH_INTENT_SQL).toContain("'activate:' || i.id::text");
    /*
      The arm names the outcomes that CONSUMED the intent, and it used to be the
      complement of the undecided pair — which swept in `expired` and so dropped
      a created-but-paused launch from the queue forever once its 24h row aged
      out. `expired` is written only where no dispatch began. See
      `launch-proposal-expiry-reoffer.test.ts` for the whole classification.
    */
    expect(ACTIVATABLE_LAUNCH_INTENT_SQL).toContain(
      "NOT IN ('pending', 'claimed', 'expired')",
    );
  });
});

describe("the row can never be mistaken for an ordinary un-pause", () => {
  it("always sets the launch lineage, under the operator origin", async () => {
    /*
      The lineage is not decoration. It is what the standing-mode resolver, the
      sweep's runtime selection and the queue executor all read to tell an
      activation from a plain `resume` — and a `resume` without it is dispatched
      one entity at a time with no approval check.
    */
    expect(producerSource).toContain("'operator_action'");
    expect(producerSource).toContain("launch_intent_id");
    expect(producerSource).toContain("input.candidate.intentId,");
  });

  it("arbitrates the insert on the index that can actually fire", async () => {
    // rec_type is NULL on an operator-origin row, and NULL is distinct from
    // NULL in a unique index, so the projection index can never arbitrate one.
    expect(producerSource).toContain(
      "ON CONFLICT (business_id, provider_account_id, decision_key, proposed_action)",
    );
    expect(producerSource).toContain(
      "WHERE status IN ('pending', 'claimed', 'reconcile')",
    );
  });

  it("labels by what the intent created, not by the verb", () => {
    expect(activationActionLabel({ operation: "new_campaign" }))
      .toBe("Activate launch");
    expect(activationActionLabel({ operation: "add_to_existing" }))
      .toBe("Activate new ad");
  });
});
