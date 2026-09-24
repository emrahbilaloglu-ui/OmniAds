/**
 * Reconcile versioned creative days with their published, finalized Ad-day
 * source, then add action evidence. Dry run is the default. Only the listed
 * economics and evidence keys change; identity, config, media and raw source
 * rows remain untouched.
 *
 * node --import tsx scripts/meta/creative-day-source-evidence-repair.ts \
 *   --business <uuid> --account act_<id> --from YYYY-MM-DD --to YYYY-MM-DD \
 *   [--manifest-out path] [--apply --expected-manifest-hash sha256]
 * Apply additionally requires ADSECUTE_CREATIVE_DAY_REPAIR_APPLY=1.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { getDb, runDbTransaction } from "@/lib/db";
import {
  buildMetaCreativeDayMetricEvidence,
  META_CREATIVE_DAY_METRIC_EVIDENCE_KEY,
  mergeMetaCreativeDayMetricEvidence,
  readMetaCreativeDayMetricEvidence,
  readMetaCreativeDayStageValue,
} from "@/lib/meta/creative-day-metric-evidence";
import {
  buildMetaCreativeDayPurchaseEvidence,
  META_CREATIVE_DAY_PURCHASE_EVIDENCE_KEY,
  mergeMetaCreativeDayPurchaseEvidence,
} from "@/lib/meta/creative-day-purchase-evidence";
import { META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION } from "@/lib/meta/creatives-types";
import { getMetaAdDailyRange, getMetaCreativeDailyRange } from "@/lib/meta/warehouse";
import type { MetaAdDailyRow, MetaCreativeDailyRow } from "@/lib/meta/warehouse-types";
import { configureOperationalScriptRuntime } from "../_operational-runtime";

const CONTRACT = "adsecute.meta-creative-day-source-evidence-repair.v1";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}
const hash = (value: unknown) => createHash("sha256")
  .update(JSON.stringify(stable(value))).digest("hex");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const finite = (value: unknown): number | null => {
  const number = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const same = (a: unknown, b: unknown) => hash(a) === hash(b);

type Scope = { businessId: string; accountId: string; from: string; to: string };
type Snapshot = {
  id: string; business_id: string; provider_account_id: string;
  endpoint_name: string; start_date: string; end_date: string;
  entity_scope: string; status: string; provider_http_status: number | null; payload_hash: string;
  payload_json: unknown; fetched_at: string; request_context: unknown;
};
type Receipt = {
  day: string; published_by_run_id: string; published_at: string | null;
  slice_source_run_id: string; slice_state: string; slice_truth_state: string;
  slice_validation_status: string; slice_status: string; staged_row_count: number | null;
  manifest_fetch_status: string; manifest_account_timezone: string;
  manifest_completed_at: string | null;
};
type RepairInputs = Scope & {
  creativeRows: MetaCreativeDailyRow[]; adRows: MetaAdDailyRow[];
  snapshots: Snapshot[]; receipts: Receipt[];
};
type Scalars = {
  spend: number; impressions: number; clicks: number; reach: number;
  frequency: number | null; conversions: number; revenue: number;
  roas: number; cpa: number | null; ctr: number | null;
  cpc: number | null; linkClicks: number | null;
};
type PlannedChange = {
  creativeId: string; day: string; oldPayloadHash: string;
  oldUpdatedAt: string; oldPayload: Record<string, unknown>;
  nextPayload: Record<string, unknown>;
  old: Scalars; next: Scalars;
  source: Array<{ adId: string; snapshotId: string; payloadHash: string;
    sourceRunId: string; fetchedAt: string }>;
  reason: "evidence_only" | "finalized_ad_day_restatement";
};

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--apply") { apply = true; continue; }
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || values.has(key)) {
      throw new Error(`invalid_argument:${key ?? "missing"}`);
    }
    values.set(key, value);
    i += 1;
  }
  const businessId = values.get("--business") ?? "";
  const accountId = values.get("--account") ?? "";
  const from = values.get("--from") ?? "";
  const to = values.get("--to") ?? "";
  if (!/^[a-f0-9-]{36}$/i.test(businessId) || !/^act_\d+$/.test(accountId) ||
      !DATE.test(from) || !DATE.test(to) || from > to ||
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 > 30) {
    throw new Error("creative_day_repair_scope_invalid_or_over_31_days");
  }
  const expectedManifestHash = values.get("--expected-manifest-hash") ?? null;
  if (apply && (!/^[a-f0-9]{64}$/.test(expectedManifestHash ?? "") ||
      process.env.ADSECUTE_CREATIVE_DAY_REPAIR_APPLY !== "1")) {
    throw new Error("creative_day_repair_apply_guard_missing");
  }
  return { businessId, accountId, from, to, apply, expectedManifestHash,
    manifestOut: values.get("--manifest-out") ?? null };
}

function memberIds(row: MetaCreativeDailyRow): string[] | null {
  const payload = record(row.payloadJson);
  if (payload.source_identity_version !== META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION ||
      payload.source_ad_ids_complete !== true ||
      !Array.isArray(payload.source_ad_ids) ||
      !Array.isArray(payload.source_creative_ids) ||
      payload.source_creative_ids.length !== 1 || payload.source_creative_ids[0] !== row.creativeId) return null;
  const ids = payload.source_ad_ids;
  if (ids.length === 0 || ids.some((id) => typeof id !== "string" || !id.trim()) ||
      new Set(ids).size !== ids.length || payload.associated_ads_count !== ids.length) return null;
  return ids as string[];
}

function verifiedReceipt(receipt: Receipt | undefined, day: string,
  accountTimezone: string, sourceRunId: string) {
  return receipt?.day === day && receipt.published_by_run_id === sourceRunId &&
    receipt.slice_source_run_id === sourceRunId && receipt.slice_state === "finalized_verified" &&
    receipt.slice_truth_state === "finalized" && receipt.slice_validation_status === "passed" &&
    receipt.slice_status === "published" && receipt.manifest_fetch_status === "completed" &&
    receipt.manifest_account_timezone === accountTimezone &&
    receipt.manifest_completed_at != null && receipt.published_at != null;
}

export function buildCreativeDaySourceEvidenceRepairPlan(input: RepairInputs) {
  const ads = new Map(input.adRows.map((row) => [`${row.date}|${row.adId}`, row]));
  const snapshots = new Map(input.snapshots.map((row) => [row.id, row]));
  const receipts = new Map(input.receipts.map((row) => [row.day, row]));
  const dayAdCounts = new Map<string, number>();
  for (const ad of input.adRows) dayAdCounts.set(ad.date, (dayAdCounts.get(ad.date) ?? 0) + 1);
  const changes: PlannedChange[] = [];
  const blockers: Array<{ day: string; creativeId: string; reason: string }> = [];
  const candidates = input.creativeRows.filter((row) => row.businessId === input.businessId &&
    row.providerAccountId === input.accountId && row.date >= input.from && row.date <= input.to &&
    (row.spend > 0 || row.impressions > 0 || row.clicks > 0 ||
      row.conversions > 0 || row.revenue > 0) &&
    record(row.payloadJson).source_identity_version ===
      META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION)
    .sort((a, b) => a.date.localeCompare(b.date) || a.creativeId.localeCompare(b.creativeId));
  for (const row of candidates) {
    const fail = (reason: string) => blockers.push({ day: row.date, creativeId: row.creativeId, reason });
    if (!row.updatedAt || !Number.isFinite(Date.parse(row.updatedAt))) {
      fail("creative_day_updated_at_missing"); continue;
    }
    const ids = memberIds(row);
    if (!ids) { fail("creative_membership_unverified"); continue; }
    const receipt = receipts.get(row.date);
    if (!receipt || receipt.staged_row_count !== dayAdCounts.get(row.date) ||
        input.adRows.some((ad) => ad.date === row.date &&
          (ad.sourceRunId !== receipt.published_by_run_id ||
            ad.truthState !== "finalized" || ad.validationStatus !== "passed"))) {
      fail("published_ad_day_receipt_incomplete"); continue;
    }
    const members: Array<{ ad: MetaAdDailyRow; raw: Record<string, unknown>; snapshot: Snapshot }> = [];
    for (const id of ids) {
      const ad = ads.get(`${row.date}|${id}`);
      const snapshot = ad?.sourceSnapshotId ? snapshots.get(ad.sourceSnapshotId) : null;
      const requestContext = record(snapshot?.request_context);
      const requestedFields = requestContext.fields;
      const actionsRequested = !Object.hasOwn(requestContext, "fields") ||
        (typeof requestedFields === "string" &&
          requestedFields.split(",").map((field) => field.trim()).includes("actions"));
      if (!ad || !snapshot || ad.businessId !== input.businessId ||
          ad.providerAccountId !== input.accountId || ad.truthState !== "finalized" ||
          ad.validationStatus !== "passed" || !ad.finalizedAt || !ad.sourceRunId ||
          !verifiedReceipt(receipt, row.date, ad.accountTimezone, ad.sourceRunId) ||
          snapshot.business_id !== input.businessId ||
          snapshot.provider_account_id !== input.accountId ||
          snapshot.endpoint_name !== "ad_insights_bulk" || snapshot.entity_scope !== "ad" ||
          snapshot.status !== "fetched" ||
          snapshot.provider_http_status !== 200 || !snapshot.payload_hash ||
          snapshot.start_date !== row.date || snapshot.end_date !== row.date ||
          requestContext.level !== "ad" || requestContext.source !== "bulk_core_sync" ||
          !actionsRequested ||
          !Number.isFinite(Date.parse(snapshot.fetched_at)) ||
          !Number.isFinite(Date.parse(receipt.published_at ?? "")) ||
          Date.parse(snapshot.fetched_at) > Date.parse(receipt.published_at ?? "") ||
          !Array.isArray(snapshot.payload_json)) {
        fail(`ad_source_receipt_invalid:${id}`); break;
      }
      const rawRows = snapshot.payload_json.filter((candidate) => {
        const raw = record(candidate);
        return raw.ad_id === id && raw.date_start === row.date;
      });
      if (rawRows.length !== 1) { fail(`raw_ad_membership_invalid:${id}`); break; }
      const raw = record(rawRows[0]);
      const adPayload = record(ad.payloadJson);
      if (!same(raw.actions ?? null, adPayload.actions ?? null) ||
          !same(raw.action_values ?? null, adPayload.action_values ?? null) ||
          finite(raw.spend) !== ad.spend || finite(raw.impressions) !== ad.impressions ||
          finite(raw.clicks) !== ad.clicks) {
        fail(`raw_ad_fact_conflict:${id}`); break;
      }
      const purchase = buildMetaCreativeDayPurchaseEvidence(raw.actions,
        { completeActionsRequest: true });
      if (purchase.state !== "measured" || purchase.value !== ad.conversions) {
        fail(`raw_purchase_conflicts_with_finalized_ad:${id}`); break;
      }
      members.push({ ad, raw, snapshot });
    }
    if (members.length !== ids.length) continue;
    const sum = (get: (ad: MetaAdDailyRow) => number) =>
      members.reduce((total, member) => total + get(member.ad), 0);
    const spend = sum((ad) => ad.spend);
    const impressions = sum((ad) => ad.impressions);
    const clicks = sum((ad) => ad.clicks);
    const reach = sum((ad) => ad.reach);
    const conversions = sum((ad) => ad.conversions);
    const revenue = sum((ad) => ad.revenue);
    const purchaseParts = members.map(({ raw }) =>
      buildMetaCreativeDayPurchaseEvidence(raw.actions, { completeActionsRequest: true }));
    const purchaseEvidence = purchaseParts.slice(1).reduce(
      (merged, part) => mergeMetaCreativeDayPurchaseEvidence(merged, part), purchaseParts[0]!);
    if (purchaseEvidence.state !== "measured" || purchaseEvidence.value !== conversions) {
      fail("group_purchase_evidence_incomplete"); continue;
    }
    const metricParts = members.map(({ raw }) =>
      buildMetaCreativeDayMetricEvidence(raw, { completeActionsRequest: true }));
    const rebuiltMetric = metricParts.slice(1).reduce(
      (merged, part) => mergeMetaCreativeDayMetricEvidence(merged, part), metricParts[0]!);
    const oldPayload = record(row.payloadJson);
    const oldMetric = readMetaCreativeDayMetricEvidence(oldPayload);
    const metricEvidence = oldMetric?.stages.outbound_click.state === "measured"
      ? { ...rebuiltMetric, stages: { ...rebuiltMetric.stages,
          outbound_click: oldMetric.stages.outbound_click } }
      : rebuiltMetric;
    const stage = (name: "link_click" | "landing_page_view" | "add_to_cart" | "initiate_checkout") =>
      readMetaCreativeDayStageValue({ [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: metricEvidence }, name);
    const linkClicks = stage("link_click");
    const lpv = stage("landing_page_view");
    const atc = stage("add_to_cart");
    const checkout = stage("initiate_checkout");
    const frequency = members.length === 1 && Number.isFinite(members[0]!.ad.frequency)
      ? members[0]!.ad.frequency : null;
    const next: Scalars = {
      spend, impressions, clicks, reach, frequency, conversions, revenue,
      roas: spend > 0 ? revenue / spend : 0,
      cpa: conversions > 0 ? spend / conversions : null,
      ctr: impressions > 0 ? clicks / impressions * 100 : null,
      cpc: linkClicks != null && linkClicks > 0 ? spend / linkClicks : null,
      linkClicks,
    };
    const old: Scalars = {
      spend: row.spend, impressions: row.impressions, clicks: row.clicks,
      reach: row.reach, frequency: row.frequency, conversions: row.conversions,
      revenue: row.revenue, roas: row.roas, cpa: row.cpa, ctr: row.ctr,
      cpc: row.cpc ?? null, linkClicks: row.linkClicks ?? null,
    };
    const presence = record(oldPayload.metric_presence);
    const nextPayload = {
      ...oldPayload,
      spend, impressions, clicks, reach, frequency, purchases: conversions,
      purchase_value: revenue, roas: next.roas, cpa: next.cpa,
      ctr_all: next.ctr, cpc_link: next.cpc,
      cpm: impressions > 0 ? spend / impressions * 1000 : null,
      link_clicks: linkClicks,
      landing_page_views: lpv, add_to_cart: atc, initiate_checkout: checkout,
      atc_to_purchase: atc != null && atc > 0 ? conversions / atc * 100 : null,
      metric_presence: { ...presence, purchases: true, purchase_value: true,
        roas: spend > 0, cpa: conversions > 0,
        link_clicks: linkClicks != null, landing_page_views: lpv != null,
        add_to_cart: atc != null, initiate_checkout: checkout != null,
        frequency: frequency != null },
      [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: metricEvidence,
      [META_CREATIVE_DAY_PURCHASE_EVIDENCE_KEY]: purchaseEvidence,
      source_snapshot_ids: [...new Set(members.map(({ snapshot }) => snapshot.id))].sort(),
      source_run_ids: [...new Set(members.map(({ ad }) => ad.sourceRunId!))].sort(),
    };
    if (same(old, next) && same(oldPayload, nextPayload)) continue;
    const economicsChanged = (["spend", "impressions", "clicks", "reach", "frequency",
      "conversions", "revenue", "roas", "cpa", "ctr"] as const)
      .some((key) => !same(old[key], next[key]));
    changes.push({ creativeId: row.creativeId, day: row.date,
      oldPayloadHash: hash(oldPayload), oldUpdatedAt: row.updatedAt, oldPayload,
      nextPayload, old, next,
      source: members.map(({ ad, snapshot }) => ({ adId: ad.adId,
        snapshotId: snapshot.id, payloadHash: snapshot.payload_hash,
        sourceRunId: ad.sourceRunId!, fetchedAt: snapshot.fetched_at })),
      reason: economicsChanged ? "finalized_ad_day_restatement" : "evidence_only" });
  }
  const manifest = { contract: CONTRACT,
    scope: { businessId: input.businessId, accountId: input.accountId,
      from: input.from, to: input.to },
    sourceContract: "published_same_run_finalized_ad_day_plus_exact_raw_actions_request",
    counts: { candidates: candidates.length, changes: changes.length,
      blocked: blockers.length, economicRestatements: changes.filter((c) =>
        c.reason === "finalized_ad_day_restatement").length },
    blockers,
    changes: changes.map(({ creativeId, day, oldPayloadHash, oldUpdatedAt,
      old, next, source, reason, oldPayload, nextPayload }) => ({ creativeId, day, reason,
      oldUpdatedAt, oldPayloadHash, old, next, source,
      oldMetricEvidence: oldPayload[META_CREATIVE_DAY_METRIC_EVIDENCE_KEY] ?? null,
      nextMetricEvidence: nextPayload[META_CREATIVE_DAY_METRIC_EVIDENCE_KEY],
      oldPurchaseEvidence: oldPayload[META_CREATIVE_DAY_PURCHASE_EVIDENCE_KEY] ?? null,
      nextPurchaseEvidence: nextPayload[META_CREATIVE_DAY_PURCHASE_EVIDENCE_KEY],
    })),
  };
  return { manifest, manifestHash: hash(manifest), changes, blockers };
}

async function loadInputs(scope: Scope): Promise<RepairInputs> {
  // Also called inside runDbTransaction: issue reads serially on its one client.
  const creativeRows = await getMetaCreativeDailyRange({ businessId: scope.businessId,
    providerAccountIds: [scope.accountId], startDate: scope.from, endDate: scope.to });
  const adRows = await getMetaAdDailyRange({ businessId: scope.businessId,
    providerAccountIds: [scope.accountId], startDate: scope.from, endDate: scope.to });
  const receiptRows = await getDb().query<Receipt>(`SELECT p.day::text AS day,
        p.published_by_run_id, p.published_at::text AS published_at,
        s.source_run_id AS slice_source_run_id, s.state AS slice_state,
        s.truth_state AS slice_truth_state, s.validation_status AS slice_validation_status,
        s.status AS slice_status, s.staged_row_count,
        m.fetch_status AS manifest_fetch_status,
        m.account_timezone AS manifest_account_timezone,
        m.completed_at::text AS manifest_completed_at
      FROM meta_authoritative_publication_pointers p
      JOIN meta_authoritative_slice_versions s ON s.id=p.active_slice_version_id
        AND s.business_id=p.business_id AND s.provider_account_id=p.provider_account_id
        AND s.day=p.day AND s.surface=p.surface
      JOIN meta_authoritative_source_manifests m ON m.id=s.manifest_id
        AND m.business_id=p.business_id AND m.provider_account_id=p.provider_account_id
        AND m.day=p.day AND m.run_id=s.source_run_id
      WHERE p.business_id=$1 AND p.provider_account_id=$2
        AND p.day BETWEEN $3::date AND $4::date AND p.surface='ad_daily'`,
      [scope.businessId, scope.accountId, scope.from, scope.to]);
  const ids = [...new Set(adRows.map((ad) => ad.sourceSnapshotId).filter(
    (id): id is string => Boolean(id)))];
  const snapshots = ids.length ? await getDb().query<Snapshot>(
    `SELECT id::text AS id, business_id, provider_account_id, endpoint_name, entity_scope,
        start_date::text AS start_date, end_date::text AS end_date,
        status, provider_http_status, payload_hash, payload_json,
        fetched_at::text AS fetched_at, request_context
      FROM meta_raw_snapshots WHERE id=ANY($1::uuid[])`, [ids]) : [];
  return { ...scope, creativeRows, adRows, snapshots, receipts: receiptRows };
}

async function applyPlan(scope: Scope, expectedManifestHash: string) {
  return runDbTransaction(async () => {
    const sql = getDb();
    await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `meta_creative_daily:${scope.businessId}:${scope.accountId}:${scope.from}:${scope.to}`]);
    await sql.query("LOCK TABLE meta_ad_daily, meta_creative_daily IN SHARE ROW EXCLUSIVE MODE");
    const plan = buildCreativeDaySourceEvidenceRepairPlan(await loadInputs(scope));
    if (plan.blockers.length || plan.manifestHash !== expectedManifestHash) {
      throw new Error("creative_day_evidence_repair_manifest_drift_or_blocked");
    }
    for (const change of plan.changes) {
      const updated = await sql.query<{ creative_id: string }>(
        `UPDATE meta_creative_daily SET spend=$5, impressions=$6, clicks=$7,
          reach=$8, frequency=$9, conversions=$10, revenue=$11, roas=$12,
          cpa=$13, ctr=$14, cpc=$15, link_clicks=$16,
          payload_json=$17::jsonb, updated_at=now()
         WHERE business_id=$1 AND provider_account_id=$2 AND date=$3::date
           AND creative_id=$4 AND updated_at=$18::timestamptz
           AND payload_json=$19::jsonb RETURNING creative_id`,
        [scope.businessId, scope.accountId, change.day, change.creativeId,
          change.next.spend, change.next.impressions, change.next.clicks,
          change.next.reach, change.next.frequency, change.next.conversions,
          change.next.revenue, change.next.roas, change.next.cpa,
          change.next.ctr, change.next.cpc, change.next.linkClicks,
          JSON.stringify(change.nextPayload), change.oldUpdatedAt,
          JSON.stringify(change.oldPayload)],
      );
      if (updated.length !== 1) throw new Error(`creative_day_evidence_repair_update_conflict:${change.creativeId}`);
    }
    return { updated: plan.changes.length, manifestHash: plan.manifestHash };
  });
}

async function main() {
  configureOperationalScriptRuntime({ lane: "owner_maintenance" });
  const options = parseArgs(process.argv.slice(2));
  const scope = { businessId: options.businessId, accountId: options.accountId,
    from: options.from, to: options.to };
  const plan = buildCreativeDaySourceEvidenceRepairPlan(await loadInputs(scope));
  const report = { ...plan.manifest, manifestHash: plan.manifestHash };
  if (options.manifestOut) writeFileSync(options.manifestOut,
    `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const readback = options.apply
    ? await applyPlan(scope, options.expectedManifestHash!) : null;
  console.log(JSON.stringify({ ...report, applied: options.apply, readback }, null, 2));
}

if (process.argv[1]?.endsWith("creative-day-source-evidence-repair.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
