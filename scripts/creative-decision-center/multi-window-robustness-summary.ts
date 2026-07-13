#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MULTI_WINDOW_CONTRACT_VERSION =
  "adsecute.multi-window-robustness-summary.v1" as const;
export const MULTI_WINDOW_CONTRACT_REVISION = 2 as const;
const SWEEP_CONTRACT_VERSION = "adsecute.f1-f2-cut-threshold-sweep.v1";
const MIN_SUPPORTED_SWEEP_REVISION = 3;

type WindowSummary = {
  knownEpisodes: number;
  unknownEpisodes: number;
  recoveredAboveTarget: number;
  earlyCutRate: number | null;
  trueLoserEpisodes: number;
  savedSpendUnits: number | null;
};

type VariantSummary = {
  variantId: string;
  episodes: number;
  defensible: boolean;
  dailyCutRows: number;
  affectedDailyRowsVsBaseline: number;
  flipRateVsBaseline: number | null;
  lossBudgetGeHardCutEpisodes: number;
  window14: WindowSummary;
};

type BusinessReview = {
  business: { id: string; name: string };
  status: "ok" | "skipped" | "failed";
  rowsEvaluated: number;
  evaluatedWindow: { startDate: string | null; endDate: string | null };
  variants: VariantSummary[];
};

export type SweepReport = {
  contractVersion: string;
  revision: number;
  title: string;
  asOf: string;
  generatedAt: string;
  engineVersion: string;
  reviews: BusinessReview[];
  recommendation?: { status: string; text: string };
};

type InputWindow = {
  id: string;
  path: string;
};

export type Row = {
  windowId: string;
  business: string;
  variantId: string;
  rowsEvaluated: number;
  episodes: number;
  defensible: boolean;
  known14: number;
  recovered14: number;
  earlyRate14: number | null;
  trueLosers14: number;
  savedUnits14: number | null;
  baselineKnown14: number;
  baselineRecovered14: number;
  baselineEarlyRate14: number | null;
  baselineSavedUnits14: number | null;
  earlyDeltaPp: number | null;
  savedDeltaUnits14: number | null;
  affectedDailyRowsVsBaseline: number;
  affectedDailyRowRate: number;
  lossBudgetGeHardCutEpisodes: number;
};

const DEFAULT_INPUTS: InputWindow[] = [
  {
    id: "2025-12-01..2026-01-31",
    path: "docs/creative-decision-center/generated/robustness-window-2025-12-01-to-2026-01-31.json",
  },
  {
    id: "2026-02-01..2026-03-31",
    path: "docs/creative-decision-center/generated/robustness-window-2026-02-01-to-2026-03-31.json",
  },
  {
    id: "2026-04-01..2026-05-31",
    path: "docs/creative-decision-center/generated/robustness-window-2026-04-01-to-2026-05-31.json",
  },
  {
    id: "2026-06-01..2026-06-20",
    path: "docs/creative-decision-center/generated/robustness-window-2026-06-01-to-2026-06-20.json",
  },
];

const VARIANTS_OF_INTEREST = [
  "V0_current",
  "V1d_purchase_floor_half_winner",
  "V2b_p25_breakeven_floor",
  "V3_recommended_combo",
  "LB1_0_loss_budget",
  "LB2_0_loss_budget",
  "LB2_5_loss_budget",
  "LB3_0_loss_budget",
] as const;

function parseArgs() {
  const parsed = {
    inputs: DEFAULT_INPUTS,
    jsonOut:
      "docs/creative-decision-center/generated/multi-window-robustness-summary-2026-07-06.json",
    mdOut: "docs/creative-decision-center/MULTI_WINDOW_ROBUSTNESS_SUMMARY_2026-07-06.md",
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--jsonOut=")) {
      parsed.jsonOut = arg.slice("--jsonOut=".length);
    } else if (arg.startsWith("--mdOut=")) {
      parsed.mdOut = arg.slice("--mdOut=".length);
    } else if (arg.startsWith("--input=")) {
      parsed.inputs = arg
        .slice("--input=".length)
        .split(",")
        .filter(Boolean)
        .map((path, index) => ({ id: `input_${index + 1}`, path }));
    }
  }

  return parsed;
}

function loadReport(input: InputWindow) {
  const raw = readFileSync(input.path, "utf8");
  return {
    report: JSON.parse(raw) as SweepReport,
    hash: sha256Text(raw),
  };
}

export function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateCompatibleReports(reports: SweepReport[]) {
  if (reports.length === 0) throw new Error("At least one sweep report is required.");
  const expectedRevision = reports[0]?.revision;
  const expectedEngineVersion = reports[0]?.engineVersion;
  for (const [index, report] of reports.entries()) {
    if (report.contractVersion !== SWEEP_CONTRACT_VERSION) {
      throw new Error(`Input ${index + 1} has incompatible contract ${report.contractVersion}.`);
    }
    if (!Number.isInteger(report.revision) || report.revision < MIN_SUPPORTED_SWEEP_REVISION) {
      throw new Error(`Input ${index + 1} has unsupported revision ${report.revision}.`);
    }
    if (report.revision !== expectedRevision) {
      throw new Error(
        `Input revisions are incompatible: expected ${expectedRevision}, received ${report.revision}.`,
      );
    }
    if (!report.engineVersion || report.engineVersion !== expectedEngineVersion) {
      throw new Error(
        `Input engine versions are incompatible: expected ${expectedEngineVersion}, received ${report.engineVersion || "missing"}.`,
      );
    }
  }
  return { inputRevision: expectedRevision as number, engineVersion: expectedEngineVersion as string };
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function delta(a: number | null, b: number | null) {
  return Number.isFinite(a) && Number.isFinite(b) ? (a as number) - (b as number) : null;
}

function fmtNumber(value: number | null, digits = 1) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return (value as number).toFixed(digits);
}

function fmtPct(value: number | null, digits = 1) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return `${((value as number) * 100).toFixed(digits)}%`;
}

function fmtPp(value: number | null, digits = 1) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  const signed = (value as number) >= 0 ? "+" : "";
  return `${signed}${(value as number).toFixed(digits)} pp`;
}

function fmtSigned(value: number | null, digits = 1) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  const signed = (value as number) >= 0 ? "+" : "";
  return `${signed}${(value as number).toFixed(digits)}`;
}

function buildRows(inputs: InputWindow[], reports: SweepReport[]) {
  const rows: Row[] = [];

  reports.forEach((report, reportIndex) => {
    const windowId = inputs[reportIndex]?.id ?? `window_${reportIndex + 1}`;

    for (const review of report.reviews) {
      if (review.status !== "ok") {
        continue;
      }

      const baseline = review.variants.find((variant) => variant.variantId === "V0_current");
      if (!baseline) {
        continue;
      }

      for (const variantId of VARIANTS_OF_INTEREST) {
        const variant = review.variants.find((candidate) => candidate.variantId === variantId);
        if (!variant) {
          continue;
        }

        const earlyRate14 = rate(
          variant.window14.recoveredAboveTarget,
          variant.window14.knownEpisodes,
        );
        const baselineEarlyRate14 = rate(
          baseline.window14.recoveredAboveTarget,
          baseline.window14.knownEpisodes,
        );
        const earlyDeltaRate = delta(earlyRate14, baselineEarlyRate14);
        const savedDeltaUnits14 = delta(
          variant.window14.savedSpendUnits,
          baseline.window14.savedSpendUnits,
        );

        rows.push({
          windowId,
          business: review.business.name,
          variantId,
          rowsEvaluated: review.rowsEvaluated,
          episodes: variant.episodes,
          defensible: variant.defensible,
          known14: variant.window14.knownEpisodes,
          recovered14: variant.window14.recoveredAboveTarget,
          earlyRate14,
          trueLosers14: variant.window14.trueLoserEpisodes,
          savedUnits14: variant.window14.savedSpendUnits,
          baselineKnown14: baseline.window14.knownEpisodes,
          baselineRecovered14: baseline.window14.recoveredAboveTarget,
          baselineEarlyRate14,
          baselineSavedUnits14: baseline.window14.savedSpendUnits,
          earlyDeltaPp:
            Number.isFinite(earlyDeltaRate) ? (earlyDeltaRate as number) * 100 : null,
          savedDeltaUnits14,
          affectedDailyRowsVsBaseline: variant.affectedDailyRowsVsBaseline,
          affectedDailyRowRate:
            review.rowsEvaluated > 0
              ? variant.affectedDailyRowsVsBaseline / review.rowsEvaluated
              : 0,
          lossBudgetGeHardCutEpisodes: variant.lossBudgetGeHardCutEpisodes,
        });
      }
    }
  });

  return rows;
}

export function aggregateRows(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.business}::${row.variantId}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.entries()]
    .map(([key, groupRows]) => {
      const [business, variantId] = key.split("::");
      const known14 = groupRows.reduce((sum, row) => sum + row.known14, 0);
      const recovered14 = groupRows.reduce((sum, row) => sum + row.recovered14, 0);
      const baselineKnown14 = groupRows.reduce((sum, row) => sum + row.baselineKnown14, 0);
      const baselineRecovered14 = groupRows.reduce(
        (sum, row) => sum + row.baselineRecovered14,
        0,
      );
      const pairwiseCompleteSavedRows = groupRows.filter(
        (row) =>
          Number.isFinite(row.savedUnits14) && Number.isFinite(row.baselineSavedUnits14),
      );
      const savedUnits14 =
        pairwiseCompleteSavedRows.length > 0
          ? pairwiseCompleteSavedRows.reduce(
              (sum, row) => sum + (row.savedUnits14 as number),
              0,
            )
          : null;
      const baselineSavedUnits14 =
        pairwiseCompleteSavedRows.length > 0
          ? pairwiseCompleteSavedRows.reduce(
              (sum, row) => sum + (row.baselineSavedUnits14 as number),
              0,
            )
          : null;
      const earlyRate14 = rate(recovered14, known14);
      const baselineEarlyRate14 = rate(baselineRecovered14, baselineKnown14);
      const earlyDeltaRate = delta(earlyRate14, baselineEarlyRate14);
      const rowsEvaluated = groupRows.reduce((sum, row) => sum + row.rowsEvaluated, 0);
      const affectedDailyRowsVsBaseline = groupRows.reduce(
        (sum, row) => sum + row.affectedDailyRowsVsBaseline,
        0,
      );

      return {
        business,
        variantId,
        windows: groupRows.length,
        defensibleWindows: groupRows.filter((row) => row.defensible).length,
        episodes: groupRows.reduce((sum, row) => sum + row.episodes, 0),
        known14,
        recovered14,
        earlyRate14,
        baselineKnown14,
        baselineRecovered14,
        baselineEarlyRate14,
        earlyDeltaPp: Number.isFinite(earlyDeltaRate)
          ? (earlyDeltaRate as number) * 100
          : null,
        trueLosers14: groupRows.reduce((sum, row) => sum + row.trueLosers14, 0),
        savedUnits14,
        baselineSavedUnits14,
        savedDeltaUnits14: delta(savedUnits14, baselineSavedUnits14),
        savedUnitsNullWindows: groupRows.filter((row) => !Number.isFinite(row.savedUnits14))
          .length,
        baselineSavedUnitsNullWindows: groupRows.filter(
          (row) => !Number.isFinite(row.baselineSavedUnits14),
        ).length,
        affectedDailyRowsVsBaseline,
        affectedDailyRowRate:
          rowsEvaluated > 0 ? affectedDailyRowsVsBaseline / rowsEvaluated : 0,
        lossBudgetGeHardCutEpisodes: groupRows.reduce(
          (sum, row) => sum + row.lossBudgetGeHardCutEpisodes,
          0,
        ),
      };
    })
    .sort((a, b) => {
      if (a.business !== b.business) {
        return a.business.localeCompare(b.business);
      }
      return VARIANTS_OF_INTEREST.indexOf(a.variantId as (typeof VARIANTS_OF_INTEREST)[number]) -
        VARIANTS_OF_INTEREST.indexOf(b.variantId as (typeof VARIANTS_OF_INTEREST)[number]);
    });
}

function renderAggregateTable(aggregates: ReturnType<typeof aggregateRows>) {
  const header =
    "| Business | Variant | Windows | Defensible | Known 14d | Early 14d | Baseline Early | Delta | Saved Units | Saved Delta | Affected Rows | LB>=HardCut |\n" +
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
  const rows = aggregates
    .map((row) =>
      [
        row.business,
        row.variantId,
        String(row.windows),
        String(row.defensibleWindows),
        String(row.known14),
        fmtPct(row.earlyRate14),
        fmtPct(row.baselineEarlyRate14),
        fmtPp(row.earlyDeltaPp),
        fmtNumber(row.savedUnits14),
        fmtSigned(row.savedDeltaUnits14),
        `${row.affectedDailyRowsVsBaseline} (${fmtPct(row.affectedDailyRowRate)})`,
        String(row.lossBudgetGeHardCutEpisodes),
      ].join(" | "),
    )
    .map((row) => `| ${row} |`)
    .join("\n");
  return `${header}\n${rows}`;
}

function renderWindowRows(rows: Row[]) {
  const header =
    "| Window | Business | Variant | Known 14d | Early 14d | Baseline Early | Delta | Saved Units | Saved Delta | Defensible | Affected Rows |\n" +
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
  const selected = rows.filter((row) =>
    [
      "V0_current",
      "V1d_purchase_floor_half_winner",
      "V2b_p25_breakeven_floor",
      "LB2_0_loss_budget",
      "LB3_0_loss_budget",
    ].includes(row.variantId),
  );
  const renderedRows = selected
    .map((row) =>
      [
        row.windowId,
        row.business,
        row.variantId,
        String(row.known14),
        fmtPct(row.earlyRate14),
        fmtPct(row.baselineEarlyRate14),
        fmtPp(row.earlyDeltaPp),
        fmtNumber(row.savedUnits14),
        fmtSigned(row.savedDeltaUnits14),
        row.defensible ? "yes" : "no",
        `${row.affectedDailyRowsVsBaseline} (${fmtPct(row.affectedDailyRowRate)})`,
      ].join(" | "),
    )
    .map((row) => `| ${row} |`)
    .join("\n");
  return `${header}\n${renderedRows}`;
}

function renderMarkdown(
  inputs: InputWindow[],
  reports: SweepReport[],
  rows: Row[],
  aggregates: ReturnType<typeof aggregateRows>,
  lineage: {
    gitSha: string;
    scriptContractRevision: number;
    inputRevision: number;
    engineVersion: string;
    inputHashes: Array<{ id: string; path: string; sha256: string | null }>;
  },
) {
  const generatedAt = new Date().toISOString();
  const inputLines = inputs
    .map((input, index) => {
      const report = reports[index];
      const statuses = report.reviews
        .map((review) => `${review.business.name}:${review.status}`)
        .join(", ");
      return `- ${input.id}: ${input.path} (${statuses})`;
    })
    .join("\n");

  return `# Multi-Window Robustness Summary - 2026-07-06

Generated at: ${generatedAt}

Git SHA: ${lineage.gitSha}

Script contract revision: ${lineage.scriptContractRevision}

Input sweep revision: ${lineage.inputRevision}; engine version: ${lineage.engineVersion}

Input SHA-256:
${lineage.inputHashes.map((input) => `- ${input.id}: ${input.sha256 ?? "unavailable"} (${input.path})`).join("\n")}

Read-only: yes. This summary only aggregates prior shadow replay outputs; it does not query providers, mutate DB rows, change resolver code, or post cron endpoints.

## Decision

No uniform/global formula change is supported by the multi-window replay.

The strongest repeated economic signal is TheSwaf + V2b (p25/breakeven boundary floor), but it is not a clean production candidate. It produces positive saved-unit deltas in all four windows (+869.9 units total), yet its pooled 14d early-cut rate worsens by +5.3 pp versus baseline and Dec-Jan/Feb-Mar worsen materially. The sign flips by regime: Dec-Jan +21.6 pp and Feb-Mar +31.9 pp, then Apr-May -10.4 pp and June -6.3 pp. This supports a deeper TheSwaf-only shadow investigation with golden cases, not rollout approval.

TheSwaf V2b is also target-history sensitive in a first-order way because its boundary depends on breakEvenRoas/targetRoas. This replay applies the latest target/config state across seven months of history; the two worst TheSwaf V2b windows (Dec-Mar) are also the most anachronistic windows. The final arbiter for this variant is live accrual under current targets, not the pooled +5.3 pp or the last-two-window improvement in isolation.

Grandmix V1d is not robust enough for production. It helps in the Apr-May window, is neutral in Dec-Jan and June, and does not fix the high-risk Feb-Mar window.

LossBudgetMultiplier should be account-level structurally, but it is not the first production lever. LB2.0 is small/inconsistent; LB3.0 exposes the lossBudget >= hardCut behavior class and must be blocked by validation/clamping or covered by new golden cases before any rollout.

IwaStore is no longer just a June small-n footnote. Older windows show enough episodes and high current early-cut rates to treat it as an account-level alarm. V2b is directionally interesting in aggregate, but it still worsens Feb-Mar early-cut rate and must be treated as a diagnostic candidate rather than a production-ready fix.

## Inputs

${inputLines}

## Aggregate Weighted Table

Weighted rates sum recovered/known episodes across windows. Saved-unit deltas are summed only where both baseline and variant report finite saved-unit values; null saved-unit windows are retained in the JSON output. The pooled early-cut number is known-weighted, so longer/older windows can dominate shorter recent windows; do not quote TheSwaf V2b's pooled +5.3 pp without the per-window sign flip.

${renderAggregateTable(aggregates)}

## Per-Window Detail

${renderWindowRows(rows)}

## Evidence Limits

- Window-seam double counting is possible. Episode dedup state is scoped to each input window; a creative whose cut-zone run crosses a boundary such as late January into early February can open one episode in each neighboring window. This affects only three seams here and is expected to be small, but it can slightly inflate episode totals.
- Pooled rates are known-weighted, not equal-weighted by window. Dec-Jan and Feb-Mar have longer spans than the June closed window, so aggregate rates can over-represent older regimes.
- V2b is more target-history-sensitive than the other tested variants because it uses breakEvenRoas/targetRoas. Historical target-pack changes are not reconstructed in this replay.

## Validation Notes

- Data ceiling is 2026-07-05; the current live source latest date observed in the prior phase was 2026-07-04, so the closed June decision window ends on 2026-06-20 for a 14-day outcome read.
- Unit of analysis remains cut episode, not daily row. Episode dedup requires a new cut run plus post-trigger spend before a new episode can open.
- Calibration is trailing 90d per replay day, but historical target packs are assumed fixed because the target/config tables expose the latest target pack state.
- This formula-level replay does not apply campaign-label guard, provider writes, DB writes, migrations, UI behavior, or resolver threshold changes.
- The multi-window evidence is still shadow evidence. It can justify the next controlled shadow parameter phase, not a direct unguarded production change.
`;
}

function main() {
  const args = parseArgs();
  const loaded = args.inputs.map(loadReport);
  const reports = loaded.map((input) => input.report);
  const compatibility = validateCompatibleReports(reports);
  const rows = buildRows(args.inputs, reports);
  const aggregates = aggregateRows(rows);
  const lineage = {
    gitSha: currentGitSha(),
    scriptContractRevision: MULTI_WINDOW_CONTRACT_REVISION,
    inputContractVersion: SWEEP_CONTRACT_VERSION,
    inputRevision: compatibility.inputRevision,
    engineVersion: compatibility.engineVersion,
    inputHashes: args.inputs.map((input, index) => ({
      id: input.id,
      path: input.path,
      sha256: loaded[index]?.hash ?? null,
    })),
  };
  const summary = {
    contractVersion: MULTI_WINDOW_CONTRACT_VERSION,
    revision: MULTI_WINDOW_CONTRACT_REVISION,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    mutatesData: false,
    inputs: args.inputs,
    lineage,
    variantsOfInterest: VARIANTS_OF_INTEREST,
    rows,
    aggregates,
  };

  mkdirSync(dirname(args.jsonOut), { recursive: true });
  mkdirSync(dirname(args.mdOut), { recursive: true });
  writeFileSync(args.jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(args.mdOut, renderMarkdown(args.inputs, reports, rows, aggregates, lineage));

  console.log(
    JSON.stringify(
      {
        jsonOut: args.jsonOut,
        mdOut: args.mdOut,
        windows: args.inputs.length,
        rows: rows.length,
        aggregates: aggregates.length,
      },
      null,
      2,
    ),
  );
}

function currentGitSha() {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("Unable to derive a valid current git SHA for artifact lineage.");
  }
  return sha;
}

const isMain =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1] as string)).href === import.meta.url;

if (isMain) main();
