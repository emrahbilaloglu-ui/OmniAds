import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the LEGACY `/platforms/meta/launchpad` route does with `?handoff=`.
 *
 * THE DEFECT THIS PINS. A handoff can only be consumed by the canonical route:
 * the consume is a server-side, single-use, session-scoped read that needs the
 * signed-in user and the assignment-verified account. The legacy body is a
 * client component with none of that. So a reference arriving at the legacy
 * route was previously dropped on the floor in every rollout mode that renders
 * the legacy body — `off`, `internal`, a non-allowlisted business under
 * `allowlist`, and a `schema_unavailable` authorization under `on` — and the
 * operator landed on a blank wizard that reads exactly like success.
 *
 * THE LAW. When a reference is present the route carries the whole query to the
 * canonical route, which re-verifies and consumes it. That is a redirect, not a
 * grant. When no reference is present the route must behave exactly as before,
 * because the compatibility decision is not this route's to change.
 *
 * AND ONE MORE, added after the first version shipped: `ZERO_BASE_UI_MODE=off`
 * is the ROLLBACK. A rollback that still forwards to the canonical route is
 * not a rollback, so under `off` the reference is NOT carried — it falls
 * through to the legacy body, which says it could not be consumed. That is why
 * every case below states the mode it is exercising instead of inheriting the
 * default, which is `off`.
 */

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  getSessionFromCookies: vi.fn(),
  compatibilityPage: vi.fn(),
  compatibilityRender: vi.fn(() => "COMPATIBILITY_BODY"),
  loginUrlFor: vi.fn(
    (next: string) => `/login?next=${encodeURIComponent(next)}`,
  ),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth", () => ({
  getSessionFromCookies: mocks.getSessionFromCookies,
}));
vi.mock("@/lib/zero-base/auth-routing", () => ({
  loginUrlFor: mocks.loginUrlFor,
}));
vi.mock("@/lib/zero-base/compatibility-page", () => ({
  compatibilityPage: (...args: unknown[]) => {
    mocks.compatibilityPage(...args);
    return mocks.compatibilityRender;
  },
}));
vi.mock("@/app/(dashboard)/platforms/meta/launchpad/legacy-page", () => ({
  default: () => null,
}));

const LegacyLaunchpadRoute = (
  await import("@/app/(dashboard)/platforms/meta/launchpad/page")
).default;

const REFERENCE = `0f1e2d3c-4b5a-4c7d-8e9f-a0b1c2d3e4f5.${"a".repeat(43)}`;

async function open(
  searchParams: Record<string, string | string[] | undefined>,
) {
  try {
    const result = await LegacyLaunchpadRoute({
      searchParams: Promise.resolve(searchParams),
    });
    return { redirectedTo: null as string | null, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("NEXT_REDIRECT:")) throw error;
    return {
      redirectedTo: message.slice("NEXT_REDIRECT:".length),
      result: null,
    };
  }
}

const ORIGINAL_UI_MODE = process.env.ZERO_BASE_UI_MODE;

afterEach(() => {
  if (ORIGINAL_UI_MODE === undefined) delete process.env.ZERO_BASE_UI_MODE;
  else process.env.ZERO_BASE_UI_MODE = ORIGINAL_UI_MODE;
});

beforeEach(() => {
  vi.clearAllMocks();
  // Stated, never inherited: the default is `off`, which is the rollback, and
  // the carry is deliberately refused there. Every case that expects a carry
  // must therefore say it is NOT rolled back.
  process.env.ZERO_BASE_UI_MODE = "on";
  mocks.compatibilityRender.mockReturnValue("COMPATIBILITY_BODY");
  mocks.getSessionFromCookies.mockResolvedValue({
    sessionId: "s1",
    user: { id: "user_1" },
    activeBusinessId: "biz_1",
  });
});

describe("legacy /platforms/meta/launchpad handoff routing", () => {
  it("refuses to carry the reference under the rollback, and says so through the legacy body", async () => {
    // ZERO_BASE_UI_MODE=off is the rollback. Forwarding to the canonical route
    // from there would take the operator OUT of the mode someone deliberately
    // rolled back to, which is the one thing a rollback must not do. The
    // reference is dropped in favour of the legacy body, which states that it
    // could not be consumed — an honest refusal, not a silent hop.
    process.env.ZERO_BASE_UI_MODE = "off";
    const { redirectedTo, result } = await open({
      handoff: REFERENCE,
      providerAccountId: "act_1",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(redirectedTo).toBeNull();
    expect(result).toBe("COMPATIBILITY_BODY");
  });

  it("leaves the ordinary compatibility decision alone when no reference is present", async () => {
    const result = await open({ providerAccountId: "act_1" });

    expect(result.redirectedTo).toBeNull();
    expect(result.result).toBe("COMPATIBILITY_BODY");
    expect(mocks.getSessionFromCookies).not.toHaveBeenCalled();
  });

  it("carries a handoff reference and the whole query to the canonical route", async () => {
    const result = await open({
      handoff: REFERENCE,
      providerAccountId: "act_1",
      launchpadStep: "creatives",
    });

    expect(result.redirectedTo).toBe(
      `/c/biz_1/meta/launchpad?handoff=${encodeURIComponent(REFERENCE)}&providerAccountId=act_1&launchpadStep=creatives`,
    );
    // The reference travels unchanged and is still only a reference: the
    // canonical route re-verifies every part of it and burns the token there.
    expect(mocks.compatibilityRender).not.toHaveBeenCalled();
  });

  // Spending the operator's sign-in and then landing them on a Launchpad that
  // has forgotten what they clicked is its own silent failure, so the reference
  // rides through the round-trip in `next`.
  it("sends an unauthenticated request to sign in WITHOUT dropping the reference", async () => {
    mocks.getSessionFromCookies.mockResolvedValue(null);

    const result = await open({ handoff: REFERENCE, providerAccountId: "act_1" });

    expect(result.redirectedTo).toBe(
      `/login?next=${encodeURIComponent(
        `/platforms/meta/launchpad?handoff=${REFERENCE}&providerAccountId=act_1`,
      )}`,
    );
  });

  // No active business means no canonical destination exists. Falling through
  // is correct — and the legacy body then says the reference was not consumed
  // rather than opening a wizard that carries nothing.
  it("falls through to the compatibility decision when no business is selected", async () => {
    mocks.getSessionFromCookies.mockResolvedValue({
      sessionId: "s1",
      user: { id: "user_1" },
      activeBusinessId: null,
    });

    const result = await open({ handoff: REFERENCE });

    expect(result.redirectedTo).toBeNull();
    expect(result.result).toBe("COMPATIBILITY_BODY");
  });

  it("ignores a blank reference", async () => {
    const result = await open({ handoff: "   " });

    expect(result.redirectedTo).toBeNull();
    expect(result.result).toBe("COMPATIBILITY_BODY");
  });
});
