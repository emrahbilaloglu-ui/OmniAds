import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CommercialTruthExact } from "@/components/commercial-truth/CommercialTruthExact";
import { buildCommercialTruthExactModel } from "@/components/commercial-truth/commercial-truth-exact-adapter";

const model = buildCommercialTruthExactModel({
  business: { name: "Grandmix", currency: "USD", timezone: "Europe/Istanbul" },
  targetPack: {
    targetRoas: 3.8,
    breakEvenRoas: 2.5,
    targetCpa: 24,
    aovAssumption: 58,
    costStructure: {
      cogsPercent: 0.38,
      shippingPercent: 0.08,
      paymentProcessingPercent: 0.03,
    },
    updatedAt: "2026-08-02T09:00:00.000Z",
  },
  costModel: { cogsPercent: 0.38, shippingPercent: 0.08, feePercent: 0.03, fixedCost: 12000 },
  window: { spend: 26000, revenue: 100000 },
  campaigns: [
    {
      id: "c1",
      name: "Prospecting — Broad US",
      platform: "Meta",
      level: "Campaign",
      spend: 21900,
      revenue: 112128,
      roas: 5.12,
    },
  ],
  history: [
    {
      id: "h1",
      at: "2026-08-02T09:00:00.000Z",
      changes: ["Target ROAS updated"],
      sourceLabel: "Q3 margin push",
      actor: "Emrah B.",
    },
  ],
  pack: {
    canEdit: true,
    saving: false,
    dirty: false,
    error: null,
    lastUpdatedActor: "Emrah B.",
  },
});

function render(overrides: Partial<React.ComponentProps<typeof CommercialTruthExact>> = {}) {
  return renderToStaticMarkup(
    React.createElement(CommercialTruthExact, {
      model,
      onFieldChange: () => {},
      onSave: () => {},
      onDiscard: () => {},
      ...overrides,
    }),
  );
}

const source = readFileSync("components/commercial-truth/CommercialTruthExact.tsx", "utf8");

describe("CommercialTruthExact", () => {
  it("draws the navy Single source band with its sentence and three stats", () => {
    const html = render();
    expect(html).toContain("Single source");
    expect(html).toContain("One target pack per workspace.");
    expect(html).toContain("Workspace");
    expect(html).toContain("Grandmix");
    expect(html).toContain("Europe/Istanbul");
  });

  it("orders the grid Target pack then revenue split, with the pack first", () => {
    const html = render();
    expect(html.indexOf("Target pack")).toBeLessThan(html.indexOf("Where $100 of revenue goes"));
    expect(html.indexOf("Where $100 of revenue goes")).toBeLessThan(
      html.indexOf("Spend × ROAS scenario guide"),
    );
    expect(html.indexOf("Spend × ROAS scenario guide")).toBeLessThan(
      html.indexOf("Where spend sits against these targets"),
    );
  });

  it("renders the pack's inline save controls and provenance line", () => {
    const html = render();
    expect(html).toContain("Save target pack");
    expect(html).toContain("Discard changes");
    expect(html).toContain("applies on the next snapshot, never retroactively");
    expect(html).toContain("last updated Aug 2 by Emrah B.");
  });

  it("renders seven scenario rows including Fixed costs, each with its sub-label", () => {
    const html = render();
    for (const label of [
      "Ad-attributed revenue",
      "Variable costs",
      "Contribution before ads",
      "Ad spend",
      "Fixed costs",
      "Net profit / month",
      "Net margin",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("spend × ROAS");
    expect(html).toContain("from the pack · applies once per month");
    expect(html).toContain("net profit ÷ revenue");
    expect(html).toContain("COGS 38% + shipping 8% + fees 3%");
    expect(html).toContain("51% of revenue");
  });

  it("uses the design's ROAS stub and reset caption", () => {
    const html = render();
    expect(html).toContain("edit per column · defaults to target");
    expect(html).toContain("Reset ROAS to target 3.80×");
  });

  it("drops the value and its sign when no target is served", () => {
    // "Reset ROAS to target —×" — a multiplication sign attached to nothing —
    // is what substituting the em dash into the reference's caption produced.
    const unservedTarget = buildCommercialTruthExactModel({
      business: { name: "Grandmix", currency: "USD", timezone: "Europe/Istanbul" },
      targetPack: null,
      costModel: null,
      window: { spend: null, revenue: null },
      campaigns: [],
      history: [],
      pack: { canEdit: false, saving: false, dirty: false, error: null, lastUpdatedActor: null },
    });
    const html = renderToStaticMarkup(
      React.createElement(CommercialTruthExact, {
        model: unservedTarget,
        onFieldChange: () => {},
        onSave: () => {},
        onDiscard: () => {},
      }),
    );

    expect(html).toContain("Reset ROAS to target");
    expect(html).not.toContain("target —×");
    expect(html).not.toContain("—×");
  });

  it("renders the seven-column campaign table and the blended tfoot", () => {
    const html = render();
    for (const header of [
      "Campaign",
      "Spend · 28d",
      "Share",
      "Revenue",
      "ROAS",
      "vs target",
      "Next-snapshot verdict",
    ]) {
      expect(html).toContain(header);
    }
    expect(html).toContain("Blended · all labeled spend");
    expect(html).toContain("vs target 3.80");
    expect(html).toContain("Prospecting — Broad US");
    expect(html).toContain("Meta · Campaign");
  });

  it("renders both closing mono footnotes", () => {
    const html = render();
    expect(html).toContain("Reads gross margin, shipping, fees and fixed costs from the pack");
    expect(html).toContain("Preview only — verdicts stamp on the next snapshot");
    expect(html).toContain("share of labeled ad spend · 28d · labeled coverage");
  });

  it("renders the design's four bands with their verdicts and reads chips", () => {
    const html = render();
    for (const band of ["Above target", "Near target", "Above breakeven", "Below breakeven"]) {
      expect(html).toContain(band);
    }
    expect(html).toContain("Watch / Trim");
    expect(html).toContain("reads: Target ROAS · break-even ROAS");
  });

  it("omits the header when mounted inside another page's shell", () => {
    const html = render({ showHeader: false });
    expect(html).not.toContain("Targets &amp; economics");
    expect(html).toContain("Single source");
  });

  it("contains none of the five sections the design has no equivalent of", () => {
    const html = render();
    for (const absent of [
      "Decision Coverage",
      "Country Economics",
      "Promo Calendar",
      "Site Health",
      "Decision Calibration",
      "Reconfirm unchanged economics",
    ]) {
      expect(html).not.toContain(absent);
    }
    // No sticky save bar, no eyebrow/tooltip chrome, no winning-column tint.
    expect(source).not.toContain("sticky");
    expect(source).not.toContain("bestIdx");
    expect(source).not.toContain("Section ");
  });
});

describe("C2.1 — no stale commercial vocabulary anywhere on the visible surface", () => {
  it("renders neither 'CPA ceiling' nor 'AOV floor'", () => {
    const html = renderToStaticMarkup(
      React.createElement(CommercialTruthExact, {
        model,
        onFieldChange: () => {},
        onSave: () => {},
        onDiscard: () => {},
      } as never),
    );
    // These named the wrong thing: the anchors are an explicit Target CPA and
    // an operator AOV assumption, not a "ceiling" and a "floor".
    expect(html).not.toContain("CPA ceiling");
    expect(html).not.toContain("AOV floor");
  });

  it("names the anchors truthfully in the consumer strip", () => {
    const html = renderToStaticMarkup(
      React.createElement(CommercialTruthExact, {
        model,
        onFieldChange: () => {},
        onSave: () => {},
        onDiscard: () => {},
      } as never),
    );
    expect(html).toContain("Target CPA");
    expect(html).toContain("AOV assumption");
  });
});
