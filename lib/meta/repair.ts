import { resolveMetaCredentials } from "@/lib/api/meta";
import { createMetaFinalizationCompletenessProof } from "@/lib/meta/finalization-proof";
import {
  rebuildAccountRowsFromCampaignRows,
  repairAdSetRowsFromSnapshots,
  repairCampaignRowsFromSnapshots,
} from "@/lib/meta/serving";
import {
  getMetaAccountDailyRange,
  getMetaAdSetDailyRange,
  getMetaCampaignDailyRange,
  replaceMetaAccountDailySlice,
  replaceMetaAdSetDailySlice,
  replaceMetaCampaignDailySlice,
} from "@/lib/meta/warehouse";
import type {
  MetaAccountDailyRow,
  MetaAdSetDailyRow,
  MetaCampaignDailyRow,
} from "@/lib/meta/warehouse-types";

function changedCampaignRow(next: MetaCampaignDailyRow, prev?: MetaCampaignDailyRow) {
  return (
    !prev ||
    next.objective !== prev.objective ||
    next.optimizationGoal !== prev.optimizationGoal ||
    next.bidStrategyType !== prev.bidStrategyType ||
    next.bidStrategyLabel !== prev.bidStrategyLabel ||
    next.manualBidAmount !== prev.manualBidAmount ||
    next.bidValue !== prev.bidValue ||
    next.bidValueFormat !== prev.bidValueFormat ||
    next.dailyBudget !== prev.dailyBudget ||
    next.lifetimeBudget !== prev.lifetimeBudget
  );
}

function changedAdSetRow(next: MetaAdSetDailyRow, prev?: MetaAdSetDailyRow) {
  return (
    !prev ||
    next.optimizationGoal !== prev.optimizationGoal ||
    next.bidStrategyType !== prev.bidStrategyType ||
    next.bidStrategyLabel !== prev.bidStrategyLabel ||
    next.manualBidAmount !== prev.manualBidAmount ||
    next.bidValue !== prev.bidValue ||
    next.bidValueFormat !== prev.bidValueFormat ||
    next.dailyBudget !== prev.dailyBudget ||
    next.lifetimeBudget !== prev.lifetimeBudget
  );
}

function changedAccountRow(next: MetaAccountDailyRow, prev?: MetaAccountDailyRow) {
  return (
    !prev ||
    next.spend !== prev.spend ||
    next.revenue !== prev.revenue ||
    next.conversions !== prev.conversions ||
    next.impressions !== prev.impressions ||
    next.clicks !== prev.clicks ||
    next.reach !== prev.reach ||
    next.roas !== prev.roas ||
    next.cpa !== prev.cpa ||
    next.ctr !== prev.ctr ||
    next.cpc !== prev.cpc
  );
}

export async function repairMetaWarehouseTruthRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
}) {
  const [accountRows, campaignRows, adsetRows, credentials] = await Promise.all([
    getMetaAccountDailyRange(input),
    getMetaCampaignDailyRange(input),
    getMetaAdSetDailyRange(input),
    resolveMetaCredentials(input.businessId).catch(() => null),
  ]);
  const existingAccountRows = accountRows ?? [];
  const [repairedCampaignRows, repairedAdSetRows] = await Promise.all([
    repairCampaignRowsFromSnapshots({
      businessId: input.businessId,
      rows: campaignRows,
    }),
    repairAdSetRowsFromSnapshots({
      businessId: input.businessId,
      rows: adsetRows,
    }),
  ]);
  const repairedAccountRows = rebuildAccountRowsFromCampaignRows({
    campaignRows: repairedCampaignRows,
    existingAccountRows,
    accountProfiles: credentials?.accountProfiles ?? null,
  });

  const campaignBySlice = new Map<string, MetaCampaignDailyRow[]>();
  for (const row of repairedCampaignRows) {
    const key = `${row.businessId}:${row.providerAccountId}:${row.date}`;
    const list = campaignBySlice.get(key);
    if (list) list.push(row);
    else campaignBySlice.set(key, [row]);
  }
  for (const rows of campaignBySlice.values()) {
    const sample = rows[0]!;
    await replaceMetaCampaignDailySlice({
      rows,
      // Repair replays HISTORICAL days. The config payload carried on these
      // rows is the account's current inventory, so appending it as config
      // history would stamp today's configuration onto every repaired date —
      // the same amplification the backfill path suppresses. Metrics and
      // dimension enrichment are unaffected.
      appendConfigHistory: false,
      proof: createMetaFinalizationCompletenessProof({
        businessId: sample.businessId,
        providerAccountId: sample.providerAccountId,
        date: sample.date,
        scope: "campaign",
        sourceRunId: sample.sourceRunId ?? `repair:${sample.providerAccountId}:${sample.date}`,
        complete: rows.length > 0,
        validationStatus: "passed",
      }),
    });
  }

  const adsetBySlice = new Map<string, MetaAdSetDailyRow[]>();
  for (const row of repairedAdSetRows) {
    const key = `${row.businessId}:${row.providerAccountId}:${row.date}`;
    const list = adsetBySlice.get(key);
    if (list) list.push(row);
    else adsetBySlice.set(key, [row]);
  }
  for (const rows of adsetBySlice.values()) {
    const sample = rows[0]!;
    await replaceMetaAdSetDailySlice({
      rows,
      // Same as the campaign slice above: a repaired historical day must not
      // inherit today's adset configuration as its history.
      appendConfigHistory: false,
      proof: createMetaFinalizationCompletenessProof({
        businessId: sample.businessId,
        providerAccountId: sample.providerAccountId,
        date: sample.date,
        scope: "adset",
        sourceRunId: sample.sourceRunId ?? `repair:${sample.providerAccountId}:${sample.date}`,
        complete: rows.length > 0,
        validationStatus: "passed",
      }),
    });
  }

  for (const row of repairedAccountRows) {
    await replaceMetaAccountDailySlice({
      rows: [row],
      proof: createMetaFinalizationCompletenessProof({
        businessId: row.businessId,
        providerAccountId: row.providerAccountId,
        date: row.date,
        scope: "account",
        sourceRunId: row.sourceRunId ?? `repair:${row.providerAccountId}:${row.date}`,
        complete: true,
        validationStatus: "passed",
      }),
    });
  }

  return {
    accountRowsScanned: existingAccountRows.length,
    campaignRowsScanned: campaignRows.length,
    adsetRowsScanned: adsetRows.length,
    accountRowsChanged: repairedAccountRows.filter((row) => {
      const prev = existingAccountRows.find(
        (candidate) =>
          candidate.providerAccountId === row.providerAccountId &&
          candidate.date === row.date,
      );
      return changedAccountRow(row, prev);
    }).length,
    campaignRowsChanged: repairedCampaignRows.filter((row, index) =>
      changedCampaignRow(row, campaignRows[index]),
    ).length,
    adsetRowsChanged: repairedAdSetRows.filter((row, index) =>
      changedAdSetRow(row, adsetRows[index]),
    ).length,
  };
}
