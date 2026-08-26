/**
 * The acknowledgement contract, proved against the real share route.
 *
 * A buyer share POSTed without the acknowledgement must be 400. Asserting that
 * against the actual handler is the point: a helper that returns the right
 * verdict proves nothing if the route never calls it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const requireBusinessAccess = vi.hoisted(() =>
  vi.fn(async () => ({
    session: { user: { id: "user-1" } },
    membership: { businessId: "biz-1", role: "collaborator" },
  })),
);
const rejectIfReviewerReadOnly = vi.hoisted(() => vi.fn(() => null));
const getCreativeShareLedgerCapability = vi.hoisted(() =>
  vi.fn(async () => ({ canWrite: true, canRead: true })),
);
const fetchAssignedAccountIds = vi.hoisted(() => vi.fn(async () => ["act_1"]));
const createCreativeShareSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({ token: "tok-new", expiresAt: "2026-09-01" })),
);
const buildBuyerClientActions = vi.hoisted(() => vi.fn(async () => []));

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/creative-share-store", () => ({
  createCreativeShareSnapshot,
  getCreativeShareLedgerCapability,
  listCreativeShareSnapshots: vi.fn(),
  // The real audience resolver, so the gate is exercised on real values.
  resolveCreativeShareAudience: (value: unknown) =>
    value === "buyer" || value === "creative_team" || value === "external"
      ? value
      : null,
}));
vi.mock("@/lib/creatives/client-action-feed", () => ({ buildBuyerClientActions }));
vi.mock("@/lib/meta/creatives-warehouse", () => ({
  resolveMetaCreativesAccountScope: (input: { requestedProviderAccountId?: string | null }) => ({
    ok: true,
    providerAccountId: input.requestedProviderAccountId ?? "act_1",
  }),
}));

/*
 * The fail-closed demo authority's DB read, stubbed.
 *
 * The GUARD is the code under test — its statuses, its codes and its position
 * in the precedence — so only the read it delegates to is replaced. `getDb()`
 * throws with no DATABASE_URL under vitest, which is why the read has to be
 * mocked rather than the guard.
 */
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(async () => "live"),
}));
vi.mock("@/lib/meta/reviewer-write-guard", () => ({ rejectIfReviewerReadOnly }));
vi.mock("@/lib/meta/creatives-fetchers", () => ({ fetchAssignedAccountIds }));

import { POST } from "@/app/api/creatives/share/route";
import { BUYER_ACKNOWLEDGEMENT_VALUE } from "@/lib/zero-base/creative/share-acknowledgement";

function request(body: unknown) {
  return { json: async () => body } as never;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    businessId: "biz-1",
    providerAccountId: "act_1",
    title: "Q3 creatives",
    dateRange: "2026-07-01..2026-07-31",
    expiresAt: "2026-09-01",
    metrics: [],
    creatives: [
      {
        id: "creative_1",
        name: "Hero",
        format: "image",
        launchDate: "2026-07-01",
        preview: { render_mode: "unavailable" },
      },
    ],
    audience: "buyer",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  /*
   * Minting is now also held by `META_PUBLIC_SHARE_MINT`, which ships off. This
   * file is about the ACKNOWLEDGEMENT contract, which exists at every rollout
   * state, so the gate is opened here rather than measured. Its own refusal —
   * and the fact that it lands after the caller and scope checks — is asserted
   * in `route.test.ts`; the shipped default is asserted in
   * `lib/meta/release-gates.test.ts`.
   */
  vi.stubEnv("META_PUBLIC_SHARE_MINT", "true");
  requireBusinessAccess.mockResolvedValue({
    session: { user: { id: "user-1" } },
    membership: { businessId: "biz-1", role: "collaborator" },
  });
  rejectIfReviewerReadOnly.mockReturnValue(null);
  getCreativeShareLedgerCapability.mockResolvedValue({ canWrite: true, canRead: true });
  fetchAssignedAccountIds.mockResolvedValue(["act_1"]);
  createCreativeShareSnapshot.mockResolvedValue({
    token: "c".repeat(32),
    expiresAt: "2026-09-01",
  });
  buildBuyerClientActions.mockResolvedValue([]);
});

describe("a buyer share without acknowledgement is refused by the real route", () => {
  it("returns 400 with the required code", async () => {
    const response = await POST(request(payload()));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("financial_acknowledgement_required");
    // The refusal carries the warning, so the caller learns what it must show.
    expect(body.warning).toMatch(/attribution-window dependent/);
  });

  it("refuses a truthy stand-in rather than accepting it", async () => {
    for (const value of [true, "yes", 1]) {
      const response = await POST(request(payload({ acknowledgement: value })));
      expect(response.status, String(value)).toBe(400);
    }
  });

  it("names the exact value the caller must send", async () => {
    const body = await (await POST(request(payload()))).json();
    expect(body.message).toContain(BUYER_ACKNOWLEDGEMENT_VALUE);
  });

  it("refuses before any share is written", async () => {
    await POST(request(payload()));
    expect(createCreativeShareSnapshot).not.toHaveBeenCalled();
  });

  it("gets past the acknowledgement gate when the exact value is sent", async () => {
    const response = await POST(
      request(payload({ acknowledgement: BUYER_ACKNOWLEDGEMENT_VALUE })),
    );
    // Whatever happens downstream, it is no longer THIS refusal.
    const body = await response.json().catch(() => ({}));
    expect(body.error).not.toBe("financial_acknowledgement_required");
  });

  it("leaves a creative-team share unaffected by the new gate", async () => {
    const response = await POST(
      request(payload({ audience: "creative_team" })),
    );
    const body = await response.json().catch(() => ({}));
    expect(body.error).not.toBe("financial_acknowledgement_required");
  });
});
