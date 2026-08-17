// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import {
  IntegrationsExact,
  IntegrationsExactSkeleton,
} from "@/components/integrations/IntegrationsExact";
import type { IntegrationsExactModel } from "@/components/integrations/integrations-exact-model";

afterEach(() => cleanup());

function model(
  overrides: Partial<IntegrationsExactModel> = {},
): IntegrationsExactModel {
  return {
    cards: [
      {
        provider: "shopify",
        name: "Shopify",
        logoSrc: "/platform-logos/shopify_glyph.svg",
        description: "Orders and revenue ledger — the trusted commercial source.",
        status: "Connected",
        statusTone: "connected",
        syncing: false,
        firstSync: null,
        meta: "aurora-supply.myshopify.com · connected Mar 2 · fresh 4m ago",
        button: { caption: "Manage", kind: "manage" },
      },
      {
        provider: "meta",
        name: "Meta Ads",
        logoSrc: "/platform-logos/Meta.png",
        description: "Campaign performance, decision snapshots and guarded writes.",
        status: "Not connected",
        statusTone: "neutral",
        syncing: false,
        firstSync: null,
        meta: "no data pulled yet",
        button: { caption: "Connect", kind: "connect" },
      },
    ],
    soonCards: [
      {
        provider: "tiktok",
        name: "TikTok Ads",
        logoSrc: "/platform-logos/tiktok.svg",
        eta: "—",
      },
    ],
    ...overrides,
  };
}

describe("IntegrationsExact", () => {
  it("draws the design's header: eyebrow, title and one sentence", () => {
    render(<IntegrationsExact model={model()} onAction={vi.fn()} />);
    expect(screen.getByText("Workspace · Data sources")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "Integrations" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/a full sync runs nightly at 03:00 ET/),
    ).toBeTruthy();
  });

  it("gives each card exactly one button", () => {
    const { container } = render(
      <IntegrationsExact model={model()} onAction={vi.fn()} />,
    );
    const cards = container.querySelectorAll("article[data-provider]");
    for (const card of Array.from(cards).slice(0, 2)) {
      expect(card.querySelectorAll("button")).toHaveLength(1);
    }
  });

  it("keeps the provider name a span so the only h2 is Coming soon", () => {
    render(<IntegrationsExact model={model()} onAction={vi.fn()} />);
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe("Coming soon");
  });

  it("puts the meta line and the button on the same footer row", () => {
    const { container } = render(
      <IntegrationsExact model={model()} onAction={vi.fn()} />,
    );
    const card = container.querySelector('article[data-provider="shopify"]')!;
    // header row, description, footer row — no first-sync block on this card.
    expect(card.children).toHaveLength(3);
    const footer = card.children[2]!;
    expect(footer.textContent).toContain("aurora-supply.myshopify.com");
    expect(within(footer as HTMLElement).getByRole("button").textContent).toBe(
      "Manage",
    );
  });

  it("renders the first-sync block with a percent, a bar and four named steps", () => {
    const withSync = model({
      cards: [
        {
          ...model().cards[1]!,
          status: "Connecting",
          statusTone: "connecting",
          syncing: true,
          meta: "first import running — nothing shows in the app until the snapshot lands",
          button: null,
          firstSync: {
            percentLabel: "59%",
            barWidth: "58.5%",
            complete: false,
            steps: [
              { key: "authorize", label: "Authorize", note: "done", state: "done" },
              { key: "entities", label: "Fetch entities", note: "done", state: "done" },
              {
                key: "backfill",
                label: "Backfill 28 days",
                note: "events & revenue",
                state: "current",
              },
              {
                key: "snapshot",
                label: "Validate & snapshot",
                note: "",
                state: "pending",
              },
            ],
          },
        },
      ],
    });
    const { container } = render(
      <IntegrationsExact model={withSync} onAction={vi.fn()} />,
    );
    const block = screen.getByTestId("integration-first-sync");
    expect(within(block).getByText("First sync")).toBeTruthy();
    expect(within(block).getByText("59%")).toBeTruthy();
    for (const label of [
      "Authorize",
      "Fetch entities",
      "Backfill 28 days",
      "Validate & snapshot",
    ]) {
      expect(within(block).getByText(label)).toBeTruthy();
    }
    const fill = block.querySelector<HTMLElement>("div > div > div");
    expect(fill?.style.width).toBe("58.5%");
    // No button while the first import runs.
    expect(
      container.querySelector('article[data-provider="meta"]')!.querySelectorAll("button"),
    ).toHaveLength(0);
  });

  it("reports the provider and the action kind on click", () => {
    const onAction = vi.fn();
    render(<IntegrationsExact model={model()} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onAction).toHaveBeenCalledWith("meta", "connect");
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(onAction).toHaveBeenCalledWith("shopify", "manage");
  });

  it("renders roadmap cards with a SOON badge and an inert Notify me control", () => {
    render(<IntegrationsExact model={model()} onAction={vi.fn()} />);
    expect(screen.getByText("SOON")).toBeTruthy();
    const notify = screen.getByRole("button", { name: "Notify me" });
    expect((notify as HTMLButtonElement).disabled).toBe(true);
  });

  it("paints the loading state as the same one-grid shape", () => {
    const { container } = render(<IntegrationsExactSkeleton cardCount={6} />);
    expect(screen.getByRole("heading", { level: 1, name: "Integrations" })).toBeTruthy();
    expect(container.querySelectorAll("[class*='card']")).toHaveLength(6);
  });
});

describe("IntegrationsExact source", () => {
  const source = readFileSync(
    "components/integrations/IntegrationsExact.tsx",
    "utf8",
  );
  const css = readFileSync(
    "components/integrations/IntegrationsExact.module.css",
    "utf8",
  );

  it("keeps every notice, banner and progress sub-card out of the card body", () => {
    for (const banned of [
      "StateBanner",
      "MetaIntegrationProgress",
      "GoogleIntegrationProgress",
      "ShopifyIntegrationStatus",
      "SyncStatusPill",
      "syncNotice",
    ]) {
      expect(source).not.toContain(banned);
    }
  });

  it("ports the design's card and button geometry literally", () => {
    expect(css).toContain("border-radius: 14px");
    expect(css).toContain("padding: 16px");
    expect(css).toContain("gap: 10px");
    expect(css).toContain("height: 30px");
    expect(css).toContain("border-radius: 8px");
    expect(css).toContain("font-size: 12px");
    // The bar is 6px, and the card border only ever takes two values.
    expect(css).toContain("height: 6px");
    expect(css).toContain("#e4e8f0");
    expect(css).toContain("#cbd9ff");
    expect(css).not.toContain("min-width: 104px");
  });
});
