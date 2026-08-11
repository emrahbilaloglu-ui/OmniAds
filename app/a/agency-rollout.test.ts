/**
 * Rollout OFF hides the Agency routes entirely.
 *
 * "Hidden" has to mean absent, not disabled. A route that renders a locked
 * Agency panel still advertises the capability and still invites a user without
 * Agency context to wonder what they are missing — the plan forbids exactly
 * that teaser. `notFound()` is the correct answer, and it also means the
 * legacy dashboard cannot be affected by anything under /a.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({ notFound, redirect }));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/access", () => ({ listUserBusinesses: vi.fn() }));
vi.mock("@/components/zero-base/shell/agency-shell", () => ({
  AgencyShell: ({ children }: { children: unknown }) => children,
}));

const AgencyLayout = (await import("@/app/a/layout")).default;
const auth = await import("@/lib/auth");
const access = await import("@/lib/access");

const ORIGINAL_MODE = process.env.ZERO_BASE_UI_MODE;

function session() {
  return {
    sessionId: "sess_1",
    user: { id: "user_1", name: "Ada", email: "ada@example.com", avatar: null, language: "en" },
    activeBusinessId: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function business(id: string, membershipStatus: "active" | "invited" = "active") {
  return { id, name: id, timezone: null, timezoneSource: null, currency: "USD", role: "admin", membershipStatus };
}

beforeEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL_MODE === undefined) delete process.env.ZERO_BASE_UI_MODE;
  else process.env.ZERO_BASE_UI_MODE = ORIGINAL_MODE;
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  vi.mocked(access.listUserBusinesses).mockResolvedValue([
    business("biz_1"),
    business("biz_2"),
  ] as never);
});

describe("rollout OFF", () => {
  it("makes /a not found, with no session or membership read at all", async () => {
    delete process.env.ZERO_BASE_UI_MODE;

    await expect(AgencyLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
    // Refused before any read: rollout-off costs nothing and leaks nothing.
    expect(auth.getSessionFromCookies).not.toHaveBeenCalled();
    expect(access.listUserBusinesses).not.toHaveBeenCalled();
  });

  it("is also not found in allowlist mode, which scopes clients not Agency", async () => {
    process.env.ZERO_BASE_UI_MODE = "allowlist";
    await expect(AgencyLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("rollout ON", () => {
  it("renders for a multi-client actor", async () => {
    process.env.ZERO_BASE_UI_MODE = "on";
    await expect(AgencyLayout({ children: "body" })).resolves.toBeDefined();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("shows no teaser to an actor without Agency context — the route is absent", async () => {
    process.env.ZERO_BASE_UI_MODE = "on";
    vi.mocked(access.listUserBusinesses).mockResolvedValue([business("biz_1")] as never);

    // One client is not an agency. Not a disabled panel: nothing at all.
    await expect(AgencyLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("does not count invited memberships towards Agency context", async () => {
    process.env.ZERO_BASE_UI_MODE = "on";
    vi.mocked(access.listUserBusinesses).mockResolvedValue([
      business("biz_1"),
      business("biz_2", "invited"),
    ] as never);

    await expect(AgencyLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("sends an unauthenticated visitor to login, preserving where they were going", async () => {
    process.env.ZERO_BASE_UI_MODE = "on";
    vi.mocked(auth.getSessionFromCookies).mockResolvedValue(null as never);

    await expect(AgencyLayout({ children: null })).rejects.toThrow(/NEXT_REDIRECT:\/login/);
    expect(redirect).toHaveBeenCalledWith("/login?next=%2Fa%2Fdesk");
  });

  it("never gates on a plan or tier", async () => {
    process.env.ZERO_BASE_UI_MODE = "on";
    // The layout takes no plan input; membership count is the only gate.
    const source = (
      await import("node:fs")
    ).readFileSync("app/a/layout.tsx", "utf8");
    expect(source).not.toMatch(/plan|scale|tier|billing|subscription/i);
  });
});
