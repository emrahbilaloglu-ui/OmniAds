import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type LaunchpadBodyProps = {
  businessId?: string;
  businessName?: string | null;
  providerAccountId?: string | null;
};

const routeMocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  loginUrlFor: vi.fn(
    (next: string) => `/login?next=${encodeURIComponent(next)}`,
  ),
  legacyBody: vi.fn((_props: LaunchpadBodyProps) => null),
}));

vi.mock("next/navigation", () => ({
  notFound: routeMocks.notFound,
  redirect: routeMocks.redirect,
}));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/access", () => ({ listUserBusinesses: vi.fn() }));
vi.mock("@/lib/access/require-business-page-context", () => ({
  requireBusinessPageContext: vi.fn(),
}));
vi.mock("@/lib/zero-base/auth-routing", () => ({
  loginUrlFor: routeMocks.loginUrlFor,
}));
vi.mock("@/lib/zero-base/provider-scope-server", () => ({
  resolveProviderAccountId: vi.fn(),
}));
vi.mock("@/app/(dashboard)/platforms/meta/launchpad/legacy-page", () => ({
  default: (props: LaunchpadBodyProps) => routeMocks.legacyBody(props),
}));

const MetaLaunchpadPage = (
  await import("@/app/c/[businessId]/meta/launchpad/page")
).default;
const auth = await import("@/lib/auth");
const access = await import("@/lib/access");
const businessPageAccess = await import(
  "@/lib/access/require-business-page-context"
);
const providerScope = await import("@/lib/zero-base/provider-scope-server");

function session() {
  return {
    sessionId: "session_1",
    user: {
      id: "user_1",
      name: "Route Operator",
      email: "operator@example.com",
      avatar: null,
      language: "en",
    },
    activeBusinessId: "different_selected_business",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function authorizedContext(businessId: string) {
  return {
    kind: "ok" as const,
    context: {
      session: session(),
      membership: {
        businessId,
        userId: "user_1",
        role: "admin" as const,
        status: "active" as const,
      },
      businessId,
      role: "admin" as const,
      reviewerReadOnly: false,
      demo: false,
    },
  };
}

async function renderPage(
  searchParams: Record<string, string | string[] | undefined> = {},
) {
  const element = await MetaLaunchpadPage({
    params: Promise.resolve({ businessId: "biz_route" }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  vi.mocked(
    businessPageAccess.requireBusinessPageContext,
  ).mockResolvedValue(authorizedContext("biz_route") as never);
  vi.mocked(access.listUserBusinesses).mockResolvedValue(
    [
      { id: "biz_route", name: "Route Business", currency: "TRY" },
      {
        id: "different_selected_business",
        name: "Store Selection",
        currency: "USD",
      },
    ] as never,
  );
  vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
    "act_assigned",
  );
});

describe("Meta Launchpad canonical route authority", () => {
  it("forwards the authorized business and assigned account to the exact body", async () => {
    await renderPage({ providerAccountId: "act_requested" });

    expect(businessPageAccess.requireBusinessPageContext).toHaveBeenCalledWith({
      businessId: "biz_route",
    });
    expect(providerScope.resolveProviderAccountId).toHaveBeenCalledWith({
      businessId: "biz_route",
      provider: "meta",
      requestedAccountId: "act_requested",
    });
    expect(access.listUserBusinesses).toHaveBeenCalledWith("user_1");
    expect(routeMocks.legacyBody).toHaveBeenCalledWith({
      businessId: "biz_route",
      businessName: "Route Business",
      providerAccountId: "act_assigned",
    });
  });

  it("forwards an explicit null when the requested account is not assigned", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValueOnce(
      null,
    );

    await renderPage({ providerAccountId: "act_unassigned" });

    expect(routeMocks.legacyBody).toHaveBeenCalledWith({
      businessId: "biz_route",
      businessName: "Route Business",
      providerAccountId: null,
    });
  });

  it("redirects before membership, account, or business metadata reads", async () => {
    vi.mocked(auth.getSessionFromCookies).mockResolvedValueOnce(null as never);

    await expect(
      MetaLaunchpadPage({
        params: Promise.resolve({ businessId: "biz_route" }),
        searchParams: Promise.resolve({
          providerAccountId: "act_unassigned",
        }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:");

    expect(routeMocks.loginUrlFor).toHaveBeenCalledWith(
      "/c/biz_route/meta/launchpad",
    );
    expect(businessPageAccess.requireBusinessPageContext).not.toHaveBeenCalled();
    expect(providerScope.resolveProviderAccountId).not.toHaveBeenCalled();
    expect(access.listUserBusinesses).not.toHaveBeenCalled();
    expect(routeMocks.legacyBody).not.toHaveBeenCalled();
  });

  it("returns not-found before resolving scope for an unauthorized business", async () => {
    vi.mocked(
      businessPageAccess.requireBusinessPageContext,
    ).mockResolvedValueOnce({ kind: "not-found" } as never);

    await expect(
      MetaLaunchpadPage({
        params: Promise.resolve({ businessId: "biz_foreign" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(businessPageAccess.requireBusinessPageContext).toHaveBeenCalledWith({
      businessId: "biz_foreign",
    });
    expect(providerScope.resolveProviderAccountId).not.toHaveBeenCalled();
    expect(access.listUserBusinesses).not.toHaveBeenCalled();
    expect(routeMocks.legacyBody).not.toHaveBeenCalled();
  });
});
