/**
 * The Agency directory boundary.
 *
 * A page request is its own authorization, not a continuation of a trusted
 * session: the session is read, the rollout gate is re-checked and scope is
 * re-derived on every single page. These tests pin that, plus the two failure
 * modes that matter — a bad cursor must fail closed rather than silently
 * serving page one, and a money key must never leave the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return { ...actual, getSessionFromRequest: vi.fn() };
});
vi.mock("@/lib/zero-base/agency-directory-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/zero-base/agency-directory-store")
  >("@/lib/zero-base/agency-directory-store");
  return { ...actual, readAgencyDirectoryPage: vi.fn() };
});
vi.mock("@/lib/product-instrumentation", () => ({
  recordProductInstrumentationEvent: vi.fn(),
}));

const { GET } = await import("@/app/api/agency-today/route");
const auth = await import("@/lib/auth");
const store = await import("@/lib/zero-base/agency-directory-store");

const ORIGINAL_MODE = process.env.ZERO_BASE_UI_MODE;

function session() {
  return {
    sessionId: "sess_1",
    user: { id: "user_1", name: "Ada", email: "ada@example.com", avatar: null, language: "en" },
    activeBusinessId: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    items: [
      {
        businessId: "biz_1",
        name: "Acme",
        role: "admin",
        membershipStatus: "active",
        configuredCurrency: "USD",
        sourceUpdatedAt: null,
        href: "/c/biz_1/home",
      },
    ],
    servedCount: 1,
    totalCount: 1,
    nextCursor: null,
    truncated: false,
    disclosure: null,
    ...overrides,
  };
}

function request(query: string) {
  return new NextRequest(`https://app.example/api/agency-today?${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ZERO_BASE_UI_MODE = "on";
  vi.mocked(auth.getSessionFromRequest).mockResolvedValue(session() as never);
  vi.mocked(store.readAgencyDirectoryPage).mockResolvedValue(page() as never);
});

afterEach(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.ZERO_BASE_UI_MODE;
  else process.env.ZERO_BASE_UI_MODE = ORIGINAL_MODE;
});

describe("authorization is re-checked on every page", () => {
  it("401s without a session, before any read", async () => {
    vi.mocked(auth.getSessionFromRequest).mockResolvedValue(null as never);
    const response = await GET(request("contract=zero-base.v1"));
    expect(response.status).toBe(401);
    expect(store.readAgencyDirectoryPage).not.toHaveBeenCalled();
  });

  it("passes the caller's own identity into the read, never a client value", async () => {
    await GET(request("contract=zero-base.v1&userId=someone_else&cursor=abc"));
    const call = vi.mocked(store.readAgencyDirectoryPage).mock.calls[0][0];
    // Scope comes from the session; the query string cannot influence it.
    expect(call.userId).toBe("user_1");
    expect(call.email).toBe("ada@example.com");
  });

  it("re-reads the session for a mid-scan page, not just the first", async () => {
    await GET(request("contract=zero-base.v1&cursor=abc"));
    expect(auth.getSessionFromRequest).toHaveBeenCalledTimes(1);
    await GET(request("contract=zero-base.v1&cursor=def"));
    expect(auth.getSessionFromRequest).toHaveBeenCalledTimes(2);
  });
});

describe("rollout gating", () => {
  it("404s the boundary with rollout off, before any read", async () => {
    delete process.env.ZERO_BASE_UI_MODE;
    const response = await GET(request("contract=zero-base.v1"));
    expect(response.status).toBe(404);
    expect(store.readAgencyDirectoryPage).not.toHaveBeenCalled();
  });

  it("closes mid-scan when rollout is turned off between pages", async () => {
    expect((await GET(request("contract=zero-base.v1"))).status).toBe(200);
    process.env.ZERO_BASE_UI_MODE = "off";
    // Not deferred to the next reload: the very next page request is refused.
    expect((await GET(request("contract=zero-base.v1&cursor=abc"))).status).toBe(404);
  });

  it("leaves the legacy projection reachable with rollout off", async () => {
    delete process.env.ZERO_BASE_UI_MODE;
    // No `contract` param ⇒ the legacy branch, which this package must not gate.
    const response = await GET(request("startDate=2026-08-01&endDate=2026-08-07"));
    expect(response.status).not.toBe(404);
  });
});

describe("pagination contract", () => {
  it("computes the total only for the first page", async () => {
    await GET(request("contract=zero-base.v1"));
    expect(vi.mocked(store.readAgencyDirectoryPage).mock.calls[0][0].withTotal).toBe(true);

    await GET(request("contract=zero-base.v1&cursor=abc"));
    expect(vi.mocked(store.readAgencyDirectoryPage).mock.calls[1][0].withTotal).toBe(false);
  });

  it("passes the cursor through opaquely", async () => {
    await GET(request("contract=zero-base.v1&cursor=b3BhcXVl"));
    expect(vi.mocked(store.readAgencyDirectoryPage).mock.calls[0][0].cursor).toBe("b3BhcXVl");
  });

  it("400s a malformed cursor rather than silently restarting", async () => {
    vi.mocked(store.readAgencyDirectoryPage).mockRejectedValue(
      new store.InvalidAgencyCursorError(),
    );
    const response = await GET(request("contract=zero-base.v1&cursor=tampered"));
    expect(response.status).toBe(400);
    // Serving page one here would look like the list had quietly restarted.
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_cursor" });
  });

  it("returns the envelope with no-store caching", async () => {
    const response = await GET(request("contract=zero-base.v1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(response.headers.get("Vary")).toBe("Cookie");
    await expect(response.json()).resolves.toMatchObject({ servedCount: 1, nextCursor: null });
  });
});

describe("forbidden keys never leave the process", () => {
  it("withholds the response if a money key ever appears", async () => {
    vi.mocked(store.readAgencyDirectoryPage).mockResolvedValue(
      page({ items: [{ businessId: "biz_1", spend: 8214 }] }) as never,
    );
    const response = await GET(request("contract=zero-base.v1"));
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "projection_violation" });
    expect(JSON.stringify(body)).not.toContain("8214");
  });

  it("serves a clean page unchanged", async () => {
    const response = await GET(request("contract=zero-base.v1"));
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(Object.keys(body.items[0]).sort()).toEqual([
      "businessId",
      "configuredCurrency",
      "href",
      "membershipStatus",
      "name",
      "role",
      "sourceUpdatedAt",
    ]);
  });
});
