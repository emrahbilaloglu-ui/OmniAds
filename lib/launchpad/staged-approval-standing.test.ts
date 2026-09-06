/**
 * Does the approval a launch intent was staged under still stand?
 *
 * `verifyMetaLaunchIntentLineage` ran once, inside `createMetaLaunchIntent`,
 * and nothing asked again. An intent stores the brief's ID and not its status,
 * so every immutability check between the staging and the provider POST — the
 * account, the operation, the idempotency key, the request fingerprint, the
 * four lineage ids — still matched after the brief behind those ids had been
 * moved back to `draft`.
 *
 * These cases pin what counts as a withdrawal and, just as importantly, what
 * does not. A guard that refused every edited brief would be as wrong as the
 * one that refused none: `patchMetaCreativeBrief` leaves a brief `reviewed`
 * when the edit re-states the review, and that launch must still run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/meta/creative-brief-store", () => ({
  readMetaCreativeBrief: vi.fn(),
}));

import { getDb } from "@/lib/db";
import { readMetaCreativeBrief } from "@/lib/meta/creative-brief-store";
import {
  buildMetaCreativeDecisionId,
  type MetaCreativeBrief,
} from "@/lib/meta/creative-brief-contract";
import type { MetaLaunchIntentLineage } from "@/lib/launchpad/meta-launch-intent";
import {
  readMetaLaunchIntentApprovalStanding,
  verifyMetaLaunchIntentLineage,
} from "@/lib/launchpad/meta-launch-intent-lineage";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "act_9";
const BRIEF = "44444444-4444-4444-8444-444444444444";
const DRAFT = "55555555-5555-4555-8555-555555555555";
const SNAPSHOT = "66666666-6666-4666-8666-666666666666";
const DECISION = "meta:decision:account:act_9:23851000000077";

/** The lineage the launch-intent producer writes for a staged decision. */
function lineage(overrides: Partial<MetaLaunchIntentLineage> = {}): MetaLaunchIntentLineage {
  return {
    sourceDecisionId: DECISION,
    sourceDecisionSnapshotId: SNAPSHOT,
    creativeBriefId: BRIEF,
    sourceDraftId: DRAFT,
    ...overrides,
  };
}

function brief(overrides: Partial<MetaCreativeBrief> = {}): MetaCreativeBrief {
  return {
    contractVersion: "meta_creative_brief_v1",
    id: BRIEF,
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    sourceDecision: {
      decisionId: DECISION,
      snapshotId: SNAPSHOT,
      creativeId: "23851000000077",
      engineVersion: "v3",
      snapshotAsOf: "2026-09-04",
      scopeType: "account",
      scopeId: ACCOUNT,
      publishedLabel: "scale",
      rawLabel: "scale",
      reason: "Sustained ROAS above target",
      badges: [],
      trigger: "decision_card",
    },
    content: { keep: "Keep it", change: "Nothing", next: "Promote it" },
    status: "reviewed",
    version: 3,
    createdBy: null,
    updatedBy: null,
    reviewedBy: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-09-04T08:00:00.000Z",
    updatedAt: "2026-09-04T09:00:00.000Z",
    reviewedAt: "2026-09-04T09:00:00.000Z",
    ...overrides,
  } as MetaCreativeBrief;
}

/**
 * The two reads this path can run, answered by which table the SQL names.
 *
 * A brief-bound intent only ever runs the draft-existence read. An intent whose
 * approval IS a decision snapshot runs the snapshot read as well, and the two
 * have to be answerable apart or the decision cases would pass on the draft's
 * answer.
 */
function dbRows(input: {
  drafts?: Array<{ id: string }>;
  snapshots?: Array<Record<string, string>>;
}) {
  const query = vi.fn(async (sql: string) =>
    sql.includes("engine_v3_decision_snapshots_daily")
      ? (input.snapshots ?? [])
      : (input.drafts ?? []),
  );
  vi.mocked(getDb).mockReturnValue({ query } as never);
  return query;
}

/** The draft-existence read, which is the only SQL a brief-bound intent runs. */
function draftRows(rows: Array<{ id: string }>) {
  return dbRows({ drafts: rows });
}

/** The account-scoped snapshot a decision-only intent's approval resolves to. */
const DECISION_ONLY_CREATIVE = "23851000000099";
const DECISION_ONLY_ID = buildMetaCreativeDecisionId({
  businessId: BUSINESS,
  providerAccountId: ACCOUNT,
  creativeId: DECISION_ONLY_CREATIVE,
  scopeType: "account",
  scopeId: ACCOUNT,
});
const DECISION_ONLY_SNAPSHOT_ROW = {
  snapshot_id: SNAPSHOT,
  creative_id: DECISION_ONLY_CREATIVE,
  scope_type: "account",
  scope_id: ACCOUNT,
};

beforeEach(() => {
  vi.clearAllMocks();
  draftRows([{ id: DRAFT }]);
  vi.mocked(readMetaCreativeBrief).mockResolvedValue(brief());
});

describe("an approval that still stands", () => {
  it("accepts a reviewed brief whose decision binding and draft are intact", async () => {
    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage(),
    });

    expect(standing).toEqual({ stands: true });
  });

  it("accepts a brief that was EDITED and re-reviewed", async () => {
    /*
      The other half of the rule. `patchMetaCreativeBrief` keeps a brief
      `reviewed` when the patch re-states the status, and bumps its version and
      review timestamp either way. Nothing here reads the text, the version or
      the timestamp, so an operator tidying the words of an approval they still
      stand behind does not stop the launch.
    */
    vi.mocked(readMetaCreativeBrief).mockResolvedValue(
      brief({
        content: { keep: "Keep it — tightened", change: "Nothing", next: "Promote it" },
        version: 9,
        updatedAt: "2026-09-06T10:00:00.000Z",
        reviewedAt: "2026-09-06T10:00:00.000Z",
      }),
    );

    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage(),
    });

    expect(standing).toEqual({ stands: true });
  });

  it("accepts an intent that binds no approval at all, and reads nothing", async () => {
    /*
      An intent with neither a brief nor a decision was composed and confirmed
      on the Launchpad screen. Its authority is the operator confirmation inside
      its own request fingerprint, which every caller already re-checks; there
      is no staged approval here for a later edit to withdraw.
    */
    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage({
        creativeBriefId: null,
        sourceDecisionId: null,
        sourceDecisionSnapshotId: null,
      }),
    });

    expect(standing).toEqual({ stands: true });
    expect(readMetaCreativeBrief).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("re-asks the DECISION for an intent that binds one and no brief", async () => {
    /*
      The exemption above used to cover this shape too, and it was safe only by
      accident: the sole writer of decision lineage joins a brief, so no such
      intent exists today. `createMetaLaunchIntent` accepts one and
      `READY_LAUNCH_INTENT_SQL` would make it queue-eligible, with zero reads
      and `stands: true` — an approval nobody ever re-asked about.
    */
    dbRows({ drafts: [{ id: DRAFT }], snapshots: [DECISION_ONLY_SNAPSHOT_ROW] });

    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage({
        creativeBriefId: null,
        sourceDecisionId: DECISION_ONLY_ID,
      }),
    });

    expect(standing).toEqual({ stands: true });
    // The decision snapshot itself, resolved in THIS account — not the brief
    // read, which such an intent has nothing to point at.
    expect(readMetaCreativeBrief).not.toHaveBeenCalled();
    expect(getDb).toHaveBeenCalled();
  });
});

describe("the withdrawal that can really happen", () => {
  it("names creative_brief_not_reviewed when the brief went back to draft", async () => {
    /*
      The only reachable brief-side withdrawal, and the one an operator can
      produce twice over: an explicit revert to `draft`, and a content edit that
      states no status, which the shipped UPDATE forces to `draft`.
    */
    vi.mocked(readMetaCreativeBrief).mockResolvedValue(
      brief({ status: "draft", reviewedBy: null, reviewedAt: null }),
    );

    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage(),
    });

    expect(standing.stands).toBe(false);
    expect(standing.stands === false && standing.code).toBe(
      "creative_brief_not_reviewed",
    );
  });
});

describe("the decision an intent with no brief was staged under", () => {
  it("names source_decision_not_found when the snapshot is gone from the account", async () => {
    dbRows({ drafts: [{ id: DRAFT }], snapshots: [] });

    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage({
        creativeBriefId: null,
        sourceDecisionId: DECISION_ONLY_ID,
      }),
    });

    expect(standing.stands === false && standing.code).toBe(
      "source_decision_not_found",
    );
  });

  it("is not asked for a decision lineage that names no snapshot, because creation refuses one", async () => {
    /*
      The re-ask is keyed on the approval sources that can be RE-RESOLVED: a
      brief, or a snapshot. A lineage naming a decision and no snapshot is not
      a third case for this function to answer — creation refuses it, which is
      what the second half of this case proves, so no stored intent has it.
    */
    dbRows({ drafts: [{ id: DRAFT }] });

    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage({
        creativeBriefId: null,
        sourceDecisionId: DECISION_ONLY_ID,
        sourceDecisionSnapshotId: null,
      }),
    });

    expect(standing).toEqual({ stands: true });
    await expect(
      verifyMetaLaunchIntentLineage({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        sourceDecisionId: DECISION_ONLY_ID,
      }),
    ).rejects.toMatchObject({ code: "source_decision_snapshot_required" });
  });

  it("names source_decision_mismatch when the snapshot is a different decision", async () => {
    dbRows({
      drafts: [{ id: DRAFT }],
      snapshots: [{ ...DECISION_ONLY_SNAPSHOT_ROW, creative_id: "23851000000078" }],
    });

    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage({
        creativeBriefId: null,
        sourceDecisionId: DECISION_ONLY_ID,
      }),
    });

    expect(standing.stands === false && standing.code).toBe(
      "source_decision_mismatch",
    );
  });
});

/**
 * States the schema currently forbids, kept because this is the guard.
 *
 * None of these three can happen to a stored, brief-bound intent:
 * `meta_launch_intents.creative_brief_id` and `.source_draft_id` are
 * `ON DELETE RESTRICT`, and a brief's source decision is written once by the
 * INSERT — the single UPDATE never touches it and the patch parser refuses any
 * body that names `sourceDecision`. They are mocked here as defence in depth,
 * not as production scenarios: if a later migration relaxes one of those
 * constraints, the answer has to already exist rather than be discovered.
 */
describe("defence in depth: states the schema forbids today", () => {
  it("names creative_brief_not_found when the brief is gone", async () => {
    vi.mocked(readMetaCreativeBrief).mockResolvedValue(null);

    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage(),
    });

    expect(standing.stands === false && standing.code).toBe(
      "creative_brief_not_found",
    );
  });

  it("names source_decision_mismatch when the brief now points elsewhere", async () => {
    // The exact approved SOURCE binding, not merely "a reviewed brief exists".
    vi.mocked(readMetaCreativeBrief).mockResolvedValue(
      brief({
        sourceDecision: {
          ...brief().sourceDecision,
          snapshotId: "77777777-7777-4777-8777-777777777777",
        },
      }),
    );

    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage(),
    });

    expect(standing.stands === false && standing.code).toBe(
      "source_decision_mismatch",
    );
  });

  it("names source_draft_not_found when the composed launch was deleted", async () => {
    draftRows([]);

    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage(),
    });

    expect(standing.stands === false && standing.code).toBe(
      "source_draft_not_found",
    );
  });
});

describe("a state nobody can read", () => {
  it("fails closed rather than treating an unreadable brief as unchanged", async () => {
    vi.mocked(readMetaCreativeBrief).mockRejectedValue(new Error("db down"));

    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage(),
    });

    expect(standing.stands === false && standing.code).toBe(
      "launch_approval_source_unreadable",
    );
  });

  it("fails closed when the draft read throws", async () => {
    const query = vi.fn(async () => {
      throw new Error("statement timeout");
    });
    vi.mocked(getDb).mockReturnValue({ query } as never);

    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      lineage: lineage(),
    });

    expect(standing.stands === false && standing.code).toBe(
      "launch_approval_source_unreadable",
    );
  });
});
