import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decideCreative,
  resolveAccountDecisionProfile,
  ENGINE_VERSION,
} from "@/lib/creative-decision-engine";
import {
  applyCreativeCampaignLabelGuard,
  buildCreativeCampaignLabelMap,
  withCreativeCampaignLabelContext,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";

const BUSINESSES: Record<string, string> = {
  TheSwaf: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  IwaStore: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2",
};

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (typeof v === "object") {
    s = JSON.stringify(v);
  } else {
    s = String(v);
  }
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmt(value: unknown, decimals = 2): string {
  if (value === null || value === undefined) return "";
  const n = typeof value === "number" ? value : parseFloat(String(value));
  if (Number.isNaN(n)) return "";
  return n.toFixed(decimals);
}

async function main() {
  const asOf = new Date().toISOString().slice(0, 10);
  const dataSource = new WarehouseDataSource();
  const allRows: Array<Record<string, unknown>> = [];

  for (const [name, id] of Object.entries(BUSINESSES)) {
    console.log(`[live] ${name} (${id})...`);
    const flags = await resolveEngineV3Flags(id);
    const profile = await resolveAccountDecisionProfile({
      businessId: id,
      asOf,
      dataSource,
      flags,
    });
    const dataHealth = await dataSource.getDataHealth({
      businessId: id,
      asOf,
    });

    const inputs = await dataSource.listCreativeInputs({
      businessId: id,
      asOf,
    });
    const campaignIds = Array.from(
      new Set(
        inputs
          .map((input) => input.campaignId?.trim() || "")
          .filter(Boolean),
      ),
    );
    const campaignLabelsById = buildCreativeCampaignLabelMap(
      campaignIds.length > 0
        ? await readMetaCampaignLabels({
            businessId: id,
            campaignIds,
          })
        : [],
    );

    console.log(`  ${inputs.length} creative inputs`);
    let labelCount = 0;
    for (const input of inputs) {
      const inputWithCampaignKind = withCreativeCampaignLabelContext(
        input,
        campaignLabelsById,
      );
      const decision = applyCreativeCampaignLabelGuard({
        decision: decideCreative(inputWithCampaignKind, profile, dataHealth),
        input: inputWithCampaignKind,
        campaignLabelsById,
      });
      allRows.push({
        business: name,
        creative_id: input.creativeId,
        creative_name: input.creativeName ?? "",
        campaign_kind: decision.campaignKind,
        campaign_label_status: decision.campaignLabelStatus,
        decision_kind_source: decision.decisionKindSource,
        label_transform: decision.labelTransform,
        blocked_action_type: decision.blockedActionType,
        v3_label: decision.label,
        v3_reason: decision.reason,
        v3_confidence: decision.confidence,
        v3_truth_source: decision.truthSource,
        v3_effective_target_roas: decision.effectiveTargetRoas,
        v3_ratio_to_target: decision.ratioToTarget,
        v3_badges: decision.badges,
      });
      labelCount++;
    }
    console.log(`  → ${labelCount} live decisions`);
  }

  const baseDir = resolve(process.cwd(), "_analysis/phase-5");
  const headers = [
    "business",
    "creative_id",
    "creative_name",
    "campaign_kind",
    "campaign_label_status",
    "decision_kind_source",
    "label_transform",
    "blocked_action_type",
    "v3_label",
    "v3_reason",
    "v3_confidence",
    "v3_truth_source",
    "v3_effective_target_roas",
    "v3_ratio_to_target",
    "v3_badges",
  ];
  const csv = [headers.join(",")];
  for (const row of allRows) {
    csv.push(headers.map((c) => csvCell(row[c])).join(","));
  }
  writeFileSync(resolve(baseDir, "02-v3-decisions.csv"), csv.join("\n") + "\n");

  // Stats
  const dist: Record<string, number> = {};
  for (const r of allRows) {
    dist[String(r.v3_label)] = (dist[String(r.v3_label)] ?? 0) + 1;
  }
  console.log(`\nEngine version: ${ENGINE_VERSION}`);
  console.log("Live label distribution:");
  for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  // Below-breakeven badge counter
  let belowBE = 0;
  for (const r of allRows) {
    const badges = r.v3_badges as Array<{ type: string }>;
    if (Array.isArray(badges) && badges.some((b) => b.type === "below_breakeven")) {
      belowBE++;
    }
  }
  console.log(`Below-breakeven badge count: ${belowBE}`);
  console.log(`[live] wrote ${baseDir}/02-v3-decisions.csv (${allRows.length} rows)`);
}

main().catch((err) => {
  console.error("ERROR:", err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
