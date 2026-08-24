import { readFileSync } from "node:fs";
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
vi.mock("@/lib/zero-base/provider-scope-server", () => ({
  /**
   * The surface-state resolver reads the SCOPE, not just the id: it needs the
   * refusal reason to tell "nothing assigned" from "several assigned, none
   * chosen". Derived from the same mock so the two can never disagree about
   * which account this request resolved to.
   */
  resolveProviderAccountScope: async (input: unknown) => {
    // Reaches the same mock through the module itself, because the factory
    // runs before the file's own bindings exist and cannot close over one.
    const { resolveProviderAccountId: resolveId } = (await import(
      "@/lib/zero-base/provider-scope-server"
    )) as { resolveProviderAccountId: (value: unknown) => Promise<string | null> };
    const id = await resolveId(input);
    return id
      ? { providerAccountId: id, refusal: null, requestedButUnassigned: null }
      : {
          providerAccountId: null,
          refusal: "provider_account_none_assigned" as const,
          requestedButUnassigned: null,
        };
  },
  readProviderScopeCatalog: async () => ({ provider: "meta" as const, accounts: [] }),
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
  // Law: every Decision Center route family renders the same body.
  //
  // Pinned here and again in
  // `components/creatives/creative-evidence-window-wiring.test.ts` — the route
  // must go through the shared shim rather than mounting the body itself, so
  // the three route families cannot drift apart. The server-resolved provider
  // account now reaches the body THROUGH that shim as `serverProviderAccountId`
  // rather than by mounting the body directly, which would have broken the
  // convergence law this test exists to protect.
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
      serverProviderAccountId: "act_assigned",
      // Stated rather than left absent, and false because nothing set
      // META_DECISION_WORKFLOW_UI here. The workflow overlay's shipped state is
      // off (§18: the design draws no ownership controls, so they wait for the
      // owner's separately approved round), and a route forwarding `undefined`
      // would leave the body guessing at a fact the server just read.
      decisionWorkflowUiEnabled: false,
    });
    expect(legacyInteriorBridge).not.toHaveBeenCalled();
  });

  // Law: the fail-closed resolver is the only thing that may name an account.
  // An unassigned requested id resolves to null, and the route may never
  // substitute some other account it happens to have access to — not in the
  // props, and not by letting the raw URL value through.
  //
  // WHY it is the law (restated, because the previous statement of it was
  // factually wrong): this test used to justify itself with the claim that
  // `/api/meta/decisions-workspace` does not re-check the requested account.
  // It does. `canonicalDecisionReadModel()` in
  // `app/api/meta/decisions-workspace/route.ts` calls
  // `getProviderAccountAssignments(businessId, "meta")` and returns
  // `403 provider_account_not_assigned` for an id outside `account_ids`,
  // and the GET handler propagates that status. The real law is narrower and
  // survives that correction: this page's resolver is the surface's scope OF
  // RECORD. Everything downstream — the picker fallback, the account label,
  // the currency, every deep link this screen mints — treats
  // `serverProviderAccountId` as already verified. Forwarding an id that was
  // never verified here would make an unverified value indistinguishable from
  // a verified one at every one of those readers, no matter how well the API
  // defends itself.
  it("sends an unassigned account request through the fail-closed server resolver and forwards the resolver's null, never the raw id", async () => {
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
    // The forwarded value is the RESOLVER'S answer, so an unassigned request
    // arrives at the body as null. The raw URL id must never be substituted —
    // not because the API is undefended (it returns 403
    // provider_account_not_assigned), but because this prop is consumed as
    // already-verified scope by everything downstream of it.
    expect(legacyMetaPage.mock.calls[0]?.[0]).toEqual({
      businessId: "biz_route",
      businessName: "Route Business",
      currency: "TRY",
      serverProviderAccountId: null,
      decisionWorkflowUiEnabled: false,
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

describe("the server-resolved provider account reaches the body", () => {
  // The route resolves the account under the session, and it is the only
  // assignment-verified answer in the request. Dropping it meant a failing
  // /api/meta/history/accounts read emptied the whole surface behind an error
  // banner for a business whose single account the route had already resolved.
  // Pinned on the source because the defect was an omission, not a wrong value.
  const routeSource = readFileSync(
    "app/c/[businessId]/meta/decisions/page.tsx",
    "utf8",
  );
  const shimSource = readFileSync(
    "app/(dashboard)/platforms/meta/legacy-page.tsx",
    "utf8",
  );

  it("forwards it instead of voiding it", () => {
    expect(routeSource).toContain("serverProviderAccountId={providerAccountId}");
    expect(routeSource).not.toContain("void providerAccountId;");
  });

  it("carries it through the shared shim to the body", () => {
    expect(shimSource).toContain("serverProviderAccountId?: string | null;");
    expect(shimSource).toContain(
      "serverProviderAccountId={serverProviderAccountId}",
    );
  });
});
