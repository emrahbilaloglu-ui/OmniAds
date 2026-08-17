import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type LegacyMetaPageProps = {
  businessId: string;
  businessName?: string | null;
  currency?: string | null;
};

const redirect = vi.fn((href: string): never => {
  throw new Error(`NEXT_REDIRECT:${href}`);
});
const notFound = vi.fn((): never => {
  throw new Error("NEXT_NOT_FOUND");
});
const legacyMetaPage = vi.fn((_props: LegacyMetaPageProps) => null);
const legacyInteriorBridge = vi.fn((_props: { children?: unknown }) => null);

vi.mock("next/navigation", () => ({ notFound, redirect }));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/access", () => ({ listUserBusinesses: vi.fn() }));
vi.mock("@/lib/access/require-business-page-context", () => ({
  requireBusinessPageContext: vi.fn(),
}));
vi.mock("@/lib/zero-base/auth-routing", () => ({
  loginUrlFor: vi.fn(
    (next: string) => `/login?next=${encodeURIComponent(next)}`,
  ),
}));
vi.mock("@/lib/zero-base/meta/decisions-url-state", () => ({
  parseDecisionsUrlState: vi.fn(() => ({})),
}));
vi.mock("@/lib/zero-base/meta/mutation-ceremony", () => ({
  isMutationUiEnabled: vi.fn(() => true),
}));
vi.mock("@/lib/zero-base/provider-scope-server", () => ({
  resolveProviderAccountId: vi.fn(),
}));
vi.mock("@/app/(dashboard)/platforms/meta/legacy-page", () => ({
  default: (props: LegacyMetaPageProps) => legacyMetaPage(props),
}));
vi.mock("@/components/legacy/legacy-interior-bridge", () => ({
  LegacyInteriorBridge: (props: { children?: unknown }) =>
    legacyInteriorBridge(props),
}));

const MetaDecisionsPage = (
  await import("@/app/c/[businessId]/meta/decisions/page")
).default;
const auth = await import("@/lib/auth");
const access = await import("@/lib/access");
const businessPageAccess = await import(
  "@/lib/access/require-business-page-context"
);
const authRouting = await import("@/lib/zero-base/auth-routing");
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

async function renderPage(input?: {
  businessId?: string;
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const element = await MetaDecisionsPage({
    params: Promise.resolve({ businessId: input?.businessId ?? "biz_route" }),
    searchParams: Promise.resolve(input?.searchParams ?? {}),
  });
  return renderToStaticMarkup(element as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  vi.mocked(businessPageAccess.requireBusinessPageContext).mockResolvedValue(
    authorizedContext("biz_route") as never,
  );
  vi.mocked(access.listUserBusinesses).mockResolvedValue(
    [
      {
        id: "different_selected_business",
        name: "Client Store Selection",
        currency: "USD",
      },
      { id: "biz_route", name: "Route Business", currency: "TRY" },
    ] as never,
  );
  vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
    "act_assigned",
  );
});

describe("Meta Decisions canonical route authority", () => {
  it("passes the server-authorized business scope directly to the legacy body without a second interior shell", async () => {
    await renderPage({
      searchParams: { providerAccountId: "act_assigned" },
    });

    expect(access.listUserBusinesses).toHaveBeenCalledWith("user_1");
    expect(legacyMetaPage).toHaveBeenCalledTimes(1);
    expect(legacyMetaPage.mock.calls[0]?.[0]).toEqual({
      businessId: "biz_route",
      businessName: "Route Business",
      currency: "TRY",
    });
    expect(legacyInteriorBridge).not.toHaveBeenCalled();
  });

  it("sends an unassigned account request through the fail-closed server resolver without widening the page props", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValueOnce(
      null,
    );

    await renderPage({
      searchParams: { providerAccountId: "act_unassigned" },
    });

    expect(providerScope.resolveProviderAccountId).toHaveBeenCalledWith({
      businessId: "biz_route",
      provider: "meta",
      requestedAccountId: "act_unassigned",
    });
    expect(legacyMetaPage.mock.calls[0]?.[0]).toEqual({
      businessId: "biz_route",
      businessName: "Route Business",
      currency: "TRY",
    });
    expect(legacyMetaPage.mock.calls[0]?.[0]).not.toHaveProperty(
      "providerAccountId",
    );
  });

  it("redirects an unauthenticated request before reading business or provider scope", async () => {
    vi.mocked(auth.getSessionFromCookies).mockResolvedValueOnce(null as never);

    await expect(
      MetaDecisionsPage({
        params: Promise.resolve({ businessId: "biz_route" }),
        searchParams: Promise.resolve({
          providerAccountId: "act_unassigned",
        }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:");

    expect(authRouting.loginUrlFor).toHaveBeenCalledWith(
      "/c/biz_route/meta/decisions",
    );
    expect(redirect).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/c/biz_route/meta/decisions")}`,
    );
    expect(
      businessPageAccess.requireBusinessPageContext,
    ).not.toHaveBeenCalled();
    expect(access.listUserBusinesses).not.toHaveBeenCalled();
    expect(providerScope.resolveProviderAccountId).not.toHaveBeenCalled();
    expect(legacyMetaPage).not.toHaveBeenCalled();
  });

  it("returns not-found for an authenticated but unauthorized business before exposing its metadata", async () => {
    vi.mocked(
      businessPageAccess.requireBusinessPageContext,
    ).mockResolvedValueOnce({ kind: "not-found" } as never);

    await expect(
      MetaDecisionsPage({
        params: Promise.resolve({ businessId: "biz_foreign" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(
      businessPageAccess.requireBusinessPageContext,
    ).toHaveBeenCalledWith({ businessId: "biz_foreign" });
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
    expect(access.listUserBusinesses).not.toHaveBeenCalled();
    expect(providerScope.resolveProviderAccountId).not.toHaveBeenCalled();
    expect(legacyMetaPage).not.toHaveBeenCalled();
  });
});
