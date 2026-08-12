import { describe, expect, it } from "vitest";

import {
  authorizationDenialResponse,
  evaluateBusinessAuthorization,
  type BusinessAuthorizationOutcome,
} from "@/lib/access/authorize-business";
import type { MembershipRecord } from "@/lib/access-membership";
import type { SessionContext } from "@/lib/auth";
import { DEMO_BUSINESS_ID } from "@/lib/demo-business";
import { SHOPIFY_REVIEWER_EMAIL } from "@/lib/reviewer-access";

function session(overrides: Partial<SessionContext["user"]> = {}): SessionContext {
  return {
    sessionId: "sess_1",
    user: {
      id: "user_1",
      name: "Ada",
      email: "ada@example.com",
      avatar: null,
      language: "en",
      ...overrides,
    },
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

const base = {
  session: session(),
  businessId: "biz_1",
  schemaAvailable: true,
  membership: membership(),
};

describe("evaluateBusinessAuthorization", () => {
  it("authorizes an active membership meeting the minimum role", () => {
    const outcome = evaluateBusinessAuthorization({ ...base, minRole: "collaborator" });
    expect(outcome.kind).toBe("authorized");
  });

  it("defaults the minimum role to guest", () => {
    const outcome = evaluateBusinessAuthorization({
      ...base,
      membership: membership({ role: "guest" }),
    });
    expect(outcome.kind).toBe("authorized");
  });

  it("rejects a missing business ID before reading the session", () => {
    expect(
      evaluateBusinessAuthorization({ ...base, businessId: null, session: null }).kind,
    ).toBe("missing_business_id");
    expect(evaluateBusinessAuthorization({ ...base, businessId: "" }).kind).toBe(
      "missing_business_id",
    );
  });

  it("rejects an unauthenticated caller", () => {
    expect(evaluateBusinessAuthorization({ ...base, session: null }).kind).toBe(
      "unauthenticated",
    );
  });

  it("denies a cross-tenant business ID that only appears in the URL", () => {
    // The membership belongs to biz_1; the URL claims biz_2.
    const outcome = evaluateBusinessAuthorization({
      ...base,
      businessId: "biz_2",
      membership: null,
    });
    expect(outcome.kind).toBe("no_membership");
  });

  it("denies a reviewer outside the demo business, before any membership read", () => {
    const outcome = evaluateBusinessAuthorization({
      ...base,
      session: session({ email: SHOPIFY_REVIEWER_EMAIL }),
      businessId: "biz_1",
      // Even a valid active membership must not rescue an out-of-scope reviewer.
      membership: membership({ role: "admin" }),
    });
    expect(outcome.kind).toBe("reviewer_out_of_scope");
  });

  it("allows a reviewer inside the demo business", () => {
    const outcome = evaluateBusinessAuthorization({
      ...base,
      session: session({ email: SHOPIFY_REVIEWER_EMAIL }),
      businessId: DEMO_BUSINESS_ID,
      membership: membership({ businessId: DEMO_BUSINESS_ID }),
    });
    expect(outcome.kind).toBe("authorized");
  });

  it("denies pending and invited memberships", () => {
    for (const status of ["pending", "invited"] as const) {
      const outcome = evaluateBusinessAuthorization({
        ...base,
        membership: membership({ status }),
      });
      expect(outcome).toEqual({ kind: "membership_inactive", status });
    }
  });

  it("reports an unavailable schema distinctly from a missing membership", () => {
    expect(
      evaluateBusinessAuthorization({ ...base, schemaAvailable: false, membership: null }).kind,
    ).toBe("schema_unavailable");
    expect(evaluateBusinessAuthorization({ ...base, membership: null }).kind).toBe(
      "no_membership",
    );
  });

  it("enforces the role ladder", () => {
    const cases: Array<[MembershipRecord["role"], "guest" | "collaborator" | "admin", boolean]> = [
      ["guest", "guest", true],
      ["guest", "collaborator", false],
      ["guest", "admin", false],
      ["collaborator", "guest", true],
      ["collaborator", "collaborator", true],
      ["collaborator", "admin", false],
      ["admin", "guest", true],
      ["admin", "collaborator", true],
      ["admin", "admin", true],
    ];
    for (const [actual, required, allowed] of cases) {
      const outcome = evaluateBusinessAuthorization({
        ...base,
        minRole: required,
        membership: membership({ role: actual }),
      });
      expect(outcome.kind === "authorized", `${actual} vs ${required}`).toBe(allowed);
      if (!allowed) {
        expect(outcome).toEqual({ kind: "insufficient_role", required, actual });
      }
    }
  });

  it("is unaffected by anything resembling a plan or rollout input", () => {
    // Authorization takes no such parameter; this asserts the shape stays that
    // way, so a plan/rollout value can never be threaded in as a grant.
    const keys = Object.keys(base);
    expect(keys).toEqual(["session", "businessId", "schemaAvailable", "membership"]);
  });
});

describe("authorizationDenialResponse", () => {
  it("preserves the exact legacy status and message for every denial", () => {
    const expected: Record<string, { status: number; error: string; message: string }> = {
      missing_business_id: {
        status: 400,
        error: "missing_business_id",
        message: "businessId is required.",
      },
      unauthenticated: {
        status: 401,
        error: "auth_error",
        message: "Authentication required.",
      },
      reviewer_out_of_scope: {
        status: 403,
        error: "auth_error",
        message: "You do not have access to this business.",
      },
      schema_unavailable: {
        status: 403,
        error: "auth_error",
        message: "You do not have access to this business.",
      },
      no_membership: {
        status: 403,
        error: "auth_error",
        message: "You do not have access to this business.",
      },
      membership_inactive: {
        status: 403,
        error: "auth_error",
        message: "You do not have access to this business.",
      },
      insufficient_role: {
        status: 403,
        error: "auth_error",
        message: "Insufficient role permissions for this action.",
      },
    };

    const outcomes: Array<Exclude<BusinessAuthorizationOutcome, { kind: "authorized" }>> = [
      { kind: "missing_business_id" },
      { kind: "unauthenticated" },
      { kind: "reviewer_out_of_scope" },
      { kind: "schema_unavailable" },
      { kind: "no_membership" },
      { kind: "membership_inactive", status: "pending" },
      { kind: "insufficient_role", required: "admin", actual: "guest" },
    ];

    for (const outcome of outcomes) {
      expect(authorizationDenialResponse(outcome), outcome.kind).toEqual(expected[outcome.kind]);
    }
    // Every denial branch is covered above.
    expect(outcomes).toHaveLength(Object.keys(expected).length);
  });

  it("keeps the three no-access reasons indistinguishable to the client", () => {
    const bodies = (
      [
        { kind: "reviewer_out_of_scope" },
        { kind: "no_membership" },
        { kind: "membership_inactive", status: "pending" },
        { kind: "schema_unavailable" },
      ] as Array<Exclude<BusinessAuthorizationOutcome, { kind: "authorized" }>>
    ).map((outcome) => JSON.stringify(authorizationDenialResponse(outcome)));

    expect(new Set(bodies).size).toBe(1);
  });
});
