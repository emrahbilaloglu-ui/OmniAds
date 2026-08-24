import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";

import type { AutomationViewerEnvelope } from "@/app/(dashboard)/platforms/meta/automation/viewer-envelope";

type ExactPageProps = {
  businessId?: string;
  providerAccountId?: string | null;
  initialPayload?: MetaAutomationControlPlane | null;
  viewer?: AutomationViewerEnvelope;
};

const redirect = vi.fn((href: string): never => {
  throw new Error(`NEXT_REDIRECT:${href}`);
});
const notFound = vi.fn((): never => {
  throw new Error("NEXT_NOT_FOUND");
});
const exactPage = vi.fn((_props: ExactPageProps) => null);

vi.mock("next/navigation", () => ({ notFound, redirect }));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
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
vi.mock("@/lib/meta/automation-control-plane", () => ({
  getMetaAutomationControlPlane: vi.fn(),
}));
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(),
}));
vi.mock("@/app/(dashboard)/platforms/meta/automation/automation-view", () => ({
  default: (props: ExactPageProps) => exactPage(props),
}));

const MetaAutomationRoute = (
  await import("@/app/c/[businessId]/meta/automation/page")
).default;
const auth = await import("@/lib/auth");
const businessPageAccess =
  await import("@/lib/access/require-business-page-context");
const providerScope = await import("@/lib/zero-base/provider-scope-server");
const controlPlane = await import("@/lib/meta/automation-control-plane");
const authRouting = await import("@/lib/zero-base/auth-routing");
const writeAuthority = await import(
  "@/app/api/launchpad/meta/demo-write-authority"
);

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
    activeBusinessId: "different_business",
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

const control: MetaAutomationControlPlane = {
  contractVersion: "meta-automation-control-plane.v1",
  businessId: "biz_route",
  providerAccountId: "act_assigned",
  globalKillSwitch: { engaged: false, reason: null },
  businessControl: {
    businessId: "biz_route",
    killSwitchEngaged: false,
    killSwitchReason: null,
    autoExecutionEnabled: false,
    readinessTier: "manual_review",
    guardrails: {
      dailyAutoActionCap: 3,
      perActionSpendCeilingMinor: null,
      perActionSpendCeilingCurrency: null,
      notificationPolicy: "every_auto_action",
      maxBudgetIncreasePct: 20,
      maxDailyBudgetChangeMinor: null,
      requireCampaignLabel: true,
      requireCommercialAnchor: true,
      requireLivePreflight: true,
      requireRollbackPlan: true,
      dryRunOnly: true,
      minRoasFloor: null,
      quietHours: null,
    },
    updatedAt: null,
    updatedBy: null,
    source: "persisted",
  },
  execution: {
    autoExecutionAllowed: false,
    writeEndpointsBlocked: false,
    blockedReasons: ["auto_execution_not_enabled", "dry_run_only_guardrail"],
  },
  promotionRecords: [],
  readCompleteness: { promotionRecords: "complete" },
  activityLedger: [
    {
      id: "business_event",
      activityType: "business_kill_switch_engaged",
      severity: "danger",
      message: "Business stop event.",
      payload: null,
      createdAt: "2026-08-15T12:00:00.000Z",
      source: "automation_ledger",
      actor: null,
      entity: null,
      result: null,
    },
    {
      id: "account_event",
      activityType: "provider_write",
      severity: "success",
      message: "Provider action event.",
      payload: null,
      createdAt: "2026-08-15T11:00:00.000Z",
      source: "meta_action_log",
      actor: null,
      entity: null,
      result: null,
    },
  ],
  decisionTypeModes: [],
};

async function renderPage(input?: {
  businessId?: string;
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const element = await MetaAutomationRoute({
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
  vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
    "act_assigned",
  );
  vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue(
    control,
  );
  vi.mocked(writeAuthority.readLaunchpadWriteAuthority).mockResolvedValue(
    "live",
  );
});

describe("Automation canonical route authority", () => {
  it("passes only the authorized route business and assigned account into the shared exact page", async () => {
    await renderPage({
      searchParams: { providerAccountId: "act_assigned" },
    });

    expect(providerScope.resolveProviderAccountId).toHaveBeenCalledWith({
      businessId: "biz_route",
      provider: "meta",
      requestedAccountId: "act_assigned",
    });
    expect(controlPlane.getMetaAutomationControlPlane).toHaveBeenCalledWith({
      businessId: "biz_route",
      providerAccountId: "act_assigned",
    });
    expect(exactPage).toHaveBeenCalledWith({
      businessId: "biz_route",
      providerAccountId: "act_assigned",
      initialPayload: control,
      viewer: {
        role: "admin",
        reviewerReadOnly: false,
        demo: false,
        canMutate: true,
        reason: null,
        reasonCode: null,
      },
    });
  });

  it("does not choose a first account and removes account-owned activity when scope is unresolved", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValueOnce(
      null,
    );
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValueOnce(
      {
        ...control,
        providerAccountId: null,
      },
    );

    await renderPage();

    expect(controlPlane.getMetaAutomationControlPlane).toHaveBeenCalledWith({
      businessId: "biz_route",
      providerAccountId: null,
    });
    const props = exactPage.mock.calls[0]?.[0];
    expect(props?.providerAccountId).toBeNull();
    expect(props?.initialPayload?.activityLedger).toEqual([
      expect.objectContaining({ id: "business_event" }),
    ]);
    expect(props?.initialPayload?.activityLedger).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "account_event" }),
      ]),
    );
  });

  /**
   * REWRITTEN, not deleted, and its assertion is now INVERTED on purpose.
   *
   * The old law was "pass no write capability", and `not.toHaveProperty
   * ("viewer")` was read as proof of it. It proved the opposite. Withholding
   * the viewer facts did not withhold anything from the surface: every control
   * on it was gated on `businessId && providerAccountId`, both of which this
   * route DOES pass, so a reviewer got live Approve / Modify / Dismiss /
   * + New rule / rule toggle and found out about the refusal from the 403 that
   * landed after the click. The absent prop was the defect, not the guard.
   *
   * The refusal itself has always lived on the routes (`rejectIfReviewerReadOnly`)
   * and still does. What travels now is the server's ANSWER, so the refusal is
   * visible before the click instead of after it.
   */
  it("carries the reviewer refusal from the server rather than withholding it", async () => {
    vi.mocked(
      businessPageAccess.requireBusinessPageContext,
    ).mockResolvedValueOnce({
      ...authorizedContext("biz_route"),
      context: {
        ...authorizedContext("biz_route").context,
        reviewerReadOnly: true,
      },
    } as never);

    await renderPage();

    const viewer = exactPage.mock.calls[0]?.[0]?.viewer;
    expect(viewer).toBeDefined();
    expect(viewer!.reviewerReadOnly).toBe(true);
    expect(viewer!.canMutate).toBe(false);
    // The code the route that would answer actually returns. Restated, never
    // re-derived: this reviewer is also an admin, and re-deriving from role
    // alone would have said "may write".
    expect(viewer!.reasonCode).toBe("reviewer_read_only");
    expect(viewer!.reason).toContain("Reviewer access is read-only");
    // Still no mutation handler and no write capability of any kind.
    expect(exactPage.mock.calls[0]?.[0]).not.toHaveProperty(
      "onToggleBusinessStop",
    );
  });

  it("refuses a demo workspace even for an admin", async () => {
    vi.mocked(writeAuthority.readLaunchpadWriteAuthority).mockResolvedValueOnce(
      "demo",
    );

    await renderPage();

    const viewer = exactPage.mock.calls[0]?.[0]?.viewer;
    // "Demo businesses have zero Meta write authority even if a presentation
    // defect supplies an action."
    expect(viewer?.demo).toBe(true);
    expect(viewer?.canMutate).toBe(false);
    expect(viewer?.reasonCode).toBe("demo_business_read_only");
  });

  it("holds writes when the demo flag itself could not be read", async () => {
    vi.mocked(writeAuthority.readLaunchpadWriteAuthority).mockResolvedValueOnce(
      "unverified",
    );

    await renderPage();

    const viewer = exactPage.mock.calls[0]?.[0]?.viewer;
    // An unreadable flag is never "live". A missing fact does not become a
    // permission.
    expect(viewer?.canMutate).toBe(false);
    expect(viewer?.reasonCode).toBe("demo_status_unverified");
  });

  it("refuses a viewer below the collaborator floor every write route enforces", async () => {
    vi.mocked(
      businessPageAccess.requireBusinessPageContext,
    ).mockResolvedValueOnce({
      ...authorizedContext("biz_route"),
      context: {
        ...authorizedContext("biz_route").context,
        role: "guest",
      },
    } as never);

    await renderPage();

    const viewer = exactPage.mock.calls[0]?.[0]?.viewer;
    expect(viewer?.role).toBe("guest");
    expect(viewer?.canMutate).toBe(false);
    expect(viewer?.reasonCode).toBe("insufficient_role");
  });

  it("reads the demo flag from the table rather than reusing the id comparison", async () => {
    await renderPage();

    // `access.context.demo` only compares the well-known demo id and would miss
    // a workspace flagged `is_demo_business`, so the write-authority read is
    // the one that decides.
    expect(writeAuthority.readLaunchpadWriteAuthority).toHaveBeenCalledWith(
      "biz_route",
    );
  });

  it("redirects unauthenticated requests before account or control-plane reads", async () => {
    vi.mocked(auth.getSessionFromCookies).mockResolvedValueOnce(null as never);

    await expect(
      MetaAutomationRoute({
        params: Promise.resolve({ businessId: "biz_route" }),
        searchParams: Promise.resolve({ providerAccountId: "act_unassigned" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:");

    expect(authRouting.loginUrlFor).toHaveBeenCalledWith(
      "/c/biz_route/meta/automation",
    );
    expect(
      businessPageAccess.requireBusinessPageContext,
    ).not.toHaveBeenCalled();
    expect(providerScope.resolveProviderAccountId).not.toHaveBeenCalled();
    expect(controlPlane.getMetaAutomationControlPlane).not.toHaveBeenCalled();
    expect(exactPage).not.toHaveBeenCalled();
  });

  it("returns not-found before reading a foreign business scope", async () => {
    vi.mocked(
      businessPageAccess.requireBusinessPageContext,
    ).mockResolvedValueOnce({ kind: "not-found" } as never);

    await expect(
      MetaAutomationRoute({
        params: Promise.resolve({ businessId: "biz_foreign" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(providerScope.resolveProviderAccountId).not.toHaveBeenCalled();
    expect(controlPlane.getMetaAutomationControlPlane).not.toHaveBeenCalled();
    expect(exactPage).not.toHaveBeenCalled();
  });
});
