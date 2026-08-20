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

/**
 * THE LAW: the drawer separates the three families it is given.
 *
 * The summary stays a summary; authority evidence renders beside the numbers it
 * qualifies; hashes and lineage receipts render in a disclosure that is CLOSED
 * by default, so proving a decision never costs the reader the decision itself.
 * A loading or failed helper read announces itself in words rather than dashing
 * out like a real absence.
 */
describe("CreativeEvidenceWindowExact audit sections", () => {
  it("renders authority rows beside the evidence, tone-marked without tinted body text", () => {
    render(
      <CreativeEvidenceWindowExact
        onClose={vi.fn()}
        viewModel={viewModel({
          authority: [
            { id: "source-authority", label: "Source authority", value: "Legacy review only", tone: "warning" },
            { id: "action-eligibility", label: "Action eligible", value: "no", tone: "warning" },
          ],
        })}
      />,
    );
    const block = document.querySelector("[data-creative-evidence-authority]");
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("Legacy review only");
    expect(block?.textContent).toContain("Action eligible");
    expect(
      block?.querySelector('[data-tone="warning"]'),
    ).not.toBeNull();
  });

  it("keeps diagnostics closed by default and out of the summary", () => {
    render(
      <CreativeEvidenceWindowExact
        onClose={vi.fn()}
        viewModel={viewModel({
          diagnostics: [
            { id: "decision-hash", label: "decision hash", value: "dec_hash_9" },
          ],
        })}
      />,
    );
    const details = document.querySelector<HTMLDetailsElement>(
      "[data-creative-evidence-diagnostics]",
    );
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("dec_hash_9");
    expect(screen.getByText("Server verdict: Refresh.").textContent).not.toContain(
      "dec_hash_9",
    );
  });

  it("says a helper read is loading or unreadable instead of dashing silently", () => {
    const { rerender } = render(
      <CreativeEvidenceWindowExact
        onClose={vi.fn()}
        viewModel={viewModel({
          readNotice: { tone: "info", text: "Ad-grain evidence is still loading." },
        })}
      />,
    );
    expect(
      document.querySelector('[data-creative-evidence-read-state="loading"]')
        ?.textContent,
    ).toContain("still loading");

    rerender(
      <CreativeEvidenceWindowExact
        onClose={vi.fn()}
        viewModel={viewModel({
          readNotice: { tone: "negative", text: "Ad-grain evidence could not be read: boom." },
        })}
      />,
    );
    expect(
      document.querySelector('[data-creative-evidence-read-state="error"]')
        ?.textContent,
    ).toContain("could not be read");
  });

  it("renders no read banner and no empty audit blocks when nothing is served", () => {
    render(<CreativeEvidenceWindowExact onClose={vi.fn()} viewModel={viewModel()} />);
    expect(document.querySelector("[data-creative-evidence-read-state]")).toBeNull();
    expect(document.querySelector("[data-creative-evidence-authority]")).toBeNull();
    expect(document.querySelector("[data-creative-evidence-diagnostics]")).toBeNull();
  });

  it("keeps a provider-write control fail-closed even when it has a destination", () => {
    // The window never decides authority. It is handed one, and the only
    // safe reading of "disabled with a destination" is refuse-and-stay-put:
    // rendering the anchor anyway would let a served href execute a route the
    // caller had already refused. A disabled action stays a dead button.
    render(
      <CreativeEvidenceWindowExact
        onClose={vi.fn()}
        viewModel={viewModel({
          primaryAction: {
            label: "Promote to Main",
            href: "/platforms/meta/launchpad?handoff=abc",
            disabled: true,
          },
        })}
      />,
    );
    expect(
      screen.queryByRole("link", { name: "Promote to Main" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Promote to Main" })).toBeDisabled();
  });

  it("keeps a labelled primary inert until a callback is actually supplied", () => {
    // A label is a caption, never a permission. Without an onClick and without
    // an href there is nothing to press, and the button says so rather than
    // looking live and doing nothing.
    render(
      <CreativeEvidenceWindowExact
        onClose={vi.fn()}
        viewModel={viewModel({
          primaryAction: { label: "Promote to Main", href: null },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Promote to Main" })).toBeDisabled();
  });

  it("keeps every new audit style at or above the 12px typography floor", () => {
    const sizes = [
      ...CSS.matchAll(
        /\.(readNotice|auditLabel|auditValue|diagnosticsSummary|diagnosticsValue|coverageHeadline|coverageLabel|coverageItems|coverageNote)\s*\{[^}]*font-size:\s*([0-9.]+)px/g,
      ),
    ].map((match) => Number(match[2]));
    expect(sizes.length).toBe(9);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(12);
  });
});

/**
 * The coverage statement: the window's own account of which half of this row's
 * evidence it is holding.
 *
 * It exists because the window can now be opened on a row that was served
 * WITHOUT a canonical decision envelope — on a degraded account that is every
 * row — and a screen of unexplained dashes reads as "the engine measured
 * nothing" when what it means is "this row has no audit envelope, and therefore
 * no authority".
 */
describe("CreativeEvidenceWindowExact evidence coverage", () => {
  const servedOnly = {
    state: "served-only" as const,
    tone: "warning" as const,
    headline: "Served evidence only. This row was served without a canonical decision envelope.",
    servedLabel: "Served for this row",
    served: ["engine reasoning", "ad metrics"],
    unavailableLabel: "Canonical-only, unavailable",
    unavailable: ["action eligibility", "provider lineage"],
    note: "No canonical envelope means no action authority.",
  };

  it("states both halves and marks the served-only state on the node", () => {
    render(
      <CreativeEvidenceWindowExact
        onClose={vi.fn()}
        viewModel={viewModel({ coverage: servedOnly })}
      />,
    );
    const node = document.querySelector("[data-creative-evidence-coverage]");
    expect(node?.getAttribute("data-creative-evidence-coverage")).toBe("served-only");
    expect(node?.textContent).toContain("Served evidence only");
    expect(node?.textContent).toContain("engine reasoning · ad metrics");
    expect(node?.textContent).toContain("action eligibility · provider lineage");
    expect(node?.textContent).toContain("no action authority");
  });

  it("says nothing is withheld rather than printing an empty list", () => {
    render(
      <CreativeEvidenceWindowExact
        onClose={vi.fn()}
        viewModel={viewModel({
          coverage: { ...servedOnly, state: "served-and-canonical", unavailable: [], note: "" },
        })}
      />,
    );
    expect(
      document.querySelector("[data-creative-evidence-coverage-withheld]")?.textContent,
    ).toContain("none — every audit field below came from this row's own envelope");
  });

  it("renders no coverage block at all when the caller states none", () => {
    render(<CreativeEvidenceWindowExact onClose={vi.fn()} viewModel={viewModel()} />);
    expect(document.querySelector("[data-creative-evidence-coverage]")).toBeNull();
  });
});
