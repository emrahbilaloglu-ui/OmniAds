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
