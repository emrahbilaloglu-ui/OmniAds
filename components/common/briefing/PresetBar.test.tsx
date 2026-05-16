import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PresetBar, type AssetLibraryPreset } from "@/components/common/briefing/PresetBar";

const PRESETS: AssetLibraryPreset[] = [
  {
    key: "facebook_ecom",
    label: "Facebook Ecommerce",
    description: "Buyer view — spend, ROAS, CPA, frequency.",
    metricsCount: 6,
    metricChips: ["Spend", "ROAS", "CPA"],
  },
  {
    key: "creative_teams",
    label: "Creative teams",
    description: "0–100 scoring framing.",
    metricsCount: 6,
    metricChips: ["Hook", "CTA", "Offer"],
    unavailable: true,
    unavailableReason: "Backend-dependent — scoring pipeline pending.",
  },
];

describe("PresetBar", () => {
  it("renders the active preset chip with metric count", () => {
    const html = renderToStaticMarkup(
      <PresetBar
        presets={PRESETS}
        activePresetKey="facebook_ecom"
        onPresetChange={() => undefined}
        dateChip={<span data-date-chip>14d</span>}
        labelFilter={<span data-label-filter />}
        countLabel="38"
      />,
    );

    expect(html).toContain("Facebook Ecommerce");
    expect(html).toContain("· 6 KPIs");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("14d");
    expect(html).toContain(">38<");
  });

  it("renders the share view button when onShareView is provided", () => {
    const html = renderToStaticMarkup(
      <PresetBar
        presets={PRESETS}
        activePresetKey="facebook_ecom"
        onPresetChange={() => undefined}
        dateChip={<span />}
        labelFilter={<span />}
        countLabel="38"
        onShareView={() => undefined}
      />,
    );

    expect(html).toContain("Share view");
    expect(html).toContain('data-testid="preset-bar-share-view"');
  });

  it("disables the Compare button when no rows are selected", () => {
    const html = renderToStaticMarkup(
      <PresetBar
        presets={PRESETS}
        activePresetKey="facebook_ecom"
        onPresetChange={() => undefined}
        dateChip={<span />}
        labelFilter={<span />}
        countLabel="38"
        selectedCount={0}
        onCompare={() => undefined}
      />,
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain("Compare");
  });

  it("shows selected count when rows are picked", () => {
    const html = renderToStaticMarkup(
      <PresetBar
        presets={PRESETS}
        activePresetKey="facebook_ecom"
        onPresetChange={() => undefined}
        dateChip={<span />}
        labelFilter={<span />}
        countLabel="38"
        selectedCount={4}
      />,
    );

    expect(html).toContain("· 4 sel");
  });
});
