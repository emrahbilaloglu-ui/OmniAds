#!/usr/bin/env node
// Automatic Campaign Context shadow harness + historical evaluation.
//
// Read-only phase per DECISION_LOG D033 and
// docs/creative-decision-center/AUTOMATIC_CAMPAIGN_CONTEXT_SPEC_2026-07-06.md:
// script-local deterministic resolver, no production consumption, no DB writes,
// no migrations, no provider writes. Existing meta_campaign_labels rows are
// evaluation truth only, never runtime truth.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDb, resetDbClientCache } from "@/lib/db";
import { normalizePostgresDate } from "@/lib/creative-decision-engine/simulation/calendar-date";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

export {
  CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  DEFAULT_CONTEXT_CONFIG,
  FEATURE_WINDOW_DAYS,
  applyHysteresisSequence,
  campaignFamilyKey,
  classifyCampaignContext,
  computeFamilyInheritance,
  computeSignalScores,
} from "@/lib/creative-decision-engine/campaign-context/resolver";
export type {
  CampaignFeatures,
  CampaignKind,
  ContextConfidenceClass,
  ContextResolution,
  ContextResolverConfig,
  FamilyInheritanceInput,
  FamilyInheritanceOutcome,
  HysteresisResult,
  SignalFamilyScores,
} from "@/lib/creative-decision-engine/campaign-context/resolver";
import {
  CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  DEFAULT_CONTEXT_CONFIG,
  FEATURE_WINDOW_DAYS,
  applyHysteresisSequence,
  campaignFamilyKey,
  classifyCampaignContext,
  computeFamilyInheritance,
  type CampaignKind,
  type ContextResolution,
} from "@/lib/creative-decision-engine/campaign-context/resolver";
import {
  buildCampaignContextFeatures,
  computeCampaignLineage,
  readCampaignContextCampaignMeta,
  readCampaignContextCreativeDays,
  type CampaignMetaRow,
  type CreativeDayRow,
  type LineageStats,
} from "@/lib/creative-decision-engine/campaign-context/data";
import {
  applyDailyHysteresis,
  type HysteresisState,
} from "@/lib/creative-decision-engine/jobs/campaign-context-job";

const DEFAULT_BUSINESSES = ["IwaStore", "EMOLOS", "Grandmix", "TheSwaf"];
const DEFAULT_START_DATE = "2026-06-01";
const DEFAULT_END_DATE = "2026-07-05";
const DEFAULT_JSON_OUT =
  "docs/creative-decision-center/generated/automatic-campaign-context-shadow-2026-06-01-to-2026-07-05.json";
const DEFAULT_MD_OUT =
  "docs/creative-decision-center/AUTOMATIC_CAMPAIGN_CONTEXT_SHADOW_2026-06-01_TO_2026-07-05.md";
const SPOT_CHECK_TARGET = 15;

// ---------------------------------------------------------------------------
// DB harness (read-only)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface ParsedArgs {
  startDate: string;
  endDate: string;
  businesses: string[];
  jsonOut: string;
  mdOut: string;
  writeFiles: boolean;
  queryTimeoutMs: number;
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

function parseArgs(argv: string[]): ParsedArgs {
  return {
    startDate: arg(argv, "startDate", DEFAULT_START_DATE),
    endDate: arg(argv, "endDate", DEFAULT_END_DATE),
    businesses: csvArg(argv, "businesses") ?? DEFAULT_BUSINESSES,
    jsonOut: arg(argv, "jsonOut", DEFAULT_JSON_OUT),
    mdOut: arg(argv, "mdOut", DEFAULT_MD_OUT),
    writeFiles: arg(argv, "write", "1") !== "0",
    queryTimeoutMs: Math.max(1_000, Number(arg(argv, "queryTimeoutMs", "120000")) || 120_000),
  };
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

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

interface LabelRow {
  campaignId: string;
  campaignKind: CampaignKind;
  campaignName: string | null;
}

interface BusinessScope {
  id: string;
  name: string;
}

async function readBusinessScope(names: string[]): Promise<BusinessScope[]> {
  const rows = await getDb().query<Row>(
    `
    SELECT id::text AS id, name
    FROM businesses
    WHERE lower(name) = ANY($1::text[])
    ORDER BY name ASC
    `,
    [names.map((name) => name.toLowerCase())],
  );
  return rows.map((row) => ({
    id: toText(row.id) ?? "",
    name: toText(row.name) ?? "",
  }));
}

async function readLabels(businessId: string): Promise<LabelRow[]> {
  const rows = await getDb().query<Row>(
    `
    SELECT campaign_id, campaign_kind, campaign_name
    FROM meta_campaign_labels
    WHERE business_id = $1
    `,
    [businessId],
  );
  return rows
    .map((row) => ({
      campaignId: toText(row.campaign_id) ?? "",
      campaignKind: (toText(row.campaign_kind) ?? "") as CampaignKind,
      campaignName: toText(row.campaign_name),
    }))
    .filter((row) => row.campaignId && ["main", "test", "mixed"].includes(row.campaignKind));
}

interface GuardImpactRow {
  campaignId: string | null;
  blockedRows: number;
}

async function readGuardImpact(
  businessId: string,
  engineVersion: string,
): Promise<{ asOfDate: string | null; rows: GuardImpactRow[] }> {
  const rows = await getDb().query<Row>(
    `
    WITH latest AS (
      SELECT MAX(as_of_date) AS as_of_date
      FROM engine_v3_decision_snapshots_daily
      WHERE business_ref_id::text = $1 AND engine_version = $2
    ),
    blocked AS (
      SELECT s.creative_id, s.as_of_date
      FROM engine_v3_decision_snapshots_daily s, latest
      WHERE s.business_ref_id::text = $1
        AND s.engine_version = $2
        AND s.as_of_date = latest.as_of_date
        AND s.badges @> '[{"type":"unlabeled_campaign_context"}]'::jsonb
        AND s.label = 'diagnose'
        AND (s.reason LIKE '[Unlabeled campaign%' OR s.reason LIKE '[Stop-loss review%')
    ),
    campaign_map AS (
      SELECT DISTINCT ON (b.creative_id)
        b.creative_id,
        b.as_of_date,
        d.campaign_id
      FROM blocked b
      LEFT JOIN meta_creative_daily d
        ON (d.business_ref_id::text = $1 OR d.business_id = $1)
       AND d.creative_id = b.creative_id
       AND d.campaign_id IS NOT NULL
       AND d.date <= b.as_of_date
      ORDER BY b.creative_id, d.date DESC
    )
    SELECT
      (SELECT as_of_date::text FROM latest) AS as_of_date,
      campaign_id,
      COUNT(*)::integer AS blocked_rows
    FROM campaign_map
    GROUP BY campaign_id
    ORDER BY blocked_rows DESC
    `,
    [businessId, engineVersion],
  );
  const asOfDate = rows.length > 0 ? normalizePostgresDate(rows[0].as_of_date) : null;
  return {
    asOfDate,
    rows: rows.map((row) => ({
      campaignId: toText(row.campaign_id),
      blockedRows: toNumber(row.blocked_rows),
    })),
  };
}

function buildAsOfGrid(
  startDate: string,
  endDate: string,
  stepDays: number,
): string[] {
  const grid: string[] = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    grid.push(cursor);
    cursor = addDays(cursor, stepDays);
  }
  if (grid[grid.length - 1] !== endDate) grid.push(endDate);
  return grid;
}

function writeTextFile(path: string, content: string) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const args = parseArgs(process.argv.slice(2));
  process.env.DB_QUERY_TIMEOUT_MS = String(args.queryTimeoutMs);
  const generatedAt = new Date().toISOString();
  const engineVersion = "v3-2026-07-02-math-guardrails";
  // Daily grid matches production cadence (the context job runs daily);
  // weekly remains available for quick approximations.
  const gridStepDays =
    arg(process.argv.slice(2), "gridMode", "daily") === "weekly" ? 7 : 1;
  const asOfGrid = buildAsOfGrid(args.startDate, args.endDate, gridStepDays);
  const rangeStart = addDays(args.startDate, -(FEATURE_WINDOW_DAYS - 1));

  const businesses = await readBusinessScope(args.businesses);
  const businessReports: Row[] = [];

  for (const business of businesses) {
    const [creativeDays, meta, labels, guardImpact] = [
      await readCampaignContextCreativeDays(business.id, rangeStart, args.endDate),
      await readCampaignContextCampaignMeta(business.id, args.endDate),
      await readLabels(business.id),
      await readGuardImpact(business.id, engineVersion),
    ];
    const lineage = computeCampaignLineage(creativeDays);

    const sequences = new Map<
      string,
      Array<{ asOf: string; resolution: ContextResolution }>
    >();
    for (const asOf of asOfGrid) {
      const features = buildCampaignContextFeatures({
        rows: creativeDays,
        meta,
        lineage,
        asOf,
      });
      for (const feature of features) {
        const resolution = classifyCampaignContext(feature, DEFAULT_CONTEXT_CONFIG);
        const sequence = sequences.get(feature.campaignId) ?? [];
        sequence.push({ asOf, resolution });
        sequences.set(feature.campaignId, sequence);
      }
    }

    const finalFeatures = buildCampaignContextFeatures({
      rows: creativeDays,
      meta,
      lineage,
      asOf: args.endDate,
    });
    const featureById = new Map(finalFeatures.map((f) => [f.campaignId, f]));
    const labelById = new Map(labels.map((l) => [l.campaignId, l]));

    const campaigns = [...sequences.entries()].map(([campaignId, sequence]) => {
      const last = sequence[sequence.length - 1].resolution;
      // Production hysteresis (applyDailyHysteresis from the context job),
      // chained causally over the grid, with the full per-date sequence
      // persisted so adjacent-date flips are auditable. The previous
      // analysis-only applyHysteresisSequence skipped null resolutions
      // (pinning stale kinds through conflict/unknown) and used lookahead;
      // its outputs must not be used for flip decisions.
      let hysteresisState: HysteresisState | null = null;
      let suppressedDays = 0;
      let publishedFlips = 0;
      let rawFlips = 0;
      let previousPublishedKind: CampaignKind | null = null;
      let previousRawKind: CampaignKind | null = null;
      const perDate = sequence.map((item, index) => {
        const outcome = applyDailyHysteresis(
          hysteresisState,
          item.resolution.kind,
          item.resolution.confidenceClass,
        );
        hysteresisState = outcome.state;
        if (outcome.suppressedFlip) suppressedDays += 1;
        if (index > 0 && outcome.publishedKind !== previousPublishedKind) {
          publishedFlips += 1;
        }
        if (index > 0 && item.resolution.kind !== previousRawKind) {
          rawFlips += 1;
        }
        previousPublishedKind = outcome.publishedKind;
        previousRawKind = item.resolution.kind;
        return {
          asOf: item.asOf,
          rawKind: item.resolution.kind,
          rawClass: item.resolution.confidenceClass,
          publishedKind: outcome.publishedKind,
          publishedClass: outcome.publishedClass,
          suppressedFlip: outcome.suppressedFlip,
        };
      });
      const lastPerDate = perDate[perDate.length - 1];
      const hysteresis = {
        finalKind: lastPerDate?.publishedKind ?? null,
        finalClass: lastPerDate?.publishedClass ?? ("unknown" as const),
        publishedFlips,
        rawFlips,
        suppressedDays,
        finalDivergence:
          (lastPerDate?.publishedKind ?? null) !== (lastPerDate?.rawKind ?? null),
        perDate,
      };
      const ablation = featureById.has(campaignId)
        ? classifyCampaignContext(featureById.get(campaignId)!, DEFAULT_CONTEXT_CONFIG, {
            includeLineage: false,
          })
        : null;
      const label = labelById.get(campaignId) ?? null;
      return {
        campaignId,
        campaignName: last.campaignName,
        final: last,
        kindBasis: "behavioral" as "behavioral" | "family_inheritance",
        hysteresis,
        evaluationsSeen: sequence.length,
        withoutLineage: ablation
          ? { kind: ablation.kind, confidenceClass: ablation.confidenceClass }
          : null,
        manualLabel: label ? label.campaignKind : null,
      };
    });

    // Cold-start/family inheritance post-pass (main/mixed only; never test).
    const inheritance = computeFamilyInheritance(
      campaigns.map((c) => ({
        campaignId: c.campaignId,
        familyKey: campaignFamilyKey(c.campaignName),
        kind: c.final.kind,
        confidenceClass: c.final.confidenceClass,
      })),
    );
    for (const outcome of inheritance) {
      const target = campaigns.find((c) => c.campaignId === outcome.campaignId);
      if (!target) continue;
      target.final = {
        ...target.final,
        kind: outcome.inheritedKind,
        confidenceClass: "medium",
        evidence: [
          ...target.final.evidence,
          `family_prefix_inheritance basis=${outcome.basisMembers} members`,
        ],
      };
      target.kindBasis = "family_inheritance";
    }

    // Evaluation vs manual labels (exact integer counts). Labeled campaigns
    // that no longer clear evidence floors in the final window are "dormant":
    // for them, unknown is the correct conservative outcome, not a miss, so
    // they are reported separately instead of polluting active accuracy.
    const labeled = campaigns.filter((c) => c.manualLabel !== null);
    const evalRows = labeled.map((c) => {
      const feature = featureById.get(c.campaignId);
      const activeInWindow =
        (feature?.spend28 ?? 0) >= DEFAULT_CONTEXT_CONFIG.floors.minSpend28 &&
        (feature?.activeDays ?? 0) >= DEFAULT_CONTEXT_CONFIG.floors.minActiveDays;
      return {
        campaignId: c.campaignId,
        campaignName: c.campaignName,
        manual: c.manualLabel,
        inferredKind: c.final.kind,
        inferredClass: c.final.confidenceClass,
        activeInWindow,
        agree: c.final.kind === c.manualLabel,
        agreeWithoutLineage: c.withoutLineage
          ? c.withoutLineage.kind === c.manualLabel
          : null,
      };
    });
    const activeEvalRows = evalRows.filter((r) => r.activeInWindow);
    const dormantLabeled = evalRows.filter((r) => !r.activeInWindow);
    const highEval = evalRows.filter((r) => r.inferredClass === "high");
    const falseTestHigh = evalRows.filter(
      (r) => r.inferredClass === "high" && r.inferredKind === "test" && r.manual !== "test",
    );
    const falseTestAny = evalRows.filter(
      (r) => r.inferredKind === "test" && r.manual !== "test",
    );

    // Spot-check package: high-confidence unlabeled campaigns, extended with
    // medium rows so sparse-label accounts (EMOLOS-class) are reviewable.
    const spotCheck = campaigns
      .filter(
        (c) =>
          c.manualLabel === null &&
          (c.final.confidenceClass === "high" || c.final.confidenceClass === "medium"),
      )
      .sort((a, b) => {
        const classRank = (cls: string) => (cls === "high" ? 0 : 1);
        const rankDiff =
          classRank(a.final.confidenceClass) - classRank(b.final.confidenceClass);
        if (rankDiff !== 0) return rankDiff;
        return (
          (featureById.get(b.campaignId)?.spend28 ?? 0) -
          (featureById.get(a.campaignId)?.spend28 ?? 0)
        );
      })
      .slice(0, SPOT_CHECK_TARGET)
      .map((c) => ({
        campaignId: c.campaignId,
        campaignName: c.campaignName,
        inferredKind: c.final.kind,
        confidenceClass: c.final.confidenceClass,
        kindBasis: c.kindBasis,
        confidenceScore: c.final.confidenceScore,
        spend28: featureById.get(c.campaignId)?.spend28 ?? 0,
        evidence: c.final.evidence,
      }));

    // Guard impact (APPROXIMATE: snapshots lack campaign columns; join is via
    // latest meta_creative_daily campaign_id per creative).
    const guardByCampaign = guardImpact.rows.map((row) => {
      const campaign = row.campaignId
        ? campaigns.find((c) => c.campaignId === row.campaignId) ?? null
        : null;
      return {
        campaignId: row.campaignId,
        campaignName: campaign?.campaignName ?? null,
        blockedRows: row.blockedRows,
        inferredKind: campaign?.final.kind ?? null,
        inferredClass: campaign?.final.confidenceClass ?? null,
      };
    });
    const unlockableRows = guardByCampaign
      .filter((row) => row.inferredClass === "high")
      .reduce((sum, row) => sum + row.blockedRows, 0);
    const totalBlockedRows = guardByCampaign.reduce(
      (sum, row) => sum + row.blockedRows,
      0,
    );

    const classCounts: Record<string, number> = {};
    for (const c of campaigns) {
      const key = `${c.final.kind ?? "unknown"}/${c.final.confidenceClass}`;
      classCounts[key] = (classCounts[key] ?? 0) + 1;
    }

    businessReports.push({
      business: business.name,
      businessId: business.id,
      campaignsEvaluated: campaigns.length,
      classCounts,
      lineageStats: {
        totalCreatives: lineage.totalCreatives,
        multiCampaignCreatives: lineage.multiCampaignCreatives,
        visibleLineageCoverage:
          lineage.totalCreatives > 0
            ? round4(lineage.multiCampaignCreatives / lineage.totalCreatives)
            : null,
      },
      flipSummary: {
        campaignsWithPublishedFlips: campaigns.filter(
          (c) => c.hysteresis.publishedFlips > 0,
        ).length,
        campaignsWithRawFlips: campaigns.filter((c) => c.hysteresis.rawFlips > 0)
          .length,
        campaignsWithSuppressedDays: campaigns.filter(
          (c) => c.hysteresis.suppressedDays > 0,
        ).length,
        campaignsWithFinalDivergence: campaigns.filter(
          (c) => c.hysteresis.finalDivergence,
        ).length,
        totalPublishedFlips: campaigns.reduce(
          (sum, c) => sum + c.hysteresis.publishedFlips,
          0,
        ),
        totalRawFlips: campaigns.reduce(
          (sum, c) => sum + c.hysteresis.rawFlips,
          0,
        ),
      },
      evaluation: {
        labeledCampaigns: labeled.length,
        activeLabeledCampaigns: activeEvalRows.length,
        dormantLabeledCampaigns: dormantLabeled.length,
        agreeExactAll: `${evalRows.filter((r) => r.agree).length}/${evalRows.length}`,
        agreeExactActive: `${activeEvalRows.filter((r) => r.agree).length}/${activeEvalRows.length}`,
        highConfidenceExact: `${highEval.filter((r) => r.agree).length}/${highEval.length}`,
        falseTestHighExact: `${falseTestHigh.length}/${highEval.length}`,
        falseTestAnyExact: `${falseTestAny.length}/${evalRows.length}`,
        withoutLineageAgreeExact: `${activeEvalRows.filter((r) => r.agreeWithoutLineage === true).length}/${activeEvalRows.filter((r) => r.agreeWithoutLineage !== null).length}`,
        rows: evalRows,
      },
      grandfatheringTable: evalRows,
      spotCheck,
      guardImpact: {
        approximate: true,
        note: "snapshots lack campaign columns; joined via latest meta_creative_daily campaign_id per creative",
        snapshotAsOf: guardImpact.asOfDate,
        totalBlockedHardRows: totalBlockedRows,
        blockedRowsUnderHighConfidenceContext: unlockableRows,
        byCampaign: guardByCampaign,
      },
      campaigns: campaigns.map((c) => ({
        campaignId: c.campaignId,
        campaignName: c.campaignName,
        inferredKind: c.final.kind,
        kindBasis: c.kindBasis,
        confidenceClass: c.final.confidenceClass,
        confidenceScore: c.final.confidenceScore,
        testScore: c.final.testScore,
        mainScore: c.final.mainScore,
        mixedScore: c.final.mixedScore,
        agreeingFamilies: c.final.agreeingFamilies,
        conflictReasons: c.final.conflictReasons,
        hysteresis: c.hysteresis,
        withoutLineage: c.withoutLineage,
        manualLabel: c.manualLabel,
        spend28: featureById.get(c.campaignId)?.spend28 ?? 0,
      })),
    });
  }

  const report = {
    title:
      "Automatic Campaign Context Shadow Evaluation - 2026-06-01 to 2026-07-05",
    generatedAt,
    resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    engineVersion,
    readOnly: true,
    dbWrites: false,
    providerWrites: false,
    productionConsumption: false,
    notProductionApproval: true,
    startDate: args.startDate,
    endDate: args.endDate,
    asOfGrid,
    featureWindowDays: FEATURE_WINDOW_DAYS,
    config: DEFAULT_CONTEXT_CONFIG,
    businesses: businessReports,
    evidenceLimits: [
      "This is a read-only shadow evaluation. It is NOT production approval; no resolver, guard, DB, or UI consumption changed.",
      "Manual labels are evaluation truth only; label coverage is sparse and uneven (EMOLOS-like accounts need the spot-check package).",
      "Creative lineage visibility is capped by warehouse first-non-null campaign attribution; same-day multi-campaign reuse is invisible, so visibleLineageCoverage understates true reuse.",
      "Guard-impact numbers are APPROXIMATE: decision snapshots do not persist campaign ids; the join uses the latest meta_creative_daily campaign per creative.",
      "Campaign names come from meta_campaign_daily as of the data ceiling; historical renames are not versioned here.",
      "Hysteresis uses the production applyDailyHysteresis function chained causally over the asOf grid; run with the default daily grid for production-cadence fidelity (gridMode=weekly is an approximation).",
      "Per-campaign perDate sequences (raw and published kind/class per asOf) are persisted so adjacent-date flips are auditable; earlier artifacts without perDate cannot support flip claims.",
    ],
  };

  const markdown = renderMarkdown(report);
  if (args.writeFiles) {
    const jsonPath = writeTextFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
    const mdPath = writeTextFile(args.mdOut, markdown);
    console.log(JSON.stringify({ jsonPath, mdPath, businesses: businessReports.length }, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  await resetDbClientCache();
}

function renderMarkdown(report: Record<string, unknown>): string {
  const lines: string[] = [];
  const businesses = report.businesses as Row[];
  lines.push(`# ${report.title as string}`);
  lines.push("");
  lines.push(
    "Read-only shadow evaluation of the Automatic Campaign Context Resolver (D033). This report is NOT production approval: no resolver behavior, guard behavior, DB state, provider state, or UI consumption changed.",
  );
  lines.push("");
  lines.push("## Live Status");
  lines.push("");
  lines.push(`- generatedAt: ${report.generatedAt as string}`);
  lines.push(`- resolverVersion: ${report.resolverVersion as string}`);
  lines.push(`- engineVersion (guard-impact join): ${report.engineVersion as string}`);
  lines.push(
    `- window: ${report.startDate as string} .. ${report.endDate as string}, feature window ${report.featureWindowDays as number}d, asOf grid: ${(report.asOfGrid as string[]).length} dates`,
  );
  lines.push("- source: live_db_read_only; tables: meta_creative_daily, meta_campaign_daily, meta_campaign_labels, engine_v3_decision_snapshots_daily, businesses");
  lines.push("");
  for (const business of businesses) {
    lines.push(`## ${business.business as string}`);
    lines.push("");
    lines.push(`- campaigns evaluated: ${business.campaignsEvaluated as number}`);
    lines.push(`- class counts: ${JSON.stringify(business.classCounts)}`);
    const lineage = business.lineageStats as Row;
    lines.push(
      `- lineage: ${lineage.multiCampaignCreatives as number}/${lineage.totalCreatives as number} creatives visibly multi-campaign (coverage ${String(lineage.visibleLineageCoverage)})`,
    );
    const flips = business.flipSummary as Row;
    lines.push(
      `- hysteresis (production applyDailyHysteresis, causal): raw flips on ${flips.campaignsWithRawFlips as number} campaigns (${flips.totalRawFlips as number} total), published flips on ${flips.campaignsWithPublishedFlips as number} campaigns (${flips.totalPublishedFlips as number} total), ${flips.campaignsWithSuppressedDays as number} campaigns with suppressed days, ${flips.campaignsWithFinalDivergence as number} with final published!=raw divergence`,
    );
    const evaluation = business.evaluation as Row;
    lines.push("");
    lines.push("### Evaluation vs manual labels (exact counts)");
    lines.push("");
    lines.push(
      `- labeled campaigns: ${evaluation.labeledCampaigns as number} (active in final window: ${evaluation.activeLabeledCampaigns as number}, dormant: ${evaluation.dormantLabeledCampaigns as number})`,
    );
    lines.push(
      `- active-labeled agreement: ${evaluation.agreeExactActive as string} (dormant labeled campaigns resolve to unknown by design and are excluded)`,
    );
    lines.push(`- all-labeled agreement (context only): ${evaluation.agreeExactAll as string}`);
    lines.push(`- high-confidence agreement: ${evaluation.highConfidenceExact as string}`);
    lines.push(`- false-Test (high confidence): ${evaluation.falseTestHighExact as string}`);
    lines.push(`- false-Test (any class): ${evaluation.falseTestAnyExact as string}`);
    lines.push(`- without-lineage active agreement (ablation): ${evaluation.withoutLineageAgreeExact as string}`);
    lines.push("");
    lines.push("### Grandfathering table (manual vs inferred)");
    lines.push("");
    lines.push("| Campaign | Manual | Inferred | Class | Window | Agree |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const row of evaluation.rows as Row[]) {
      const windowState = row.activeInWindow ? "active" : "dormant";
      const agreeText = row.activeInWindow ? (row.agree ? "yes" : "NO") : "n/a (dormant)";
      lines.push(
        `| ${(row.campaignName as string | null) ?? row.campaignId} | ${row.manual as string} | ${(row.inferredKind as string | null) ?? "unknown"} | ${row.inferredClass as string} | ${windowState} | ${agreeText} |`,
      );
    }
    lines.push("");
    const spotCheck = business.spotCheck as Row[];
    lines.push(`### Spot-check package (${spotCheck.length} unlabeled campaigns, high+medium)`);
    lines.push("");
    lines.push("| Campaign | Inferred | Class | Basis | Score | Spend28 | Evidence |");
    lines.push("| --- | --- | --- | --- | ---: | ---: | --- |");
    for (const row of spotCheck) {
      lines.push(
        `| ${(row.campaignName as string | null) ?? row.campaignId} | ${row.inferredKind as string} | ${row.confidenceClass as string} | ${row.kindBasis as string} | ${row.confidenceScore as number} | ${Math.round(row.spend28 as number)} | ${(row.evidence as string[]).join("; ")} |`,
      );
    }
    lines.push("");
    const guard = business.guardImpact as Row;
    lines.push("### Guard impact (APPROXIMATE)");
    lines.push("");
    lines.push(`- snapshot asOf: ${String(guard.snapshotAsOf)}`);
    lines.push(`- guard-blocked hard rows: ${guard.totalBlockedHardRows as number}`);
    lines.push(
      `- blocked rows under high-confidence inferred context (potential unlock candidates, subject to remaining guards and user approval gates): ${guard.blockedRowsUnderHighConfidenceContext as number}`,
    );
    lines.push(`- note: ${guard.note as string}`);
    lines.push("");
  }
  lines.push("## Evidence Limits");
  lines.push("");
  for (const limit of report.evidenceLimits as string[]) {
    lines.push(`- ${limit}`);
  }
  lines.push("");
  return lines.join("\n");
}

const isDirectExecution =
  process.argv[1]?.includes("automatic-campaign-context-shadow") ?? false;
if (isDirectExecution) {
  withOperationalStartupLogsSilenced(main).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
