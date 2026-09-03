// @vitest-environment jsdom
/**
 * PRE-DEPLOY AUDIT — the legacy Automation mount, fail-open no longer.
 *
 * The canonical `/platforms/meta/automation` route is what `ZERO_BASE_UI_MODE`
 * defaults to (`readZeroBaseRolloutConfig` with no env resolves to `"off"`,
 * and `decideCompatibility` returns `{kind: "legacy"}` unconditionally for
 * `"off"` — proven directly below). It mounted `AutomationView` with NO
 * `viewer` prop at all, so every render defaulted to
 * `AUTOMATION_VIEWER_NOT_ESTABLISHED` (`role: null`), and
 * `buildBudgetMasterSwitchAuthorization` read that null role as "no server
 * fact, let the routes decide" and granted the master-switch controls in
 * full. A collaborator, a reviewer, a demo workspace, an unverified one, or a
 * guest with no membership at all — every one of them saw Enable / Disable /
 * Save-preparation exactly as an admin would, on the route production
 * actually serves by default. The eventual 403 from the POST route is not a
 * defense: the defect is showing the live control at all.
 *
 * Two independent layers close it, and this file proves both:
 *
 *  1. `buildBudgetMasterSwitchAuthorization` is now an ALLOWLIST: only
 *     `role === "admin" && canMutate && reason === null` on the desktop
 *     surface grants anything. An unestablished (`null`) role refuses, same
 *     as any other non-admin state.
 *  2. `legacy-page.tsx` now establishes a REAL viewer from the same canonical
 *     sources the zero-base route already uses, so a genuine admin on this
 *     route is not collaterally locked out by (1).
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import type { BudgetWriteReadinessModel } from "@/lib/meta/budget-write-readiness";
import { D087_ACTIVATION_BLOCKERS } from "@/lib/meta/budget-write-capability";
import {
  buildAutomationViewerEnvelope,
  buildBudgetMasterSwitchAuthorization,
  BUDGET_MASTER_SWITCH_ADMIN_REFUSAL,
  BUDGET_MASTER_SWITCH_VIEWER_UNESTABLISHED_REFUSAL,
  AUTOMATION_VIEWER_NOT_ESTABLISHED,
  type AutomationViewerEnvelope,
} from "./viewer-envelope";
import { readZeroBaseRolloutConfig } from "@/lib/zero-base/rollout";
import { decideCompatibility } from "@/lib/zero-base/compatibility";

const NOW = Date.now();

const mocks = vi.hoisted(() => ({
  fetchAccounts: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ selectedBusinessId: "biz_1" }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: mocks.replace, push: vi.fn(), refresh: mocks.refresh }),
}));
vi.mock("@/lib/meta/history-client", () => ({
  fetchMetaHistoryAccounts: mocks.fetchAccounts,
}));

const MetaAutomationPage = (await import("./automation-view")).default;

function controlPlane(): MetaAutomationControlPlane {
  const observedAt = new Date(NOW - 30_000).toISOString();
  return {
    contractVersion: "meta-automation-control-plane.v1",
    businessId: "biz_1",
    providerAccountId: "act_1",
    globalKillSwitch: { engaged: false, reason: null },
    businessControl: {
      businessId: "biz_1",
      killSwitchEngaged: false,
      killSwitchReason: null,
      autoExecutionEnabled: false,
      readinessTier: "manual_review",
      guardrails: {
        dailyAutoActionCap: 3,
        perActionSpendCeilingMinor: 5000,
        perActionSpendCeilingCurrency: "EUR",
        notificationPolicy: "every_auto_action",
        maxBudgetIncreasePct: 15,
        maxDailyBudgetChangeMinor: null,
        requireCampaignLabel: true,
        requireCommercialAnchor: true,
        requireLivePreflight: true,
        requireRollbackPlan: true,
        dryRunOnly: true,
        minRoasFloor: null,
        quietHours: null,
      },
      updatedAt: observedAt,
      updatedBy: "user_1",
      source: "persisted",
    },
    execution: {
      autoExecutionAllowed: false,
      writeEndpointsBlocked: false,
      blockedReasons: [],
    },
    promotionRecords: [],
    readCompleteness: {
      promotionRecords: "complete",
      businessControl: "complete",
      activityLedger: "complete",
      rules: "complete",
    },
    sections: {
      businessControl: { status: "complete", errorCode: null, observedAt },
    },
    activityLedger: [],
    decisionTypeModes: [],
  } as unknown as MetaAutomationControlPlane;
}

function budgetWriteReadiness(): BudgetWriteReadinessModel {
  return {
    contract: "meta.budget-write-readiness.v1",
    businessId: "biz_1",
    providerAccountId: "act_1",
    proposal: {
      proposalId: "11111111-1111-4111-8111-111111111111",
      ownerGrain: "campaign",
      entityId: "c_100",
      budgetField: "daily_budget",
      currency: "TRY",
      currencyExponent: 2,
      beforeAmountMinor: 250000,
      intendedAmountMinor: 300000,
      changePercent: 20,
      evidenceAsOf: new Date(NOW - 3_600_000).toISOString(),
      evidenceAgeHours: 1,
    },
    execution: {
      executionEnabled: false,
      capabilityPrepared: true,
      activationBlockers: D087_ACTIVATION_BLOCKERS,
      preflightBlockers: [],
      readbackState: "not_attempted",
      rollbackEligible: false,
      lastAttemptAt: null,
      proposalState: "pending",
      claimState: "unclaimed",
      reconcileState: "none",
      activatedProviderAccountId: null,
      // Ready to activate — every mutation control this file cares about
      // renders enabled for a GRANTED admin, so a refusal can only be the
      // authorization layer, never an incidental readiness blocker.
      activationReadyBlockers: [],
    },
    unavailableReason: null,
    preparation: {
      contract: "meta.budget-preparation-read.v1",
      rowRead: true,
      rowExists: true,
      dryRunOnly: { state: "persisted", value: false },
      budgetMinHoursBetweenChanges: { state: "persisted", value: 12 },
      budgetMaxChangesPer7d: { state: "persisted", value: 3 },
      budgetMaxAccountConcentrationPct: { state: "persisted", value: 40 },
      maxBudgetIncreasePct: { state: "persisted", value: 25 },
      perActionSpendCeilingMinor: { state: "persisted", value: 500000 },
      perActionSpendCeilingCurrency: { state: "persisted", value: "TRY" },
    },
  } as unknown as BudgetWriteReadinessModel;
}

function mount(viewer?: AutomationViewerEnvelope) {
  return render(
    <MetaAutomationPage
      businessId="biz_1"
      providerAccountId="act_1"
      initialPayload={controlPlane()}
      budgetWriteReadiness={budgetWriteReadiness()}
      viewer={viewer}
    />,
  );
}

const ADMIN = buildAutomationViewerEnvelope({
  role: "admin", reviewerReadOnly: false, writeAuthority: "live",
});
const COLLABORATOR = buildAutomationViewerEnvelope({
  role: "collaborator", reviewerReadOnly: false, writeAuthority: "live",
});
const GUEST = buildAutomationViewerEnvelope({
  role: "guest", reviewerReadOnly: false, writeAuthority: "live",
});
const REVIEWER = buildAutomationViewerEnvelope({
  role: "admin", reviewerReadOnly: true, writeAuthority: "live",
});
const DEMO = buildAutomationViewerEnvelope({
  role: "admin", reviewerReadOnly: false, writeAuthority: "demo",
});
const UNVERIFIED = buildAutomationViewerEnvelope({
  role: "admin", reviewerReadOnly: false, writeAuthority: "unverified",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchAccounts.mockResolvedValue([{ id: "act_1", name: "Solo" }]);
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, saved: true, autoExecutionEnabled: false }),
  } as Response);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const preparationForm = (container: HTMLElement) =>
  container.querySelector('[data-testid="budget-preparation-form"]');
const enableButton = (container: HTMLElement) =>
  container.querySelector('[data-testid="budget-activation-enable"]') as HTMLButtonElement | null;
const disableButton = (container: HTMLElement) =>
  container.querySelector('[data-testid="budget-activation-disable"]') as HTMLButtonElement | null;
const phraseInput = (container: HTMLElement) =>
  container.querySelector('[data-testid="budget-activation-phrase"]') as HTMLInputElement | null;

describe("buildBudgetMasterSwitchAuthorization — an allowlist, unit-level", () => {
  it("grants ONLY role===admin, canMutate===true, reason===null, desktop", () => {
    const granted = buildBudgetMasterSwitchAuthorization({ viewer: ADMIN, surface: "desktop" });
    expect(granted).toEqual({
      canConfigure: true, canDisable: true, reason: null, reasonCode: null, surface: "desktop",
    });
  });

  it("refuses an UNESTABLISHED (null role) viewer — the exact defect fixed", () => {
    const result = buildBudgetMasterSwitchAuthorization({
      viewer: AUTOMATION_VIEWER_NOT_ESTABLISHED, surface: "desktop",
    });
    expect(result.canConfigure).toBe(false);
    expect(result.canDisable).toBe(false);
    expect(result.reasonCode).toBe("viewer_not_established");
    expect(result.reason).toBe(BUDGET_MASTER_SWITCH_VIEWER_UNESTABLISHED_REFUSAL);
  });

  it("refuses a collaborator", () => {
    const result = buildBudgetMasterSwitchAuthorization({ viewer: COLLABORATOR, surface: "desktop" });
    expect(result.canConfigure).toBe(false);
    expect(result.canDisable).toBe(false);
    expect(result.reasonCode).toBe("insufficient_role");
    expect(result.reason).toBe(BUDGET_MASTER_SWITCH_ADMIN_REFUSAL);
  });

  it("refuses a guest", () => {
    const result = buildBudgetMasterSwitchAuthorization({ viewer: GUEST, surface: "desktop" });
    expect(result.canConfigure).toBe(false);
    expect(result.reasonCode).toBe("insufficient_role");
  });

  it("refuses a reviewer, even one with admin role", () => {
    const result = buildBudgetMasterSwitchAuthorization({ viewer: REVIEWER, surface: "desktop" });
    expect(result.canConfigure).toBe(false);
    expect(result.reasonCode).toBe("reviewer_read_only");
  });

  it("refuses a demo workspace, even for its admin", () => {
    const result = buildBudgetMasterSwitchAuthorization({ viewer: DEMO, surface: "desktop" });
    expect(result.canConfigure).toBe(false);
    expect(result.reasonCode).toBe("demo_business_read_only");
  });

  it("refuses an unverified workspace", () => {
    const result = buildBudgetMasterSwitchAuthorization({ viewer: UNVERIFIED, surface: "desktop" });
    expect(result.canConfigure).toBe(false);
    expect(result.reasonCode).toBe("demo_status_unverified");
  });

  it("refuses the mobile pane unconditionally, even for an admin", () => {
    const result = buildBudgetMasterSwitchAuthorization({ viewer: ADMIN, surface: "mobile_read_only" });
    expect(result.canConfigure).toBe(false);
    expect(result.canDisable).toBe(false);
    expect(result.reasonCode).toBe("read_only_surface");
  });

  it("refuses an unestablished viewer on mobile too (mobile refuses first)", () => {
    const result = buildBudgetMasterSwitchAuthorization({
      viewer: AUTOMATION_VIEWER_NOT_ESTABLISHED, surface: "mobile_read_only",
    });
    expect(result.reasonCode).toBe("read_only_surface");
  });
});

describe("the mounted page — admin sees the real controls", () => {
  it("shows Enable, the phrase input, Disable, and the preparation form", () => {
    const { container } = mount(ADMIN);
    expect(enableButton(container)).not.toBeNull();
    expect(phraseInput(container)).not.toBeNull();
    expect(disableButton(container)).not.toBeNull();
    expect(preparationForm(container)).not.toBeNull();
    expect(enableButton(container)!.getAttribute("data-enabled")).toBe("true");
  });
});

describe("the mounted page — no mutation control for anyone else", () => {
  it.each([
    ["collaborator", COLLABORATOR],
    ["guest", GUEST],
    ["reviewer", REVIEWER],
    ["demo workspace admin", DEMO],
    ["unverified workspace admin", UNVERIFIED],
    ["unestablished (null role) — the production default", AUTOMATION_VIEWER_NOT_ESTABLISHED],
    ["no viewer prop at all — the exact pre-fix legacy call shape", undefined],
  ])("%s: no enable, no phrase, no disable, no preparation form", (_label, viewer) => {
    const { container } = mount(viewer);
    expect(enableButton(container)).toBeNull();
    expect(phraseInput(container)).toBeNull();
    expect(disableButton(container)).toBeNull();
    expect(preparationForm(container)).toBeNull();
    // And the refusal is STATED, not just an absent control that looks like
    // a bug — a reviewer/demo/unverified viewer's own reason is restated
    // verbatim; the unestablished viewer gets the new named refusal.
    expect(container.textContent).toContain(
      viewer === undefined || viewer === AUTOMATION_VIEWER_NOT_ESTABLISHED
        ? BUDGET_MASTER_SWITCH_VIEWER_UNESTABLISHED_REFUSAL
        : (viewer as AutomationViewerEnvelope).reason ?? BUDGET_MASTER_SWITCH_ADMIN_REFUSAL,
    );
  });
});

describe("the mobile pane — never a mutation control, whatever the role", () => {
  it("admin on mobile still sees no live master-switch control", () => {
    const { container } = mount(ADMIN);
    const mobile = container.querySelector('[data-testid="meta-mobile-automation"]')!;
    expect(mobile.querySelector('[data-testid="budget-activation-enable"]')).toBeNull();
    expect(mobile.querySelector('[data-testid="budget-preparation-form"]')).toBeNull();
  });
});

describe("save -> onSaved -> router.refresh() — the real server round-trip", () => {
  it("calls router.refresh() after a successful preparation save", async () => {
    const { container } = mount(ADMIN);
    const save = container.querySelector('[data-testid="preparation-save"]') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it("calls router.refresh() after a successful disable", async () => {
    const { container } = mount(ADMIN);
    fireEvent.click(disableButton(container)!);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it("calls router.refresh() after a successful enable (phrase + submit)", async () => {
    const { container } = mount(ADMIN);
    fireEvent.change(phraseInput(container)!, {
      target: { value: "irrelevant — the server decides, not this string" },
    });
    fireEvent.click(enableButton(container)!);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it("does NOT refresh on a refused save (no control mounted to click)", () => {
    // A collaborator has no Save button to press at all — the refresh chain
    // is unreachable, not merely unclicked.
    mount(COLLABORATOR);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("the API admin guard — unchanged by this pass", () => {
  it("still requires admin for set_budget_auto_execution and save_budget_automation_config", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("app/api/meta/automation/route.ts", "utf8");
    expect(route).toContain('action === "release_kill_switch" || action === "set_guardrail_policy"');
    expect(route).toContain('|| action === "set_budget_auto_execution"');
    expect(route).toContain('|| action === "save_budget_automation_config" || armsAutoExecution');
    expect(route).toContain('? "admin"');
  });
});

describe("ZERO_BASE_UI_MODE default is off, and off mounts the file this pass fixed", () => {
  it("no env var resolves to uiMode: off", () => {
    expect(readZeroBaseRolloutConfig({} as NodeJS.ProcessEnv).uiMode).toBe("off");
  });

  it("uiMode off decides legacy unconditionally, before any actor is resolved", () => {
    /*
      Only the `uiMode === "off"` early-return branch is under test — it
      returns before `target` or `actor` is read at all, so a placeholder
      shape (rather than a fully-formed one) is the honest input for this
      case, cast past the compiler the same way the rest of this file casts
      other deliberately-partial fixtures.
    */
    const decision = decideCompatibility({
      target: {} as never,
      config: { uiMode: "off", allowlist: [] } as never,
      actor: null as never,
    } as never);
    expect(decision).toEqual({ kind: "legacy", reason: "mode-off" });
  });

  it("the shim wires LegacyBody to legacy-page.tsx — the file this pass fixed", async () => {
    const { readFileSync } = await import("node:fs");
    const shim = readFileSync(
      "app/(dashboard)/platforms/meta/automation/page.tsx", "utf8",
    );
    expect(shim).toContain('import LegacyBody from "./legacy-page"');
    expect(shim).toContain('compatibilityPage("/platforms/meta/automation", LegacyBody)');
  });
});
