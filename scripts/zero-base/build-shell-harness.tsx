/**
 * Non-production shell harness.
 *
 * Renders the real shell components to static HTML against the real
 * `app/globals.css`, one file per width, so a browser can measure the layout
 * contract without a server or a database. Written to `playwright/.harness/`,
 * which is gitignored — it is generated evidence, not source.
 *
 * It lives here rather than inside the Playwright spec because Playwright
 * applies its own JSX transform to spec files, which rewrites component JSX
 * into Playwright's internal element type and makes `renderToStaticMarkup`
 * throw. Generating the markup in a plain tsx script side-steps that entirely.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ContextBar } from "@/components/zero-base/shell/context-bar";
import { Rail } from "@/components/zero-base/shell/rail";
import { DataTable } from "@/components/zero-base/collections/data-table";
import { buildAgencyDirectoryPage } from "@/lib/zero-base/agency-projection";
import { HomeView } from "@/components/zero-base/home/home-view";
import { toHomeMetric, type HomeContract } from "@/lib/zero-base/home/metric-contract";
import { DecisionsView } from "@/components/zero-base/meta/decisions/decisions-view";
import { buildDecisionsViewModel } from "@/lib/zero-base/meta/decisions-presentation";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaLanePayload } from "@/components/meta/redesign/types";
import { AutomationView } from "@/components/zero-base/meta/automation/automation-view";
import { buildProviderPostures } from "@/lib/zero-base/meta/automation-posture";
import { navGroupsFor } from "@/lib/zero-base/navigation";
import { THEME_ATTRIBUTE } from "@/lib/theme";

const ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "playwright", ".harness");

export const HARNESS_WIDTHS = [1440, 1280, 768, 390, 320] as const;
export const HARNESS_THEMES = ["light", "dark"] as const;
export const DRAWER_BREAKPOINT = 768;

const SCOPE = {
  businessName: "Grandmix",
  providerAccountLabel: "act_298410771",
  evidenceWindowLabel: "Last 7 days",
  configuredCurrency: "USD",
  currencyProof: "configured-only" as const,
  businessTimezone: "Europe/Istanbul",
  timezoneProof: "disagreement" as const,
  freshness: "stale" as const,
  snapshotAt: "2026-08-11T09:00:00Z",
};

function canonicalCss(): string {
  const css = readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
  // From the first real rule: slicing at the banner comment leaves a stray
  // terminator that makes the parser drop the first ruleset.
  return css.slice(css.indexOf('[data-adc-ui="zero-base"] {'));
}

function shellMarkup(width: number): string {
  const narrow = width < DRAWER_BREAKPOINT;
  const groups = navGroupsFor("Client");

  const rail = narrow
    ? ""
    : renderToStaticMarkup(
        <Rail
          groups={groups}
          businessId="biz_1"
          pathname="/c/biz_1/home"
          footer={<p style={{ margin: 0, fontSize: 12 }}>Ada Lovelace</p>}
        />,
      );

  const contextBar = renderToStaticMarkup(
    <ContextBar facts={SCOPE} compact={narrow} onOpenScopeSheet={() => {}} />,
  );

  // Wider than <main> at every tested width, so "scrolls inside main" is a
  // real assertion everywhere rather than one that only bites when the
  // viewport happens to be narrow.
  const wideTable = `<table style="min-width:1600px;width:100%"><caption>Campaigns</caption><thead><tr>${Array.from(
    { length: 8 },
    (_, i) => `<th scope="col">Column ${i + 1}</th>`,
  ).join("")}</tr></thead><tbody><tr>${Array.from(
    { length: 8 },
    () => "<td>a rather long cell value</td>",
  ).join("")}</tr></tbody></table>`;

  return `<div data-adc-ui="zero-base" data-shell style="height:100vh;display:flex;flex-direction:column;overflow:hidden">
  <div style="display:flex;flex:1 1 auto;min-height:0">
    ${rail}
    <div style="display:flex;flex-direction:column;flex:1 1 auto;min-width:0">
      <header data-top-bar style="display:flex;align-items:center;gap:12px;padding:8px 16px;min-height:56px;border-bottom:1px solid var(--ledger-border-subtle)">
        <h1 style="margin:0;font-size:16px;font-weight:600;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Grandmix</h1>
      </header>
      ${contextBar}
      <main id="zero-base-main" tabindex="-1" style="flex:1 1 auto;min-width:0;min-height:0;padding:${narrow ? 16 : 40}px;overflow-x:auto;overflow-y:auto">${wideTable}</main>
    </div>
  </div>
</div>`;
}

export function harnessFileName(width: number, theme: string): string {
  return `shell-${width}-${theme}.html`;
}

export const AGENCY_HARNESS_WIDTHS = [1440, 390] as const;
/** H03/H04/H08: desktop plus both mobile widths the design draws. */
export const HOME_HARNESS_WIDTHS = [1440, 390, 320] as const;

export function homeHarnessFileName(width: number, theme: string): string {
  return `home-${width}-${theme}.html`;
}

/** H09/H10: Decisions is a daily operator surface at every drawn width. */
export const DECISIONS_HARNESS_WIDTHS = [1440, 1280, 768, 390, 320] as const;

export function decisionsHarnessFileName(width: number, theme: string): string {
  return `decisions-${width}-${theme}.html`;
}

/** Flow I: Meta automation and the Meta stop. */
export const AUTOMATION_HARNESS_WIDTHS = [1440, 390, 320] as const;

export function automationHarnessFileName(width: number, theme: string): string {
  return `automation-${width}-${theme}.html`;
}

function automationMarkup(width: number): string {
  const narrow = width < DRAWER_BREAKPOINT;

  const body = renderToStaticMarkup(
    <AutomationView
      // Meta degraded, Google healthy: the case where a missing Google row
      // would teach an operator that one switch covers both providers.
      postures={buildProviderPostures({
        meta: { state: "degraded", reason: "Token refresh is failing for one account." },
      })}
      guardrails={{ dailyAutoActionCap: 3, perActionSpendCeilingMinor: 5000 }}
      ceremony={{
        intent: "engage",
        viewer: { role: "admin", isReviewer: false, demo: false },
        currentlyEngaged: false,
        // No read-back yet: no status banner may appear.
        readBack: null,
      }}
    />,
  );

  return `<div data-adc-ui="zero-base" data-shell style="height:100vh;display:flex;flex-direction:column;overflow:hidden">
  <main id="zero-base-main" tabindex="-1" style="flex:1 1 auto;min-width:0;min-height:0;padding:${narrow ? 16 : 40}px;overflow-x:auto;overflow-y:auto">${body}</main>
</div>`;
}

function decisionsMarkup(width: number): string {
  const narrow = width < DRAWER_BREAKPOINT;

  const row = (
    id: string,
    title: string,
    decision: string,
    overrides: Partial<MetaRecommendation> = {},
  ) =>
    ({
      id,
      level: "campaign",
      type: "campaign_state",
      lens: "profitability",
      priority: "high",
      confidence: "high",
      decisionState: "act",
      decision,
      title,
      why: "Seven-day ROAS is above target and pace is +18%.",
      summary: "",
      recommendedAction: "Raise the daily budget by 20%.",
      expectedImpact: "",
      evidence: [],
      timeframeContext: {},
      campaignName: title,
      ...overrides,
    }) as unknown as MetaRecommendation;

  const rows = [
    row("d1", "Prospecting — Broad US", "Scale up — 7-day ROAS 3.4 vs target 2.6"),
    row("d2", "Retargeting — 30d", "Hold — evidence incomplete at ad grain", {
      recommendedAction: "",
      stateReason: "Authority blocked: no write token for this account.",
    }),
    row("d3", "Lookalike 3% — AU", "Cut — 14-day CPA above break-even", {
      confidence: "medium",
      confidenceReason: "Source freshness capped confidence.",
    }),
  ];

  const lanePayload = {
    businessId: "biz_1",
    startDate: "2026-08-01",
    endDate: "2026-08-07",
    sourceModel: "v3",
    snapshotDate: "2026-08-07",
    snapshotCreatedAt: "2026-08-11T06:00:00Z",
    actionNow: rows,
    watching: [],
    healthy: [],
    nonSales: [],
    archive: [],
    deferredIds: [],
    counts: { actionNow: rows.length, watching: 4, healthy: 0, nonSales: 2, archive: 0 },
  } as unknown as MetaLanePayload;

  const state = { lane: "act" as const, levels: [], search: "", selected: null };

  const model = buildDecisionsViewModel({
    lane: lanePayload,
    banners: [
      { id: "b1", tone: "danger", title: "Meta token expired", detail: "Reconnect to refresh decisions.", blocking: true },
      { id: "b2", tone: "warning", title: "Partial window", detail: "Two days are missing from the evidence window.", blocking: false },
    ],
    viewer: { role: "collaborator", isReviewer: false, readOnly: false, readOnlyReason: null },
    state,
  });

  const body = renderToStaticMarkup(
    <DecisionsView
      model={model}
      state={state}
      demo={false}
      onStateChange={() => {}}
      adsManagerHref="https://adsmanager.facebook.com/"
    />,
  );

  return `<div data-adc-ui="zero-base" data-shell style="height:100vh;display:flex;flex-direction:column;overflow:hidden">
  <main id="zero-base-main" tabindex="-1" style="flex:1 1 auto;min-width:0;min-height:0;padding:${narrow ? 16 : 40}px;overflow-x:auto;overflow-y:auto">${body}</main>
</div>`;
}

/**
 * Client Home from the real contract and the real components.
 *
 * The fixture deliberately mixes states the surface must survive: an
 * unavailable metric, a metric with no comparison, a cost metric that rose, a
 * neutral spend, and both banner severities at once.
 */
function homeMarkup(width: number): string {
  const narrow = width < DRAWER_BREAKPOINT;

  const spark = [
    { date: "2026-08-05", value: 120 },
    { date: "2026-08-06", value: null },
    { date: "2026-08-07", value: 180 },
    { date: "2026-08-08", value: 150 },
  ];

  const build = (
    metricKey: string,
    title: string,
    unit: "currency" | "count" | "ratio",
    value: number | null,
    previousValue: number | null,
    changePct: number | null,
    status: "available" | "partial" | "unavailable" = "available",
  ) =>
    toHomeMetric({
      metricKey,
      card:
        status === "unavailable"
          ? undefined
          : {
              id: metricKey,
              title,
              value,
              previousValue,
              changePct,
              sparklineData: spark.filter((point) => point.value !== null) as Array<{
                date: string;
                value: number;
              }>,
              trendDirection: "neutral",
              dataSource: { key: "shopify_ledger", label: "Shopify ledger" },
              status,
              unit,
            },
      mode: "previous_period",
      currency: "USD",
      currencyProof: "configured-only",
      unavailableReason: "Meta is not connected for this business.",
    });

  const contract: HomeContract = {
    metrics: [
      build("revenue", "Revenue", "currency", 48213, 41200, 17),
      build("spend", "Spend", "currency", 12480, 9900, 26),
      build("blended_roas", "Blended ROAS", "ratio", 3.86, 4.16, -7.2),
      build("cpa", "Blended CPA", "currency", 31.4, 26.2, 19.8),
      build("orders", "Orders", "count", 397, null, null),
      build("aov", "AOV", "currency", null, null, null, "unavailable"),
    ],
    sources: [
      { key: "meta", label: "Meta", state: "unavailable", reason: "Token expired.", freshness: "unknown", lastUpdatedAt: null },
      { key: "ga4", label: "GA4", state: "partial", reason: "Window incomplete.", freshness: "stale", lastUpdatedAt: "2026-08-06T09:00:00Z" },
      { key: "shopify", label: "Shopify", state: "ok", reason: null, freshness: "fresh", lastUpdatedAt: "2026-08-11T08:00:00Z" },
    ],
    window: { startDate: "2026-08-01", endDate: "2026-08-11" },
    comparisonMode: "previous_period",
  };

  const body = renderToStaticMarkup(
    <HomeView contract={contract} scopeLine="Grandmix · act_298410771" refreshState="failed" />,
  );

  return `<div data-adc-ui="zero-base" data-shell style="height:100vh;display:flex;flex-direction:column;overflow:hidden">
  <main id="zero-base-main" tabindex="-1" style="flex:1 1 auto;min-width:0;min-height:0;padding:${narrow ? 16 : 40}px;overflow-x:auto;overflow-y:auto">${body}</main>
</div>`;
}

export function agencyHarnessFileName(width: number, theme: string): string {
  return `agency-${width}-${theme}.html`;
}

/**
 * The Agency directory with fifty clients, rendered from the real projection
 * and the real table. Fifty is the point: it is the scan the design calls out,
 * and it is where a table that looks fine with three rows starts overflowing.
 */
function agencyMarkup(width: number): string {
  const narrow = width < DRAWER_BREAKPOINT;
  const page = buildAgencyDirectoryPage(
    Array.from({ length: 50 }, (_, index) => {
      const padded = String(index).padStart(2, "0");
      return {
        id: `biz_${padded}`,
        name: `Client ${padded} — a deliberately long trading name`,
        role: "admin",
        membershipStatus: "active" as const,
        currency: "USD",
        sourceUpdatedAt: "2026-08-10T12:00:00Z",
      };
    }),
    { pageSize: 50 },
  );

  const table = renderToStaticMarkup(
    <DataTable
      caption="Clients, listed alphabetically"
      rows={page.items}
      rowKey={(row) => row.businessId}
      columns={[
        { id: "name", header: "Client", render: (row) => row.name },
        { id: "role", header: "Your role", render: (row) => row.role },
        {
          id: "currency",
          header: "Currency",
          render: (row) => `${row.configuredCurrency ?? "Not set"} (configured)`,
        },
        {
          id: "activity",
          header: "Last source activity",
          render: (row) => row.sourceUpdatedAt ?? "Not recorded",
        },
      ]}
    />,
  );

  return `<div data-adc-ui="zero-base" data-shell style="height:100vh;display:flex;flex-direction:column;overflow:hidden">
  <main id="zero-base-main" data-agency-directory tabindex="-1" style="flex:1 1 auto;min-width:0;min-height:0;padding:${narrow ? 16 : 40}px;overflow-x:auto;overflow-y:auto">
    <h2 style="font-size:20px;line-height:26px;margin:0 0 16px">Clients</h2>
    ${table}
    <p data-collection-count style="font-size:12px;margin-top:12px">Showing ${page.servedCount} of ${page.totalCount}.</p>
  </main>
</div>`;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const css = canonicalCss();
  let count = 0;
  for (const width of HARNESS_WIDTHS) {
    const body = shellMarkup(width);
    for (const theme of HARNESS_THEMES) {
      const html = `<!doctype html>
<html lang="en" ${THEME_ATTRIBUTE}="${theme}">
<head><meta charset="utf-8"><title>Shell harness ${width} ${theme}</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${css}</style>
</head>
<body>${body}</body>
</html>`;
      writeFileSync(path.join(OUT_DIR, harnessFileName(width, theme)), html);
      count += 1;
    }
  }

  for (const width of HOME_HARNESS_WIDTHS) {
    const body = homeMarkup(width);
    for (const theme of HARNESS_THEMES) {
      const html = `<!doctype html>
<html lang="en" ${THEME_ATTRIBUTE}="${theme}">
<head><meta charset="utf-8"><title>Home harness ${width} ${theme}</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${css}</style>
</head>
<body>${body}</body>
</html>`;
      writeFileSync(path.join(OUT_DIR, homeHarnessFileName(width, theme)), html);
      count += 1;
    }
  }

  for (const width of AUTOMATION_HARNESS_WIDTHS) {
    const body = automationMarkup(width);
    for (const theme of HARNESS_THEMES) {
      const html = `<!doctype html>
<html lang="en" ${THEME_ATTRIBUTE}="${theme}">
<head><meta charset="utf-8"><title>Automation harness ${width} ${theme}</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${css}</style>
</head>
<body>${body}</body>
</html>`;
      writeFileSync(path.join(OUT_DIR, automationHarnessFileName(width, theme)), html);
      count += 1;
    }
  }

  for (const width of DECISIONS_HARNESS_WIDTHS) {
    const body = decisionsMarkup(width);
    for (const theme of HARNESS_THEMES) {
      const html = `<!doctype html>
<html lang="en" ${THEME_ATTRIBUTE}="${theme}">
<head><meta charset="utf-8"><title>Decisions harness ${width} ${theme}</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${css}</style>
</head>
<body>${body}</body>
</html>`;
      writeFileSync(path.join(OUT_DIR, decisionsHarnessFileName(width, theme)), html);
      count += 1;
    }
  }

  for (const width of AGENCY_HARNESS_WIDTHS) {
    const body = agencyMarkup(width);
    for (const theme of HARNESS_THEMES) {
      const html = `<!doctype html>
<html lang="en" ${THEME_ATTRIBUTE}="${theme}">
<head><meta charset="utf-8"><title>Agency harness ${width} ${theme}</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${css}</style>
</head>
<body>${body}</body>
</html>`;
      writeFileSync(path.join(OUT_DIR, agencyHarnessFileName(width, theme)), html);
      count += 1;
    }
  }
  console.log(`wrote ${count} harness pages to ${path.relative(ROOT, OUT_DIR)}`);
}

if (process.argv[1] && process.argv[1].includes("build-shell-harness")) main();
