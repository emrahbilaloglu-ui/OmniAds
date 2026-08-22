import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type LaunchpadBodyProps = {
  businessId?: string;
  businessName?: string | null;
  providerAccountId?: string | null;
  viewer?: {
    role: string | null;
    reviewerReadOnly: boolean;
    demo: boolean;
    canMutate: boolean;
    reason: string | null;
  };
  handoffPrefill?: unknown;
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
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(),
}));
// This file is about WHO may see Launchpad. The handoff seam has its own file
// (`handoff-read.test.tsx`); it is mocked here so an unrelated authority
// assertion can never depend on a database read.
vi.mock("@/lib/meta/launchpad-handoff-server", () => ({
  landLaunchpadHandoff: vi.fn(),
  readLaunchpadHandoffPrefill: vi.fn(async () => ({ status: "none" })),
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
const demoAuthority = await import("@/app/api/launchpad/meta/demo-write-authority");

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
  vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue(
    "live",
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
      viewer: {
        role: "admin",
        reviewerReadOnly: false,
        demo: false,
        canMutate: true,
        reason: null,
        // Null exactly when the write is allowed: a code without a refusal
        // would be a reason the surface could show for nothing.
        refusalCode: null,
      },
      // No handoff was named, and that is stated rather than left absent: an
      // undefined prop means "no server established one", which this route
      // always does establish.
      handoffPrefill: { status: "none" },
      // Stated for the same reason, and false because nothing set
      // META_LAUNCHPAD_EXECUTION in this environment. The gate's shipped state
      // is off (ADR-003), so a route that forwarded `undefined` here would be
      // leaving the body to guess at a fact the server just read.
      executionEnabled: false,
    });
  });

  function contextWithRole(role: string, reviewerReadOnly = false) {
    return {
      kind: "ok",
      context: {
        session: session(),
        membership: {
          businessId: "biz_route",
          userId: "user_1",
          role,
          status: "active",
        },
        businessId: "biz_route",
        role,
        reviewerReadOnly,
        demo: false,
      },
    };
  }

  // Every Launchpad write route refuses a reviewer (403 `reviewer_read_only`),
  // anything below collaborator, and a demo workspace (403
  // `demo_business_read_only`), before any provider call. The route holds those
  // facts already; withholding them leaves the surface rendering an
  // active-looking Launch whose click ends in a red 403 — and, because that
  // response carries no counts, in a receipt that reads as a partial launch.
  // The server decides the whole envelope, so the surface has nothing to derive.
  it("forwards the write facts the launch routes enforce", async () => {
    vi.mocked(
      businessPageAccess.requireBusinessPageContext,
    ).mockResolvedValueOnce(contextWithRole("guest", true) as never);

    await renderPage({});

    expect(routeMocks.legacyBody).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: {
          role: "guest",
          reviewerReadOnly: true,
          demo: false,
          canMutate: false,
          reason: expect.stringContaining("Reviewer access is read-only"),
          // The code travels with the reason so the surface restates the
          // route's own spelling instead of re-deriving one.
          refusalCode: "reviewer_read_only",
        },
      }),
    );
  });

  // LAW (INVARIANTS.md): "Demo businesses have zero Meta write authority even
  // if a presentation defect supplies an action." A demo session is an ADMIN
  // under a non-reviewer email, so neither the role nor the reviewer fact
  // catches it — the demo read does, on the server, and the surface renders it.
  it("refuses writes for a demo workspace even when the role is admin", async () => {
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValueOnce(
      "demo",
    );

    await renderPage({});

    expect(demoAuthority.readLaunchpadWriteAuthority).toHaveBeenCalledWith(
      "biz_route",
    );
    expect(routeMocks.legacyBody).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: {
          role: "admin",
          reviewerReadOnly: false,
          demo: true,
          canMutate: false,
          reason: expect.stringContaining(
            "Demo workspaces have zero Meta write authority",
          ),
          refusalCode: "demo_business_read_only",
        },
      }),
    );
  });

  // LAW: a read failure is never a success. An unreadable demo flag holds the
  // write instead of presenting the workspace as live.
  it("holds writes when the demo flag could not be read", async () => {
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValueOnce(
      "unverified",
    );

    await renderPage({});

    expect(routeMocks.legacyBody).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: expect.objectContaining({
          demo: false,
          canMutate: false,
          reason: expect.stringContaining("could not be confirmed as a live"),
        }),
      }),
    );
  });

  it("forwards an explicit null when the requested account is not assigned", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValueOnce(
      null,
    );

    await renderPage({ providerAccountId: "act_unassigned" });

    expect(routeMocks.legacyBody).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_route",
        businessName: "Route Business",
        providerAccountId: null,
      }),
    );
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
