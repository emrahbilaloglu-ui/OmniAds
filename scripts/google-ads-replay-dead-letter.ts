import { loadEnvConfig } from "@next/env";
import { replayGoogleAdsDeadLetterPartitions } from "@/lib/google-ads/warehouse";
import type { GoogleAdsWarehouseScope } from "@/lib/google-ads/warehouse-types";

loadEnvConfig(process.cwd());

const GOOGLE_ADS_SCOPES: GoogleAdsWarehouseScope[] = [
  "account_daily",
  "campaign_daily",
  "ad_group_daily",
  "ad_daily",
  "keyword_daily",
  "search_term_daily",
  "asset_group_daily",
  "asset_daily",
  "audience_daily",
  "geo_daily",
  "device_daily",
  "product_daily",
];

async function main() {
  const businessId = process.argv[2];
  const requestedScope = process.argv[3] ?? null;
  const startDate = process.argv[4] ?? null;
  const endDate = process.argv[5] ?? startDate;
  if (!businessId) {
    console.error(
      "usage: node --import tsx scripts/google-ads-replay-dead-letter.ts <businessId> [scope] [startDate] [endDate]"
    );
    process.exit(1);
  }

  const result = await replayGoogleAdsDeadLetterPartitions({
    businessId,
    scope:
      requestedScope && GOOGLE_ADS_SCOPES.includes(requestedScope as GoogleAdsWarehouseScope)
        ? (requestedScope as GoogleAdsWarehouseScope)
        : null,
    startDate,
    endDate,
    recoveryKinds: ["replayable_transient", "unknown"],
  });

  console.log(
    JSON.stringify(
      {
        businessId,
        scope: requestedScope,
        startDate,
        endDate,
        outcome: result.outcome,
        replayedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
        rows: result.partitions,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
