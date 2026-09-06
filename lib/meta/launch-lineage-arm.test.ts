/**
 * A queue row must be able to name the launch intent it is about.
 *
 * Two facts are pinned here, and they are the pair that makes the rest of the
 * activation work safe to build on.
 *
 * The first is a database rule. Turning on what a Launchpad launch created is
 * raised as `resume`, the same verb the engine already uses for ordinary
 * un-pausing, so the action alone cannot tell the two apart. An activation row
 * that lost its lineage would read as an ordinary resume: armed by the pause
 * standing mode, dispatched by the status runtimes, with no activation
 * approval, no campaign -> ad set -> ad ordering and no route back to the
 * intent that authorized it. The CHECK makes such a row unstorable.
 *
 * The second is the reading rule. `decisionTypeForProposal` resolves the
 * standing family from the ROW, so the one place that decides which mode
 * governs an unattended dispatch asks the lineage rather than the verb.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  runDbTransaction: vi.fn(async (run: () => Promise<unknown>) => run()),
}));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));
vi.mock("@/lib/meta/automation-guardrail-policy", () => ({
  readMetaAutomationProposalRoasFloor: vi.fn(),
}));

const dbModule = await import("@/lib/db");

import { readMetaAutomationProposal } from "@/lib/meta/automation-proposals";
import {
  decisionTypeForProposal,
  decisionTypeForProposedAction,
} from "@/lib/meta/scheduled-action-execution";

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-09-05T12:00:00.000Z";

/** The stored shape of one row, before the mapper sees it. */
function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL_ID,
    business_id: BUSINESS_ID,
    provider_account_id: "act_1",
    origin: "operator_action",
    rule_id: null,
    dedupe_key: null,
    decision_key: `activate:${INTENT_ID}`,
    scope_type: "campaign",
    scope_id: "camp_1",
    rec_id: null,
    rec_type: null,
    snapshot_date: "2026-09-04",
    engine_version: null,
    decision_label: null,
    proposed_action: "resume",
    action_label: "Activate campaign",
    primary_caption: "Approve & apply",
    entity_label: "Prospecting — broad",
    reason: "The launch is created and paused; activation publishes it.",
    evidence_label: null,
    evidence_ref: {},
    expires_at: NOW,
    status: "pending",
    decided_by: null,
    decided_at: null,
    decision_note: null,
    receipt_json: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/**
 * A db double that answers per call and records the statement it was handed.
 *
 * The fallback path is the point of the second answer, so a call may also be
 * asked to raise PostgreSQL's `undefined_column` rather than return rows.
 */
function respondingDb(answers: Array<Array<Record<string, unknown>> | Error>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tagged = () => Promise.resolve([]);
  (tagged as unknown as { query: unknown }).query = (
    text: string,
    values: unknown[],
  ) => {
    calls.push({ text, values });
    const next = answers.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? []);
  };
  return { tagged, calls };
}

function undefinedColumnError(): Error {
  const error = new Error(
    'column "launch_intent_id" does not exist',
  ) as Error & { code?: string };
  error.code = "42703";
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the activation lineage CHECK", () => {
  const source = readFileSync("lib/migrations.ts", "utf8");

  it("makes an operator-staged resume row without an intent unstorable", () => {
    expect(source).toContain(
      "ADD CONSTRAINT meta_automation_proposals_activation_lineage",
    );
    /*
      The predicate, whitespace-insensitively. The three arms in this order are
      the whole rule: any action other than `resume` is unaffected, any origin
      other than the operator's own is unaffected, and what is left — the rows
      the activation producer will raise — must name an intent.
    */
    const predicate = source
      .slice(source.indexOf("meta_automation_proposals_activation_lineage\n"))
      .replace(/\s+/g, " ");
    expect(predicate).toContain(
      "CHECK ( proposed_action <> 'resume' OR origin <> 'operator_action' "
        + "OR launch_intent_id IS NOT NULL )",
    );
  });

  it("is additive: it is added beside the launch rule, never in place of it", () => {
    // A `launch` row has no meaning without an intent whatever its origin, so
    // that rule is the stricter of the two and must survive untouched.
    expect(source).toContain(
      "ADD CONSTRAINT meta_automation_proposals_launch_lineage",
    );
    expect(source).toContain(
      "CHECK (proposed_action <> 'launch' OR launch_intent_id IS NOT NULL)",
    );
    // Guarded by name, so re-running the migration on a database that already
    // carries the constraint is a no-op rather than a failure.
    expect(source).toContain(
      "AND c.conname = 'meta_automation_proposals_activation_lineage'",
    );
  });

  it("leaves the PAUSED-only creation rule alone", () => {
    /*
      A launch authorizes creation, never publication. Nothing in this item may
      widen the status a launch intent is allowed to request; activation is a
      separate, separately approved act.
    */
    expect(source).toContain(
      "requested_status            TEXT NOT NULL DEFAULT 'PAUSED' "
        + "CHECK (requested_status = 'PAUSED')",
    );
  });
});

describe("reading a row's launch lineage", () => {
  it("selects the intent id as text and maps it onto the proposal", async () => {
    const { tagged, calls } = respondingDb([
      [dbRow({ launch_intent_id: INTENT_ID })],
    ]);
    vi.mocked(dbModule.getDb).mockReturnValue(tagged as never);

    const proposal = await readMetaAutomationProposal({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      proposalId: PROPOSAL_ID,
    });

    expect(calls[0]!.text).toContain(
      "launch_intent_id::text AS launch_intent_id",
    );
    expect(proposal?.launchIntentId).toBe(INTENT_ID);
  });

  it("degrades to null on a database that predates the lineage column", async () => {
    /*
      The same degradation the claim and envelope columns already have, and it
      is a READ that degrades, not a decision. Null here means "this database
      cannot say", which is why every executor that needs the lineage refuses
      on null rather than proceeding without it.
    */
    const { tagged, calls } = respondingDb([
      undefinedColumnError(),
      [dbRow()],
    ]);
    vi.mocked(dbModule.getDb).mockReturnValue(tagged as never);

    const proposal = await readMetaAutomationProposal({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      proposalId: PROPOSAL_ID,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.text).not.toContain("launch_intent_id");
    expect(proposal?.id).toBe(PROPOSAL_ID);
    expect(proposal?.launchIntentId).toBeNull();
  });
});

describe("decisionTypeForProposal", () => {
  it("reads a resume row carrying an intent as the creative family", () => {
    /*
      The defect. By its verb this row is a resume, and the pause mode would
      arm it: an operator who turned on unattended pausing would be dispatching
      an activation they never armed, publishing ads that were created paused
      on purpose.
    */
    expect(
      decisionTypeForProposal({
        proposedAction: "resume",
        launchIntentId: INTENT_ID,
      }),
    ).toBe("creative");
  });

  it("reads a resume row with no lineage as the pause family, unchanged", () => {
    expect(
      decisionTypeForProposal({ proposedAction: "resume", launchIntentId: null }),
    ).toBe("pause");
  });

  it("treats an unreadable lineage as no lineage, never as an activation", () => {
    // A pre-migration read yields null, and the answer there must be the old
    // one: nothing may become a creative dispatch because a column was missing.
    expect(
      decisionTypeForProposal({ proposedAction: "pause", launchIntentId: null }),
    ).toBe("pause");
  });

  it("routes a launch row to creative whether or not the lineage is readable", () => {
    expect(
      decisionTypeForProposal({
        proposedAction: "launch",
        launchIntentId: INTENT_ID,
      }),
    ).toBe("creative");
    expect(
      decisionTypeForProposal({ proposedAction: "launch", launchIntentId: null }),
    ).toBe("creative");
  });

  it("delegates every other action to the verb-only resolver, unchanged", () => {
    const actions = [
      "bid", "budget", "duplicate", "launch", "pause", "resume",
    ] as const;
    for (const action of actions) {
      expect(
        decisionTypeForProposal({ proposedAction: action, launchIntentId: null }),
      ).toBe(decisionTypeForProposedAction(action));
    }
  });
});

describe("decisionTypeForProposedAction keeps its pinned cases", () => {
  it("still answers by verb for callers that only have one", () => {
    expect(decisionTypeForProposedAction("bid")).toBe("bid");
    expect(decisionTypeForProposedAction("budget")).toBe("budget");
    expect(decisionTypeForProposedAction("duplicate")).toBe("creative");
    expect(decisionTypeForProposedAction("launch")).toBe("creative");
    expect(decisionTypeForProposedAction("pause")).toBe("pause");
    expect(decisionTypeForProposedAction("resume")).toBe("pause");
  });
});
