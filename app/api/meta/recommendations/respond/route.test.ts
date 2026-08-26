import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { POST } from "@/app/api/meta/recommendations/respond/route";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

/*
 * The two server authorities this route gained, stubbed at their DB read.
 *
 * Only the reads are mocked, never the guards: `rejectIfMetaOperatorDemoWrite`
 * and the route's own three-way handling of the served result are the code
 * under test, so their status codes and precedence are really exercised.
 * `getDb()` throws with no DATABASE_URL under vitest, which is why the reads
 * have to be replaced rather than the guards.
 */
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(),
}));
vi.mock("@/lib/meta/served-recommendation", () => ({
  readServedMetaRecommendation: vi.fn(),
}));

vi.mock("@/lib/meta/decision-responses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/decision-responses")>();
  return {
    ...actual,
    recordMetaDecisionResponse: vi.fn(),
    emitMetaDecisionResponseTelemetry: vi.fn(),
  };
});

const access = await import("@/lib/access");
const responses = await import("@/lib/meta/decision-responses");
const demoAuthority = await import("@/app/api/launchpad/meta/demo-write-authority");
const served = await import("@/lib/meta/served-recommendation");

/** Every request body this file sends, so a case names only what it changes. */
function respondRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/meta/recommendations/respond", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Neither authority may be reached without the other refusing first. */
function expectNothingWritten() {
  expect(responses.recordMetaDecisionResponse).not.toHaveBeenCalled();
  expect(responses.emitMetaDecisionResponseTelemetry).not.toHaveBeenCalled();
}

describe("POST /api/meta/recommendations/respond", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } } as never,
      membership: { businessId: "biz_1" } as never,
    });
    vi.mocked(responses.recordMetaDecisionResponse).mockResolvedValue({
      recId: "rec_1",
      businessId: "biz_1",
      action: "deferred",
      actionSubtype: "let_cook_24h",
      timestamp: "2026-05-06T10:00:00.000Z",
      reappearAt: "2026-05-07T10:00:00.000Z",
    });
    vi.mocked(responses.emitMetaDecisionResponseTelemetry).mockReturnValue({
      contractVersion: "operator-decision-telemetry-event.v1",
    } as never);
    // A proven live workspace, and an id the engine really served: the two
    // states in which this route is allowed to write at all.
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("live");
    vi.mocked(served.readServedMetaRecommendation).mockResolvedValue({
      status: "served",
      snapshotDate: "2026-05-06",
    });
  });

  it("validates required fields and action values", async () => {
    const missing = await POST(
      new NextRequest("http://localhost/api/meta/recommendations/respond", {
        method: "POST",
        body: JSON.stringify({ businessId: "biz_1", action: "deferred" }),
      }),
    );
    expect(missing.status).toBe(400);

    const invalid = await POST(
      new NextRequest("http://localhost/api/meta/recommendations/respond", {
        method: "POST",
        body: JSON.stringify({ businessId: "biz_1", recId: "rec_1", action: "dismissed" }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(responses.recordMetaDecisionResponse).not.toHaveBeenCalled();
  });

  it("requires collaborator access, persists the response, and emits telemetry", async () => {
    const request = new NextRequest("http://localhost/api/meta/recommendations/respond", {
      method: "POST",
      body: JSON.stringify({
        businessId: "biz_1",
        recId: "rec_1",
        action: "deferred",
        actionSubtype: "let_cook_24h",
        reappearAt: "2026-05-07T10:00:00.000Z",
      }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request,
      businessId: "biz_1",
      minRole: "collaborator",
    });
    expect(responses.recordMetaDecisionResponse).toHaveBeenCalledWith({
      recId: "rec_1",
      businessId: "biz_1",
      action: "deferred",
      actionSubtype: "let_cook_24h",
      reappearAt: "2026-05-07T10:00:00.000Z",
    });
    expect(responses.emitMetaDecisionResponseTelemetry).toHaveBeenCalledWith({
      recId: "rec_1",
      businessId: "biz_1",
      action: "deferred",
      actionSubtype: "let_cook_24h",
    });
  });

  it("returns auth errors without persistence", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/meta/recommendations/respond", {
        method: "POST",
        body: JSON.stringify({ businessId: "biz_1", recId: "rec_1", action: "ignored" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(responses.recordMetaDecisionResponse).not.toHaveBeenCalled();
    expect(responses.emitMetaDecisionResponseTelemetry).not.toHaveBeenCalled();
  });

  /*
   * LAW: a demo workspace has zero Meta write authority, and the enforcement
   * is the SERVER's. `lib/zero-base/meta/intelligence-server.ts` disables both
   * controls on the claim that these routes refuse a demo workspace; until
   * this guard existed that claim was false, and `/api/auth/demo-login` opens
   * a session as an ADMIN under a non-reviewer email, so a direct POST cleared
   * the role floor and the reviewer floor and wrote a durable row.
   */
  it("refuses a confirmed demo workspace, with nothing written", async () => {
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("demo");

    const response = await POST(
      respondRequest({ businessId: "biz_1", recId: "rec_1", action: "acted" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("demo_business_read_only");
    expect(payload.error.action).toBe("operator_response");
    expectNothingWritten();
    // The served check is not even reached: the refusal is about the
    // workspace, and asking the snapshot source would be work done for a
    // request that was always going to be refused.
    expect(served.readServedMetaRecommendation).not.toHaveBeenCalled();
  });

  for (const authority of ["unverified", "not_established"] as const) {
    it(`refuses when demo status reads back as ${authority}, with nothing written`, async () => {
      vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue(authority);

      const response = await POST(
        respondRequest({ businessId: "biz_1", recId: "rec_1", action: "acted" }),
      );
      const payload = await response.json();

      // FAIL-CLOSED. An unreadable flag is not proof of a live workspace, and
      // a database outage must never read as authority to write.
      expect(response.status).toBe(503);
      expect(payload.error.code).toBe("demo_status_unverified");
      expectNothingWritten();
    });
  }

  it("reads the demo flag for the SERVER's business, not the body's", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } } as never,
      membership: { businessId: "biz_resolved" } as never,
    });

    await POST(
      respondRequest({ businessId: "biz_claimed", recId: "rec_1", action: "acted" }),
    );

    expect(demoAuthority.readLaunchpadWriteAuthority).toHaveBeenCalledWith("biz_resolved");
    expect(served.readServedMetaRecommendation).toHaveBeenCalledWith({
      businessId: "biz_resolved",
      recId: "rec_1",
    });
  });

  /*
   * LAW: the id is the SERVER's to verify. `rec_id` has no foreign key —
   * `lib/triage-events.ts` is a second writer of the same table with synthetic
   * ids — so nothing below this route establishes that the id names a real
   * recommendation, and `lib/meta/outcome-accrual.ts` reads these rows back as
   * evidence that an operator acted.
   */
  it("refuses an id the engine never served, with nothing written", async () => {
    vi.mocked(served.readServedMetaRecommendation).mockResolvedValue({
      status: "not_served",
    });

    const response = await POST(
      respondRequest({ businessId: "biz_1", recId: "rec_invented", action: "acted" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error.code).toBe("recommendation_not_served");
    expectNothingWritten();
  });

  it("refuses when the snapshot source cannot be read, rather than calling it absent", async () => {
    vi.mocked(served.readServedMetaRecommendation).mockResolvedValue({
      status: "source_unavailable",
    });

    const response = await POST(
      respondRequest({ businessId: "biz_1", recId: "rec_1", action: "acted" }),
    );
    const payload = await response.json();

    // 503, not 404. Telling an operator their recommendation does not exist
    // because the database was unreadable is a read failure reported as a fact.
    expect(response.status).toBe(503);
    expect(payload.error.code).toBe("recommendation_source_unavailable");
    expectNothingWritten();
  });

  it("rejects reviewer read-only attempts before persistence", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "reviewer_1", email: "shopify-review@adsecute.com" } } as never,
      membership: { businessId: "biz_1" } as never,
    });

    const response = await POST(
      new NextRequest("http://localhost/api/meta/recommendations/respond", {
        method: "POST",
        body: JSON.stringify({ businessId: "biz_1", recId: "rec_1", action: "deferred" }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("reviewer_read_only");
    expect(payload.error.action).toBe("operator_response");
    expect(responses.recordMetaDecisionResponse).not.toHaveBeenCalled();
    expect(responses.emitMetaDecisionResponseTelemetry).not.toHaveBeenCalled();
  });
});
