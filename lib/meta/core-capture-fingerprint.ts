import { createHash } from "node:crypto";
import type { MetaAccountDailyRow, MetaAdDailyRow, MetaAdSetDailyRow,
  MetaCampaignDailyRow, MetaWarehouseBaseRow } from "./warehouse-types";

export const META_CORE_CAPTURE_FINGERPRINT_VERSION = "meta-core-capture.v2";

export type MetaCorePageEvidence = {
  pageIndex: number;
  snapshotId: string;
  rowCount: number;
  hasNext: boolean;
  providerHttpStatus: number;
  status: string;
  requestFields: string;
};

/** Keep the exact raw page for each Ad; ambiguous duplicate IDs have no single-page proof. */
export function recordMetaAdPageSourceSnapshots(
  sourceByAdId: Map<string, string | null>,
  rows: readonly { ad_id?: string | null }[],
  snapshotId: string,
) {
  for (const row of rows) {
    const adId = row.ad_id;
    if (!adId) continue;
    sourceByAdId.set(adId, sourceByAdId.has(adId) ? null : snapshotId);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** A complete ordered Graph capture plus every normalized Ad fact it produced. */
export function buildMetaCoreCaptureFingerprint(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  sourceRunId: string;
  requestFields: string;
  pages: readonly MetaCorePageEvidence[];
  rowsFetchedTotal: number;
  accountRows: readonly MetaAccountDailyRow[];
  campaignRows: readonly MetaCampaignDailyRow[];
  adsetRows: readonly MetaAdSetDailyRow[];
  adRows: readonly MetaAdDailyRow[];
}) {
  const pages = input.pages;
  if (!input.businessId || !input.providerAccountId || !input.day || !input.sourceRunId ||
      !input.requestFields.split(",").map((field) => field.trim()).includes("actions") ||
      pages.length === 0 || !Number.isSafeInteger(input.rowsFetchedTotal) ||
      input.rowsFetchedTotal < 0 ||
      pages.reduce((total, page) => total + page.rowCount, 0) !== input.rowsFetchedTotal ||
      pages.some((page, index) => page.pageIndex !== index || !page.snapshotId ||
        !Number.isSafeInteger(page.rowCount) || page.rowCount < 0 ||
        page.hasNext !== (index < pages.length - 1) ||
        page.providerHttpStatus !== 200 || page.status !== "fetched" ||
        page.requestFields !== input.requestFields)) return null;

  const pageSnapshotIds = new Set(pages.map((page) => page.snapshotId));
  if (pageSnapshotIds.size !== pages.length) return null;
  const rowSets: Array<[string, readonly MetaWarehouseBaseRow[], (row: MetaWarehouseBaseRow) => string]> = [
    ["account_daily", input.accountRows, () => input.providerAccountId],
    ["campaign_daily", input.campaignRows, (row) => (row as MetaCampaignDailyRow).campaignId],
    ["adset_daily", input.adsetRows, (row) => (row as MetaAdSetDailyRow).adsetId],
    ["ad_daily", input.adRows, (row) => (row as MetaAdDailyRow).adId],
  ];
  if (input.accountRows.length !== 1) return null;
  const surfaceFactFingerprints: Record<string, string> = {};
  for (const [surface, rows, rowId] of rowSets) {
    const ids = rows.map(rowId);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length ||
        rows.some((row) => row.businessId !== input.businessId ||
          row.providerAccountId !== input.providerAccountId || row.date !== input.day ||
          row.sourceRunId !== input.sourceRunId || !row.sourceSnapshotId ||
          !pageSnapshotIds.has(row.sourceSnapshotId))) return null;
    const facts = rows.map((row) => {
      // Capture clocks are not source facts. Preserve every other field,
      // including configuration, raw payload-derived values, and source identity.
      const fact = { ...row } as Record<string, unknown>;
      delete fact.createdAt;
      delete fact.updatedAt;
      delete fact.finalizedAt;
      return fact;
    }).sort((left, right) => String(rowId(left as unknown as MetaWarehouseBaseRow))
      .localeCompare(String(rowId(right as unknown as MetaWarehouseBaseRow))));
    surfaceFactFingerprints[surface] = fingerprint({
      version: META_CORE_CAPTURE_FINGERPRINT_VERSION,
      businessId: input.businessId, providerAccountId: input.providerAccountId,
      day: input.day, sourceRunId: input.sourceRunId, surface, facts,
    });
  }
  return {
    version: META_CORE_CAPTURE_FINGERPRINT_VERSION,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    day: input.day,
    sourceRunId: input.sourceRunId,
    requestFields: input.requestFields,
    pages,
    rowsFetchedTotal: input.rowsFetchedTotal,
    surfaceFactFingerprints,
  };
}
