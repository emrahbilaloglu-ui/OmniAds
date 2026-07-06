#!/usr/bin/env node
// Day-2 hysteresis dry run (read-only).
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/creative-decision-center/day2-hysteresis-dry-run.ts [--asOf=YYYY-MM-DD]
//
// Simulates tomorrow's production chaining against TODAY'S live persisted
// state, exercising the exact code paths and DB seams the in-memory replay
// could not: readPreviousPublishedLabels reading the persisted raw_label
// snapshots, and parseHysteresisState reading persisted
// hysteresis_state_json. Nothing is written; the output reports what the
// next wave WOULD publish if metrics held, plus seam health checks.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  applyCreativeCampaignLabelGuard,
  buildCreativeCampaignLabelMap,
  withCreativeCampaignLabelContext,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
import { decideCreative } from "@/lib/creative-decision-engine/engine";
import {
  readPreviousPublishedLabels,
  stabilizeDecisionLabel,
} from "@/lib/creative-decision-engine/decision-stability";
import { listEnabledBusinessIds } from "@/lib/creative-decision-engine/feature-flags";
import { resolveAccountDecisionProfile } from "@/lib/creative-decision-engine/account-decision-profile";
import { parseHysteresisState } from "@/lib/creative-decision-engine/jobs/campaign-context-job";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

type Row = Record<string, unknown>;

function arg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  return (
    process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ??
    fallback
  );
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const today = arg("asOf", new Date().toISOString().slice(0, 10));
  const tomorrow = addDays(today, 1);
  const db = getDb();
  const source = new WarehouseDataSource();
  const businessIds = await listEnabledBusinessIds();

  const perBusiness: Row[] = [];
  let totalDecisions = 0;
  let totalWithMemory = 0;
  let totalWouldSuppress = 0;
  let totalMemoryRawLabels = 0;
  const suppressionSamples: Row[] = [];
  const contextSeamSamples: Row[] = [];
  let contextStatesParsed = 0;
  let contextStatesWithCounters = 0;

  for (const businessId of businessIds) {
    const nameRow = await db.query<Row>(
      `SELECT name FROM businesses WHERE id::text = $1`,
      [businessId],
    );
    const businessName = String(nameRow[0]?.name ?? businessId);

    // --- Decision-label seam: production reader against live snapshots ---
    const inputs = await source.listCreativeInputs({
      businessId,
      asOf: tomorrow,
    });
    const campaignLabelsById = buildCreativeCampaignLabelMap(
      await readMetaCampaignLabels({ businessId }),
    );
    const profile = await resolveAccountDecisionProfile({
      businessId,
      asOf: tomorrow,
      dataSource: source,
    });
    const dataHealth = await source.getDataHealth({
      businessId,
      asOf: tomorrow,
    });
    const previous = await readPreviousPublishedLabels({
      businessId,
      asOf: tomorrow,
      creativeIds: inputs.map((input: { creativeId: string }) => input.creativeId),
    });
    const memoryWithRaw = [...previous.values()].filter(
      (item) => item.rawLabel !== null,
    ).length;

    let wouldSuppress = 0;
    for (const creativeInput of inputs) {
      const enriched = withCreativeCampaignLabelContext(
        creativeInput,
        campaignLabelsById,
      );
      const guarded = applyCreativeCampaignLabelGuard({
        decision: decideCreative(enriched, profile, dataHealth),
        input: enriched,
        campaignLabelsById,
      });
      const stabilized = stabilizeDecisionLabel(
        guarded,
        previous.get(creativeInput.creativeId) ?? null,
      );
      if (stabilized.suppressed) {
        wouldSuppress += 1;
        if (suppressionSamples.length < 25) {
          suppressionSamples.push({
            business: businessName,
            creativeId: creativeInput.creativeId,
            previousPublished:
              previous.get(creativeInput.creativeId)?.publishedLabel ?? null,
            previousRaw: previous.get(creativeInput.creativeId)?.rawLabel ?? null,
            rawToday: stabilized.rawLabel,
            wouldPublish: stabilized.decision.label,
          });
        }
      }
    }

    // --- Context seam: persisted hysteresis_state_json through the
    // production parser ---
    const contextRows = await db.query<Row>(
      `
      SELECT campaign_id, inferred_kind, confidence_class, hysteresis_state_json
      FROM engine_v3_campaign_context_daily
      WHERE business_id = $1 AND as_of_date = $2::date
      `,
      [businessId, today],
    );
    let parsedCount = 0;
    let counterCount = 0;
    for (const row of contextRows) {
      const state = parseHysteresisState(row.hysteresis_state_json);
      parsedCount += 1;
      if (
        (state.graceDaysUsed ?? 0) > 0 ||
        (state.pendingConflictCount ?? 0) > 0 ||
        state.pendingCount > 0 ||
        state.stableClass !== null
      ) {
        counterCount += 1;
      }
      if (contextSeamSamples.length < 10 && state.stableKind !== null) {
        contextSeamSamples.push({
          business: businessName,
          campaignId: row.campaign_id,
          persistedKind: row.inferred_kind,
          parsedState: state,
        });
      }
    }
    contextStatesParsed += parsedCount;
    contextStatesWithCounters += counterCount;

    perBusiness.push({
      business: businessName,
      inputs: inputs.length,
      previousLabelMemory: previous.size,
      memoryWithRawLabel: memoryWithRaw,
      wouldSuppressTomorrow: wouldSuppress,
      contextStatesToday: parsedCount,
    });
    totalDecisions += inputs.length;
    totalWithMemory += previous.size;
    totalMemoryRawLabels += memoryWithRaw;
    totalWouldSuppress += wouldSuppress;
  }

  const report = {
    title: `Day-2 hysteresis dry run - simulated asOf ${tomorrow} against live state of ${today}`,
    generatedAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    readOnly: true,
    dbWrites: false,
    providerWrites: false,
    caveat:
      "Projection: uses data available now (today's warehouse rows) as tomorrow's inputs. Real day-2 metrics will differ; the point is proving the persisted-state seams and chaining, not predicting labels.",
    seams: {
      decisionLabelMemory: {
        pass: totalWithMemory > 0 && totalMemoryRawLabels > 0,
        detail: `readPreviousPublishedLabels returned ${totalWithMemory} previous labels (${totalMemoryRawLabels} with raw_label) from today's persisted snapshots via the production reader/version key.`,
      },
      contextStateRoundTrip: {
        pass: contextStatesParsed > 0,
        detail: `parseHysteresisState parsed ${contextStatesParsed} persisted context states; ${contextStatesWithCounters} carry non-default counters/class (full-field round-trip live).`,
      },
    },
    totals: {
      businesses: businessIds.length,
      decisionInputs: totalDecisions,
      previousLabelMemory: totalWithMemory,
      memoryWithRawLabel: totalMemoryRawLabels,
      wouldSuppressTomorrowIfMetricsHeld: totalWouldSuppress,
    },
    perBusiness,
    suppressionSamples,
    contextSeamSamples,
    evidenceLimits: [
      "Read-only projection; no rows written, no jobs triggered.",
      "Tomorrow's inputs are approximated by today's warehouse state; the suppression count is a lower-bound sanity signal, not a forecast.",
      "Decision seam proof = non-empty previous-label memory including raw_label through the production reader; context seam proof = persisted hysteresis_state_json parsing through the production parser.",
    ],
  };

  const outPath = resolve(
    `docs/creative-decision-center/generated/day2-hysteresis-dry-run-${tomorrow}.json`,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { outPath, seams: report.seams, totals: report.totals },
      null,
      2,
    ),
  );
  await resetDbClientCache();
}

withOperationalStartupLogsSilenced(main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
