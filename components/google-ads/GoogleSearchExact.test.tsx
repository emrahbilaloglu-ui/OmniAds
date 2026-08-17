import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GoogleSearchExact } from "@/components/google-ads/GoogleSearchExact";
import type { SearchIntelligenceRow } from "@/components/google-ads/google-ads-dashboard-support";
import {
  buildGoogleSearchExactViewModel,
  type GoogleSearchExactTab,
  type GoogleSearchTermFilterKey,
} from "@/components/google-ads/google-search-exact-adapter";

const source = readFileSync("components/google-ads/GoogleSearchExact.tsx", "utf8");
const stylesheet = readFileSync(
  "components/google-ads/GoogleSearchProductsExact.module.css",
  "utf8",
);

const terms: SearchIntelligenceRow[] = [
  {
    key: "t1",
    searchTerm: "canvas tote with zip",
    campaign: "Search — Non-brand",
    spend: 540,
    revenue: 3120,
    conversions: 38,
    clicks: 412,
    roas: 5.78,
    ctr: 6.1,
    intent: "transactional",
    keywordOpportunityFlag: true,
  },
  {
    key: "t2",
    searchTerm: "refund policy",
    campaign: "Search — Non-brand",
    spend: 212,
    revenue: 0,
    conversions: 0,
    clicks: 164,
    roas: 0,
    ctr: 2.1,
    intent: "informational",
    wasteFlag: true,
  },
];

function render(
  tab: GoogleSearchExactTab = "terms",
  termFilter: GoogleSearchTermFilterKey = "all",
) {
  const model = buildGoogleSearchExactViewModel({
    identity: {
      accountId: "4931182201",
      currencyCode: "USD",
      windowLabel: "28d",
      syncLabel: "Synced 26m ago",
    },
    tab,
    termFilter,
    terms,
    keywords: [
      {
        criterionId: "k1",
        keywordText: "canvas tote bag",
        matchType: "Exact",
        campaignName: "Search — Non-brand",
        spend: 2410,
        conversions: 186,
        cpa: 12.96,
        roas: 4.62,
        ctr: 5.8,
        impressionShare: 0.52,
        qualityScore: 8,
        expectedCtr: "above avg CTR",
        adRelevance: "high relevance",
        landingPageExperience: "good LP",
      },
    ],
    keywordInsights: {
      highCtrLowConvCount: 4,
      highConvLowBudgetCount: 3,
      deserveOwnAdGroupCount: 2,
    },
    roasTarget: 3.8,
  });
  return renderToStaticMarkup(
    React.createElement(GoogleSearchExact, {
      model,
      syncTone: "positive",
      onTabChange: () => {},
      onFilterChange: () => {},
    }),
  );
}

describe("GoogleSearchExact structure", () => {
  it("opens on the canonical head", () => {
    const markup = render();
    expect(markup).toContain('data-screen-label="Google Ads · Search"');
    expect(markup).toContain("Google Ads · 4931182201 · USD · 28d window");
    expect(markup).toContain("Search intelligence");
    expect(markup).toContain("writes guarded · receipt on every change");
    expect(markup).toContain("Synced 26m ago");
  });

  it("renders the Search terms / Keywords tab row", () => {
    const markup = render();
    expect(markup).toContain('data-google-search-tab="terms"');
    expect(markup).toContain('data-google-search-tab="keywords"');
    expect(markup).toContain("Search terms");
    expect(markup).toContain("Keywords");
  });

  it("mounts the two bodies mutually exclusively", () => {
    const termsMarkup = render("terms");
    expect(termsMarkup).toContain("Search term");
    expect(termsMarkup).not.toContain("may deserve their own ad group");
    expect(termsMarkup).not.toContain("Quality Score and its components");

    const keywordMarkup = render("keywords");
    expect(keywordMarkup).toContain("may deserve their own ad group");
    expect(keywordMarkup).toContain("Quality Score and its components");
    expect(keywordMarkup).not.toContain("Wasteful = 30+ clicks");
  });

  it("prints the canonical column headers in order", () => {
    const termHeaders = Array.from(render("terms").matchAll(/<th[^>]*>([^<]+)<\/th>/g)).map(
      (match) => match[1],
    );
    expect(termHeaders).toEqual([
      "Search term",
      "Campaign",
      "Clicks",
      "Conv",
      "CPA",
      "Conv value",
      "ROAS",
      "CTR",
      "Spend",
    ]);

    const keywordHeaders = Array.from(
      render("keywords").matchAll(/<th[^>]*>([^<]+)<\/th>/g),
    ).map((match) => match[1]);
    expect(keywordHeaders).toEqual([
      "Keyword",
      "Campaign",
      "Spend",
      "Conv",
      "CPA",
      "ROAS",
      "QS",
      "IS",
      "CTR",
    ]);
  });

  it("renders both closing footnotes with their canonical copy", () => {
    expect(render("terms")).toContain(
      "Wasteful = 30+ clicks, zero conversions, meaningful spend.",
    );
    expect(render("keywords")).toContain(
      "Quality Score and its components (expected CTR · ad relevance · landing page) are Google-served, refreshed each sync.",
    );
  });

  it("filters the table from the pill the operator pressed", () => {
    const markup = render("terms", "wasteful");
    expect(markup).toContain("refund policy");
    expect(markup).not.toContain("canvas tote with zip");
  });
});

describe("GoogleSearchExact has none of the invented chrome", () => {
  it("draws no escape hatch, export button or Google Ads deep link", () => {
    const markup = render();
    expect(markup).not.toContain("Escape hatch");
    expect(markup).not.toContain("Copy negatives");
    expect(markup).not.toContain("Download CSV");
    expect(markup).not.toContain("ads.google.com");
    expect(source).not.toContain("buildGoogleAdsDeepLink");
  });

  it("draws no geo or device card", () => {
    expect(render()).not.toContain("When and where ads showed");
    expect(source).not.toMatch(/geo|device/i);
  });

  it("draws no second source chip strip", () => {
    const markup = render();
    expect(markup).not.toContain("PMax ");
    expect(markup).not.toContain("Negative ");
    expect(markup).not.toContain("Positive ");
  });

  it("nests no design card inside a second bordered card", () => {
    // The stat grid, the filter row, both tables and both footnotes are direct
    // children of the 16px screen column, exactly as the reference draws them.
    expect(source).not.toContain("rounded-[14px] border");
    expect(stylesheet).toContain("gap: 16px;");
  });
});

describe("GoogleSearchExact geometry", () => {
  it("pins the reference table widths per table", () => {
    expect(stylesheet).toContain("min-width: 860px");
    expect(stylesheet).toContain("min-width: 880px");
  });

  it("uses the near-black active pill, not the blue accent", () => {
    expect(stylesheet).toContain("background: #0b1020;");
    expect(stylesheet).not.toContain("--adv-accent");
  });

  it("keeps both footnotes in the reference mono face", () => {
    expect(stylesheet).toMatch(/\.footnote \{[^}]*font-family: "IBM Plex Mono"/);
  });

  it("separates the served neutral ink from the unserved ink", () => {
    // The reference puts both on the same neu[0] fill and changes only the ink:
    // neu[1] #45526B for a served in-band ROAS, #7A869E for the rows that
    // print the em dash.
    expect(stylesheet).toMatch(/\.toneNeutral \{[^}]*color: #45526b;/);
    expect(stylesheet).toMatch(/\.toneUnserved \{[^}]*background: #f1f4f9;/);
    expect(stylesheet).toMatch(/\.toneUnserved \{[^}]*color: #7a869e;/);
    // The blanket override that painted every neutral ROAS chip grey is gone.
    expect(stylesheet).not.toContain(".roasChip.toneNeutral");
  });
});
