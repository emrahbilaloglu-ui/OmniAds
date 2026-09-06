import { META_GATE_REFUSAL_REASONS } from "@/lib/meta/release-gate-copy";
import type { ReactElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  /*
    The route creates the business's control row on first view.

    Twelve of thirteen businesses had no row, and with no row every write
    answered `control_state_unavailable` — a refusal nobody could act on
    because the thing that was missing was invisible. The row is created with
    every switch off, so the call is safe to make on a read. Mocked here
    because this suite is about the route's authority, not about that write.
  */
  ensureBusinessControlRow: vi.fn(async () => ({ created: false })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({}) as never) }));
vi.mock("@/lib/meta/state-history-compaction-readiness", () => ({
  readStateHistoryCompactionReadiness: vi.fn(),
}));
vi.mock("@/lib/meta/budget-readiness-read-model", () => ({
  readBudgetReadiness: vi.fn(),
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
const compactionReadiness = await import(
  "@/lib/meta/state-history-compaction-readiness"
);
const budgetReadinessModel = await import("@/lib/meta/budget-readiness-read-model");

const READINESS_FIXTURE = {
  contract: "d077.state-history-compaction-readiness.v3",
  businessId: "biz_route",
  fence: null,
  approvalStatus: "NOT_EXECUTED",
  journalRead: "ok",
  latestJournal: [],
  plannedReclaim: null,
  d075WriterEvidence: { state: "unknown", detail: "test" },
  blockers: ["fence_measurement_unavailable"],
} as never;

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
      perActionSpendCeilingValid: true,
      notificationPolicy: "every_auto_action",
      maxBudgetIncreasePct: 20,
      maxDailyBudgetChangeMinor: null,
      requireResolvedCampaignRole: true,
      requireCommercialAnchor: true,
      requireLivePreflight: true,
      requireRollbackPlan: true,
      dryRunOnly: true,
      budgetMinHoursBetweenChanges: null,
      budgetMaxChangesPer7d: null,
      budgetMaxAccountConcentrationPct: null,
      // Unstamped: no sizing policy version is bound, which is the state
      // every business is in until an operator saves one.
      budgetSizingPolicyVersion: null,
      bidSizingPolicyVersion: null,
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
  /*
    D086: a route-level default so every pre-existing case still renders. The
    route awaits this read, and an unset mock returns `undefined`, whose
    `.catch` does not exist.
  */
  vi.mocked(budgetReadinessModel.readBudgetReadiness).mockResolvedValue(null as never);
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
  vi.mocked(
    compactionReadiness.readStateHistoryCompactionReadiness,
  ).mockResolvedValue(READINESS_FIXTURE);
});

describe("Automation canonical route authority", () => {
  it("a readiness read failure reaches the body as null (rendered unavailable), never as ready", async () => {
    vi.mocked(
      compactionReadiness.readStateHistoryCompactionReadiness,
    ).mockRejectedValueOnce(new Error("db down"));
    await renderPage({ searchParams: { providerAccountId: "act_assigned" } });
    expect(exactPage).toHaveBeenCalledWith(
      expect.objectContaining({ stateHistoryReadiness: null }),
    );
  });

  it("passes a journal-unavailable readiness state through verbatim — never null/empty/NOT_EXECUTED (correction 3)", async () => {
    const unavailableFixture = {
      ...(READINESS_FIXTURE as Record<string, unknown>),
      journalRead: "unavailable",
      approvalStatus: "UNKNOWN_JOURNAL_UNAVAILABLE",
      latestJournal: [],
      blockers: ["compaction_journal_read_unavailable"],
    } as never;
    vi.mocked(
      compactionReadiness.readStateHistoryCompactionReadiness,
    ).mockResolvedValueOnce(unavailableFixture);
    await renderPage({ searchParams: { providerAccountId: "act_assigned" } });
    expect(exactPage).toHaveBeenCalledWith(
      expect.objectContaining({ stateHistoryReadiness: unavailableFixture }),
    );
    const passed = (
      vi.mocked(exactPage).mock.calls.at(-1)?.[0] as unknown as Record<
        string,
        Record<string, unknown>
      >
    ).stateHistoryReadiness;
    expect(passed.journalRead).toBe("unavailable");
    expect(passed.approvalStatus).toBe("UNKNOWN_JOURNAL_UNAVAILABLE");
  });

  it("reads recovery readiness for exactly the route business", async () => {
    await renderPage({ searchParams: { providerAccountId: "act_assigned" } });
    expect(
      compactionReadiness.readStateHistoryCompactionReadiness,
    ).toHaveBeenCalledWith(expect.anything(), { businessId: "biz_route" });
  });

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
      /*
       * The two release-gate facts the SERVER owns, handed to the body rather
       * than re-derived there. Both gates ship off, so both reasons are present
       * in this default environment — and both are asserted as the exact
       * operator sentence, so a gate cannot start refusing for a different
       * reason without this saying so.
       */
      /*
        The STOP is never refused for want of a capability.

        It used to sit behind its own environment gate, which meant a business
        could reach a screen where automation was live and the control that
        turns it off said "not enabled yet". A stop that can be withheld is not
        a stop. It is now unconditional, so nothing refuses engaging it and
        this reason is null.
      */
      stopEngageRefusalReason: null,
      liveWritesRefusalReason: META_GATE_REFUSAL_REASONS.automationLiveWrites,
      // D077: the server-read, display-only recovery readiness travels to
      // the body verbatim.
      stateHistoryReadiness: READINESS_FIXTURE,
      // D086 Correction 1: the budget-readiness read travels the same way. r1
      // never wired it, so the body always received the `null` default.
      budgetReadiness: null,
      // D088 C3: the budget WRITE readiness, which carries the account
      // automatic execution is activated for. `null` here because this test's
      // database mock has no control row to read it from — the body renders
      // that as unavailable, never as activated.
      budgetWriteReadiness: null,
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

// ---------------------------------------------------------------------------
// D086 Correction 1 #1/#2 — the readiness read is WIRED, and account-scoped
// ---------------------------------------------------------------------------

const BUDGET_READINESS_FIXTURE = {
  contract: "d086.budget-readiness-read-model.v2",
  businessId: "biz_route",
  providerAccountId: "act_assigned",
  scopeBlocker: null,
  compiledResolverVersion: "campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01",
  dimensions: [],
  blockers: [],
} as const;

describe("D086 C1 — the budget-readiness read reaches the body", () => {
  it("is CALLED by the route, with the business and the resolved account", async () => {
    /*
      r1 wired nothing. `readBudgetReadiness` existed only at its own definition,
      so the section always took its `null` default and always rendered
      unavailable — a readiness surface that could never report readiness.
    */
    vi.mocked(budgetReadinessModel.readBudgetReadiness)
      .mockResolvedValue(BUDGET_READINESS_FIXTURE as never);
    await renderPage({ searchParams: { providerAccountId: "act_assigned" } });

    expect(budgetReadinessModel.readBudgetReadiness).toHaveBeenCalledTimes(1);
    const [, scope] = vi.mocked(budgetReadinessModel.readBudgetReadiness).mock.calls[0]!;
    expect(scope.businessId).toBe("biz_route");
    // EXACTLY the account the route resolved — not a client parameter echo.
    expect(scope.providerAccountId).toBe("act_assigned");
    expect(typeof scope.nowIso).toBe("string");
  });

  it("passes the model to the body VERBATIM", async () => {
    vi.mocked(budgetReadinessModel.readBudgetReadiness)
      .mockResolvedValue(BUDGET_READINESS_FIXTURE as never);
    await renderPage({ searchParams: { providerAccountId: "act_assigned" } });
    const props = vi.mocked(exactPage).mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    expect(props.budgetReadiness).toBe(BUDGET_READINESS_FIXTURE);
  });

  it("a read FAILURE reaches the body as null, never as ready", async () => {
    vi.mocked(budgetReadinessModel.readBudgetReadiness)
      .mockRejectedValue(new Error("connection reset"));
    await renderPage({ searchParams: { providerAccountId: "act_assigned" } });
    const props = vi.mocked(exactPage).mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    expect(props.budgetReadiness).toBeNull();
  });

  it("an UNRESOLVED account travels as null, so the model fails closed", async () => {
    // The route must not substitute a default or pick one of several accounts.
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(null as never);
    vi.mocked(budgetReadinessModel.readBudgetReadiness)
      .mockResolvedValue({ ...BUDGET_READINESS_FIXTURE, providerAccountId: null } as never);
    await renderPage();
    const [, scope] = vi.mocked(budgetReadinessModel.readBudgetReadiness).mock.calls[0]!;
    expect(scope.providerAccountId).toBeNull();
  });

  it("a FOREIGN requested account never becomes the readiness scope", async () => {
    /*
      The scope comes from the route's own resolution. Whatever the client asked
      for, only what `resolveProviderAccountId` returned may travel.
    */
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue("act_assigned" as never);
    vi.mocked(budgetReadinessModel.readBudgetReadiness)
      .mockResolvedValue(BUDGET_READINESS_FIXTURE as never);
    await renderPage({ searchParams: { providerAccountId: "act_FOREIGN" } });
    const [, scope] = vi.mocked(budgetReadinessModel.readBudgetReadiness).mock.calls[0]!;
    expect(scope.providerAccountId).toBe("act_assigned");
    expect(scope.providerAccountId).not.toBe("act_FOREIGN");
  });

  it("#13 uses the CANONICAL approved-version resolver, not raw process.env", () => {
    /*
      r2 read `process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION` directly,
      so a stale or arbitrary value would look like an approval on this surface
      while the runtime refused it. `campaignContextAuthorityResolverVersion()`
      returns the approved version only when it equals the compiled one.
    */
    const src = readFileSync(resolve("app/c/[businessId]/meta/automation/page.tsx"), "utf8");
    const executable = src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    expect(executable).toContain("campaignContextAuthorityResolverVersion()");
    expect(executable).not.toMatch(/process\.env\.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION/);
    expect(executable).not.toMatch(/process\.env\[/);
  });

  it("the legacy compatibility shim passes NO readiness, so it renders unavailable", () => {
    /*
      The shim must not become a softer path. It mounts the legacy body and
      supplies no `budgetReadiness`, so the section takes its `null` default.
    */
    const shim = readFileSync(
      resolve("app/(dashboard)/platforms/meta/automation/page.tsx"), "utf8",
    );
    expect(shim).not.toContain("budgetReadiness");
    expect(shim).not.toContain("readBudgetReadiness");
  });
});

// ---------------------------------------------------------------------------
// The control-row bootstrap is a WRITE, so it runs only for a viewer who may
// write.
//
// Round three of one family. The first fix moved the bootstrap in
// `POST /api/meta/automation` below its reviewer and demo guards; the second
// moved this page's below the write-authority resolution and gated it on
// `!reviewerReadOnly && writeAuthority === "live"`. Both asked about the
// BUSINESS's posture and about the reviewer flag, and neither asked whether
// the VIEWER may write — and a guest satisfies both. `requireBusinessPageContext`
// is called with no `minRole`, which `evaluateBusinessAuthorization` defaults
// to `"guest"`, so a guest reached an INSERT that stamped `updated_by` with an
// id every Automation write route refuses.
//
// Both directions are asserted: every actor without mutation authority writes
// nothing, and the actors who have it still get their row.
// ---------------------------------------------------------------------------

function contextWithRole(role: "admin" | "collaborator" | "guest") {
  const base = authorizedContext("biz_route");
  return {
    ...base,
    context: {
      ...base.context,
      role,
      membership: { ...base.context.membership, role },
    },
  };
}

describe("control-row bootstrap is gated on the viewer's own mutation authority", () => {
  it("a GUEST on a live workspace persists nothing", async () => {
    vi.mocked(businessPageAccess.requireBusinessPageContext).mockResolvedValue(
      contextWithRole("guest") as never,
    );
    vi.mocked(writeAuthority.readLaunchpadWriteAuthority).mockResolvedValue("live");

    await renderPage();

    /*
      THE THIRD-ROUND DEFECT. This guest is admitted by
      `requireBusinessPageContext`, is not a reviewer, and this workspace reads
      `live` — so the previous gate passed on both halves and the durable
      INSERT ran under a guest's id.
    */
    expect(controlPlane.ensureBusinessControlRow).not.toHaveBeenCalled();
    // The same render already knew: the envelope refuses this viewer.
    expect(exactPage.mock.calls.at(-1)?.[0]?.viewer?.canMutate).toBe(false);
    expect(exactPage.mock.calls.at(-1)?.[0]?.viewer?.reasonCode).toBe(
      "insufficient_role",
    );
  });

  it("a REVIEWER persists nothing, whatever their role says", async () => {
    const base = contextWithRole("admin");
    vi.mocked(businessPageAccess.requireBusinessPageContext).mockResolvedValue({
      ...base,
      context: { ...base.context, reviewerReadOnly: true },
    } as never);
    vi.mocked(writeAuthority.readLaunchpadWriteAuthority).mockResolvedValue("live");

    await renderPage();

    expect(controlPlane.ensureBusinessControlRow).not.toHaveBeenCalled();
  });

  it("a demo workspace persists nothing, even for an admin", async () => {
    vi.mocked(writeAuthority.readLaunchpadWriteAuthority).mockResolvedValue("demo");

    await renderPage();

    expect(controlPlane.ensureBusinessControlRow).not.toHaveBeenCalled();
  });

  it("an unreadable demo flag persists nothing", async () => {
    // A missing fact never becomes a permission: `unverified` refuses.
    vi.mocked(writeAuthority.readLaunchpadWriteAuthority).mockResolvedValue(
      "unverified",
    );

    await renderPage();

    expect(controlPlane.ensureBusinessControlRow).not.toHaveBeenCalled();
  });

  it("a COLLABORATOR on a live workspace still gets the row, stamped with their own id", async () => {
    vi.mocked(businessPageAccess.requireBusinessPageContext).mockResolvedValue(
      contextWithRole("collaborator") as never,
    );
    vi.mocked(writeAuthority.readLaunchpadWriteAuthority).mockResolvedValue("live");

    await renderPage();

    /*
      The regression the tightening could have caused. `collaborator` is the
      floor every Automation write enforces, so this viewer must still get the
      default-closed row — without it every write answers
      `control_state_unavailable`.
    */
    expect(controlPlane.ensureBusinessControlRow).toHaveBeenCalledTimes(1);
    expect(controlPlane.ensureBusinessControlRow).toHaveBeenCalledWith({
      businessId: "biz_route",
      userId: "user_1",
    });
  });

  it("an ADMIN on a live workspace still gets the row", async () => {
    await renderPage();

    expect(controlPlane.ensureBusinessControlRow).toHaveBeenCalledTimes(1);
  });
});
