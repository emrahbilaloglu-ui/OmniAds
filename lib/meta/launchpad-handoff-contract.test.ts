import { describe, expect, it } from "vitest";

import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import {
  authorizeLaunchpadHandoff,
  describeLaunchpadHandoffRefusal,
  formatLaunchpadHandoffReference,
  launchpadModeForAuthorizedAction,
  parseLaunchpadHandoffReference,
  parseLaunchpadHandoffRefusal,
  authorizeLaunchpadCopyHandoff,
  buildLaunchpadHandoffPrefill,
  launchpadWizardTargetForHandoffMode,
  type LaunchpadHandoffEnvelope,
} from "@/lib/meta/launchpad-handoff-contract";

/**
 * The handoff authorization law, tested without a database.
 *
 * Every one of these cases is a way a URL used to be able to open Launchpad
 * claiming a decision that did not authorize it.
 */

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
    },
    sourceDecision: { snapshotAsOf: "2026-08-17" },
    parentChain: {
      campaign: { id: "camp_1" },
      adset: { id: "adset_1" },
      ad: { id: "ad_1" },
      creative: { id: "cre_1" },
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
    },
    ...overrides,
  } as unknown as MetaCanonicalDecision;
}

function authorize(overrides: Record<string, unknown> = {}) {
  return authorizeLaunchpadHandoff({
    decision: decision(overrides),
    providerAccountId: "act_1",
  });
}

describe("launchpad handoff authorization", () => {
  it("authorizes an exactly-active, native-exact, act-state refresh as a rebuild", () => {
    const result = authorize();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authorization.mode).toBe("rebuild");
    expect(result.authorization.authorizedAction).toBe("refresh");
    expect(result.authorization.exactAdExecutionEligible).toBe(true);
    expect(result.authorization.lineage).toMatchObject({
      sourceDecisionId: "dec_1",
      sourceSnapshotId: "snap_1",
      campaignId: "camp_1",
      adsetId: "adset_1",
      adId: "ad_1",
      creativeId: "cre_1",
      engineVersion: "engine-v3",
      decisionHash: "decision_hash",
      inputHash: "input_hash",
    });
  });

  it("maps an authorized scale to duplicate", () => {
    const result = authorize({
      sourceAuthority: {
        ...(decision().sourceAuthority as object),
        authorizedAction: "scale",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authorization.mode).toBe("duplicate");
  });

  // Law, verbatim from docs/creative-decision-center/INVARIANTS.md: "A blocked,
  // held, review-only, or action-ineligible canonical decision must not map to
  // any Launchpad mode. In particular, a held Cut with compatibility label
  // test_more must never appear as Fresh Test."
  //
  // `cut` therefore has NO mode at all — held or not, blocked or not. The map
  // is the enforcement point, so a future editor cannot add a Cut destination
  // without deleting this test.
  it("gives an authorized cut no Launchpad mode at all", () => {
    expect(launchpadModeForAuthorizedAction("cut")).toBeNull();
    const result = authorize({
      sourceAuthority: {
        ...(decision().sourceAuthority as object),
        authorizedAction: "cut",
      },
    });
    expect(result).toEqual({
      ok: false,
      refusal: "authorized_action_has_no_launchpad_mode",
    });
  });

  it("refuses a held decision even when the served action is otherwise eligible", () => {
    const result = authorize({
      classification: { decisionState: "act", heldAction: "cut", blockers: [] },
    });
    expect(result).toEqual({ ok: false, refusal: "decision_held" });
  });

  it("refuses a blocked decision state", () => {
    const result = authorize({
      classification: {
        decisionState: "blocked",
        heldAction: null,
        blockers: [],
      },
    });
    expect(result).toEqual({ ok: false, refusal: "decision_blocked" });
  });

  it("refuses an act decision that still carries blockers", () => {
    const result = authorize({
      classification: {
        decisionState: "act",
        heldAction: null,
        blockers: [{ code: "policy_review", label: "Policy", category: "policy" }],
      },
    });
    expect(result).toEqual({ ok: false, refusal: "decision_blocked" });
  });

  it("refuses a monitor decision state", () => {
    const result = authorize({
      classification: {
        decisionState: "monitor",
        heldAction: null,
        blockers: [],
      },
    });
    expect(result).toEqual({ ok: false, refusal: "decision_state_not_act" });
  });

  it("refuses a legacy review-only source authority", () => {
    const result = authorize({
      sourceAuthority: {
        ...(decision().sourceAuthority as object),
        status: "legacy_review_only",
      },
    });
    expect(result).toEqual({
      ok: false,
      refusal: "source_authority_review_only",
    });
  });

  // Law: "Demo businesses have zero Meta write authority even if a
  // presentation defect supplies an action." The fixture below IS that defect —
  // a demo envelope carrying actionEligible true and an authorizedAction — and
  // it must still be refused, under the demo name so the defect stays visible.
  it("refuses a demo decision that a presentation defect marked eligible and actionable", () => {
    const result = authorize({
      sourceAuthority: {
        ...(decision().sourceAuthority as object),
        status: "demo_synthetic_review_only",
        actionEligible: true,
        authorizedAction: "scale",
      },
    });
    expect(result).toEqual({
      ok: false,
      refusal: "demo_synthetic_review_only",
    });
  });

  it("refuses an action-ineligible decision", () => {
    const result = authorize({
      sourceAuthority: {
        ...(decision().sourceAuthority as object),
        actionEligible: false,
      },
    });
    expect(result).toEqual({ ok: false, refusal: "action_not_eligible" });
  });

  it("refuses a decision with no authorized action", () => {
    const result = authorize({
      sourceAuthority: {
        ...(decision().sourceAuthority as object),
        authorizedAction: null,
      },
    });
    expect(result).toEqual({ ok: false, refusal: "no_authorized_action" });
  });

  it("refuses a decision with no source authority envelope at all", () => {
    const result = authorize({ sourceAuthority: undefined });
    expect(result).toEqual({ ok: false, refusal: "source_authority_missing" });
  });

  it("refuses a decision that belongs to another provider account", () => {
    const result = authorizeLaunchpadHandoff({
      decision: decision({ providerAccountId: "act_other" }),
      providerAccountId: "act_1",
    });
    expect(result).toEqual({
      ok: false,
      refusal: "provider_account_mismatch",
    });
  });

  it("refuses a decision missing the snapshot half of its lineage", () => {
    const result = authorize({ sourceSnapshotId: "  " });
    expect(result).toEqual({ ok: false, refusal: "lineage_incomplete" });
  });

  // Law: "Inventory visibility must never be treated as recommendation or
  // execution eligibility", and "an unavailable current-status reconciliation
  // fails closed as UNKNOWN". A non-exact hierarchy does not block the DRAFT —
  // opening a draft is not executing — but it must be recorded as ineligible
  // so nothing downstream can read it as permission.
  it("records exact-Ad execution eligibility as false for an unknown hierarchy without refusing the draft", () => {
    const result = authorize({
      deliveryScope: {
        state: "unknown",
        campaignStatus: null,
        adsetStatus: null,
        adStatus: null,
        reason: "hierarchy_status_unknown",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authorization.exactAdExecutionEligible).toBe(false);
  });

  it("records exact-Ad execution eligibility as false when only the campaign is not active", () => {
    const result = authorize({
      deliveryScope: {
        state: "active",
        campaignStatus: "PAUSED",
        adsetStatus: "ACTIVE",
        adStatus: "ACTIVE",
        reason: "active_hierarchy",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authorization.exactAdExecutionEligible).toBe(false);
  });
});

describe("launchpad handoff reference encoding", () => {
  const uuid = "0f1e2d3c-4b5a-4c7d-8e9f-a0b1c2d3e4f5";
  const token = "a".repeat(43);

  it("round-trips a well-formed reference", () => {
    const reference = formatLaunchpadHandoffReference({
      handoffId: uuid,
      token,
    });
    expect(reference).toBe(`${uuid}.${token}`);
    expect(parseLaunchpadHandoffReference(reference)).toEqual({
      handoffId: uuid,
      token,
    });
  });

  // The parser is the SQL boundary. A reference that is not shaped like one of
  // ours never reaches a query, so a hand-edited `?handoff=` cannot be used to
  // probe the store.
  it.each([
    ["empty", ""],
    ["no separator", uuid],
    ["non-uuid id", `not-a-uuid.${token}`],
    ["short token", `${uuid}.abc`],
    ["token with punctuation", `${uuid}.${"a".repeat(42)}!`],
    ["leading separator", `.${token}`],
  ])("refuses a %s reference", (_label, raw) => {
    expect(parseLaunchpadHandoffReference(raw)).toBeNull();
  });

  it("refuses an absurdly long reference before touching it", () => {
    expect(parseLaunchpadHandoffReference(`${uuid}.${"a".repeat(400)}`)).toBeNull();
  });
});

describe("launchpad handoff refusal vocabulary", () => {
  // The refusal code travels in a URL, so it is validated against the closed
  // vocabulary rather than echoed. Otherwise `?handoffRefused=<anything>`
  // would let a link author write a sentence onto the Decisions screen.
  it("accepts only codes this system issues", () => {
    expect(parseLaunchpadHandoffRefusal("already_consumed")).toBe(
      "already_consumed",
    );
    expect(parseLaunchpadHandoffRefusal("demo_synthetic_review_only")).toBe(
      "demo_synthetic_review_only",
    );
    expect(parseLaunchpadHandoffRefusal("you are now an admin")).toBeNull();
    expect(parseLaunchpadHandoffRefusal("")).toBeNull();
    expect(parseLaunchpadHandoffRefusal(null)).toBeNull();
  });

  it("gives every refusal a sentence that names the cause", () => {
    expect(describeLaunchpadHandoffRefusal("expired")).toMatch(/expired/i);
    expect(describeLaunchpadHandoffRefusal("already_consumed")).toMatch(
      /already used/i,
    );
    expect(describeLaunchpadHandoffRefusal("decision_held")).toMatch(/held/i);
    expect(describeLaunchpadHandoffRefusal("demo_synthetic_review_only")).toMatch(
      /Demo/,
    );
    expect(describeLaunchpadHandoffRefusal("business_mismatch")).toMatch(
      /different business/i,
    );
  });
});

describe("launchpad wizard target", () => {
  // One map, so the route that redirects and the body that renders cannot
  // disagree about what a mode opens.
  it("maps every mode to exactly one wizard destination", () => {
    expect(launchpadWizardTargetForHandoffMode("rebuild")).toEqual({
      launchpadMode: "new_campaign",
      launchpadStep: "creatives",
    });
    expect(launchpadWizardTargetForHandoffMode("duplicate")).toEqual({
      launchpadMode: "add_to_existing",
      launchpadStep: "creatives",
    });
    // A copy line is drafted against a NEW ad. Routing it into
    // `add_to_existing` would put a line with no execution authority into the
    // workflow a Scale decision authorizes.
    expect(launchpadWizardTargetForHandoffMode("copy_draft")).toEqual({
      launchpadMode: "new_campaign",
      launchpadStep: "creatives",
    });
  });
});

describe("authorizeLaunchpadCopyHandoff", () => {
  const candidate = {
    copyId: "copy:cre_1",
    providerAccountId: "act_1",
    assetType: "primary_text",
    sourceText: "The line that is running",
    alternates: ["The line that is running", "The other line Meta served"],
    campaignIds: ["camp_1", "camp_1", " "],
    adIds: ["ad_1", "ad_2"],
    creativeIds: ["cre_1"],
  };
  const window = { startDate: "2026-07-19", endDate: "2026-08-17" };

  it("authorizes a line the server actually served, with the window frozen onto it", () => {
    const result = authorizeLaunchpadCopyHandoff({
      candidate,
      providerAccountId: "act_1",
      requestedAlternateText: "  The other line Meta served  ",
      window,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authorization.mode).toBe("copy_draft");
    expect(result.authorization.copy).toEqual({
      copyId: "copy:cre_1",
      alternateId: "alt-2",
      alternateText: "The other line Meta served",
      sourceText: "The line that is running",
      assetType: "primary_text",
    });
    expect(result.authorization.evidenceWindow).toEqual({
      basis: "requested_metrics_window",
      startDate: "2026-07-19",
      endDate: "2026-08-17",
      snapshotAsOf: null,
      computedAt: null,
    });
    // Deduplicated and blank-free, because these ids are handed straight to the
    // wizard's pickers.
    expect(result.authorization.selection.campaignIds).toEqual(["camp_1"]);
    expect(result.authorization.selection.adIds).toEqual(["ad_1", "ad_2"]);
  });

  /**
   * The alternate is read out of the SERVED lines, never taken on the caller's
   * word. This is the whole reason the endpoint re-reads: without it, a
   * hand-rolled POST could put arbitrary ad text into a draft that claims Meta's
   * own served lines as its source.
   */
  it("refuses a line the server never served", () => {
    expect(
      authorizeLaunchpadCopyHandoff({
        candidate,
        providerAccountId: "act_1",
        requestedAlternateText: "Operator-invented urgency!",
        window,
      }),
    ).toEqual({ ok: false, refusal: "copy_identity_missing" });
  });

  it("refuses a copy row from a different account", () => {
    expect(
      authorizeLaunchpadCopyHandoff({
        candidate,
        providerAccountId: "act_other",
        requestedAlternateText: "The other line Meta served",
        window,
      }),
    ).toEqual({ ok: false, refusal: "provider_account_mismatch" });
  });

  // A window the server cannot restate is refused rather than defaulted. "The
  // last 30 days" invented here would be a claim about evidence nobody measured.
  it.each([
    [{ startDate: "not-a-date", endDate: "2026-08-17" }],
    [{ startDate: "2026-08-17", endDate: "2026-07-19" }],
    [{ startDate: "", endDate: "" }],
  ])("refuses the window %o rather than defaulting it", (badWindow) => {
    expect(
      authorizeLaunchpadCopyHandoff({
        candidate,
        providerAccountId: "act_1",
        requestedAlternateText: "The other line Meta served",
        window: badWindow,
      }),
    ).toEqual({ ok: false, refusal: "lineage_incomplete" });
  });

  it("refuses a row with no copy identity at all", () => {
    expect(
      authorizeLaunchpadCopyHandoff({
        candidate: { ...candidate, copyId: "   " },
        providerAccountId: "act_1",
        requestedAlternateText: "The other line Meta served",
        window,
      }),
    ).toEqual({ ok: false, refusal: "copy_identity_missing" });
  });
});

describe("buildLaunchpadHandoffPrefill", () => {
  function envelope(
    overrides: Partial<LaunchpadHandoffEnvelope> = {},
  ): LaunchpadHandoffEnvelope {
    return {
      version: "v1",
      handoffId: "0f1e2d3c-4b5a-4c7d-8e9f-a0b1c2d3e4f5",
      tokenHash: "f".repeat(64),
      businessId: "biz_1",
      providerAccountId: "act_1",
      createdByUserId: "user_1",
      origin: "decision",
      authorizedAction: "scale",
      mode: "duplicate",
      actionEligible: true,
      exactAdExecutionEligible: false,
      sourceAuthorityStatus: "native_exact",
      lineage: {
        sourceDecisionId: "dec_1",
        sourceSnapshotId: "snap_1",
        episodeId: null,
        engineVersion: "engine-v3",
        snapshotAsOf: "2026-08-17",
        decisionHash: null,
        inputHash: null,
        campaignId: "camp_1",
        adsetId: "adset_1",
        adId: "ad_1",
        creativeId: "cre_1",
      },
      selection: {
        campaignIds: ["camp_1"],
        adsetIds: ["adset_1"],
        adIds: ["ad_1"],
        creativeIds: ["cre_1"],
      },
      evidenceWindow: {
        basis: "decision_snapshot",
        startDate: null,
        endDate: null,
        snapshotAsOf: "2026-08-17",
        computedAt: null,
      },
      copy: null,
      createdAt: "2026-08-17T10:00:00.000Z",
      expiresAt: "2026-08-17T10:15:00.000Z",
      consumedAt: "2026-08-17T10:01:00.000Z",
      ...overrides,
    } as LaunchpadHandoffEnvelope;
  }

  it("restates the server's verdict without re-deriving any of it", () => {
    const prefill = buildLaunchpadHandoffPrefill(envelope());

    expect(prefill.launchpadMode).toBe("add_to_existing");
    expect(prefill.authorizedAction).toBe("scale");
    // Copied, not recomputed: an envelope that says execution is not exact
    // stays not-exact here even though everything else looks healthy.
    expect(prefill.exactAdExecutionEligible).toBe(false);
    expect(prefill.summary).toContain("server-authorized scale");
    expect(prefill.summary).toContain("snapshot 2026-08-17");
    expect(prefill.summary).toContain("1 creative preselected");
    expect(prefill.unsupported).toBeNull();
  });

  // A missing window is stated as missing. "snapshot 2026-08-17" for a
  // snapshot nobody recorded would be a fabricated date.
  it("says the window is unrecorded rather than inventing one", () => {
    const prefill = buildLaunchpadHandoffPrefill(
      envelope({
        evidenceWindow: {
          basis: "decision_snapshot",
          startDate: null,
          endDate: null,
          snapshotAsOf: null,
          computedAt: null,
        },
      }),
    );
    expect(prefill.summary).toContain("snapshot date unrecorded");
  });

  it("marks a copy prefill as carrying no execution authority, and says what cannot be applied", () => {
    const prefill = buildLaunchpadHandoffPrefill(
      envelope({
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
          alternateText: "The other line Meta served",
          sourceText: "The line that is running",
          assetType: "primary_text",
        },
      }),
    );

    expect(prefill.launchpadMode).toBe("new_campaign");
    expect(prefill.authorizedAction).toBeNull();
    expect(prefill.actionEligible).toBe(false);
    expect(prefill.summary).toContain("no execution authority");
    expect(prefill.summary).toContain("window 2026-07-19 → 2026-08-17");
    expect(prefill.unsupported).toContain("Launchpad has no copy field");
  });
});
