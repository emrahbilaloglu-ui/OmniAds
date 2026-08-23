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
// Must run before any component import: the components below import CSS
// modules, which Node's CommonJS loader hands to the JavaScript parser. See the
// stub for why this gate has been failing at step one.
import "./css-module-stub";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ContextBar } from "@/components/zero-base/shell/context-bar";
import { MAIN_CONTENT_TABINDEX } from "@/components/zero-base/shell/skip-link";
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
import { HistoryView } from "@/components/zero-base/meta/history/history-view";
import {
  PublicSharePage,
  PublicShareUnavailable,
} from "@/components/zero-base/creative/public-share-page";
import { toPublicShare } from "@/lib/zero-base/creative/public-share";
import { CriticalIncidentPath } from "@/components/zero-base/ops/repair-panel";
import { IntelligenceView } from "@/components/zero-base/meta/intelligence/intelligence-view";
import { buildProviderPostures } from "@/lib/zero-base/meta/automation-posture";
import { navGroupsFor } from "@/lib/zero-base/navigation";
import { THEME_ATTRIBUTE } from "@/lib/theme";

const ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "playwright", ".harness");

export const HARNESS_WIDTHS = [1440, 1280, 768, 390, 320] as const;
export const HARNESS_THEMES = ["light", "dark"] as const;
export const DRAWER_BREAKPOINT = 768;

const SCOPE = {
  scopeContext: "Client",
  enteredFrom: null,
  providerLabel: "Meta",
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
      <main id="zero-base-main" tabindex="${MAIN_CONTENT_TABINDEX}" style="flex:1 1 auto;min-width:0;min-height:0;padding:${narrow ? 16 : 40}px;overflow-x:auto;overflow-y:auto">${wideTable}</main>
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

/**
 * The mirror case: Meta healthy, Google unreadable.
 *
 * Together with the degraded-Meta fixture this covers both directions, so
 * neither provider's row can be quietly conditional on the other's health.
 */
export function automationMirrorHarnessFileName(width: number, theme: string): string {
  return `automation-mirror-${width}-${theme}.html`;
}

export function historyHarnessFileName(width: number, theme: string): string {
  return `history-${width}-${theme}.html`;
}

export function intelligenceHarnessFileName(width: number, theme: string): string {
  return `intelligence-${width}-${theme}.html`;
}

function frame(width: number, body: string): string {
  const narrow = width < DRAWER_BREAKPOINT;
  return `<div data-adc-ui="zero-base" data-shell style="height:100vh;display:flex;flex-direction:column;overflow:hidden">
  <main id="zero-base-main" tabindex="${MAIN_CONTENT_TABINDEX}" style="flex:1 1 auto;min-width:0;min-height:0;padding:${narrow ? 16 : 40}px;overflow-x:auto;overflow-y:auto">${body}</main>
</div>`;
}

function automationMirrorMarkup(width: number): string {
  return frame(
    width,
    renderToStaticMarkup(
      <AutomationView
        postures={buildProviderPostures({
          meta: { state: "serving", reason: null },
          // The read failed. This must print Unknown, never Serving.
          google: { read: false, reason: "integration status is unavailable" },
        })}
        guardrails={{
          dailyAutoActionCap: 3,
          perActionSpendCeilingMinor: 5000,
          minimumConfidence: "high",
          cooldownMinutes: 60,
          maxEvidenceAgeHours: 24,
        }}
        ceremony={{
          intent: "release",
          viewer: { role: "admin", isReviewer: false, demo: false },
          currentlyEngaged: true,
          readBack: null,
        }}
      />,
    ),
  );
}

/** The public share, as a stranger sees it, from a real payload shape. */
function publicShareMarkup(width: number): string {
  return frame(
    width,
    renderToStaticMarkup(
      <PublicSharePage
        share={toPublicShare({
          token: "tok",
          title: "Q3 creatives",
          dateRange: "2026-07-01..2026-07-31",
          createdAt: "2026-08-01",
          expiresAt: "2026-09-01",
          businessId: "biz-internal-9f2c",
          providerAccountId: "act_internal_7781",
          scopeContext: "Client",
          enteredFrom: null,
          providerLabel: "Meta",
          businessName: "Acme Internal Workspace",
          clientEmail: "finance@acme-internal.example",
          metrics: [],
          includeNotes: false,
          audience: "buyer",
          creatives: [
            {
              id: "cr-internal-1",
              name: "Hero video",
              format: "video",
              previewState: "preview",
              isCatalog: false,
              previewUrl: null,
              imageUrl: null,
              thumbnailUrl: null,
              preview: {
                render_mode: "video",
                image_url: null,
                video_url: "https://cdn.example/hero.mp4",
                poster_url: null,
                source: "preview_url",
                is_catalog: false,
              },
              launchDate: "2026-07-01",
              tags: [],
              spend: 100,
              purchaseValue: 300,
              roas: 3,
              cpa: 10,
              ctrAll: 1.2,
              purchases: 10,
            },
            {
              id: "cr-internal-2",
              name: "Static banner",
              format: "image",
              previewState: "unavailable",
              isCatalog: false,
              previewUrl: null,
              imageUrl: null,
              thumbnailUrl: null,
              preview: {
                render_mode: "unavailable",
                image_url: null,
                video_url: null,
                poster_url: null,
                source: null,
                is_catalog: false,
              },
              launchDate: "2026-07-01",
              tags: [],
              spend: 5,
              purchaseValue: 0,
              roas: 0,
              cpa: 0,
              ctrAll: 0,
              purchases: 0,
            },
          ],
        } as never)}
      />,
    ),
  );
}

/**
 * A marketing page under the scoped Ledger stylesheet.
 *
 * Long legal prose is the hard case: it must stay readable at 320 without the
 * page scrolling sideways, and its measure must stay bounded at 1440.
 */
function marketingMarkup(width: number): string {
  const body = renderToStaticMarkup(
    <div data-adc-marketing>
      <main>
        <h1>Security</h1>
        <p>
          Adsecute stores provider credentials encrypted at rest and never shares
          workspace data between businesses. This paragraph exists to exercise the
          measure and line height at every supported width, including the narrowest
          one, where an unbounded line length is the difference between readable and
          unusable.
        </p>
        <h2>Data handling</h2>
        <ul>
          <li>Provider tokens are encrypted with a per-installation key.</li>
          <li>Access is scoped to the business a member belongs to.</li>
        </ul>
        <p>
          <a href="/privacy">Read the privacy policy</a>
        </p>
      </main>
    </div>,
  );
  return `<div style="min-height:100vh">${body}</div>`;
}

/** Flow J: the critical incident path, at Ops widths. */
function opsIncidentMarkup(width: number): string {
  return frame(
    width,
    renderToStaticMarkup(
      <div>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Integration health</h1>
        <p style={{ margin: "6px 0 16px", fontSize: 12.5 }}>
          Shopify webhooks are failing for one workspace.
        </p>
        <CriticalIncidentPath />
      </div>,
    ),
  );
}

function publicShareGoneMarkup(width: number): string {
  return frame(width, renderToStaticMarkup(<PublicShareUnavailable />));
}

function historyMarkup(width: number): string {
  return frame(
    width,
    renderToStaticMarkup(
      <HistoryView
        accountLabel="Main account"
        disclosure="Showing the 40 most recent entries. More exist beyond this page."
        limitations={["Rows without an account scope were omitted."]}
        rows={[
          {
            id: "h1",
            occurredAt: "2026-08-11T08:00:00Z",
            action: "Pause ad",
            outcome: "verified",
            actor: "ada@example.com",
            replayed: false,
          },
          {
            id: "h2",
            occurredAt: "2026-08-11T09:00:00Z",
            action: "Resume ad set",
            outcome: "silent_failure",
            // No recorded actor: the row must say so rather than say "System".
            actor: null,
            replayed: true,
          },
        ]}
      />,
    ),
  );
}

function intelligenceMarkup(width: number): string {
  return frame(
    width,
    renderToStaticMarkup(
      <IntelligenceView
        window={{ startDate: "2026-07-15", endDate: "2026-08-11" }}
        sources={[
          {
            key: "status",
            label: "Connection & account",
            state: "serving",
            reason: null,
            observedAt: "2026-08-11T12:00:00Z",
            facts: [{ label: "Selected account", value: "act_1" }],
          },
          {
            key: "summary",
            label: "Summary",
            state: "partial",
            reason: "Current-day live Meta totals are still being prepared.",
            observedAt: "2026-08-11T12:00:00Z",
            facts: [{ label: "Read source", value: "current_day_live" }],
          },
          {
            key: "breakdowns",
            label: "Breakdowns",
            state: "degraded",
            reason: "The breakdown source could not be read.",
            observedAt: null,
            facts: [],
          },
          {
            key: "structure",
            label: "Structure & recommendations",
            state: "unavailable",
            reason: "This source is not configured for this business.",
            observedAt: null,
            facts: [],
          },
        ]}
      />,
    ),
  );
}

function automationMarkup(width: number): string {
  const body = renderToStaticMarkup(
    <AutomationView
      // Meta degraded, Google healthy: the case where a missing Google row
      // would teach an operator that one switch covers both providers.
      postures={buildProviderPostures({
        google: { read: true, connected: true },
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

  return frame(width, body);
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
  <main id="zero-base-main" tabindex="${MAIN_CONTENT_TABINDEX}" style="flex:1 1 auto;min-width:0;min-height:0;padding:${narrow ? 16 : 40}px;overflow-x:auto;overflow-y:auto">${body}</main>
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
    <HomeView contract={contract} refreshState="failed" />,
  );

  return `<div data-adc-ui="zero-base" data-shell style="height:100vh;display:flex;flex-direction:column;overflow:hidden">
  <main id="zero-base-main" tabindex="${MAIN_CONTENT_TABINDEX}" style="flex:1 1 auto;min-width:0;min-height:0;padding:${narrow ? 16 : 40}px;overflow-x:auto;overflow-y:auto">${body}</main>
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
  <main id="zero-base-main" data-agency-directory tabindex="${MAIN_CONTENT_TABINDEX}" style="flex:1 1 auto;min-width:0;min-height:0;padding:${narrow ? 16 : 40}px;overflow-x:auto;overflow-y:auto">
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

  // The remaining Flow I surfaces and the mirror provider case.
  const marketingCss = readFileSync(path.join(ROOT, "app", "marketing-ledger.css"), "utf8");
  for (const width of [1440, 390, 320]) {
    const body = marketingMarkup(width);
    for (const theme of HARNESS_THEMES) {
      const html = `<!doctype html>
<html lang="en" ${THEME_ATTRIBUTE}="${theme}">
<head><meta charset="utf-8"><title>Marketing ${width} ${theme}</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${css}</style>
<style>${marketingCss}</style>
</head>
<body>${body}</body>
</html>`;
      writeFileSync(path.join(OUT_DIR, `marketing-${width}-${theme}.html`), html);
      count += 1;
    }
  }

  for (const width of [1280, 768, 390]) {
    const body = opsIncidentMarkup(width);
    for (const theme of HARNESS_THEMES) {
      const html = `<!doctype html>
<html lang="en" ${THEME_ATTRIBUTE}="${theme}">
<head><meta charset="utf-8"><title>Ops incident ${width} ${theme}</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${css}</style>
</head>
<body>${body}</body>
</html>`;
      writeFileSync(path.join(OUT_DIR, `ops-incident-${width}-${theme}.html`), html);
      count += 1;
    }
  }

  for (const [name, markup] of [
    ["automation-mirror", automationMirrorMarkup],
    ["public-share", publicShareMarkup],
    ["public-share-gone", publicShareGoneMarkup],
    ["history", historyMarkup],
    ["intelligence", intelligenceMarkup],
  ] as const) {
    for (const width of AUTOMATION_HARNESS_WIDTHS) {
      const body = markup(width);
      for (const theme of HARNESS_THEMES) {
        const html = `<!doctype html>
<html lang="en" ${THEME_ATTRIBUTE}="${theme}">
<head><meta charset="utf-8"><title>${name} harness ${width} ${theme}</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${css}</style>
</head>
<body>${body}</body>
</html>`;
        writeFileSync(path.join(OUT_DIR, `${name}-${width}-${theme}.html`), html);
        count += 1;
      }
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
