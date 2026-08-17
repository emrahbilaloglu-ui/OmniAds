// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  GoogleAdvisorActionCard,
  GoogleAdvisorResponse,
  GoogleRecommendation,
} from "@/lib/google-ads/growth-advisor-types";

import { GoogleAdvisorExact, type GoogleAdvisorExactProps } from "./GoogleAdvisorExact";

function actionCard(
  overrides: Partial<GoogleAdvisorActionCard> = {},
): GoogleAdvisorActionCard {
  return {
    contractVersion: "google_ads_advisor_action_v2",
    contractSource: "native",
    assistMode: "deterministic",
    recommendationType: "query_governance",
    primaryAction: "Add 2 exact negative keywords now.",
    scope: {
      level: "campaign",
      label: "Search — Non-brand · exact match",
      governedEntityCount: 1,
    },
    exactChanges: [
      {
        label: "Add exact negatives now",
        items: ["refund policy", "free shipping code"],
        kind: "change",
        tone: "primary",
      },
    ],
    exactChangePayload: {
      kind: "generic_manual_action",
      recommendedAction: "Add 2 exact negative keywords now.",
    },
    expectedEffect: {
      summary: "Waste recovery of $180–$320/mo at current click prices.",
      estimationMode: "bounded_range",
      estimateLabel: "Waste recovery: $180–$320/mo",
      note: "Bounded by the native contract.",
    },
    whyThisNow: "31 zero-conversion terms concentrate on these 2 query stems.",
    evidence: [],
    validation: ["Zero-conv spend falls to $0 within 14 days."],
    rollback: ["Delete the two negatives — no learning reset."],
    blockedBecause: [],
    ...overrides,
  };
}

function recommendation(
  id: string,
  overrides: Partial<GoogleRecommendation> = {},
): GoogleRecommendation {
  return {
    id,
    recommendationFingerprint: `fp-${id}`,
    type: "query_governance",
    doBucket: "do_now",
    confidence: "high",
    integrityState: "ready",
    actionability: "ready_now",
    decision: { riskLevel: "low" },
    blockers: [],
    operatorActionCard: actionCard(),
    ...overrides,
  } as GoogleRecommendation;
}

function advisorFixture(): GoogleAdvisorResponse {
  return {
    summary: {},
    recommendations: [
      recommendation("query"),
      recommendation("next", {
        type: "keyword_buildout",
        doBucket: "do_next",
        operatorActionCard: actionCard({
          recommendationType: "keyword_buildout",
          primaryAction: "Promote proven search terms.",
          expectedEffect: {
            summary: "Direction is supported.",
            estimationMode: "heuristic_only",
            estimateLabel: null,
            note: "Heuristic only.",
          },
        }),
      }),
      recommendation("blocked", {
        type: "product_allocation",
        doBucket: "do_later",
        integrityState: "blocked",
        actionability: "not_ready",
        operatorActionCard: actionCard({
          recommendationType: "product_allocation",
          primaryAction: "Do not apply yet — resolve the feed blocker first.",
          scope: {
            level: "product_cluster",
            label: "Shopping — Core feed · listing groups",
            governedEntityCount: 1,
          },
          exactChanges: [
            {
              label: "Blocked because",
              items: ["feed_disapproval: product is out of auction"],
              kind: "blocker",
              tone: "danger",
            },
          ],
          exactChangePayload: {
            kind: "blocked_or_insufficient_evidence",
            state: "blocked",
            reasons: ["Resolve in Merchant Center."],
          },
          expectedEffect: {
            summary: "Blocked — no effect estimate is honest yet.",
            estimationMode: "blocked",
            estimateLabel: null,
            note: "Blocked.",
          },
          whyThisNow: "Allocation reads are distorted by the disapproval.",
          validation: ["Merchant Center re-review clears."],
          rollback: [],
          blockedBecause: ["Resolve in Merchant Center."],
        }),
      }),
    ],
    sections: [],
    clusters: [],
    metadata: { asOfDate: "2026-08-17" },
  } as unknown as GoogleAdvisorResponse;
}

function setMobile(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      media: "(max-width: 1023px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function exactProps(overrides: Partial<GoogleAdvisorExactProps> = {}): GoogleAdvisorExactProps {
  return {
    advisor: advisorFixture(),
    accountId: "493-118-2201",
    currencyCode: "USD",
    windowLabel: "28d",
    syncLabel: "Synced 26m ago",
    planHref: "/app/google/plan",
    productsHref: "/app/google/products",
    onNavigate: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => setMobile(false));
afterEach(cleanup);

describe("GoogleAdvisorExact", () => {
  it("renders the exact four tiles and every card as flat ordered siblings with no legacy extras", () => {
    const { container } = render(<GoogleAdvisorExact {...exactProps()} />);
    const surface = container.querySelector('[data-screen-label="Google Ads · Advisor"]')!;
    const tiles = Array.from(surface.querySelectorAll(":scope > [data-advisor-tiles] > article"));
    const cards = Array.from(surface.querySelectorAll(":scope > [data-advisor-card]"));

    expect(tiles.map((tile) => tile.getAttribute("data-advisor-tile"))).toEqual([
      "do-now",
      "do-next",
      "blocked",
      "applied-30d",
    ]);
    expect(cards.map((card) => card.getAttribute("data-advisor-card"))).toEqual([
      "query",
      "next",
      "blocked",
    ]);
    expect(cards.every((card) => card.parentElement === surface)).toBe(true);
    expect(surface.textContent).not.toContain("Open findings");
    expect(surface.textContent).not.toContain("Opportunity Queue");
    expect(surface.textContent).not.toContain("Account decisions");
    expect(surface.textContent).not.toContain("Lifecycle");
  });

  it("renders exact header, native card anatomy, blocked state, and truthful closing field", () => {
    const { container } = render(<GoogleAdvisorExact {...exactProps()} />);
    const query = container.querySelector('[data-advisor-card="query"]') as HTMLElement;
    expect(screen.getByText("Google Ads · 493-118-2201 · USD · 28d window")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Advisor" })).toBeTruthy();
    expect(container.textContent).not.toContain("receipt on every change");
    expect(screen.getByText("Synced 26m ago")).toBeTruthy();
    expect(within(query).getByText("Add 2 exact negative keywords now.")).toBeTruthy();
    expect(within(query).getByText("scope · Search — Non-brand · exact match")).toBeTruthy();
    expect(within(query).getByText("Add exact negatives now")).toBeTruthy();
    expect(within(query).getByText("Expected effect")).toBeTruthy();
    expect(within(query).getByText("Why this now")).toBeTruthy();
    expect(within(query).getByText("Validation")).toBeTruthy();
    expect(screen.getAllByText("Rollback")).toHaveLength(2);

    const blocked = container.querySelector('[data-advisor-card="blocked"]')!;
    expect(within(blocked as HTMLElement).getByText("Blocked")).toBeTruthy();
    expect(within(blocked as HTMLElement).getByText("blocked", { selector: "span" })).toBeTruthy();
    const unblockLabel = within(blocked as HTMLElement).getByText("Unblock path");
    expect(unblockLabel.nextElementSibling?.textContent).toBe("—");
    expect(unblockLabel.className).toBe(
      within(query).getByText("Rollback").className,
    );
    expect(within(blocked as HTMLElement).getByRole("button", { name: "Open Products" })).toBeTruthy();
    expect(within(blocked as HTMLElement).getByRole("button", { name: "Dismiss" })).toBeDisabled();

    expect(container.querySelector("section > p:last-child")?.textContent).toBe("—");
    expect(container.textContent).not.toContain("every change returns a Google receipt");
    expect(container.textContent).not.toContain("rollback is one click");
  });

  it("keeps all four tiles as dashes while the Advisor payload is unavailable", () => {
    const { container } = render(
      <GoogleAdvisorExact
        {...exactProps({ advisor: null, advisorState: "error" })}
      />,
    );
    const surface = container.querySelector('[data-screen-label="Google Ads · Advisor"]')!;
    const values = Array.from(
      surface.querySelectorAll("[data-advisor-tile] p:nth-child(2)"),
    ).map((node) => node.textContent);

    expect(surface.getAttribute("data-advisor-state")).toBe("error");
    expect(values).toEqual(["—", "—", "—", "—"]);
    expect(surface.querySelectorAll(":scope > [data-advisor-card]")).toHaveLength(0);
  });

  it("uses CTA callbacks for navigation only and never calls a provider endpoint", () => {
    const onNavigate = vi.fn();
    const onDismiss = vi.fn();
    const providerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const { container } = render(
      <GoogleAdvisorExact
        {...exactProps({ onNavigate, onDismiss, dismissAuthority: "allowed" })}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Apply (guarded)" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Open Products" }));
    fireEvent.click(
      within(container.querySelector('[data-advisor-card="query"]') as HTMLElement).getByRole(
        "button",
        { name: "Dismiss" },
      ),
    );

    expect(onNavigate).toHaveBeenNthCalledWith(
      1,
      "/app/google/plan",
      expect.objectContaining({ id: "query" }),
    );
    expect(onNavigate).toHaveBeenNthCalledWith(
      2,
      "/app/google/products",
      expect.objectContaining({ id: "blocked" }),
    );
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ id: "query" }));
    expect(providerFetch).not.toHaveBeenCalled();
    providerFetch.mockRestore();
  });

  it("renders a disabled dash instead of sending non-product blocked cards to Products", () => {
    const onNavigate = vi.fn();
    const advisor = advisorFixture();
    advisor.recommendations = [
      recommendation("blocked-query", {
        integrityState: "blocked",
        blockers: ["query ownership unresolved"],
        operatorActionCard: actionCard({
          expectedEffect: {
            summary: "Blocked.",
            estimationMode: "blocked",
            estimateLabel: null,
            note: "Blocked.",
          },
          blockedBecause: ["query ownership unresolved"],
        }),
      }),
    ];
    const { container } = render(
      <GoogleAdvisorExact {...exactProps({ advisor, onNavigate })} />,
    );
    const blocked = container.querySelector('[data-advisor-card="blocked-query"]') as HTMLElement;
    const unsupported = within(blocked).getByRole("button", { name: "—" });

    expect(unsupported).toBeDisabled();
    expect(unsupported).toHaveAttribute("data-advisor-navigation", "unsupported");
    fireEvent.click(unsupported);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(within(blocked).queryByRole("button", { name: "Open Products" })).toBeNull();
  });

  it("keeps dismiss disabled for explicit read-only and unknown authority", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <GoogleAdvisorExact {...exactProps({ onDismiss, dismissAuthority: "unknown" })} />,
    );
    expect(screen.getAllByRole("button", { name: "Dismiss" }).every((button) => button.hasAttribute("disabled"))).toBe(true);

    rerender(
      <GoogleAdvisorExact
        {...exactProps({ onDismiss, dismissAuthority: "allowed", readOnly: true })}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("enforces the sub-1024 mobile read-only memory boundary", () => {
    setMobile(true);
    const onDismiss = vi.fn();
    render(
      <GoogleAdvisorExact {...exactProps({ onDismiss, dismissAuthority: "allowed" })} />,
    );

    const dismiss = screen.getAllByRole("button", { name: "Dismiss" });
    expect(dismiss.every((button) => button.hasAttribute("disabled"))).toBe(true);
    fireEvent.click(dismiss[0]);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("pins the reference geometry, mobile breakpoint, and zero-provider-write source contract", () => {
    const root = process.cwd();
    const css = readFileSync(
      join(root, "components/google-ads/GoogleAdvisorExact.module.css"),
      "utf8",
    );
    const component = readFileSync(
      join(root, "components/google-ads/GoogleAdvisorExact.tsx"),
      "utf8",
    );
    const adapter = readFileSync(
      join(root, "components/google-ads/google-advisor-exact-adapter.ts"),
      "utf8",
    );

    expect(css).toContain("grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));");
    expect(css).toContain("border-radius: 14px;");
    expect(css).toContain("width: 200px;");
    expect(css).toContain("grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));");
    expect(css).toMatch(/\.ctaBlocked\s*\{\s*border:\s*none;/u);
    expect(css).not.toContain(".unblockLabel");
    expect(css).not.toContain(".unblockText");
    expect(css).toContain("@media (max-width: 1023px)");
    expect(css).toMatch(/\.dismiss\s*\{[\s\S]*?pointer-events:\s*none;/u);
    expect(`${component}\n${adapter}`).not.toMatch(
      /fetch\s*\(|\/api\/|apply_mutate|buildGoogleAdsOperatorActionCard/u,
    );
    expect(component).not.toContain("every change returns a Google receipt");
    expect(component).not.toContain("receipt on every change");
    expect(component).not.toContain("rollback is one click");
  });
});
