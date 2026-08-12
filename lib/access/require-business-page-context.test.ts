import { describe, expect, it } from "vitest";

import { pageResultForOutcome } from "@/lib/access/require-business-page-context";
import type { BusinessAuthorizationOutcome } from "@/lib/access/authorize-business";
import type { MembershipRecord } from "@/lib/access-membership";
import type { SessionContext } from "@/lib/auth";
import { DEMO_BUSINESS_ID } from "@/lib/demo-business";
import { SHOPIFY_REVIEWER_EMAIL } from "@/lib/reviewer-access";

function session(email = "ada@example.com"): SessionContext {
  return {
    sessionId: "sess_1",
    user: { id: "user_1", name: "Ada", email, avatar: null, language: "en" },
    activeBusinessId: "biz_1",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function membership(overrides: Partial<MembershipRecord> = {}): MembershipRecord {
  return {
    id: "mem_1",
    userId: "user_1",
    businessId: "biz_1",
    role: "collaborator",
    status: "active",
    joinedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("pageResultForOutcome", () => {
  it("builds the page context from the membership, not from the URL", () => {
    const result = pageResultForOutcome({
      kind: "authorized",
      session: session(),
      membership: membership({ businessId: "biz_1" }),
    });
    expect(result).toEqual({
      kind: "ok",
      context: {
        session: session(),
        membership: membership({ businessId: "biz_1" }),
        businessId: "biz_1",
        role: "collaborator",
        reviewerReadOnly: false,
        demo: false,
      },
    });
  });

  it("marks a reviewer read-only and the demo business as demo", () => {
    const result = pageResultForOutcome({
      kind: "authorized",
      session: session(SHOPIFY_REVIEWER_EMAIL),
      membership: membership({ businessId: DEMO_BUSINESS_ID }),
    });
    expect(result).toMatchObject({
      kind: "ok",
      context: { reviewerReadOnly: true, demo: true },
    });
  });

  it("sends only an unauthenticated actor to login", () => {
    expect(pageResultForOutcome({ kind: "unauthenticated" })).toEqual({
      kind: "unauthenticated",
    });
  });

  it("hides existence: every no-access reason renders the same not-found", () => {
    const hidden: BusinessAuthorizationOutcome[] = [
      { kind: "missing_business_id" },
      { kind: "reviewer_out_of_scope" },
      { kind: "no_membership" },
      { kind: "membership_inactive", status: "pending" },
      { kind: "membership_inactive", status: "invited" },
    ];
    for (const outcome of hidden) {
      expect(pageResultForOutcome(outcome), outcome.kind).toEqual({ kind: "not-found" });
    }
  });

  it("keeps an unavailable schema explicit instead of rendering an empty page", () => {
    expect(pageResultForOutcome({ kind: "schema_unavailable" })).toEqual({
      kind: "unavailable",
    });
  });

  it("reports an insufficient role as forbidden, carrying both roles", () => {
    expect(
      pageResultForOutcome({ kind: "insufficient_role", required: "admin", actual: "guest" }),
    ).toEqual({ kind: "forbidden", required: "admin", actual: "guest" });
  });
});
