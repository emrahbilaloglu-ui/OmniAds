import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MetaAccountDailyRow, MetaAdDailyRow, MetaAdSetDailyRow,
  MetaCampaignDailyRow, MetaWarehouseBaseRow } from "./warehouse-types";

export const META_CORE_CAPTURE_FINGERPRINT_VERSION = "meta-core-capture.v3";

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

/** Equality of two partial JSON objects is not a complete capture proof. */
export function isMetaCoreCaptureReplayProof(value: unknown, scope: {
  businessId: string; providerAccountId: string; day: string; sourceRunId: string;
}): boolean {
  const object = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  const core = object(value);
  if (!core || core.version !== META_CORE_CAPTURE_FINGERPRINT_VERSION ||
      Object.entries(scope).some(([key,v]) => core[key] !== v) ||
      typeof core.requestFields !== "string" ||
      !core.requestFields.split(",").map(s=>s.trim()).includes("actions") ||
      typeof core.rowsFetchedTotal !== "number" || !Number.isSafeInteger(core.rowsFetchedTotal) ||
      core.rowsFetchedTotal < 0 || !Array.isArray(core.pages) || core.pages.length === 0) return false;
  let count = 0;
  const ids = new Set<string>();
  for (const [index,value] of core.pages.entries()) {
    const p = object(value);
    if (!p || p.pageIndex !== index || typeof p.snapshotId !== "string" || !p.snapshotId ||
        ids.has(p.snapshotId) || typeof p.rowCount !== "number" || !Number.isSafeInteger(p.rowCount) ||
        p.rowCount < 0 || p.hasNext !== (index < core.pages.length-1) ||
        p.providerHttpStatus !== 200 || p.status !== "fetched" || p.requestFields !== core.requestFields) return false;
    ids.add(p.snapshotId); count += p.rowCount;
  }
  if (count !== core.rowsFetchedTotal) return false;
  const replay = object(core.replayContent);
  const hashes = object(replay?.surfaceFactFingerprints);
  const surfaces = ["account_daily","campaign_daily","adset_daily","ad_daily"];
  const validHashes = (h: Record<string,unknown> | null) => h !== null &&
    Object.keys(h).length === surfaces.length && surfaces.every(s=>
      typeof h[s] === "string" && /^[a-f0-9]{64}$/.test(h[s]));
  if (!replay || !validHashes(hashes) || !validHashes(object(core.surfaceFactFingerprints))) return false;
  return isDeepStrictEqual(replay, {version:core.version,businessId:core.businessId,
    providerAccountId:core.providerAccountId,day:core.day,requestFields:core.requestFields,
    pages:core.pages,rowsFetchedTotal:core.rowsFetchedTotal,surfaceFactFingerprints:hashes});
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
  const replayFactFingerprints: Record<string, string> = {};
  for (const [surface, rows, rowId] of rowSets) {
    const ids = rows.map(rowId);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length ||
        rows.some((row) => row.businessId !== input.businessId ||
          row.providerAccountId !== input.providerAccountId || row.date !== input.day ||
          row.sourceRunId !== input.sourceRunId || !row.sourceSnapshotId ||
          !pageSnapshotIds.has(row.sourceSnapshotId))) return null;
    const facts = rows.map((row) => {
      // Capture/observation clocks are not changed decision facts. Preserve
      // configuration values, raw payload-derived values, and source identity.
      const fact = { ...row } as Record<string, unknown>;
      delete fact.createdAt;
      delete fact.updatedAt;
      delete fact.finalizedAt;
      delete fact.configObservedAt;
      return fact;
    }).sort((left, right) => String(rowId(left as unknown as MetaWarehouseBaseRow))
      .localeCompare(String(rowId(right as unknown as MetaWarehouseBaseRow))));
    surfaceFactFingerprints[surface] = fingerprint({
      version: META_CORE_CAPTURE_FINGERPRINT_VERSION,
      businessId: input.businessId, providerAccountId: input.providerAccountId,
      day: input.day, sourceRunId: input.sourceRunId, surface, facts,
    });
    // A different fetch attempt does not replace an unchanged publication.
    // Keep the exact raw page IDs and ALL normalized facts. Only the new run
    // identity belongs to the observation, rather than to the retained source.
    const replayFacts = facts.map(({ sourceRunId: _sourceRunId, ...fact }) => fact);
    replayFactFingerprints[surface] = fingerprint({
      version: META_CORE_CAPTURE_FINGERPRINT_VERSION,
      businessId: input.businessId, providerAccountId: input.providerAccountId,
      day: input.day, surface, facts: replayFacts,
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
    replayContent: {
      version: META_CORE_CAPTURE_FINGERPRINT_VERSION,
      businessId: input.businessId, providerAccountId: input.providerAccountId,
      day: input.day, requestFields: input.requestFields, pages,
      rowsFetchedTotal: input.rowsFetchedTotal,
      surfaceFactFingerprints: replayFactFingerprints,
    },
  };
}
