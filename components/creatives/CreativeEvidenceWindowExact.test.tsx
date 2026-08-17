// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CreativeEvidenceWindowExact,
  type CreativeEvidenceWindowExactViewModel,
} from "./CreativeEvidenceWindowExact";

afterEach(cleanup);

const CSS = readFileSync(
  join(process.cwd(), "components/creatives/CreativeEvidenceWindowExact.module.css"),
  "utf8",
);

function viewModel(
  over: Partial<CreativeEvidenceWindowExactViewModel> = {},
): CreativeEvidenceWindowExactViewModel {
  return {
    name: "fixture ad name",
    decisionLabel: "Refresh",
    decisionTone: "warning",
    previewUrl: null,
    kind: "id 8412…33 · in 2 ad sets",
    band: "High confidence",
    bandTone: "positive",
    verdict: "Server verdict: Refresh.",
    verdictSub: "fixture scope note.",
    money: "$fixture · ROAS 2.70",
    moneySub: "vs 3.80 target",
    reasons: ["fixture server reason"],
    ctr: { path: null, note: "—" },
    frequency: { path: null, note: "—" },
    funnel: [
      { id: "impressions", label: "Impressions", value: "1,000", sub: "", share: 1 },
      { id: "link-clicks", label: "Link clicks", value: "100", sub: "CTR 10.00%", share: 0.6 },
      { id: "add-to-cart", label: "Add to cart", value: "10", sub: "ATC 10.0%", share: 0.3 },
      { id: "purchases", label: "Purchases", value: "4", sub: "CVR 4.0%", share: 0.2 },
    ],
    placements: [
      { id: "placement-1", label: "—", share: "—", roas: "—", width: null },
      { id: "placement-2", label: "—", share: "—", roas: "—", width: null },
      { id: "placement-3", label: "—", share: "—", roas: "—", width: null },
    ],
    adSets: [
      { id: "a1", label: "fixture ad set", spend: "$1", roas: "2.10", roasTone: "warning" },
    ],
    facts: [
      { id: "frequency", label: "Frequency", value: "4.1" },
      { id: "first-time-reach", label: "First-time reach", value: "—" },
      { id: "thumbstop", label: "Thumbstop", value: "22.0%" },
      { id: "hold-15s", label: "Hold 15s", value: "—" },
      { id: "decision-specific", label: "—", value: "—" },
      { id: "first-seen", label: "First seen", value: "2026-06-02" },
    ],
    provenance: "provenance: snapshot 2026-08-14 · decision 4c1b…9e · engine v3",
    primaryAction: { label: "Refresh Creative", href: "/platforms/meta/launchpad?mode=rebuild" },
    compareAction: { label: "Compare in Studio", href: "/platforms/meta/creatives" },
    adsManagerAction: { label: "Ads Manager ↗", href: "https://example.invalid", external: true },
    ...over,
  };
}

describe("CreativeEvidenceWindowExact geometry", () => {
  it("pins the design's 560px aside, canvas ground and 70px shadow with no border", () => {
    expect(CSS).toContain("width: 560px");
    expect(CSS).toContain("background: #f3f5f9");
    expect(CSS).toContain("box-shadow: -28px 0 70px rgba(11, 16, 32, 0.35)");
    expect(CSS).not.toContain("border-left: 1px solid");
  });

  it("uses the design's backdrop, header band and 12px card gap", () => {
    expect(CSS).toContain("background: rgba(11, 16, 32, 0.46)");
    expect(CSS).toContain("background: #0b1020");
    expect(CSS).toMatch(/\.body \{[^}]*gap: 12px/);
  });

  it("sets the header eyebrow to 9.5px mono, not 12px", () => {
    expect(CSS).toMatch(/\.headerEyebrow \{[^}]*IBM Plex Mono/);
    // The size itself now lives in the marker-bounded reference-type block at
    // the foot of the module, where lib/typography-floor.test.ts pins the full
    // selector/size list so the sub-12px exemption cannot silently widen.
    expect(CSS).toMatch(
      /\.headerEyebrow,\s*\.funnelSub,\s*\.placementStats \{\s*font-size: 9\.5px/,
    );
  });

  it("keeps the funnel value column at 52px and the fact gutter at 20px", () => {
    expect(CSS).toMatch(/\.funnelValue \{[^}]*width: 52px/);
    expect(CSS).toMatch(/\.factGrid \{[^}]*column-gap: 20px/);
  });

  it("gives the decision contract card the design's 4px tone edge", () => {
    expect(CSS).toContain("border-left: 4px solid var(--tone-solid)");
  });
});

describe("CreativeEvidenceWindowExact composition", () => {
  it("renders the design's header band with the decision chip beside the title", () => {
    render(<CreativeEvidenceWindowExact onClose={vi.fn()} viewModel={viewModel()} />);
    expect(screen.getByText("Creative evidence · Meta")).toBeInTheDocument();
    expect(screen.getByText("fixture ad name")).toBeInTheDocument();
    expect(screen.getByText("Refresh")).toBeInTheDocument();
  });

  it("renders every body block the design defines, in order", () => {
    const { container } = render(
      <CreativeEvidenceWindowExact onClose={vi.fn()} viewModel={viewModel()} />,
    );
    for (const eyebrow of [
      "Decision contract",
      "Engine reasoning",
      "CTR · 28d",
      "Frequency · 28d",
      "Click-to-purchase funnel · 28d",
      "Placement mix",
      "Where it runs",
    ]) {
      expect(screen.getByText(eyebrow)).toBeInTheDocument();
    }
    expect(screen.getByText("ROAS per ad set · same 28d window")).toBeInTheDocument();
    expect(
      screen.getByText("provenance: snapshot 2026-08-14 · decision 4c1b…9e · engine v3"),
    ).toBeInTheDocument();
    expect(container.querySelectorAll("svg")).toHaveLength(2);
  });

  it("carries none of the sections the design does not define", () => {
    render(<CreativeEvidenceWindowExact onClose={vi.fn()} viewModel={viewModel()} />);
    for (const absent of [
      "Evidence context",
      "Signals",
      "Blockers",
      "Ad evidence",
      "Trends (7 / 28 / 90d)",
      "Exact ad usages",
      "ROAS · 7d",
      "Take to Decisions",
    ]) {
      expect(screen.queryByText(absent)).not.toBeInTheDocument();
    }
  });

  it("keeps the design's three footer buttons even when the primary has no destination", () => {
    render(
      <CreativeEvidenceWindowExact
        onClose={vi.fn()}
        viewModel={viewModel({ primaryAction: { label: "Cut", href: null } })}
      />,
    );
    expect(screen.getByRole("button", { name: "Cut" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Compare in Studio" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ads Manager ↗" })).toBeInTheDocument();
  });

  it("keeps the preview card's geometry and em-dashes an unserved asset", () => {
    const { container } = render(
      <CreativeEvidenceWindowExact onClose={vi.fn()} viewModel={viewModel()} />,
    );
    expect(
      container.querySelector('[data-creative-evidence-preview="unavailable"]'),
    ).not.toBeNull();
    expect(screen.getByText("High confidence")).toBeInTheDocument();
  });

  it("renders the served asset inside the preview stage when the provider supplies one", () => {
    const { container } = render(
      <CreativeEvidenceWindowExact
        onClose={vi.fn()}
        viewModel={viewModel({ previewUrl: "https://example.invalid/asset.jpg" })}
      />,
    );
    expect(
      container.querySelector('[data-creative-evidence-preview="served"]'),
    ).not.toBeNull();
  });

  it("closes on the backdrop, the close glyph and Escape", () => {
    const onClose = vi.fn();
    const { container } = render(
      <CreativeEvidenceWindowExact onClose={onClose} viewModel={viewModel()} />,
    );
    fireEvent.click(container.querySelector('[data-testid="creative-evidence-window"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Close creative evidence" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("does not close when the aside itself is clicked", () => {
    const onClose = vi.fn();
    render(<CreativeEvidenceWindowExact onClose={onClose} viewModel={viewModel()} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pads absent placement, ad set and fact rows to the design's slot counts", () => {
    const { container } = render(
      <CreativeEvidenceWindowExact
        onClose={vi.fn()}
        viewModel={viewModel({ placements: [], adSets: [], facts: [] })}
      />,
    );
    expect(container.querySelectorAll('[class*="placementRow"]')).toHaveLength(3);
    expect(container.querySelectorAll('[class*="adSetRow"]')).toHaveLength(2);
    expect(container.querySelectorAll('[class*="factRow"]')).toHaveLength(6);
  });
});
