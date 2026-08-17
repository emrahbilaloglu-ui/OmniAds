// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The preserved `/insights/**` family must converge on the same chrome and the
 * same exact Analytics screen the canonical twins mount.
 */
const mocks = vi.hoisted(() => ({
  chrome: vi.fn((_props: { businessId?: string | null }) => null),
  screen: vi.fn((_props: { initialTab?: string }) => null),
  planGate: vi.fn((_props: { requiredPlan: string }) => null),
}));

vi.mock("@/components/pricing/PlanGate", () => ({
  PlanGate: (props: { requiredPlan: string; children?: React.ReactNode }) => {
    mocks.planGate({ requiredPlan: props.requiredPlan });
    return props.children as React.ReactElement;
  },
}));
vi.mock("@/components/insights/InsightsChrome", () => ({
  InsightsChrome: (props: { businessId?: string | null; children?: React.ReactNode }) => {
    mocks.chrome({ businessId: props.businessId });
    return props.children as React.ReactElement;
  },
}));
vi.mock("@/components/analytics/InsightsAnalyticsScreen", () => ({
  InsightsAnalyticsScreen: (props: { initialTab?: string }) => {
    mocks.screen(props);
    return <div data-testid="analytics-screen" />;
  },
}));

const InsightsLayout = (await import("@/app/(dashboard)/insights/layout")).default;
const AnalyticsBody = (await import("@/app/(dashboard)/insights/analytics/legacy-page"))
  .default;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("/insights layout", () => {
  it("keeps the pro plan gate and hands the screen to the shared chrome", () => {
    render(
      <InsightsLayout>
        <p>section body</p>
      </InsightsLayout>,
    );
    expect(mocks.planGate).toHaveBeenCalledWith({ requiredPlan: "pro" });
    expect(mocks.chrome).toHaveBeenCalledTimes(1);
    expect(screen.getByText("section body")).toBeTruthy();
  });
});

describe("/insights/analytics body", () => {
  it("is the exact screen and nothing else — no second header, no wrapper card", () => {
    const { container } = render(<AnalyticsBody />);
    expect(mocks.screen).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("h1, h2, h3").length).toBe(0);
    expect(container.firstElementChild?.getAttribute("data-testid")).toBe(
      "analytics-screen",
    );
    expect(container.childElementCount).toBe(1);
  });
});
