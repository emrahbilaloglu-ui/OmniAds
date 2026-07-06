#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  ENGINE_VERSION,
  classifyCreativeDecisionOutcome,
  CREATIVE_OUTCOME_CLASSIFIER_VERSION,
  type DecisionLabel,
  type CreativeDecisionRealizedOutcome,
} from "@/lib/creative-decision-engine";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

const DEFAULT_BUSINESSES = ["IwaStore", "EMOLOS", "Grandmix", "TheSwaf"];
const DEFAULT_START_DATE = "2025-12-01";
const DEFAULT_END_DATE = "2026-06-20";
const DEFAULT_EVALUATION_CEILING = "2026-07-05";
const DEFAULT_JSON_OUT =
  "docs/creative-decision-center/generated/confidence-calibration-source-mode-2025-12-01-to-2026-06-20.json";
const DEFAULT_MD_OUT =
  "docs/creative-decision-center/CONFIDENCE_CALIBRATION_SOURCE_MODE_2025-12-01_TO_2026-06-20.md";
const OUTCOME_WINDOWS = [7, 14] as const;
const HARD_LABELS = new Set<DecisionLabel>(["cut", "scale", "refresh"]);
const DEFENSIBLE_EPISODE_THRESHOLD = 30;
const DIRECTIONAL_EPISODE_THRESHOLD = 10;

type CountMap = Record<string, number>;
type Row = Record<string, unknown>;
type OutcomeWindowDays = (typeof OUTCOME_WINDOWS)[number];
type SourceMode =
  | "lifecycle_same_day"
  | "lifecycle_carry_forward"
  | "runtime_sql_fallback";
type OutcomeStatus = "open_window" | "known" | "unknown";

interface ParsedArgs {
  startDate: string;
  endDate: string;
  evaluationCeiling: string;
  businesses: string[];
  jsonOut: string;
  mdOut: string;
  writeFiles: boolean;
  queryTimeoutMs: number;
}

interface DecisionOutcomeRow {
  businessId: string;
  businessName: string;
  asOfDate: string;
  sourceMode: SourceMode;
  creativeId: string;
  label: DecisionLabel;
  confidence: number;
  windowDays: OutcomeWindowDays;
  status: OutcomeStatus;
  realizedOutcome: CreativeDecisionRealizedOutcome | "open_window";
  effectiveTargetRoas: number;
  baselineSpend: number | null;
  baselinePurchases: number | null;
  baselineRoas: number | null;
  outcomeSpend: number | null;
  outcomePurchases: number | null;
  outcomeRevenue: number | null;
  outcomeRoas: number | null;
  asOfDateSpend: number | null;
}

interface OutcomeEpisode extends DecisionOutcomeRow {
  episodeKey: string;
}

interface CalibrationCell {
  businessName: string;
  windowDays: OutcomeWindowDays;
  sourceMode: SourceMode;
  label: DecisionLabel;
  hardClass: "hard" | "non_hard";
  bucket: string;
  episodes: number;
  knownEpisodes: number;
  unknownEpisodes: number;
  positive: number;
  negative: number;
  neutral: number;
  observedPositiveRate: number | null;
  averageConfidence: number | null;
  absoluteGap: number | null;
  reliability: "defensible" | "directional" | "insufficient";
  positiveMeaning: "hard_action_supported" | "non_hard_missed_hard_action_proxy";
}

function parseArgs(argv: string[]): ParsedArgs {
  return {
    startDate: arg(argv, "startDate", DEFAULT_START_DATE),
    endDate: arg(argv, "endDate", DEFAULT_END_DATE),
    evaluationCeiling: arg(argv, "evaluationCeiling", DEFAULT_EVALUATION_CEILING),
    businesses: csvArg(argv, "businesses") ?? DEFAULT_BUSINESSES,
    jsonOut: arg(argv, "jsonOut", DEFAULT_JSON_OUT),
    mdOut: arg(argv, "mdOut", DEFAULT_MD_OUT),
    writeFiles: arg(argv, "write", "1") !== "0",
    queryTimeoutMs: Math.max(1_000, Number(arg(argv, "queryTimeoutMs", "120000")) || 120_000),
  };
}

function arg(argv: string[], name: string, fallback: string) {
  const prefix = `--${name}=`;
  return argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function csvArg(argv: string[], name: string) {
  const raw = arg(argv, name, "");
  if (!raw) return null;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value === null || value === undefined) return null;
  return String(value);
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toDateOnly(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return toText(value)?.slice(0, 10) ?? null;
}

function dateToMs(date: string) {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function addDays(date: string, days: number) {
  const parsed = new Date(dateToMs(date));
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function diffDays(left: string, right: string) {
  return Math.round((dateToMs(left) - dateToMs(right)) / 86_400_000);
}

function isClosedWindow(asOfDate: string, windowDays: OutcomeWindowDays, ceiling: string) {
  return addDays(asOfDate, windowDays) <= ceiling;
}

function rounded(value: number | null | undefined, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return rounded(numerator / denominator, 4);
}

function increment(map: CountMap, key: string | null | undefined, by = 1) {
  const normalized = key?.trim() || "null";
  map[normalized] = (map[normalized] ?? 0) + by;
}

function confidenceBucket(confidence: number) {
  if (confidence < 50) return "00_49";
  if (confidence < 60) return "50_59";
  if (confidence < 70) return "60_69";
  if (confidence < 80) return "70_79";
  if (confidence < 90) return "80_89";
  return "90_100";
}

function hardClass(label: DecisionLabel) {
  return HARD_LABELS.has(label) ? "hard" : "non_hard";
}

function decisionLabelPriority(label: DecisionLabel) {
  const priorities: Record<DecisionLabel, number> = {
    cut: 70,
    scale: 60,
    refresh: 50,
    diagnose: 40,
    test_more: 30,
    keep: 20,
    out_of_scope: 10,
  };
  return priorities[label] ?? 0;
}

async function readDecisionOutcomeRows(args: ParsedArgs) {
  const rows = await getDb().query<Row>(
    `
    WITH business_scope AS (
      SELECT id, name
      FROM businesses
      WHERE lower(name) = ANY($1::text[])
         OR id::text = ANY($2::text[])
    ),
    snapshots AS (
      SELECT
        b.id::text AS business_id,
        b.name AS business_name,
        s.creative_id,
        s.as_of_date,
        s.label,
        s.confidence,
        s.effective_target_roas,
        s.spend AS baseline_spend,
        s.purchases AS baseline_purchases,
        s.roas AS baseline_roas,
        CASE
          WHEN s.lifecycle_row_id IS NULL THEN 'runtime_sql_fallback'
          WHEN l.as_of_date = s.as_of_date THEN 'lifecycle_same_day'
          ELSE 'lifecycle_carry_forward'
        END AS source_mode
      FROM business_scope b
      JOIN engine_v3_decision_snapshots_daily s
        ON s.business_ref_id = b.id
      LEFT JOIN engine_v3_creative_lifecycle_daily l
        ON l.id = s.lifecycle_row_id
      WHERE s.engine_version = $3
        AND s.scope_type = 'account'
        AND s.scope_id = '*'
        AND s.as_of_date BETWEEN $4::date AND $5::date
    ),
    windows AS (
      SELECT unnest($7::integer[]) AS outcome_window_days
    ),
    day_spend AS (
      SELECT
        s.business_id,
        s.creative_id,
        s.as_of_date,
        COALESCE(SUM(d.spend), 0)::double precision AS as_of_date_spend
      FROM snapshots s
      LEFT JOIN meta_creative_daily d
        ON d.business_ref_id::text = s.business_id
       AND d.creative_id = s.creative_id
       AND d.date = s.as_of_date
      GROUP BY s.business_id, s.creative_id, s.as_of_date
    )
    SELECT
      s.business_id,
      s.business_name,
      s.creative_id,
      s.as_of_date::text AS as_of_date,
      s.source_mode,
      s.label,
      s.confidence,
      s.effective_target_roas,
      s.baseline_spend,
      s.baseline_purchases,
      s.baseline_roas,
      windows.outcome_window_days,
      MAX(day_spend.as_of_date_spend)::double precision AS as_of_date_spend,
      COALESCE(SUM(d.spend), 0)::double precision AS outcome_spend,
      COALESCE(SUM(d.conversions), 0)::double precision AS outcome_purchases,
      COALESCE(SUM(d.revenue), 0)::double precision AS outcome_revenue,
      CASE
        WHEN COALESCE(SUM(d.spend), 0) > 0
        THEN COALESCE(SUM(d.revenue), 0) / NULLIF(SUM(d.spend), 0)
      END AS outcome_roas
    FROM snapshots s
    CROSS JOIN windows
    LEFT JOIN day_spend
      ON day_spend.business_id = s.business_id
     AND day_spend.creative_id = s.creative_id
     AND day_spend.as_of_date = s.as_of_date
    LEFT JOIN meta_creative_daily d
      ON d.business_ref_id::text = s.business_id
     AND d.creative_id = s.creative_id
     AND d.date > s.as_of_date
     AND d.date <= (s.as_of_date + (windows.outcome_window_days * INTERVAL '1 day'))::date
    WHERE s.as_of_date <= ($6::date - (windows.outcome_window_days * INTERVAL '1 day'))
    GROUP BY
      s.business_id,
      s.business_name,
      s.creative_id,
      s.as_of_date,
      s.source_mode,
      s.label,
      s.confidence,
      s.effective_target_roas,
      s.baseline_spend,
      s.baseline_purchases,
      s.baseline_roas,
      windows.outcome_window_days
    ORDER BY s.business_name ASC, s.creative_id ASC, windows.outcome_window_days ASC, s.as_of_date ASC
    `,
    [
      args.businesses.map((item) => item.toLowerCase()),
      args.businesses,
      ENGINE_VERSION,
      args.startDate,
      args.endDate,
      args.evaluationCeiling,
      OUTCOME_WINDOWS,
    ],
  );

  return rows.flatMap((row): DecisionOutcomeRow[] => {
    const businessId = toText(row.business_id);
    const businessName = toText(row.business_name);
    const creativeId = toText(row.creative_id);
    const asOfDate = toDateOnly(row.as_of_date);
    const label = toText(row.label) as DecisionLabel | null;
    const sourceMode = toText(row.source_mode) as SourceMode | null;
    const windowDays = toNumber(row.outcome_window_days) as OutcomeWindowDays;
    if (
      !businessId ||
      !businessName ||
      !creativeId ||
      !asOfDate ||
      !label ||
      !sourceMode ||
      !OUTCOME_WINDOWS.includes(windowDays)
    ) {
      return [];
    }
    const confidence = Math.round(toNumber(row.confidence));
    const effectiveTargetRoas = toNumber(row.effective_target_roas);
    const outcomeSpend = toNumber(row.outcome_spend);
    const outcomePurchases = toNumber(row.outcome_purchases);
    const outcomeRevenue = toNumber(row.outcome_revenue);
    const outcomeRoas = toNullableNumber(row.outcome_roas);
    const classification = classifyCreativeDecisionOutcome({
      label,
      confidence,
      effectiveTargetRoas,
      baselineSpend: toNullableNumber(row.baseline_spend),
      baselinePurchases: toNullableNumber(row.baseline_purchases),
      baselineRoas: toNullableNumber(row.baseline_roas),
      outcomeSpend,
      outcomePurchases,
      outcomeRevenue,
      outcomeRoas,
      outcomeWindowDays: windowDays,
    });

    return [
      {
        businessId,
        businessName,
        asOfDate,
        sourceMode,
        creativeId,
        label,
        confidence,
        windowDays,
        status: classification.realizedOutcome === "unknown" ? "unknown" : "known",
        realizedOutcome: classification.realizedOutcome,
        effectiveTargetRoas,
        baselineSpend: toNullableNumber(row.baseline_spend),
        baselinePurchases: toNullableNumber(row.baseline_purchases),
        baselineRoas: toNullableNumber(row.baseline_roas),
        outcomeSpend,
        outcomePurchases,
        outcomeRevenue,
        outcomeRoas,
        asOfDateSpend: toNullableNumber(row.as_of_date_spend),
      },
    ];
  });
}

function collectOutcomeEpisodes(rows: DecisionOutcomeRow[]) {
  const sorted = [...rows].sort((left, right) => {
    const businessCmp = left.businessId.localeCompare(right.businessId);
    if (businessCmp) return businessCmp;
    const creativeCmp = left.creativeId.localeCompare(right.creativeId);
    if (creativeCmp) return creativeCmp;
    const windowCmp = left.windowDays - right.windowDays;
    if (windowCmp) return windowCmp;
    return left.asOfDate.localeCompare(right.asOfDate);
  });
  const stateByCreativeWindow = new Map<
    string,
    {
      date: string | null;
      label: DecisionLabel | null;
      lastEpisodeDate: string | null;
      hasSpendAfterLastEpisode: boolean;
    }
  >();
  const episodes: OutcomeEpisode[] = [];

  for (const row of sorted) {
    const stateKey = `${row.businessId}::${row.creativeId}::${row.windowDays}`;
    const state =
      stateByCreativeWindow.get(stateKey) ??
      {
        date: null,
        label: null,
        lastEpisodeDate: null,
        hasSpendAfterLastEpisode: false,
      };
    if (
      state.lastEpisodeDate !== null &&
      row.asOfDate > state.lastEpisodeDate &&
      (row.asOfDateSpend ?? 0) > 0
    ) {
      state.hasSpendAfterLastEpisode = true;
    }
    const previousDayDiff = state.date === null ? null : diffDays(row.asOfDate, state.date);
    const startsRun =
      state.label !== row.label || previousDayDiff === null || previousDayDiff > 1;
    const hasFreshSpendSinceLastEpisode =
      state.lastEpisodeDate === null || state.hasSpendAfterLastEpisode;

    if (startsRun && hasFreshSpendSinceLastEpisode) {
      const episodeKey = [
        row.businessId,
        row.creativeId,
        row.windowDays,
        row.asOfDate,
        row.label,
      ].join("::");
      episodes.push({ ...row, episodeKey });
      state.lastEpisodeDate = row.asOfDate;
      state.hasSpendAfterLastEpisode = false;
    }

    state.date = row.asOfDate;
    state.label = row.label;
    stateByCreativeWindow.set(stateKey, state);
  }

  return episodes;
}

function buildCalibrationCells(episodes: OutcomeEpisode[]) {
  const cells = new Map<
    string,
    Omit<
      CalibrationCell,
      "observedPositiveRate" | "averageConfidence" | "absoluteGap" | "reliability" | "positiveMeaning"
    > & { confidenceSum: number }
  >();

  for (const episode of episodes) {
    const bucket = confidenceBucket(episode.confidence);
    const key = [
      episode.businessName,
      episode.windowDays,
      episode.sourceMode,
      episode.label,
      bucket,
    ].join("::");
    const cell =
      cells.get(key) ??
      {
        businessName: episode.businessName,
        windowDays: episode.windowDays,
        sourceMode: episode.sourceMode,
        label: episode.label,
        hardClass: hardClass(episode.label),
        bucket,
        episodes: 0,
        knownEpisodes: 0,
        unknownEpisodes: 0,
        positive: 0,
        negative: 0,
        neutral: 0,
        confidenceSum: 0,
      };
    cell.episodes += 1;
    if (episode.status === "known") {
      cell.knownEpisodes += 1;
      cell.confidenceSum += episode.confidence / 100;
      if (episode.realizedOutcome === "positive") cell.positive += 1;
      if (episode.realizedOutcome === "negative") cell.negative += 1;
      if (episode.realizedOutcome === "neutral") cell.neutral += 1;
    } else if (episode.status === "unknown") {
      cell.unknownEpisodes += 1;
    }
    cells.set(key, cell);
  }

  return Array.from(cells.values())
    .map((cell): CalibrationCell => {
      const observedPositiveRate = ratio(cell.positive, cell.knownEpisodes);
      const averageConfidence = ratio(cell.confidenceSum, cell.knownEpisodes);
      return {
        businessName: cell.businessName,
        windowDays: cell.windowDays,
        sourceMode: cell.sourceMode,
        label: cell.label,
        hardClass: cell.hardClass,
        bucket: cell.bucket,
        episodes: cell.episodes,
        knownEpisodes: cell.knownEpisodes,
        unknownEpisodes: cell.unknownEpisodes,
        positive: cell.positive,
        negative: cell.negative,
        neutral: cell.neutral,
        observedPositiveRate,
        averageConfidence,
        absoluteGap:
          observedPositiveRate === null || averageConfidence === null
            ? null
            : rounded(Math.abs(observedPositiveRate - averageConfidence), 4),
        reliability:
          cell.knownEpisodes >= DEFENSIBLE_EPISODE_THRESHOLD
            ? "defensible"
            : cell.knownEpisodes >= DIRECTIONAL_EPISODE_THRESHOLD
              ? "directional"
              : "insufficient",
        positiveMeaning:
          cell.hardClass === "hard"
            ? "hard_action_supported"
            : "non_hard_missed_hard_action_proxy",
      };
    })
    .sort(
      (left, right) =>
        left.businessName.localeCompare(right.businessName) ||
        left.windowDays - right.windowDays ||
        left.sourceMode.localeCompare(right.sourceMode) ||
        decisionLabelPriority(right.label) - decisionLabelPriority(left.label) ||
        left.bucket.localeCompare(right.bucket),
    );
}

function buildCoverage(rows: DecisionOutcomeRow[], episodes: OutcomeEpisode[]) {
  const byBusiness = new Map<
    string,
    {
      businessName: string;
      firstDecisionDate: string | null;
      latestDecisionDate: string | null;
      dailyRows: number;
      episodeRows: number;
      knownEpisodes: number;
      unknownEpisodes: number;
      labels: CountMap;
      sourceModes: CountMap;
    }
  >();

  for (const row of rows) {
    const current =
      byBusiness.get(row.businessName) ??
      {
        businessName: row.businessName,
        firstDecisionDate: null,
        latestDecisionDate: null,
        dailyRows: 0,
        episodeRows: 0,
        knownEpisodes: 0,
        unknownEpisodes: 0,
        labels: {},
        sourceModes: {},
      };
    current.dailyRows += 1;
    current.firstDecisionDate =
      current.firstDecisionDate === null
        ? row.asOfDate
        : row.asOfDate < current.firstDecisionDate
          ? row.asOfDate
          : current.firstDecisionDate;
    current.latestDecisionDate =
      current.latestDecisionDate === null
        ? row.asOfDate
        : row.asOfDate > current.latestDecisionDate
          ? row.asOfDate
          : current.latestDecisionDate;
    increment(current.labels, row.label);
    increment(current.sourceModes, row.sourceMode);
    byBusiness.set(row.businessName, current);
  }

  for (const episode of episodes) {
    const current = byBusiness.get(episode.businessName);
    if (!current) continue;
    current.episodeRows += 1;
    if (episode.status === "known") current.knownEpisodes += 1;
    if (episode.status === "unknown") current.unknownEpisodes += 1;
  }

  return Array.from(byBusiness.values()).sort((left, right) =>
    left.businessName.localeCompare(right.businessName),
  );
}

function formatCountMap(map: CountMap | null | undefined) {
  if (!map || Object.keys(map).length === 0) return "-";
  return Object.entries(map)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
}

function formatPct(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function escapeCell(value: unknown) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

function renderMarkdown(input: {
  args: ParsedArgs;
  generatedAt: string;
  coverage: ReturnType<typeof buildCoverage>;
  cells: CalibrationCell[];
}) {
  const lines: string[] = [];
  lines.push("# Confidence Calibration By Source Mode - 2025-12-01 to 2026-06-20");
  lines.push("");
  lines.push(`Generated at: ${input.generatedAt}`);
  lines.push(`Engine version: \`${ENGINE_VERSION}\``);
  lines.push(`Outcome classifier: \`${CREATIVE_OUTCOME_CLASSIFIER_VERSION}\``);
  lines.push(`Decision window: ${input.args.startDate} -> ${input.args.endDate}`);
  lines.push(`Outcome evaluation ceiling: ${input.args.evaluationCeiling}`);
  lines.push("");
  lines.push("## Boundary");
  lines.push("");
  lines.push(
    "Read-only: yes. This report reads persisted current-version decision snapshots and Meta daily facts through the DB tunnel; it does not run provider writes, DB writes, migrations, resolver changes, or cron endpoints.",
  );
  lines.push("");
  lines.push(
    "This is snapshot-backed calibration, not a fresh formula replay for every historical date. If a historical day has no current-version snapshot, it is absent from this report. Source mode is derived from the snapshot lifecycle row link.",
  );
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  lines.push(
    "| Business | First decision date | Latest decision date | Closed daily rows | Episodes | Known | Unknown | Labels | Source modes |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---|---|");
  for (const row of input.coverage) {
    lines.push(
      [
        row.businessName,
        row.firstDecisionDate ?? "-",
        row.latestDecisionDate ?? "-",
        row.dailyRows,
        row.episodeRows,
        row.knownEpisodes,
        row.unknownEpisodes,
        formatCountMap(row.labels),
        formatCountMap(row.sourceModes),
      ]
        .map(escapeCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }
  lines.push("");
  lines.push("## Calibration Cells");
  lines.push("");
  lines.push(
    "Positive polarity is explicit: for hard labels, positive means the hard action proxy was supported; for non-hard labels, positive means a missed hard-action opportunity proxy. Do not pool those polarities.",
  );
  lines.push("");
  lines.push(
    "| Business | Window | Source mode | Label | Class | Bucket | Episodes | Known | Unknown | Positive | Negative | Neutral | Observed positive | Avg confidence | Abs gap | Reliability | Positive meaning |",
  );
  lines.push(
    "|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
  );
  for (const cell of input.cells) {
    lines.push(
      [
        cell.businessName,
        cell.windowDays,
        cell.sourceMode,
        cell.label,
        cell.hardClass,
        cell.bucket,
        cell.episodes,
        cell.knownEpisodes,
        cell.unknownEpisodes,
        cell.positive,
        cell.negative,
        cell.neutral,
        formatPct(cell.observedPositiveRate),
        formatPct(cell.averageConfidence),
        formatPct(cell.absoluteGap),
        cell.reliability,
        cell.positiveMeaning,
      ]
        .map(escapeCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }
  lines.push("");
  lines.push("## Evidence Limits");
  lines.push("");
  lines.push("- Current-version snapshot coverage controls the sample; absent historical snapshot days are not inferred.");
  lines.push("- Episode dedup follows the same shape as prior replay: new label run plus fresh spend after the prior episode.");
  lines.push("- Confidence gaps are descriptive calibration smoke tests, not causal proof.");
  lines.push("- Hard and non-hard positive polarity is never pooled.");
  lines.push("- Target history is not reconstructed; snapshots carry their stored effective target ROAS.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeTextFile(path: string, content: string) {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  return absolutePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  if (!process.env.DB_QUERY_TIMEOUT_MS?.trim()) {
    process.env.DB_QUERY_TIMEOUT_MS = String(args.queryTimeoutMs);
  }

  const rows = await readDecisionOutcomeRows(args);
  const episodes = collectOutcomeEpisodes(rows);
  const coverage = buildCoverage(rows, episodes);
  const cells = buildCalibrationCells(episodes);
  const generatedAt = new Date().toISOString();
  const report = {
    contractVersion: "adsecute.confidence-calibration-source-mode.v1",
    generatedAt,
    readOnly: true,
    mutatesData: false,
    manualCronPosted: false,
    providerWrites: false,
    engineVersion: ENGINE_VERSION,
    classifierVersion: CREATIVE_OUTCOME_CLASSIFIER_VERSION,
    startDate: args.startDate,
    endDate: args.endDate,
    evaluationCeiling: args.evaluationCeiling,
    businessesRequested: args.businesses,
    outcomeWindows: OUTCOME_WINDOWS,
    coverage,
    cells,
  };

  const markdown = renderMarkdown({ args, generatedAt, coverage, cells });
  if (args.writeFiles) {
    const jsonPath = writeTextFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
    const mdPath = writeTextFile(args.mdOut, markdown);
    console.log(
      JSON.stringify(
        {
          jsonPath,
          mdPath,
          dailyRows: rows.length,
          episodes: episodes.length,
          cells: cells.length,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  await resetDbClientCache();
}

withOperationalStartupLogsSilenced(main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
