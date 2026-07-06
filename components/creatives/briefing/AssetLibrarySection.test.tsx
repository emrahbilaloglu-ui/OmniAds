import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ASSET_PRESETS,
  ASSET_LIBRARY_VIEW_STORAGE_KEY,
  AssetLibrarySection,
  ShareViewModal,
  assetLibraryCountSummary,
  filterAssetLibraryRows,
  rowEffectiveDecisionLabel,
  sortAssetLibraryRows,
  toggleArrayFilter,
} from "@/components/creatives/briefing/AssetLibrarySection";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";

vi.mock("@/components/creatives/CreativesTableSection", () => ({
  CreativesTableSection: ({ rows }: { rows: MetaCreativeRow[] }) => (
    <div data-mocked-creatives-table>
      {rows.map((row) => (
        <span key={row.id}>{row.name}</span>
      ))}
    </div>
  ),
}));

vi.mock("@/components/creatives/CreativeRenderSurface", () => ({
  CreativeRenderSurface: (props: { assetFallbacks?: Array<string | null | undefined> }) => (
    <div data-testid="creative-render-surface">
      {(props.assetFallbacks ?? []).filter(Boolean).join("|")}
    </div>
  ),
}));

function row(overrides: Partial<MetaCreativeRow> & Record<string, unknown>): MetaCreativeRow {
  return {
    id: "row_1",
    creativeId: "creative_1",
    name: "Aphrodite Hook",
    associatedAdsCount: 1,
    accountId: "act_1",
    accountName: "TheSwaf",
    campaignName: "ASC",
    adSetName: "Broad",
    effectiveStatus: "ACTIVE",
    currency: "USD",
    format: "image",
    creativeType: "feed",
    creativeTypeLabel: "Feed",
    creativeDeliveryType: "standard",
    creativeVisualFormat: "image",
    creativePrimaryType: "standard",
    creativePrimaryLabel: null,
    creativeSecondaryType: null,
    creativeSecondaryLabel: null,
    thumbnailUrl: null,
    previewUrl: null,
    imageUrl: null,
    isCatalog: false,
    previewState: "unavailable",
    preview: { render_mode: "unavailable", image_url: null, video_url: null, poster_url: null, source: null, is_catalog: false },
    launchDate: "2026-05-01",
    tags: [],
    aiTags: {},
    spend: 100,
    purchaseValue: 300,
    roas: 3,
    cpa: 12,
    cpcLink: 1,
    cpm: 10,
    ctrAll: 1.2,
    linkCtr: 1.1,
    purchases: 10,
    impressions: 1000,
    clicks: 20,
    frequency: 1.2,
    linkClicks: 12,
    landingPageViews: 8,
    addToCart: 4,
    initiateCheckout: 2,
    leads: 0,
    messages: 0,
    thumbstop: 0,
    clickToAddToCart: 0,
    clickToPurchase: 0,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    atcToPurchaseRatio: 0,
    ...overrides,
  } as MetaCreativeRow;
}

function decisionCenterRow(overrides: Record<string, unknown> = {}) {
  return {
    rowId: "row_1",
    creativeId: "creative_1",
    buyerAction: "scale",
    buyerLabel: "Scale",
    uiBucket: "scale",
    executionAction: null,
    nextStep: "Review the server decision.",
    missingData: [],
    ...overrides,
  };
}

function extractRowLabelCell(html: string, rowId: string) {
  const marker = `data-row-id="${rowId}"`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const tdStart = html.lastIndexOf("<td", start);
  const tdEnd = html.indexOf("</td>", start);
  expect(tdStart).toBeGreaterThanOrEqual(0);
  expect(tdEnd).toBeGreaterThan(start);
  return html.slice(tdStart, tdEnd);
}

describe("AssetLibrarySection", () => {
  it("renders the preset bar, KPI summary tiles, share view button, and wrapped table rows", () => {
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[row({ name: "Aphrodite Hook" })]}
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    expect(html).toContain("preset-bar");
    expect(html).toContain("Customize columns");
    expect(html).toContain("· 2 KPIs");
    expect(html).toContain("creative / campaign / ad set");
    expect(html).toContain("Closed 30d");
    expect(html).toContain("Total Spend");
    expect(html).toContain("asset-table");
    expect(html).toContain("Aphrodite Hook");
  });

  it("recognizes preset-specific KPI selections instead of collapsing every preset to the same metrics", () => {
    const videoPreset = ASSET_PRESETS.find((preset) => preset.id === "video");
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[
          row({
            name: "Video Hook",
            format: "video",
            creativeVisualFormat: "video",
            spend: 120,
            thumbstop: 66,
            video25: 45,
            video50: 28,
            video100: 12,
            ctrAll: 2.5,
          }),
        ]}
        defaultCurrency="USD"
        selectedMetricIds={videoPreset?.metricIds ?? []}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    expect(html).toContain("Facebook Video");
    expect(html).toContain("· 6 KPIs");
    expect(html).toContain("Thumbstop");
    expect(html).toContain("25% views");
    expect(html).not.toContain("Avg CPA");
  });

  it("renders the Creative teams table with score columns and creative-team language", () => {
    const creativeTeamsPreset = ASSET_PRESETS.find((preset) => preset.id === "creative_teams");
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[
          row({
            id: "scored-static",
            name: "Static-Promo-B",
            campaignKind: "test",
            hookScore: 28,
            ctaScore: 34,
            offerScore: 52,
            clickScore: 31,
            watchScore: 22,
            creativeScoreGap: { label: "Hook + Click gap", severity: "action" },
          }),
        ]}
        defaultCurrency="USD"
        selectedMetricIds={creativeTeamsPreset?.metricIds ?? []}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    expect(html).toContain("Creative teams");
    expect(html).toContain("· 6 KPIs");
    expect(html).toContain(">Hook<");
    expect(html).toContain(">CTA<");
    expect(html).toContain(">Offer<");
    expect(html).toContain(">Click<");
    expect(html).toContain(">Watch<");
    expect(html).toContain("Hook + Click gap");
    expect(html).toContain(">Test<");
    expect(html).not.toContain("Below breakeven");
  });

  it("keeps legacy row labels when the Decision Center UI flag is off", () => {
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[
          row({
            id: "row_legacy",
            creativeId: "cr_legacy",
            engineLabel: "Cut",
            decisionCenterRow: decisionCenterRow({
              rowId: "row_legacy",
              creativeId: "cr_legacy",
              buyerAction: "scale",
              buyerLabel: "Scale",
            }),
          }),
        ]}
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    const labelCell = extractRowLabelCell(html, "row_legacy");
    expect(labelCell).toContain(">Cut<");
    expect(labelCell).not.toContain("Scale");
    expect(labelCell).not.toContain("data-decision-center-label");
  });

  it("uses server buyerLabel over legacy engineLabel when Decision Center UI is enabled", () => {
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[
          row({
            id: "row_server",
            creativeId: "cr_server",
            engineLabel: "Cut",
            decisionCenterRow: decisionCenterRow({
              rowId: "row_server",
              creativeId: "cr_server",
              buyerAction: "scale",
              buyerLabel: "Scale (server)",
            }),
          }),
        ]}
        decisionCenterUiEnabled
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    const labelCell = extractRowLabelCell(html, "row_server");
    expect(labelCell).toContain("Scale (server)");
    expect(labelCell).not.toContain(">Cut<");
    expect(labelCell).toContain('data-decision-center-label="true"');
  });

  it("never renders a blank buyer-facing label when Decision Center UI is enabled", () => {
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[
          row({
            id: "row_blank",
            creativeId: "cr_blank",
            engineLabel: null,
            decisionCenterRow: decisionCenterRow({
              rowId: "row_blank",
              creativeId: "cr_blank",
              buyerAction: "diagnose_data",
              buyerLabel: "",
            }),
          }),
          row({
            id: "row_unknown",
            creativeId: "cr_unknown",
            engineLabel: null,
            decisionCenterRow: decisionCenterRow({
              rowId: "row_unknown",
              creativeId: "cr_unknown",
              buyerAction: "unknown_action",
              buyerLabel: null,
            }),
          }),
        ]}
        decisionCenterUiEnabled
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    const staticFallbackCell = extractRowLabelCell(html, "row_blank");
    expect(staticFallbackCell).toContain("Diagnose data");
    expect(staticFallbackCell).not.toMatch(/<span class="dot"><\/span><\/span>/);

    const unknownFallbackCell = extractRowLabelCell(html, "row_unknown");
    expect(unknownFallbackCell).toContain("Decision Center");
    expect(unknownFallbackCell).not.toContain("unknown_action");
  });

  it("keeps Creative teams campaign labels even when a Decision Center row is present", () => {
    const creativeTeamsPreset = ASSET_PRESETS.find((preset) => preset.id === "creative_teams");
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[
          row({
            id: "row_creative_team",
            creativeId: "cr_creative_team",
            campaignKind: "test",
            decisionCenterRow: decisionCenterRow({
              rowId: "row_creative_team",
              creativeId: "cr_creative_team",
              buyerAction: "scale",
              buyerLabel: "Scale",
            }),
          }),
        ]}
        decisionCenterUiEnabled
        defaultCurrency="USD"
        selectedMetricIds={creativeTeamsPreset?.metricIds ?? []}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    const labelCell = extractRowLabelCell(html, "row_creative_team");
    expect(labelCell).toContain(">Test<");
    expect(labelCell).not.toContain("Scale");
    expect(labelCell).not.toContain("data-decision-center-label");
  });

  it("does not invent Creative teams scores when backend score fields are absent", () => {
    const creativeTeamsPreset = ASSET_PRESETS.find((preset) => preset.id === "creative_teams");
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[row({ id: "unscored", name: "Needs Scoring", campaignKind: "main" })]}
        defaultCurrency="USD"
        selectedMetricIds={creativeTeamsPreset?.metricIds ?? []}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    expect(html).toContain("score unavailable");
    expect(html).toContain("Hook score unavailable");
    expect(html).toContain(">Main<");
  });

  it("renders the Share view create-link modal with audience, leak controls, link metadata, and footer actions", () => {
    const html = renderToStaticMarkup(
      <ShareViewModal
        audience="creative_team"
        includeCampaignNames={false}
        includeDecisionLanguage={false}
        allowCsv={false}
        generatedShareUrl={null}
        presetTitle="Creative teams"
        rowScopeLabel="selected"
        dateRangeLabel="Last 14d"
        dateRangeDetail="2026-05-05 - 2026-05-18"
        snapshotLabel="freezes when link is created"
        actionStatus="idle"
        rowCount={4}
        onAudienceChange={() => undefined}
        onToggleCampaignNames={() => undefined}
        onToggleDecisionLanguage={() => undefined}
        onToggleCsv={() => undefined}
        onSaveLink={() => undefined}
        onCopyLink={() => undefined}
        onCopyAndClose={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("Share Asset Library view");
    expect(html).toContain("4 selected creatives · preset = Creative teams · window = Last 14d");
    expect(html).toContain("Who is this for?");
    expect(html).toContain("Preset auto-switches to match audience");
    expect(html).toContain("What gets shared");
    expect(html).toContain("4 selected creatives (thumbs · scores · gaps)");
    expect(html).toContain("Show campaign names");
    expect(html).toContain("Hide all decision language (Cut / Scale / Promote)");
    expect(html).toContain("Link will be created after Save link");
    expect(html).toContain("Expires");
    expect(html).toContain("Open count");
    expect(html).toContain("Save link");
    expect(html).toContain("Copy &amp; close");
  });

  it("renders Asset Library thumbnails from optimized media fallbacks", () => {
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[
          row({
            name: "Media Ready",
            tableThumbnailUrl: "https://example.com/table.jpg",
            thumbnailUrl: "https://example.com/thumb.jpg",
            previewState: "preview",
          }),
        ]}
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    expect(html).toContain("row-thumb--media");
    expect(html).toContain("https://example.com/table.jpg");
  });

  it("uses canonical creative taxonomy for format labels even when legacy format is image", () => {
    const videoRow = row({
      id: "video-taxonomy",
      name: "Taxonomy Video",
      format: "image",
      creativeVisualFormat: "video",
      creativePrimaryType: "video",
      creativePrimaryLabel: "Video",
      preview: {
        render_mode: "image",
        image_url: "https://example.com/poster.jpg",
        video_url: null,
        poster_url: "https://example.com/poster.jpg",
        source: "thumbnail_url",
        is_catalog: false,
      },
    });
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[videoRow]}
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    expect(html).toContain("Taxonomy Video");
    expect(html).toContain(">VID<");
    expect(html).toMatch(/<span>(?:today|\d+d|2026-05-01) · Video<\/span>/);
    expect(
      filterAssetLibraryRows([videoRow], {
        status: "all",
        formats: ["video"],
        labels: [],
        badges: [],
        search: "",
        sort: "spend_desc",
      }).map((item) => item.id),
    ).toEqual(["video-taxonomy"]);
  });

  it("filters rows by chips/search and sorts rows", () => {
    const rows = [
      row({ id: "scale", name: "Scale Winner", spend: 500, roas: 4, engineLabel: "scale", tags: ["fatigue"] }),
      row({ id: "cut", name: "Cut Loser", spend: 900, roas: 0.6, engineLabel: "cut", tags: ["below_breakeven"], effectiveStatus: "PAUSED" }),
      row({ id: "video", name: "Video Test", spend: 100, roas: 2, format: "video", creativeVisualFormat: "video", engineLabel: "test_more" }),
    ];

    expect(toggleArrayFilter(["image"], "video")).toEqual(["image", "video"]);
    expect(toggleArrayFilter(["image", "video"], "image")).toEqual(["video"]);
    expect(
      filterAssetLibraryRows(rows, {
        status: "all",
        formats: [],
        labels: ["cut"],
        badges: ["below_breakeven"],
        campaignLabel: "all",
        search: "loser",
        sort: "spend_desc",
      }).map((item) => item.id),
    ).toEqual(["cut"]);
    expect(sortAssetLibraryRows(rows, "roas_asc").map((item) => item.id)).toEqual(["cut", "video", "scale"]);
  });

  it("renders a clear empty message when no Asset Library rows are available", () => {
    const html = renderToStaticMarkup(
      <AssetLibrarySection
        rows={[]}
        emptyMessage="No Meta ad account is assigned to this workspace."
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => undefined}
        selectedRowIds={[]}
        onToggleRow={() => undefined}
        onToggleAll={() => undefined}
        onOpenRow={() => undefined}
      />,
    );

    expect(html).toContain("0 · 0 sel");
    expect(html).toContain("No Meta ad account is assigned to this workspace.");
    expect(html).toContain("asset-table");
  });

  it("tolerates malformed runtime row fields from live Meta data", () => {
    const malformed = row({
      id: "malformed",
      name: null as never,
      tags: ["Fatigue", null, { label: "ignored" }] as never,
      engineBadges: [null, "Below breakeven"] as never,
      spend: "20" as never,
      roas: "4" as never,
      launchDate: null as never,
    });

    expect(() =>
      filterAssetLibraryRows([malformed], {
        status: "all",
        formats: [],
        labels: [],
        badges: ["fatigue"],
        campaignLabel: "all",
        search: "",
        sort: "spend_desc",
      }),
    ).not.toThrow();
    expect(
      filterAssetLibraryRows([malformed], {
        status: "all",
        formats: [],
        labels: [],
        badges: ["fatigue"],
        campaignLabel: "all",
        search: "",
        sort: "spend_desc",
      }).map((item) => item.id),
    ).toEqual(["malformed"]);
    expect(sortAssetLibraryRows([malformed], "name_asc")).toHaveLength(1);
    expect(sortAssetLibraryRows([malformed], "launch_desc")).toHaveLength(1);
  });

  it("exposes count summary and view persistence key", () => {
    expect(assetLibraryCountSummary(3, 7)).toBe("Showing 3 of 7");
    expect(ASSET_LIBRARY_VIEW_STORAGE_KEY).toBe(
      "creatives-briefing-asset-library-view",
    );
  });
});

describe("decision-center label unification (filter/CSV vs display)", () => {
  const dcRow = (buyerAction: string) => ({
    scope: "creative",
    creativeId: "cr_dc",
    identityGrain: "creative",
    familyId: null,
    engine: {
      contractVersion: "creative-decision-os.v2.1",
      engineVersion: "test-engine",
      primaryDecision: "Scale",
      actionability: "review_only",
      problemClass: "performance",
      confidence: 80,
      maturity: "mature",
      priority: "high",
      reasonTags: [],
      evidenceSummary: "",
      blockerReasons: [],
      missingData: [],
      queueEligible: false,
      applyEligible: false,
    },
    buyerAction,
    buyerLabel: "Scale review",
    uiBucket: buyerAction,
    confidenceBand: "high",
    priority: "high",
    oneLine: "",
    reasons: [],
    nextStep: "",
    missingData: [],
  });

  it("filters on the displayed decision-center action when enabled, not the stale legacy label", () => {
    const stale = row({
      id: "stale",
      name: "Stale Legacy",
      engineLabel: "cut",
      decisionCenterRow: dcRow("scale") as never,
    });
    const filters = {
      status: "all",
      formats: [],
      labels: ["scale"],
      badges: [],
      campaignLabel: "all",
      search: "",
      sort: "spend_desc",
    } as const;
    expect(
      filterAssetLibraryRows([stale], filters as never, { decisionCenterUiEnabled: true }).map(
        (item) => item.id,
      ),
    ).toEqual(["stale"]);
    // Disabled flag keeps legacy behavior: the row shows the legacy label, so
    // the filter must use it too.
    expect(
      filterAssetLibraryRows([stale], filters as never, { decisionCenterUiEnabled: false }),
    ).toEqual([]);
  });

  it("projects buyer actions into DecisionLabel space for filtering", () => {
    const base = row({ id: "p", engineLabel: "cut" });
    expect(
      rowEffectiveDecisionLabel({ ...base, decisionCenterRow: dcRow("protect") as never }, true),
    ).toBe("keep");
    expect(
      rowEffectiveDecisionLabel({ ...base, decisionCenterRow: dcRow("watch_launch") as never }, true),
    ).toBe("test_more");
    expect(
      rowEffectiveDecisionLabel({ ...base, decisionCenterRow: dcRow("fix_delivery") as never }, true),
    ).toBe("diagnose");
    expect(rowEffectiveDecisionLabel(base, true)).toBe("cut");
    expect(
      rowEffectiveDecisionLabel({ ...base, decisionCenterRow: dcRow("scale") as never }, false),
    ).toBe("cut");
  });
});
