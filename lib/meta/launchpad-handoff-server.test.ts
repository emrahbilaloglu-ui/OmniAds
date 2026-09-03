import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { LaunchpadHandoffEnvelope } from "@/lib/meta/launchpad-handoff-contract";

/**
 * The LANDING half of the handoff: what is re-checked, in what order, and what
 * the wizard is allowed to be told afterwards.
 *
 * The consume itself (token, TTL, single use, business/account/actor) has its
 * own real-PostgreSQL seam in `launchpad-handoff.db.test.ts`, because those are
 * claims about SQL. What is asserted HERE is everything the consume cannot see:
 *
 *   1. write authority is checked BEFORE the token is burned, so a reviewer
 *      following a forwarded link cannot destroy the handoff of the operator
 *      who minted it;
 *   2. a decision handoff re-reads the CURRENT canonical decision and re-runs
 *      the same pure authorization law over it, so a decision that has since
 *      been held, blocked, made review-only or withdrawn opens nothing;
 *   3. a verdict that moved (Scale -> Refresh) refuses rather than silently
 *      opening a different workflow;
 *   4. the selection and lineage handed to the wizard come from the RE-READ,
 *      not from the fifteen-minute-old copy in the record;
 *   5. a copy handoff never re-reads a decision, because it never claimed one.
 *
 * The real `authorizeLaunchpadHandoff` is used throughout. Mocking it would
 * make every one of these assertions a statement about the mock.
 */

const handoffMocks = vi.hoisted(() => ({
  consume: vi.fn(),
  readConsumed: vi.fn(),
}));

vi.mock("@/lib/meta/launchpad-handoff", async () => {
  // The pure contract, unmocked. Only the two I/O functions are replaced, so
  // `authorizeLaunchpadHandoff` below is the same law the mint side runs.
  const contract = await import("@/lib/meta/launchpad-handoff-contract");
  return {
    ...contract,
    consumeLaunchpadHandoff: handoffMocks.consume,
    readConsumedLaunchpadHandoff: handoffMocks.readConsumed,
  };
});

const {
  landLaunchpadHandoff,
  readLaunchpadHandoffPrefill,
} = await import("@/lib/meta/launchpad-handoff-server");

const HANDOFF_ID = "0f1e2d3c-4b5a-4c7d-8e9f-a0b1c2d3e4f5";
const REFERENCE = `${HANDOFF_ID}.${"a".repeat(43)}`;

function decision(
  overrides: Record<string, unknown> = {},
): MetaCanonicalDecision {
  return {
    decisionId: "dec_1",
    episodeId: "ep_1",
    sourceSnapshotId: "snap_1",
    providerAccountId: "act_1",
    identityGrain: "ad",
    sourceAuthority: {
      status: "native_exact",
      actionEligible: true,
      reviewOnlyReason: null,
      snapshotId: "snap_1",
      evaluationId: "eval_1",
      inputHash: "input_hash",
      decisionHash: "decision_hash",
      providerAccountRefId: "ref_1",
      engineVersion: "engine-v3",
      realAdId: "ad_1",
      authorizedAction: "refresh",
      jobRunId: "job_1",
      executionReadiness: "live_preflight_required",
    },
    sourceDecision: {
      snapshotAsOf: "2026-08-17",
      computedAt: "2026-08-17T06:00:00.000Z",
    },
    parentChain: {
      campaign: { id: "camp_current" },
      adset: { id: "adset_current" },
      ad: { id: "ad_current" },
      creative: { id: "cre_current" },
    },
    deliveryScope: {
      state: "active",
      campaignStatus: "ACTIVE",
      adsetStatus: "ACTIVE",
      adStatus: "ACTIVE",
      reason: "active_hierarchy",
    },
    classification: {
      decisionState: "act",
      heldAction: null,
      blockers: [],
      lifecycleRole: { value: "main" },
    },
    ...overrides,
  } as unknown as MetaCanonicalDecision;
}

function envelope(
  overrides: Partial<LaunchpadHandoffEnvelope> = {},
): LaunchpadHandoffEnvelope {
  return {
    version: "v1",
    handoffId: HANDOFF_ID,
    tokenHash: "f".repeat(64),
    businessId: "biz_1",
    providerAccountId: "act_1",
    createdByUserId: "user_1",
    origin: "decision",
    authorizedAction: "refresh",
    mode: "rebuild",
    actionEligible: true,
    exactAdExecutionEligible: true,
    sourceAuthorityStatus: "native_exact",
    lineage: {
      sourceDecisionId: "dec_1",
      sourceSnapshotId: "snap_1",
      episodeId: "ep_1",
      engineVersion: "engine-v3",
      snapshotAsOf: "2026-08-17",
      decisionHash: "decision_hash",
      inputHash: "input_hash",
      campaignId: "camp_stale",
      adsetId: "adset_stale",
      adId: "ad_stale",
      creativeId: "cre_stale",
    },
    selection: {
      campaignIds: [],
      adsetIds: [],
      adIds: ["ad_stale"],
      creativeIds: ["cre_stale"],
    },
    evidenceWindow: {
      basis: "decision_snapshot",
      startDate: null,
      endDate: null,
      snapshotAsOf: "2026-08-17",
      computedAt: "2026-08-17T06:00:00.000Z",
    },
    copy: null,
    createdAt: "2026-08-17T10:00:00.000Z",
    expiresAt: "2026-08-17T10:15:00.000Z",
    consumedAt: "2026-08-17T10:01:00.000Z",
    ...overrides,
  } as LaunchpadHandoffEnvelope;
}

const BASE = {
  reference: REFERENCE,
  businessId: "biz_1",
  providerAccountId: "act_1",
  actorUserId: "user_1",
  canMutate: true,
};

function readsDecision(result: unknown) {
  return vi.fn(async () => result as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  handoffMocks.consume.mockResolvedValue({ ok: true, envelope: envelope() });
});

describe("landLaunchpadHandoff", () => {
  it("refuses a viewer with no write authority WITHOUT burning the token", async () => {
    const result = await landLaunchpadHandoff({
      ...BASE,
      canMutate: false,
      readDecision: readsDecision({ status: "found", decision: decision() }),
    });

    expect(result).toEqual({ ok: false, refusal: "write_authority_revoked" });
    // The record has to survive: a reviewer opening a forwarded link must not
    // be able to consume the handoff its owner is about to use.
    expect(handoffMocks.consume).not.toHaveBeenCalled();
  });

  it("passes this request's identity to the consume, not the record's", async () => {
    await landLaunchpadHandoff({
      ...BASE,
      readDecision: readsDecision({ status: "found", decision: decision() }),
    });

    expect(handoffMocks.consume).toHaveBeenCalledWith({
      reference: REFERENCE,
      businessId: "biz_1",
      providerAccountId: "act_1",
      actorUserId: "user_1",
      now: undefined,
    });
  });

  it("carries a consume refusal through unchanged", async () => {
    handoffMocks.consume.mockResolvedValue({
      ok: false,
      refusal: "already_consumed",
    });

    expect(
      await landLaunchpadHandoff({
        ...BASE,
        readDecision: readsDecision({ status: "found", decision: decision() }),
      }),
    ).toEqual({ ok: false, refusal: "already_consumed" });
  });

  it("re-reads the decision the record names, by id AND snapshot id", async () => {
    const readDecision = readsDecision({
      status: "found",
      decision: decision(),
    });

    await landLaunchpadHandoff({ ...BASE, readDecision });

    expect(readDecision).toHaveBeenCalledWith({
      businessId: "biz_1",
      providerAccountId: "act_1",
      decisionId: "dec_1",
      sourceSnapshotId: "snap_1",
    });
  });

  // The prefill has to describe the world as it is NOW. Carrying the minted
  // copy forward would preselect a campaign the decision has since moved off.
  it("prefers the re-read's lineage and selection over the stored copy", async () => {
    const result = await landLaunchpadHandoff({
      ...BASE,
      readDecision: readsDecision({ status: "found", decision: decision() }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.lineage?.creativeId).toBe("cre_current");
    expect(result.envelope.selection.creativeIds).toEqual(["cre_current"]);
    expect(result.envelope.selection.adIds).toEqual(["ad_current"]);
  });

  it("refuses a decision the account no longer serves", async () => {
    expect(
      await landLaunchpadHandoff({
        ...BASE,
        readDecision: readsDecision({ status: "not_served" }),
      }),
    ).toEqual({ ok: false, refusal: "decision_not_served" });
  });

  // An unreadable decision source is not an absent decision. It refuses under
  // its own name so the operator is told the read failed rather than being told
  // their decision disappeared.
  it("refuses an unreadable decision source under its own name", async () => {
    expect(
      await landLaunchpadHandoff({
        ...BASE,
        readDecision: readsDecision({
          status: "source_unavailable",
          message: "down",
        }),
      }),
    ).toEqual({ ok: false, refusal: "decision_source_unavailable" });
  });

  // The canonical invariant, enforced at LANDING time: "A blocked, held,
  // review-only, or action-ineligible canonical decision must not map to any
  // Launchpad mode." A handoff minted while the decision was actionable must
  // still refuse once the engine holds or blocks it.
  it.each([
    [
      "held",
      { classification: { decisionState: "act", heldAction: "cut", blockers: [] } },
      "decision_held",
    ],
    [
      "blocked",
      {
        classification: {
          decisionState: "blocked",
          heldAction: null,
          blockers: [],
        },
      },
      "decision_blocked",
    ],
    [
      "action-ineligible",
      {
        sourceAuthority: {
          status: "native_exact",
          actionEligible: false,
          engineVersion: "engine-v3",
          authorizedAction: "refresh",
          snapshotId: "snap_1",
          evaluationId: null,
          inputHash: null,
          decisionHash: null,
          providerAccountRefId: null,
          realAdId: null,
          jobRunId: null,
          reviewOnlyReason: null,
        },
      },
      "action_not_eligible",
    ],
    [
      "demo-synthetic",
      {
        sourceAuthority: {
          status: "demo_synthetic_review_only",
          actionEligible: true,
          engineVersion: "engine-v3",
          authorizedAction: "refresh",
          snapshotId: "snap_1",
          evaluationId: null,
          inputHash: null,
          decisionHash: null,
          providerAccountRefId: null,
          realAdId: null,
          jobRunId: null,
          reviewOnlyReason: null,
        },
      },
      "demo_synthetic_review_only",
    ],
  ])(
    "refuses a handoff whose decision is now %s",
    async (_label, overrides, refusal) => {
      expect(
        await landLaunchpadHandoff({
          ...BASE,
          readDecision: readsDecision({
            status: "found",
            decision: decision(overrides),
          }),
        }),
      ).toEqual({ ok: false, refusal });
    },
  );

  // A Rebuild that has become a Scale is a different launch. Opening it under
  // the mode the record was minted with would run the operator's Refresh intent
  // through the Duplicate workflow.
  it("refuses when the current verdict maps to a different mode", async () => {
    expect(
      await landLaunchpadHandoff({
        ...BASE,
        readDecision: readsDecision({
          status: "found",
          decision: decision({
            sourceAuthority: {
              status: "native_exact",
              actionEligible: true,
              engineVersion: "engine-v3",
              authorizedAction: "scale",
              snapshotId: "snap_1",
              evaluationId: null,
              inputHash: null,
              decisionHash: null,
              providerAccountRefId: null,
              realAdId: null,
              jobRunId: null,
              reviewOnlyReason: null,
              executionReadiness: "live_preflight_required",
            },
            classification: {
              ...(decision().classification as object),
              lifecycleRole: { value: "test" },
            },
          }),
        }),
      }),
    ).toEqual({ ok: false, refusal: "decision_authority_changed" });
  });

  // A copy handoff has no decision to re-read and must not invent one. It is
  // discovery evidence: it opens a draft and carries no execution authority.
  it("never re-reads a decision for a copy handoff", async () => {
    const readDecision = readsDecision({ status: "not_served" });
    handoffMocks.consume.mockResolvedValue({
      ok: true,
      envelope: envelope({
        origin: "copy",
        mode: "copy_draft",
        authorizedAction: null,
        actionEligible: false,
        exactAdExecutionEligible: false,
        sourceAuthorityStatus: "warehouse_discovery",
        lineage: null,
        copy: {
          copyId: "copy:cre_1",
          alternateId: "alt-1",
          alternateText: "Second line Meta served",
          sourceText: "First line",
          assetType: "primary_text",
        },
      }),
    });

    const result = await landLaunchpadHandoff({ ...BASE, readDecision });

    expect(readDecision).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.authorizedAction).toBeNull();
    expect(result.envelope.actionEligible).toBe(false);
    expect(result.envelope.exactAdExecutionEligible).toBe(false);
  });
});

describe("readLaunchpadHandoffPrefill", () => {
  it("reads nothing and claims nothing when no record is named", async () => {
    expect(await readLaunchpadHandoffPrefill({
      handoffId: "  ",
      businessId: "biz_1",
      providerAccountId: "act_1",
      actorUserId: "user_1",
    })).toEqual({ status: "none" });
    expect(handoffMocks.readConsumed).not.toHaveBeenCalled();
  });

  it("turns a readable record into a typed prefill with the server's own summary", async () => {
    handoffMocks.readConsumed.mockResolvedValue({
      ok: true,
      envelope: envelope(),
    });

    const result = await readLaunchpadHandoffPrefill({
      handoffId: HANDOFF_ID,
      businessId: "biz_1",
      providerAccountId: "act_1",
      actorUserId: "user_1",
    });

    expect(result.status).toBe("prefilled");
    if (result.status !== "prefilled") return;
    expect(result.prefill.launchpadMode).toBe("new_campaign");
    expect(result.prefill.launchpadStep).toBe("creatives");
    expect(result.prefill.selection.creativeIds).toEqual(["cre_stale"]);
    expect(result.prefill.evidenceWindow.snapshotAsOf).toBe("2026-08-17");
    // A decision prefill has nothing the wizard cannot apply.
    expect(result.prefill.unsupported).toBeNull();
  });

  // The honest half of the copy handoff. The alternate line travels in the
  // record and no Launchpad payload field can hold it, so the prefill says so
  // rather than letting the draft quietly drop it.
  it("states plainly that a copy line cannot be applied by the wizard", async () => {
    handoffMocks.readConsumed.mockResolvedValue({
      ok: true,
      envelope: envelope({
        origin: "copy",
        mode: "copy_draft",
        authorizedAction: null,
        actionEligible: false,
        exactAdExecutionEligible: false,
        sourceAuthorityStatus: "warehouse_discovery",
        lineage: null,
        evidenceWindow: {
          basis: "requested_metrics_window",
          startDate: "2026-07-19",
          endDate: "2026-08-17",
          snapshotAsOf: null,
          computedAt: null,
        },
        copy: {
          copyId: "copy:cre_1",
          alternateId: "alt-2",
          alternateText: "Second line Meta served",
          sourceText: "First line",
          assetType: "primary_text",
        },
      }),
    });

    const result = await readLaunchpadHandoffPrefill({
      handoffId: HANDOFF_ID,
      businessId: "biz_1",
      providerAccountId: "act_1",
      actorUserId: "user_1",
    });

    expect(result.status).toBe("prefilled");
    if (result.status !== "prefilled") return;
    expect(result.prefill.unsupported).toContain("Launchpad has no copy field");
    expect(result.prefill.summary).toContain("no execution authority");
    expect(result.prefill.summary).toContain("2026-07-19");
  });

  it("reports a refused record as unavailable with its own sentence", async () => {
    handoffMocks.readConsumed.mockResolvedValue({
      ok: false,
      refusal: "prefill_expired",
    });

    const result = await readLaunchpadHandoffPrefill({
      handoffId: HANDOFF_ID,
      businessId: "biz_1",
      providerAccountId: "act_1",
      actorUserId: "user_1",
    });

    expect(result).toEqual({
      status: "unavailable",
      refusal: "prefill_expired",
      message:
        "The prepared draft expired; start it again from where you launched it.",
    });
  });
});
