// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LaunchpadExactLanding } from "./legacy-page";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";

afterEach(cleanup);

function intent(overrides: Partial<MetaLaunchIntent> = {}): MetaLaunchIntent {
  return {
    id: "li_real_1",
    businessId: "biz_1",
    providerAccountId: "act_1",
    operation: "new_campaign",
    idempotencyKey: "idem_1",
    requestedStatus: "PAUSED",
    lineage: {
      sourceDecisionId: "decision_1",
      sourceDecisionSnapshotId: "snapshot_1",
      creativeBriefId: null,
      sourceDraftId: "draft_1",
    },
    requestPayload: { campaign: { name: "Real Campaign" } },
    requestFingerprint: "fingerprint",
    status: "succeeded",
    validationReceipt: null,
    resultReceipt: {
      completedAt: "2026-08-11T16:40:00.000Z",
      providerAccountId: "act_1",
      campaignId: "campaign_1",
      adsetIds: ["adset_1"],
      adIds: ["ad_1"],
      steps: [],
      recovery: { retrySupported: false, rollbackSupported: false },
    },
    errorReceipt: null,
    createdBy: "operator_1",
    createdAt: "2026-08-11T16:39:00.000Z",
    updatedAt: "2026-08-11T16:40:00.000Z",
    startedAt: "2026-08-11T16:39:30.000Z",
    completedAt: "2026-08-11T16:40:00.000Z",
    ...overrides,
  };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft_1",
    providerAccountId: "act_1",
    name: "Real account draft",
    payload: { mode: "add_to_existing", copyMode: "reuse_creative" },
    status: "draft",
    updatedAt: "2026-08-11T14:12:00.000Z",
    ...overrides,
  } as never;
}

describe("LaunchpadExactLanding", () => {
  it("renders only the canonical landing inventory in canonical order", () => {
    const { container } = render(
      <LaunchpadExactLanding
        drafts={[draft()]}
        intents={[intent()]}
        loading={false}
        verifiedRole={null}
        verifiedHandoffName={null}
        onStartRole={vi.fn()}
        onApplyDraft={vi.fn()}
      />,
    );

    expect(screen.getByText("Meta · Guarded write surface")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "Launchpad" }),
    ).toBeTruthy();
    expect(screen.getByText("Rebuild “—”")).toBeTruthy();
    expect(screen.getByText("Duplicate “—”")).toBeTruthy();
    expect(screen.getByText("Start from scratch")).toBeTruthy();
    expect(
      screen.getByText("validation runs before any provider call"),
    ).toBeTruthy();
    expect(screen.getByText("Real account draft")).toBeTruthy();
    expect(screen.getByText("Real Campaign")).toBeTruthy();

    const labels = Array.from(
      container.querySelectorAll("[data-testid='launchpad-exact'] > *"),
    ).map((node) => node.getAttribute("data-testid") ?? node.tagName);
    expect(labels).toEqual([
      "DIV",
      "launchpad-notice",
      "launchpad-starts",
      "launchpad-drafts",
      "launchpad-receipts",
    ]);
    expect(container.textContent).not.toContain("Templates");
    expect(container.textContent).not.toContain("Source & mode");
    expect(container.textContent).not.toContain("Delete");
    expect(container.textContent).not.toContain("no automatic retry");
    expect(container.querySelector("details")).toBeNull();
  });

  it("only enables an explicitly authorized presentation role and keeps Manual available", () => {
    const onStartRole = vi.fn();
    render(
      <LaunchpadExactLanding
        drafts={[]}
        intents={[]}
        loading={false}
        verifiedRole="rebuild"
        verifiedHandoffName="Verified creative"
        onStartRole={onStartRole}
        onApplyDraft={vi.fn()}
      />,
    );

    expect(screen.getByText("Rebuild “Verified creative”")).toBeTruthy();
    expect(screen.getByText("Duplicate “—”")).toBeTruthy();
    const rebuild = within(
      screen.getByTestId("launchpad-start-rebuild"),
    ).getByRole("button");
    const duplicate = within(
      screen.getByTestId("launchpad-start-duplicate"),
    ).getByRole("button");
    const manual = screen.getByRole("button", { name: "New blank draft →" });
    expect(rebuild).not.toBeDisabled();
    expect(duplicate).toBeDisabled();
    expect(manual).not.toBeDisabled();

    fireEvent.click(rebuild);
    fireEvent.click(duplicate);
    fireEvent.click(manual);
    expect(onStartRole.mock.calls).toEqual([["rebuild"], ["manual"]]);
  });

  it("renders one draft action, no inferred validation verdict, and forwards resume", () => {
    const onApplyDraft = vi.fn();
    const realDraft = draft();
    render(
      <LaunchpadExactLanding
        drafts={[realDraft]}
        intents={[]}
        loading={false}
        verifiedRole={null}
        verifiedHandoffName={null}
        onStartRole={vi.fn()}
        onApplyDraft={onApplyDraft}
      />,
    );

    const row = screen.getByTestId("launchpad-draft-row");
    expect(within(row).getAllByRole("button")).toHaveLength(1);
    expect(within(row).getByText("—")).toBeTruthy();
    expect(within(row).queryByText("Ready")).toBeNull();
    fireEvent.click(
      within(row).getByRole("button", { name: "Resume editing" }),
    );
    expect(onApplyDraft).toHaveBeenCalledWith(realDraft);
  });

  it("binds draft mode only to persisted copyMode and withholds unproven new-campaign roles", () => {
    render(
      <LaunchpadExactLanding
        drafts={[
          draft({
            id: "reuse",
            name: "Reuse",
            payload: { mode: "add_to_existing", copyMode: "reuse_creative" },
          }),
          draft({
            id: "rebuild",
            name: "Rebuild source",
            payload: { mode: "add_to_existing", copyMode: "rebuild_creative" },
          }),
          draft({
            id: "new",
            name: "Unknown source",
            payload: { mode: "new_campaign" },
          }),
        ]}
        intents={[]}
        loading={false}
        verifiedRole={null}
        verifiedHandoffName={null}
        onStartRole={vi.fn()}
        onApplyDraft={vi.fn()}
      />,
    );

    expect(
      within(screen.getByText("Reuse").closest("tr")!).getByText("Duplicate"),
    ).toBeTruthy();
    expect(
      within(screen.getByText("Rebuild source").closest("tr")!).getByText(
        "Rebuild",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByText("Unknown source").closest("tr")!).getAllByText(
        "—",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      within(screen.getByText("Unknown source").closest("tr")!).queryByText(
        "Manual",
      ),
    ).toBeNull();
  });

  it("preserves the exact shell with dashes and disables all writes when scope is unavailable", () => {
    render(
      <LaunchpadExactLanding
        drafts={[]}
        intents={[]}
        loading={false}
        scopeReady={false}
        verifiedRole="duplicate"
        verifiedHandoffName="Verified source"
        onStartRole={vi.fn()}
        onApplyDraft={vi.fn()}
      />,
    );

    expect(screen.getByTestId("launchpad-exact")).toBeTruthy();
    expect(screen.getByTestId("launchpad-draft-empty")).toBeTruthy();
    expect(screen.getByTestId("launchpad-receipt-empty")).toBeTruthy();
    expect(
      screen
        .getAllByRole("button")
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
  });
});
