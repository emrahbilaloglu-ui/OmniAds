#!/usr/bin/env node
// Automatic-mode decision diff (read-only).
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/creative-decision-center/automatic-mode-decision-diff.ts [--asOf=YYYY-MM-DD]
//
// The last missing evidence for the CAMPAIGN_CONTEXT_MODE=automatic flip:
// computes today's decisions twice through the production path - once with
// legacy manual labels, once with the resolver's published campaign context
// (mode "automatic", including user overrides) - and diffs the guarded
// labels. Answers "if automatic mode were on today, which decisions change,
// and in which direction". Nothing is written.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  applyCreativeCampaignLabelGuard,
  buildCreativeCampaignLabelMap,
  withCreativeCampaignLabelContext,
  type CreativeCampaignLabelMap,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import { readCampaignContextLabelMap } from "@/lib/creative-decision-engine/campaign-context/source";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
import { decideCreative } from "@/lib/creative-decision-engine/engine";
import { listEnabledBusinessIds } from "@/lib/creative-decision-engine/feature-flags";
import { resolveAccountDecisionProfile } from "@/lib/creative-decision-engine/account-decision-profile";
import { ENGINE_VERSION, type DecisionLabel } from "@/lib/creative-decision-engine/types";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

type Row = Record<string, unknown>;

const HARD_LABELS: ReadonlySet<DecisionLabel> = new Set(["cut", "scale"]);

function arg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  return (
    process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ??
    fallback
  );
}

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const asOf = arg("asOf", new Date().toISOString().slice(0, 10));
  const db = getDb();
  const source = new WarehouseDataSource();
  const businessIds = await listEnabledBusinessIds();

  const perBusiness: Row[] = [];
  const changedSamples: Row[] = [];
  const transitionCounts: Record<string, number> = {};
  let totalDecisions = 0;
  let totalChanged = 0;
  let hardToSofter = 0;
  let softerToHard = 0;

  for (const businessId of businessIds) {
    const nameRow = await db.query<Row>(
      `SELECT name FROM businesses WHERE id::text = $1`,
      [businessId],
    );
    const businessName = String(nameRow[0]?.name ?? businessId);

    const inputs = await source.listCreativeInputs({ businessId, asOf });
    const campaignIds = [
      ...new Set(
        inputs
          .map((input) => input.campaignId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    const legacyMap: CreativeCampaignLabelMap = buildCreativeCampaignLabelMap(
      await readMetaCampaignLabels({ businessId }),
    );
    const automaticMap = await readCampaignContextLabelMap({
      businessId,
      campaignIds,
      asOf,
      mode: "automatic",
    });
    const profile = await resolveAccountDecisionProfile({
      businessId,
      asOf,
      dataSource: source,
    });
    const dataHealth = await source.getDataHealth({ businessId, asOf });

    let changed = 0;
    for (const creativeInput of inputs) {
      const decideUnder = (map: CreativeCampaignLabelMap) => {
        const enriched = withCreativeCampaignLabelContext(creativeInput, map);
        return applyCreativeCampaignLabelGuard({
          decision: decideCreative(enriched, profile, dataHealth),
          input: enriched,
          campaignLabelsById: map,
        });
      };
      const legacy = decideUnder(legacyMap);
      const automatic = decideUnder(automaticMap);
      totalDecisions += 1;
      if (legacy.label === automatic.label) continue;
      changed += 1;
      totalChanged += 1;
      const key = `${legacy.label}->${automatic.label}`;
      transitionCounts[key] = (transitionCounts[key] ?? 0) + 1;
      const legacyHard = HARD_LABELS.has(legacy.label);
      const automaticHard = HARD_LABELS.has(automatic.label);
      if (legacyHard && !automaticHard) hardToSofter += 1;
      if (!legacyHard && automaticHard) softerToHard += 1;
      if (changedSamples.length < 40) {
        changedSamples.push({
          business: businessName,
          creativeId: creativeInput.creativeId,
          campaignId: creativeInput.campaignId,
          spend: creativeInput.spend,
          legacyLabel: legacy.label,
          automaticLabel: automatic.label,
          legacyKind: legacy.campaignKind ?? null,
          automaticKind: automatic.campaignKind ?? null,
          automaticReason: automatic.reason.slice(0, 160),
        });
      }
    }
    perBusiness.push({
      business: businessName,
      decisions: inputs.length,
      changed,
    });
  }

  const report = {
    title: `Automatic-mode decision diff - live inputs of ${asOf}`,
    generatedAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    readOnly: true,
    dbWrites: false,
    providerWrites: false,
    modeCompared: "legacy_labels (production today) vs automatic (resolver-published kinds + user overrides)",
    totals: {
      businesses: businessIds.length,
      decisions: totalDecisions,
      changed: totalChanged,
      changedShare: totalDecisions > 0 ? totalChanged / totalDecisions : 0,
      hardToSofter,
      softerToHard,
    },
    transitionCounts,
    perBusiness,
    changedSamples,
    evidenceLimits: [
      "Read-only projection over today's live inputs through the production decide+guard path; no rows written.",
      "hardToSofter changes are the conservative direction (guard demotes on weaker context); softerToHard changes deserve individual review before the flip.",
      "The diff reflects the context table as of asOf; user overrides present in manual labels win in automatic mode by design.",
    ],
  };

  const outPath = resolve(
    `docs/creative-decision-center/generated/automatic-mode-decision-diff-${asOf}.json`,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        outPath,
        totals: report.totals,
        transitionCounts,
        perBusiness: perBusiness.filter((row) => Number(row.changed) > 0),
      },
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
