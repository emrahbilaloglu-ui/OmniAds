// Read-only materiality check: how many live creatives flip winnerMemory
// when counted over disjoint bands, and does any fatigue STATUS change?
import { readFileSync } from "node:fs";
import { getDb, resetDbClientCache } from "@/lib/db";
import { computeFatigue, type HistoricalWindow } from "@/lib/creative-decision-engine/fatigue";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

const FIXTURE = process.argv[2];

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const db = getDb();
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    asOf: string;
    businesses: Array<{
      businessId: string;
      inputs: Array<Record<string, unknown>>;
      profile: { thresholds?: { winnerMemoryMinSpend?: number | null; winnerMemoryMinPurchases?: number | null } };
    }>;
  };
  let checked = 0;
  let bitFlips = 0;
  let statusDeltas = 0;
  const samples: string[] = [];
  for (const business of fixture.businesses) {
    const ids = business.inputs.map((i) => String(i.creativeId));
    if (ids.length === 0) continue;
    const rows = await db.query<Record<string, unknown>>(
      `
      SELECT creative_id,
        SUM(spend) FILTER (WHERE date > $2::date - 14) AS s14,
        SUM(conversions) FILTER (WHERE date > $2::date - 14) AS p14,
        SUM(revenue) FILTER (WHERE date > $2::date - 14) AS v14,
        SUM(spend) FILTER (WHERE date > $2::date - 30) AS s30,
        SUM(conversions) FILTER (WHERE date > $2::date - 30) AS p30,
        SUM(revenue) FILTER (WHERE date > $2::date - 30) AS v30,
        SUM(spend) FILTER (WHERE date > $2::date - 90) AS s90,
        SUM(conversions) FILTER (WHERE date > $2::date - 90) AS p90,
        SUM(revenue) FILTER (WHERE date > $2::date - 90) AS v90
      FROM meta_creative_daily
      WHERE business_ref_id::text = $1 AND creative_id = ANY($3::text[])
        AND date <= $2::date
      GROUP BY creative_id
      `,
      [business.businessId, fixture.asOf, ids],
    );
    const floors = business.profile.thresholds ?? {};
    const inputById = new Map(business.inputs.map((i) => [String(i.creativeId), i]));
    for (const row of rows) {
      const w = (s: unknown, p: unknown, v: unknown): HistoricalWindow | null => {
        const spend = Number(s ?? 0);
        if (!(spend > 0)) return null;
        const purchases = Number(p ?? 0);
        const revenue = Number(v ?? 0);
        return { spend, purchases, roas: spend > 0 ? revenue / spend : 0, ctr: 0, clickToPurchaseRate: 0 };
      };
      const input = inputById.get(String(row.creative_id));
      if (!input) continue;
      checked += 1;
      const out = computeFatigue({
        ctr: (input.ctr as number) ?? null,
        roas: (input.roas as number) ?? null,
        clickToPurchaseRate: null,
        effectiveTargetRoas: (input.targetRoas as number) ?? null,
        breakevenRoas: (input.breakEvenRoas as number) ?? null,
        winnerMemoryMinSpend: floors.winnerMemoryMinSpend ?? null,
        winnerMemoryMinPurchases: floors.winnerMemoryMinPurchases ?? null,
        historicalWindows: {
          last14: w(row.s14, row.p14, row.v14),
          last30: w(row.s30, row.p30, row.v30),
          last90: w(row.s90, row.p90, row.v90),
        },
        spendConcentration: null,
        frequency: (input.frequency as number) ?? null,
        benchmarkRoasStatus: null,
        benchmarkClickToPurchaseStatus: null,
      });
      if (out.winnerMemory !== out.disjointWinnerMemory) {
        bitFlips += 1;
        // Status changes only where winnerMemory gates the branch: fatigued
        // requires winnerMemory; watch-without-memory requires 2 decays.
        const changes =
          out.status === "fatigued" ||
          (out.status === "watch" && out.winnerMemory) ||
          (!out.winnerMemory && out.disjointWinnerMemory);
        if (changes) statusDeltas += 1;
        if (samples.length < 10) {
          samples.push(
            `${String(row.creative_id).slice(-8)} nested=${out.winnerMemory} disjoint=${out.disjointWinnerMemory} status=${out.status}`,
          );
        }
      }
    }
  }
  console.log(JSON.stringify({ checked, bitFlips, potentialStatusDeltas: statusDeltas, samples }, null, 2));
  await resetDbClientCache();
}

withOperationalStartupLogsSilenced(main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
