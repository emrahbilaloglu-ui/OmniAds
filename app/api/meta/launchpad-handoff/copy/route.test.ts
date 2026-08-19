import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Copies -> Launchpad mint endpoint.
 *
 * THE LAW. The body NAMES a creative, a window and one alternate line. It
 * asserts nothing:
 *
 *   - the alternate is read out of the SERVED copy for that creative in that
 *     window, so a hand-rolled POST cannot put arbitrary ad text into a draft
 *     that claims Meta's own served lines as its source;
 *   - an unreadable copy source refuses (503) rather than reporting "that line
 *     was never served", because a failed read is not an empty result;
 *   - a reviewer, a demo workspace, an unverifiable workspace and an unassigned
 *     account are all refused before anything is minted;
 *   - the response never claims authority. A copies row is a warehouse
 *     aggregate — discovery evidence only — so `authorizedAction` is null and
 *     both eligibility flags are false, and no decision id is fabricated.
 *
 * Real provider writes performed by this file: zero. The one upstream read is
 * mocked, and the mint is mocked so this asserts the ROUTE's decisions rather
 * than the store's.
 */

const mocks = vi.hoisted(() => ({
  requireBusinessAccess: vi.fn(),
  isReviewerEmail: vi.fn(() => false),
  readLaunchpadWriteAuthority: vi.fn(async () => "live"),
  getProviderAccountAssignments: vi.fn(async () => ({
    account_ids: ["act_1"],
  })),
  getMetaCreativesApiPayload: vi.fn(),
  mintLaunchpadCopyHandoff: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: mocks.requireBusinessAccess,
}));
vi.mock("@/lib/reviewer-access", () => ({
  isReviewerEmail: mocks.isReviewerEmail,
}));
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: mocks.readLaunchpadWriteAuthority,
}));
vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: mocks.getProviderAccountAssignments,
}));
vi.mock("@/lib/meta/creatives-api", () => ({
  getMetaCreativesApiPayload: mocks.getMetaCreativesApiPayload,
}));
vi.mock("@/lib/meta/launchpad-handoff", async () => {
  const contract = await import("@/lib/meta/launchpad-handoff-contract");
  return { ...contract, mintLaunchpadCopyHandoff: mocks.mintLaunchpadCopyHandoff };
});

const { POST } = await import("@/app/api/meta/launchpad-handoff/copy/route");

function request(body: Record<string, unknown>) {
  return new NextRequest("https://example.test/api/meta/launchpad-handoff/copy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  businessId: "biz_1",
  providerAccountId: "act_1",
  creativeId: "cre_1",
  alternateText: "The other line Meta served",
  start: "2026-07-19",
  end: "2026-08-17",
};

function creativeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ad_1",
    creative_id: "cre_1",
    campaign_id: "camp_1",
    copy_text: "The line that is running",
    copy_variants: ["The line that is running", "The other line Meta served"],
    headline_variants: ["A headline"],
    description_variants: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireBusinessAccess.mockResolvedValue({
    session: { user: { id: "user_1", email: "operator@example.test" } },
    membership: { businessId: "biz_1", role: "collaborator" },
  });
  mocks.isReviewerEmail.mockReturnValue(false);
  mocks.readLaunchpadWriteAuthority.mockResolvedValue("live");
  mocks.getProviderAccountAssignments.mockResolvedValue({
    account_ids: ["act_1"],
  });
  mocks.getMetaCreativesApiPayload.mockResolvedValue({
    status: "ok",
    rows: [creativeRow()],
  });
  mocks.mintLaunchpadCopyHandoff.mockResolvedValue({
    ok: true,
    handoffId: "0f1e2d3c-4b5a-4c7d-8e9f-a0b1c2d3e4f5",
    reference: `0f1e2d3c-4b5a-4c7d-8e9f-a0b1c2d3e4f5.${"a".repeat(43)}`,
    envelope: {
      mode: "copy_draft",
      expiresAt: "2026-08-17T10:15:00.000Z",
      evidenceWindow: {
        basis: "requested_metrics_window",
        startDate: "2026-07-19",
        endDate: "2026-08-17",
        snapshotAsOf: null,
        computedAt: null,
      },
    },
  });
});

describe("POST /api/meta/launchpad-handoff/copy", () => {
  it("mints from the SERVED lines and never from the caller's text", async () => {
    const response = await POST(request(VALID_BODY));
    expect(response.status).toBe(200);

    const call = mocks.mintLaunchpadCopyHandoff.mock.calls[0]![0] as {
      candidate: { alternates: string[]; adIds: string[]; campaignIds: string[] };
      requestedAlternateText: string;
      window: { startDate: string; endDate: string };
    };
    // The candidate is built from the payload the SERVER read back, and the
    // caller's string is passed separately so the pure law can check
    // membership rather than trusting it.
    expect(call.candidate.alternates).toEqual([
      "The line that is running",
      "The other line Meta served",
      "A headline",
    ]);
    expect(call.candidate.adIds).toEqual(["ad_1"]);
    expect(call.candidate.campaignIds).toEqual(["camp_1"]);
    expect(call.requestedAlternateText).toBe("The other line Meta served");
    expect(call.window).toEqual({
      startDate: "2026-07-19",
      endDate: "2026-08-17",
    });
  });

  it("returns the reference and states plainly that it carries no authority", async () => {
    const response = await POST(request(VALID_BODY));
    const payload = (await response.json()) as Record<string, unknown>;

    expect(payload.handoff).toMatch(/^[0-9a-f-]{36}\./);
    expect(payload.mode).toBe("copy_draft");
    // Stated, not implied by omission.
    expect(payload.authorizedAction).toBeNull();
    expect(payload.actionEligible).toBe(false);
    expect(payload.exactAdExecutionEligible).toBe(false);
    // No decision id is fabricated anywhere in this path.
    expect(JSON.stringify(payload)).not.toContain("decisionId");
    expect(JSON.stringify(payload)).not.toContain("sourceSnapshotId");
  });

  it("refuses a reviewer before reading anything", async () => {
    mocks.isReviewerEmail.mockReturnValue(true);

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(403);
    expect(mocks.getMetaCreativesApiPayload).not.toHaveBeenCalled();
    expect(mocks.mintLaunchpadCopyHandoff).not.toHaveBeenCalled();
  });

  // "Demo businesses have zero Meta write authority even if a presentation
  // defect supplies an action."
  it("refuses a demo workspace", async () => {
    mocks.readLaunchpadWriteAuthority.mockResolvedValue("demo");

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("demo_business_read_only");
    expect(mocks.mintLaunchpadCopyHandoff).not.toHaveBeenCalled();
  });

  // An unreadable demo flag is not "live". A write path must not proceed on an
  // unproven claim that this workspace is real.
  it("refuses a workspace whose demo status could not be read", async () => {
    mocks.readLaunchpadWriteAuthority.mockResolvedValue("unverified");

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("demo_status_unverified");
  });

  it("refuses an account this business has not been assigned", async () => {
    mocks.getProviderAccountAssignments.mockResolvedValue({
      account_ids: ["act_other"],
    });

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("provider_account_not_assigned");
    expect(mocks.mintLaunchpadCopyHandoff).not.toHaveBeenCalled();
  });

  it("refuses when the assignment source itself cannot be read", async () => {
    mocks.getProviderAccountAssignments.mockRejectedValue(new Error("down"));

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe(
      "provider_account_scope_unverified",
    );
  });

  /**
   * A failed copy read is not an empty one.
   *
   * Falling through to the mint with zero rows would produce
   * `copy_identity_missing`, which tells the operator their line was never
   * served — a definite statement about their account produced by a read that
   * never happened.
   */
  it.each([
    ["a thrown read", null, true],
    ["a non-ok payload", { status: "no_connection", rows: [] }, false],
    ["a payload with no rows array", { status: "ok" }, false],
  ])("refuses %s as unavailable, not as an empty result", async (
    _label,
    payload,
    shouldThrow,
  ) => {
    if (shouldThrow) {
      mocks.getMetaCreativesApiPayload.mockRejectedValue(new Error("down"));
    } else {
      mocks.getMetaCreativesApiPayload.mockResolvedValue(payload);
    }

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("copy_source_unavailable");
    expect(mocks.mintLaunchpadCopyHandoff).not.toHaveBeenCalled();
  });

  // Only the named creative's own served lines may authorize the handoff. A
  // line served on a DIFFERENT creative in the same account is not "the other
  // line Meta served with this creative".
  it("only offers the named creative's own served lines to the mint", async () => {
    mocks.getMetaCreativesApiPayload.mockResolvedValue({
      status: "ok",
      rows: [
        creativeRow(),
        creativeRow({
          id: "ad_9",
          creative_id: "cre_other",
          copy_variants: ["A line from a different creative"],
          headline_variants: [],
        }),
      ],
    });

    await POST(request(VALID_BODY));

    const call = mocks.mintLaunchpadCopyHandoff.mock.calls[0]![0] as {
      candidate: { alternates: string[] };
    };
    expect(call.candidate.alternates).not.toContain(
      "A line from a different creative",
    );
  });

  it("carries a mint refusal through with the server's own sentence", async () => {
    mocks.mintLaunchpadCopyHandoff.mockResolvedValue({
      ok: false,
      refusal: "copy_identity_missing",
    });

    const response = await POST(request(VALID_BODY));
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(payload.error).toBe("copy_identity_missing");
    expect(payload.message).toContain("not in the current served universe");
  });

  it.each([
    ["a missing creative", { creativeId: "" }],
    ["a blank line", { alternateText: "   " }],
    ["a non-ISO window", { start: "19/07/2026" }],
    ["an inverted window", { start: "2026-08-17", end: "2026-07-19" }],
  ])("refuses %s with 400 before any read", async (_label, overrides) => {
    const response = await POST(request({ ...VALID_BODY, ...overrides }));

    expect(response.status).toBe(400);
    expect(mocks.getMetaCreativesApiPayload).not.toHaveBeenCalled();
  });
});
