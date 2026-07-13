#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildH1CountryParentReport,
  parseH1CountryArgs,
} from "./h1-country-parent-challenger";

const DEFAULT_JSON_OUT = join(
  process.cwd(),
  "docs/creative-decision-center/generated/h1-country-parent-challenger-2025-12-01-to-2026-07-05.json",
);
const DEFAULT_MD_OUT = join(
  process.cwd(),
  "docs/creative-decision-center/H1_COUNTRY_PARENT_CHALLENGER_2025-12-01_TO_2026-07-05.md",
);

type Report = Awaited<ReturnType<typeof buildH1CountryParentReport>>;

function cliValue(argv: readonly string[], name: string) {
  const prefix = `--${name}=`;
  return (
    argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function pct(value: number | null) {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function number(value: number | null, digits = 4) {
  return value === null ? "n/a" : value.toFixed(digits);
}

function selectedScores(report: Report) {
  const baseId = report.evaluation.selection.selectedBaseVariantId;
  if (!baseId) return { account: null, country: null };
  return {
    account:
      report.evaluation.summaries.find(
        (summary) =>
          summary.variant.id === `${baseId}__parent_account_goal`,
      )?.folds.lockedTest ?? null,
    country:
      report.evaluation.summaries.find(
        (summary) =>
          summary.variant.id ===
          `${baseId}__parent_account_goal_country_spend_weighted`,
      )?.folds.lockedTest ?? null,
  };
}

export function renderH1CountryParentMarkdown(report: Report) {
  const coverage = report.cohort.coverage;
  const raw = report.sources.rawCoverage;
  const selection = report.evaluation.selection;
  const scores = selectedScores(report);
  const paired = selection.selectedPair?.lockedTest ?? null;
  const bootstrap = selection.lockedRecallDeltaBootstrap;
  const windowRows = selection.selectedWindowSensitivity
    .map(
      (window) =>
        `| ${window.windowDays}d | ${window.accountGoal.known} | ${pct(window.accountGoal.precision)} | ${pct(window.accountGoal.recall)} | ${window.countryWeighted.known} | ${pct(window.countryWeighted.precision)} | ${pct(window.countryWeighted.recall)} | ${window.comparison.transition.accountGoalOnly + window.comparison.transition.countryWeightedOnly} |`,
    )
    .join("\n");
  const scoreRow = (
    label: string,
    score: typeof scores.account,
  ) =>
    score
      ? `| ${label} | ${score.emitted} | ${score.known} | ${score.supported} | ${score.refuted} | ${pct(score.precision)} | ${pct(score.precisionWilson?.lower ?? null)} | ${pct(score.recall)} | ${score.safetyViolations} |`
      : `| ${label} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`;

  return `# H1 Country-Parent Challenger

Source mode: \`${report.sourceMode}\`
Decision range: ${report.dates.startDate} to ${report.dates.decisionEndDate}
Outcome ceiling: ${report.dates.outcomeCeiling}
Producer cutoff: ${report.dates.producerCutoffUtc}
Report hash: \`${report.reportHash}\`

## Evidence Boundary

This is a producer-cutoff-strict, restated sensitivity analysis. Every source
day uses only the latest complete generation observed by that decision's
cutoff; later fetches cannot affect earlier decisions. It is not full resolver
PIT, causal lift, automation evidence, or production execution authority.
Country is represented as a 28-day ad-level spend-share vector. A multi-country
ad is never forced into one assigned country.

## Retained Source Coverage

- Retained raw country pages: **${raw.retainedPageRows}**
- Planned source-day/cutoff selections: **${raw.plannedCutoffSourceScopes}**
- Unique complete generations selected: **${raw.selectedGenerations}**
- Normalized ad-country rows selected: **${raw.selectedCountryRows}**
- Rejected source-day/cutoff selections: **${raw.incompleteOrInvalidLatestGenerations}**
- Unmapped raw scopes: **${raw.unmappedRawScopes}**
- Normalized Meta ad rows: **${report.sources.normalizedAdRows}**
- Raw source SHA-256: \`${report.sources.sourceHash}\`

## Fixed Cohort

- Rows / unique keys: **${coverage.rows} / ${coverage.uniqueKeys}**
- Purchase-cohort rows: **${coverage.purchaseCohortRows}**
- Target observed / fresh: **${coverage.targetObservedRows} / ${coverage.targetFreshRows}**
- Complete 14-day outcomes: **${coverage.completeOutcomeRows}**
- Country mix available: **${coverage.countryMixAvailableRows}**
- Multi-country rows: **${coverage.multiCountryRows}**
- Complete country fallback rows: **${coverage.countryMixFallbackRows}**
- Reconciled country-spend coverage: **${pct(coverage.countryMixSpendCoverage)}**
- Fixed cohort SHA-256: \`${report.cohort.fixedCohortHash}\`
- Manifest-set SHA-256: \`${report.cohort.manifestSetHash}\`

All **${report.evaluation.variants.length}** variants use this same cohort:
144 locked H1 configurations crossed with \`account_goal\` and
\`account_goal_country_spend_weighted\` parent modes.

## Locked Parent Comparison

Calibration selected the H1 configuration
\`${selection.selectedBaseVariantId ?? "none"}\` using only the account-goal
parent. The country parent was then compared at that locked configuration.

| Parent | Emitted | Known | Supported | Refuted | Precision | Wilson lower | Recall | Safety violations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${scoreRow("account_goal", scores.account)}
${scoreRow("country_spend_weighted", scores.country)}

Paired locked-test deltas for country minus account:

- emitted: **${paired?.deltas.emitted ?? "n/a"}**
- supported: **${paired?.deltas.supported ?? "n/a"}**
- refuted: **${paired?.deltas.refuted ?? "n/a"}**
- precision: **${number(paired?.deltas.precision ?? null)}**
- recall: **${number(paired?.deltas.recall ?? null)}**
- safety violations: **${paired?.deltas.safetyViolations ?? "n/a"}**
- clustered recall-delta 95% interval: **${number(bootstrap?.lower ?? null)} to ${number(bootstrap?.upper ?? null)}**

## Locked Outcome-Window Robustness

The H1 configuration is selected once on the primary 14-day calibration fold.
The same locked account and country variants are then scored independently on
closed 3-day, 7-day, and 14-day outcomes; windows are never pooled.

| Window | Account known | Account precision | Account recall | Country known | Country precision | Country recall | Decision changes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${windowRows}

## Gate Decision

Status: **${selection.status}**

${selection.historicalGateFailures.length > 0 ? selection.historicalGateFailures.map((failure) => `- \`${failure}\``).join("\n") : "- No historical sensitivity gate failure."}

This result can justify a production formula change only if every predeclared
historical gate passes. Even a passing result would remain review-only because
the source is restated and does not identify causal lift.

## Closure

Country conditioning is no longer an untested alternative. Sparse country
cells fall back share-by-share to the account-goal parent and cannot increase
confidence. The D049 break-even safety ceiling is identical in both modes.
No resolver change is made by this package.
`;
}

async function main() {
  const argv = process.argv.slice(2);
  const report = await buildH1CountryParentReport(parseH1CountryArgs(argv));
  const jsonOut = cliValue(argv, "jsonOut") ?? DEFAULT_JSON_OUT;
  const mdOut = cliValue(argv, "mdOut") ?? DEFAULT_MD_OUT;
  const writeFiles = !argv.includes("--no-write");

  if (writeFiles) {
    mkdirSync(dirname(jsonOut), { recursive: true });
    mkdirSync(dirname(mdOut), { recursive: true });
    writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(mdOut, `${renderH1CountryParentMarkdown(report)}\n`, "utf8");
  }

  console.log(
    JSON.stringify(
      {
        status: report.evaluation.selection.status,
        variants: report.evaluation.variants.length,
        coverage: report.cohort.coverage,
        selectedBaseVariantId:
          report.evaluation.selection.selectedBaseVariantId,
        historicalGateFailures:
          report.evaluation.selection.historicalGateFailures,
        reportHash: report.reportHash,
        outputs: writeFiles ? { json: jsonOut, markdown: mdOut } : null,
      },
      null,
      2,
    ),
  );
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  });
}
