"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  TrackingConfirmModal,
  useDeferState,
} from "@/components/common/briefing";
import {
  dateWindowToRangeValue,
  getTodayIsoForTimeZone,
  normalizeDateWindowBounds,
  rangeValueToDateWindow,
  type DateWindowValue,
} from "@/components/date-range/DateRangePicker";
import type { MetaAnomaly } from "@/lib/meta/anomalies";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type {
  MetaCanonicalDecision,
} from "@/lib/meta/decisions-workspace-contract";
import {
  describeDecisionWorkspaceFailure,
  MetaRequestFailure,
} from "@/lib/meta/workspace-failure";
import type {
  MetaOsAdDecision,
} from "@/lib/meta/decisions-os-contract";
import { dashboardHrefForRouteFamily } from "@/lib/dashboard-v2/screen-registry";
import {
  describeLaunchpadHandoffRefusal,
  parseLaunchpadHandoffRefusal,
} from "@/lib/meta/launchpad-handoff-contract";
import {
  DATE_WINDOW_INCLUDES_CURRENT_DAY,
  resolveDateWindowFromParams,
} from "@/lib/dashboard/date-window-url";
import { cn } from "@/lib/utils";
import { MetaCampaignLabelsSection } from "@/components/meta/redesign/MetaCampaignLabelsSection";
import { MetaLaunchpadOverlay } from "@/components/meta/redesign/MetaLaunchpadOverlay";
import {
  MetaDecisionCenterExact,
  type MetaDecisionCenterExactLane,
  type MetaDecisionCenterExactScope,
  type MetaDecisionCenterExactViewModel,
  type MetaDecisionCenterExactWindow,
} from "@/components/meta/decision-center/MetaDecisionCenterExact";
import { buildMetaDecisionCenterExactViewModel } from "@/components/meta/decision-center/meta-decision-center-exact-adapter";
import { CreativeEvidenceWindowExact } from "@/components/creatives/CreativeEvidenceWindowExact";
import {
  buildCreativeEvidenceWindowExactViewModel,
  buildMetaAdsManagerHref,
  type CreativeEvidenceWindowExactAdRow,
  type CreativeEvidenceWindowExactSeriesPayload,
} from "@/components/creatives/creative-evidence-window-exact-adapter";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import styles from "./MetaPlatformPage.module.css";
import {
  decisionLabelForRec,
  launchModeForRec,
  proposedBidDisplayValue,
  scopeIdForRec,
  scopeNameForRec,
  structuredMetricsForRec,
  formatMoney,
} from "@/components/meta/redesign/meta-card-utils";
import { formatCurrency } from "@/lib/briefing/utils";
import { emitProductInstrumentation } from "@/lib/product-instrumentation-client";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import type { BriefingStatusFilter } from "@/lib/meta/briefing-filter";
import type {
  MetaDecisionsWorkspacePayload,
  MetaDecisionsWorkspaceBanner as MetaWorkspaceBanner,
  MetaDrillItem,
  MetaLaunchMode,
  MetaPulsePayload,
  MetaWindowKey,
} from "@/components/meta/redesign/types";

interface MetaPlatformPageProps {
  businessId: string;
  businessName?: string | null;
  currency?: string | null;
  /**
   * The provider account the server already resolved, assignment-verified.
   *
   * Used as a fallback when the client's own accounts read produced nothing.
   * `resolveProviderAccountId` refuses an unassigned requested id and refuses
   * to choose for a multi-account business, so this can never widen scope — it
   * only keeps the workspace readable when `/api/meta/history/accounts` is the
   * one read that is down.
   *
   * CORRECTION (this file previously stated the opposite):
   * `/api/meta/decisions-workspace` DOES re-verify the requested account
   * against the business's assignments. `canonicalDecisionReadModel()` in
   * `app/api/meta/decisions-workspace/route.ts` calls
   * `getProviderAccountAssignments(businessId, "meta")` and returns
   * `403 provider_account_not_assigned` when the requested id is not in
   * `account_ids`; the GET handler propagates that status for the whole
   * response. An unreadable assignment source degrades to the
   * `provider_account_scope_unverified` unavailable model rather than to a
   * read. So the endpoint is not the reason a raw URL value is unacceptable
   * here — the reason is that this prop is the surface's own fail-closed scope
   * and a client must not mint scope it has not had verified.
   */
  serverProviderAccountId?: string | null;
}

interface AnomaliesPayload {
  anomalies: MetaAnomaly[];
  snapshotDate: string | null;
  count: number;
}

interface OverlayState {
  open: boolean;
  mode: MetaLaunchMode;
  rec: MetaRecommendation | null;
}

const EMPTY_OVERLAY: OverlayState = { open: false, mode: "rebuild", rec: null };
export function resolveMetaDecisionMoneyCurrency(
  decisionCurrency: string | null | undefined,
  providerCurrency: string | null | undefined,
): string | null {
  const normalizedDecisionCurrency = decisionCurrency?.trim();
  if (normalizedDecisionCurrency) return normalizedDecisionCurrency;

  const normalizedProviderCurrency = providerCurrency?.trim();
  return normalizedProviderCurrency || null;
}

type MetaSnapshotRunStatus = "ran" | "cooldown" | "already_running";

export function interpretMetaSnapshotRunResponse(
  responseOk: boolean,
  payload: unknown,
):
  | { ok: true; status: MetaSnapshotRunStatus }
  | { ok: false; message: string } {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const status = record?.status;
  const validStatus =
    status === "ran" || status === "cooldown" || status === "already_running";
  if (responseOk && record?.ok === true && validStatus) {
    return { ok: true, status };
  }
  const message =
    typeof record?.message === "string" && record.message.trim()
      ? record.message
      : responseOk
        ? "Snapshot refresh returned an invalid response."
        : "Snapshot refresh failed.";
  return { ok: false, message };
}

/**
 * The one place the screen speaks back.
 *
 * Every refusal and every outcome used to be written into a second state that
 * nothing rendered, so a read-only viewer, a review-only verdict and a failed
 * snapshot all looked identical: a click that did nothing. They all land here
 * now, in the banner the design already reserves for exceptional states.
 */
type MetaDecisionNotice = {
  tone: "info" | "warning" | "danger" | "success";
  title: string;
  detail?: string | null;
};
function metaNoticeToneClass(tone: MetaDecisionNotice["tone"]): string {
  if (tone === "danger") return "danger";
  if (tone === "success") return "success";
  if (tone === "warning") return "warn";
  return "info";
}

type MetaLaneView = "action" | "watching" | "healthy" | "nonSales" | "archive";

/**
 * Two lane vocabularies reach this screen and only one is current.
 *
 * The live one is `watching|healthy|nonSales|archive` (plus the implicit
 * `action`). The retired one is `act|test|watch`, from the decommissioned
 * decisions URL contract in `lib/zero-base/meta/decisions-url-state.ts`; links
 * carrying it still exist in pasted URLs and bookmarks. Those used to fall
 * through the default and render Action Now — a link that says `lane=watch`
 * silently showing a different lane is a lie about what the recipient is
 * looking at. `watch` maps; `act` is Action Now; `test` had no lane in this
 * taxonomy at all (it was a campaign label, not a queue lane), so it resolves
 * to the default by an explicit decision rather than by omission.
 */
function parseMetaLaneView(value: string | null): MetaLaneView {
  if (
    value === "watching" ||
    value === "healthy" ||
    value === "nonSales" ||
    value === "archive"
  )
    return value;
  if (value === "watch") return "watching";
  if (value === "act" || value === "test") return "action";
  return "action";
}

function parseMetaWorkspaceLane(params: {
  get(name: string): string | null;
}): MetaLaneView {
  const legacyLane = params.get("lane");
  if (legacyLane) return parseMetaLaneView(legacyLane);
  if (params.get("area") !== "monitor") return "action";
  const segment = params.get("segment");
  if (segment === "healthy") return "healthy";
  if (segment === "out_of_scope") return "nonSales";
  if (segment === "structures") return "archive";
  return "watching";
}

/**
 * The scope half of the queue's URL state.
 *
 * The lane was already deep-linkable and the scope was not, so a pasted link to
 * a creative decision reopened on Campaigns & Ad sets and the operator had to
 * find their way back. `structure` is the reference's resting scope and stays
 * out of the query string.
 */
function parseMetaScope(
  params: { get(name: string): string | null },
): MetaDecisionCenterExactScope {
  if (params.get("scope") === "creatives") return "creatives";
  // The live "Open in Decisions" link on a creative row still speaks the
  // retired vocabulary (`creativeId` + `row=ad:<adId>`, minted by
  // lib/zero-base/creative/performance-adapter.ts). It named a creative and
  // landed on Campaigns & Ad sets — exactly the failure that adapter's own
  // comment says it is guarding against. A link that names a creative opens on
  // creatives.
  return parseMetaCreativeSelection(params) ? "creatives" : "structure";
}

/**
 * The creative a link names, in either vocabulary.
 *
 * `row` is the retired contract's selected-row key and is only meaningful here
 * in its `ad:<adId>` form; anything else names a structure row that the
 * creative scope cannot open, so it is ignored rather than half-honoured.
 * Returns null when the URL names no creative at all.
 */
function parseMetaCreativeSelection(params: {
  get(name: string): string | null;
}): { adId: string | null; creativeId: string | null } | null {
  const row = params.get("row")?.trim() ?? "";
  const adId = row.startsWith("ad:") ? row.slice(3).trim() || null : null;
  const creativeId = params.get("creativeId")?.trim() || null;
  if (!adId && !creativeId) return null;
  return { adId, creativeId };
}

/**
 * The row search term a link carries.
 *
 * `q` is the retired Decisions contract's search parameter
 * (`lib/zero-base/meta/decisions-url-state.ts`) and it is still minted. The
 * live surface has exactly the control it names — the queue's row search — so
 * `q` is restored rather than reported as unsupported. Bounded to the same
 * 128 characters the old contract bounded it to: an unbounded term is not a
 * search, and it would ride into every link this screen mints back out.
 */
export const META_DEEP_LINK_SEARCH_MAX_LENGTH = 128;

export function parseMetaRowSearch(params: {
  get(name: string): string | null;
}): string {
  return (params.get("q") ?? "").trim().slice(0, META_DEEP_LINK_SEARCH_MAX_LENGTH);
}

export interface MetaDeepLinkCompatibilityEntry {
  param: string;
  value: string;
  behaviour: string;
}

/**
 * What this screen did with the parts of a link it cannot honour.
 *
 * A deep link is a promise. The retired contract minted `lane=act|test|watch`,
 * `levels`, `q` and `row`; this screen serves a different lane set, has no
 * level filter, and can only open a `row` that names an ad. Quietly falling
 * back left an operator staring at an unfiltered Action now list convinced
 * they were looking at the filtered view they pasted — the parameter was
 * dropped and the screen said nothing.
 *
 * So: every parameter this screen cannot restore is named here with the
 * behaviour that replaced it, and the screen states it. Parameters it CAN
 * restore (`q`, `scope=creatives`, `entity`, `creativeId`, `row=ad:<id>`,
 * `lane=act|watch`) are absent from this report precisely because they were
 * honoured — silence here means "restored", never "ignored".
 */
export function describeMetaDeepLinkCompatibility(params: {
  get(name: string): string | null;
}): MetaDeepLinkCompatibilityEntry[] {
  const entries: MetaDeepLinkCompatibilityEntry[] = [];

  const rawLane = params.get("lane")?.trim() ?? "";
  if (rawLane) {
    const lane = rawLane.toLowerCase();
    const restorable = new Set([
      "act",
      "action",
      "watch",
      "watching",
      "healthy",
      "nonsales",
      "archive",
    ]);
    if (lane === "test") {
      entries.push({
        param: "lane",
        value: rawLane,
        behaviour:
          "opened Action now — this queue has no separate Test lane, and test decisions are served inside Action now",
      });
    } else if (!restorable.has(lane)) {
      entries.push({
        param: "lane",
        value: rawLane,
        behaviour: "not a lane this queue serves; opened Action now",
      });
    }
  }

  const rawLevels = params.get("levels")?.trim() ?? "";
  if (rawLevels) {
    entries.push({
      param: "levels",
      value: rawLevels,
      behaviour:
        "no level filter exists here; campaign, ad set and ad rows are all shown",
    });
  }

  const rawRow = params.get("row")?.trim() ?? "";
  if (rawRow && !rawRow.startsWith("ad:")) {
    entries.push({
      param: "row",
      value: rawRow,
      behaviour:
        "only row=ad:<adId> names a row this queue can open; no row was selected",
    });
  } else if (rawRow.startsWith("ad:") && !rawRow.slice(3).trim()) {
    entries.push({
      param: "row",
      value: rawRow,
      behaviour: "names no ad id; no row was selected",
    });
  }

  const rawScope = params.get("scope")?.trim() ?? "";
  if (rawScope && rawScope !== "creatives" && rawScope !== "structure") {
    entries.push({
      param: "scope",
      value: rawScope,
      behaviour:
        "not a scope this queue serves; opened Campaigns & ad sets",
    });
  }

  return entries;
}

export function metaDeepLinkCompatibilityDetail(
  entries: readonly MetaDeepLinkCompatibilityEntry[],
): string {
  return entries
    .map((entry) => `${entry.param}=${entry.value} — ${entry.behaviour}.`)
    .join(" ");
}

/** Does a served canonical decision answer the creative the URL named? */
function matchesMetaCreativeSelection(
  decision: MetaCanonicalDecision,
  selection: { adId: string | null; creativeId: string | null },
): boolean {
  const decisionAdId = decision.parentChain.ad?.id?.trim() || null;
  const decisionCreativeId = decision.parentChain.creative?.id?.trim() || null;
  if (selection.adId && decisionAdId === selection.adId) return true;
  return Boolean(
    selection.creativeId && decisionCreativeId === selection.creativeId,
  );
}

function parseMetaWindow(value: string | null): MetaWindowKey {
  if (
    value === "7d" ||
    value === "14d" ||
    value === "28d" ||
    value === "90d" ||
    value === "custom"
  )
    return value;
  return "28d";
}

function exactLaneForMetaLane(lane: MetaLaneView): MetaDecisionCenterExactLane {
  return lane === "nonSales" ? "nonsales" : lane;
}

function metaLaneForExactLane(lane: MetaDecisionCenterExactLane): MetaLaneView {
  return lane === "nonsales" ? "nonSales" : lane;
}

function exactWindowForMetaWindow(
  window: MetaWindowKey,
): MetaDecisionCenterExactWindow | null {
  return window === "custom" ? null : window;
}

function metaOsCreativeSearchMatch(
  decision: MetaOsAdDecision,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    decision.adName,
    decision.creativeName,
    decision.campaignName,
    decision.adsetName,
    decision.action.label,
    decision.publishedLabel,
  ].some((value) => value?.toLowerCase().includes(normalized));
}

/**
 * The window this page measures — resolved once, by the shared authority.
 *
 * This used to be the second of three disagreeing resolvers. It honoured
 * `startDate`/`endDate` only when the preset key happened to read `custom`, so
 * `?window=7d&startDate=2026-08-11&endDate=2026-08-17` threw the stated dates
 * away and re-expanded "7d" with `includeCurrentDay: true` — against the
 * provider account's clock, not the workspace clock the shell had used. The
 * shell had written 08-11..08-17; this produced 08-12..08-18, and the ads
 * series was fetched for that second window while the caption still said the
 * first. See `DATE_WINDOW_INCLUDES_CURRENT_DAY` in
 * `lib/dashboard/date-window-url` for the intent both now obey: stated dates
 * are the window, verbatim, whatever the preset key says; a bare preset
 * expands to completed days ending yesterday.
 */
function metaDateRangeFromParams(
  params: URLSearchParams,
  referenceDate?: string,
): DateWindowValue {
  const selected = parseMetaWindow(params.get("window"));
  const resolved = resolveDateWindowFromParams(
    params,
    referenceDate ?? "",
    // A URL with no dates on it still names a preset, and the Meta vocabulary
    // is the one this page parses.
    { rangePreset: selected === "custom" ? "custom" : selected, customStart: "", customEnd: "" },
  );
  if (!resolved) {
    return rangeValueToDateWindow(
      dateWindowToRangeValue({ window: selected, start: "", end: "" }),
      referenceDate,
    );
  }
  // The window key stays the URL's, so the caption keeps naming the preset the
  // operator picked; `start`/`end` are the days that will actually be measured.
  // The only bound applied is the calendar itself — no window can run past the
  // day the account is currently in — which is the clamp the custom branch
  // already carried.
  return normalizeDateWindowBounds(
    { window: selected, start: resolved.start, end: resolved.end },
    { maxDate: referenceDate },
  );
}

export function campaignKindMatchesMetaLabelFilter(
  campaignKind: string | null | undefined,
  label: "all" | "main" | "test" | "mixed",
) {
  if (label === "all") return true;
  const normalized = String(campaignKind ?? "").toLowerCase();
  return normalized === label;
}


async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const serverMessage =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : null;
    throw new MetaRequestFailure({
      message: serverMessage ?? `Request failed (${response.status})`,
      status: response.status,
      hasServerReason: Boolean(serverMessage && serverMessage.trim()),
    });
  }
  return payload as T;
}

function fetchDecisionsWorkspace(
  businessId: string,
  providerAccountId: string,
  window: MetaWindowKey,
  statusFilter: BriefingStatusFilter,
  range?: Pick<DateWindowValue, "start" | "end">,
) {
  const params = new URLSearchParams({
    businessId,
    providerAccountId,
    window,
    status_filter: statusFilter,
  });
  // The dates travel for EVERY window, not just `custom`. Sending a bare
  // `window=7d` handed the route the job of picking an end date, and it picked
  // a different one (its own `resolveWorkspaceEndDate`) than the page had
  // already resolved and captioned — one click, two windows. The window key
  // still travels so the route can name what it served; the dates are what it
  // measures.
  if (range) {
    params.set("startDate", range.start);
    params.set("endDate", range.end);
  }
  return readJson<MetaDecisionsWorkspacePayload>(
    `/api/meta/decisions-workspace?${params.toString()}`,
  );
}

/**
 * The preset key is deliberately NOT a parameter here.
 *
 * This read is scoped by a date, and taking the window key alongside it was
 * what let the old `window === "custom"` guard exist. Dropping it makes it
 * impossible to reintroduce a branch where the label decides whether the date
 * travels.
 */
function fetchAnomalies(
  businessId: string,
  providerAccountId: string,
  statusFilter: BriefingStatusFilter,
  range?: Pick<DateWindowValue, "start" | "end">,
) {
  const params = new URLSearchParams({
    businessId,
    providerAccountId,
    activeOnly: "1",
    status_filter: statusFilter,
  });
  // Scope the anomaly snapshot to the selected range's end so historical
  // ranges do not surface today's anomalies. Status filtering runs against
  // the entity status captured at anomaly write time; snapshots written
  // before that field existed fail open (see anomalyMatchesStatusFilter).
  //
  // This used to be gated on `window === "custom"`: picking "Last 7 days" over
  // a historical week left the request undated, so the banner showed TODAY's
  // anomalies above last week's decisions. A preset names a window just as
  // exactly as a custom range does.
  if (range) {
    params.set("endDate", range.end);
  }
  return readJson<AnomaliesPayload>(`/api/meta/anomalies?${params.toString()}`);
}

/**
 * Record a decision response.
 *
 * This is a write, and a write that fails must never read as success. The raw
 * `Response` used to be returned unchecked, so a 403 (authority revoked) or a
 * 500 resolved normally: the operator was routed on to Launchpad while nothing
 * was recorded, and the decision reappeared in Action Now on the next
 * snapshot. Same failure contract as every read on this surface — a non-2xx
 * throws carrying the server's own reason when it gave one.
 */
async function postResponse(input: {
  businessId: string;
  recId: string;
  action: "acted" | "deferred" | "undeferred" | "ignored";
  actionSubtype?: string;
  reappearAt?: string;
}): Promise<void> {
  const response = await fetch("/api/meta/recommendations/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    cache: "no-store",
    body: JSON.stringify(input),
  });
  if (response.ok) return;
  const payload = await response.json().catch(() => null);
  const serverMessage =
    payload && typeof payload === "object" && "message" in payload
      ? String((payload as { message?: unknown }).message)
      : null;
  throw new MetaRequestFailure({
    message: serverMessage ?? `Request failed (${response.status})`,
    status: response.status,
    hasServerReason: Boolean(serverMessage && serverMessage.trim()),
  });
}

export function metaAdsetPauseNotice(status: unknown, dryRun = false) {
  if (dryRun) return "Dry run: ad set would pause.";
  const normalized =
    typeof status === "string" ? status.trim().toUpperCase() : "";
  if (!normalized || normalized === "PAUSED") return "Ad set paused in Meta.";
  return `Ad set pause verified with status ${normalized}.`;
}

function actionPayloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

export function metaActionFailureMessage(
  payload: unknown,
  fallbackMessage: string,
) {
  const record = actionPayloadRecord(payload);
  const error = actionPayloadRecord(record?.error);
  if (error?.code === "kill_switch_engaged") {
    return "Meta writes are temporarily disabled (kill switch). Try again later.";
  }
  if (typeof record?.message === "string" && record.message.trim()) {
    return record.message;
  }
  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message;
  }
  return fallbackMessage;
}

export function metaBidApplyNotice(
  payload: unknown,
  currency?: string | null,
) {
  const record = actionPayloadRecord(payload);
  const dryRun = record?.dryRun === true;
  const bidAmountMinor =
    typeof record?.bidAmountMinor === "number" &&
    Number.isFinite(record.bidAmountMinor)
      ? record.bidAmountMinor
      : null;
  if (dryRun) {
    return {
      tone: "info" as const,
      title: bidAmountMinor
        ? `Dry run: bid cap would apply at ${formatCurrency(
            bidAmountMinor / 100,
            currency,
          )}.`
        : "Dry run completed.",
      detail: "No Meta write was performed; Meta verification completed.",
    };
  }
  return {
    tone: "success" as const,
    title: bidAmountMinor
      ? `Bid cap applied at ${formatCurrency(
          bidAmountMinor / 100,
          currency,
        )}.`
      : "Bid cap applied.",
    detail: "Meta verified the ad set bid.",
  };
}

/**
 * Where a structure-level Rebuild/Duplicate actually goes.
 *
 * It used to go to
 * `?mode=duplicate&fromMetaBriefing=true&campaignIds=…&adsetIds=…`, which is a
 * lineage claim with nothing behind it. Launchpad reads `fromMetaBriefing=true`
 * as "this is a decision handoff", finds no verifiable lineage
 * (`hasCompleteLaunchpadLineageIdentifiers` is false without a decision id AND
 * a snapshot id), refuses it, strips every id and lands on "Source & mode"
 * announcing incomplete lineage. So the old link's only observable effect was
 * to make the wizard start empty while blaming the operator's link.
 *
 * A campaign-or-ad-set recommendation has no canonical ad-grain decision to
 * mint a handoff from, and picking one of the ads underneath it would be the
 * screen choosing a subject the server never named. So this link stops
 * claiming lineage it cannot prove and asks for the manual start it can
 * honour: the requested mode, the resolved account, nothing else. The caller
 * states the missing-lineage part in words instead of encoding it as a broken
 * handoff.
 */
function launchpadHrefForRec(rec: MetaRecommendation, mode: MetaLaunchMode) {
  void rec;
  const params = new URLSearchParams({
    launchpadMode: mode === "duplicate" ? "add_to_existing" : "new_campaign",
    launchpadStep: "source",
  });
  return `/platforms/meta/launchpad?${params.toString()}`;
}

export type MetaRowSort = "money" | "priority" | "age";

/** Free-text row search over entity/label truth. Empty query keeps every row. */
export function metaRecSearchMatch(
  rec: MetaRecommendation,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    scopeNameForRec(rec),
    rec.campaignName ?? "",
    rec.adsetName ?? "",
    rec.decisionLabel ?? "",
    rec.title ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

const META_PRIORITY_RANK: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function stableSortMetaRecs(
  recs: MetaRecommendation[],
  key: (rec: MetaRecommendation) => number | null,
): MetaRecommendation[] {
  // Higher key first; rows whose key is missing are kept LAST (never coerced
  // to zero). Ties preserve the incoming server priority order (stable).
  return recs
    .map((rec, index) => ({ rec, index, k: key(rec) }))
    .sort((a, b) => {
      if (a.k == null && b.k == null) return a.index - b.index;
      if (a.k == null) return 1;
      if (b.k == null) return -1;
      if (a.k === b.k) return a.index - b.index;
      return b.k - a.k;
    })
    .map((item) => item.rec);
}

/**
 * Client sort over server-structured truth only. Money = spend at stake,
 * Priority = server priority, Age = evidence age in days. Missing-metric rows
 * always sort last so an absent number never masquerades as the top row.
 */
export function sortMetaRecs(
  recs: MetaRecommendation[],
  sort: MetaRowSort,
): MetaRecommendation[] {
  if (sort === "priority") {
    return stableSortMetaRecs(recs, (rec) => {
      const rank = META_PRIORITY_RANK[rec.priority];
      return rank == null ? null : -rank;
    });
  }
  if (sort === "age") {
    return stableSortMetaRecs(recs, (rec) => {
      const age = rec.evidenceTrail?.age_days;
      return typeof age === "number" && Number.isFinite(age) ? age : null;
    });
  }
  return stableSortMetaRecs(recs, (rec) => {
    const spend = rec.metrics?.spend;
    return typeof spend === "number" && Number.isFinite(spend) ? spend : null;
  });
}

/**
 * Tracking confirm label from the server-owned actionKind. The old ternary
 * keyed on rec.type and defaulted to "Rebuild anyway", so once execute_bid
 * became tracking-gated its confirm modal lied about the action (Codex
 * follow-up review). Copy must always name what confirming will do.
 */
export function trackingConfirmLabelForRec(
  rec: Pick<MetaRecommendation, "actionKind"> | null | undefined,
): string {
  switch (rec?.actionKind) {
    case "execute_pause":
      return "Pause anyway";
    case "execute_bid":
      return "Apply bid anyway";
    case "execute_resume":
      return "Resume anyway";
    case "route_launchpad_rebuild":
      return "Rebuild anyway";
    default:
      return "Continue anyway";
  }
}

/**
 * Write gate for tracking anomalies. Pure and dismissal-free BY SIGNATURE:
 * the banner's Dismiss button only hides the banner; it can never unlock
 * pause/rebuild/resume (Codex review: the old gate keyed on dismissal).
 */
export function isTrackingWriteBlocked(
  pulse:
    | Pick<MetaPulsePayload, "trackingAnomalyActive" | "trackingHealth">
    | null
    | undefined,
): boolean {
  return Boolean(
    pulse?.trackingAnomalyActive ??
    (pulse?.trackingHealth.status === "blocked" ||
      pulse?.trackingHealth.status === "degraded"),
  );
}

function titleCaseCompact(value: string | null | undefined) {
  if (!value) return "—";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function mobileTimestamp(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return `${date.toISOString().slice(11, 16)} UTC`;
}

function mobileDecisionTone(
  rec: MetaRecommendation,
): "danger" | "positive" | "caution" {
  const label = decisionLabelForRec(rec);
  if (label === "cut" || label === "below_breakeven" || label === "fatigue")
    return "danger";
  if (label === "scale" || label === "keep") return "positive";
  return "caution";
}

function mobileDecisionLine(
  rec: MetaRecommendation,
  targetRoas: number | null | undefined,
  currency: string | null | undefined,
) {
  const metrics = structuredMetricsForRec(rec);
  const parts: string[] = [];
  if (typeof metrics?.spend === "number" && Number.isFinite(metrics.spend)) {
    parts.push(formatMoney(metrics.spend, currency));
  }
  if (typeof metrics?.roas === "number" && Number.isFinite(metrics.roas)) {
    const roas = `${metrics.roas.toFixed(2)}x`;
    parts.push(
      typeof targetRoas === "number" && Number.isFinite(targetRoas)
        ? `${roas} vs ${targetRoas.toFixed(2)}x target`
        : roas,
    );
  }
  return `${titleCaseCompact(decisionLabelForRec(rec))} · ${
    parts.length > 0
      ? parts.join(" · ")
      : rec.expectedImpact || rec.summary || "server summary —"
  }`;
}

function MobileDecisionConfidence({
  confidence,
}: {
  confidence: MetaRecommendation["confidence"];
}) {
  const label =
    confidence === "high" ? "High" : confidence === "medium" ? "Medium" : "Low";
  const activeBars = label === "High" ? 3 : label === "Medium" ? 2 : 1;
  return (
    <span className="ad-confidence-pill">
      <span aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <i key={index} data-active={index < activeBars ? "true" : "false"} />
        ))}
      </span>
      {label}
    </span>
  );
}

function MetaMobileCitationList({
  items,
}: {
  items: Array<{ label: string; value: string }>;
}) {
  if (items.length === 0) return null;
  return (
    <div className="ad-mobile-citation-list">
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`}>
          <span className="ad-mobile-cite">[{index + 1}]</span>
          <span>
            {item.label}: {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function MetaMobileEvidenceScreen({
  item,
  targetRoas,
  moneyCurrency,
  onBack,
}: {
  item: MetaDrillItem;
  targetRoas: number | null | undefined;
  moneyCurrency: string | null | undefined;
  onBack: () => void;
}) {
  if (item.mode === "anomaly") {
    const citationItems = item.anomaly.diagnostics
      .slice(0, 2)
      .map((diagnostic, index) => ({
        label: `Diagnostic ${index + 1}`,
        value: diagnostic,
      }));
    return (
      <section
        className="meta-mobile-decision-stage"
        data-testid="meta-mobile-evidence"
      >
        <div className="ad-mobile-device">
          <div className="ad-mobile-screen">
            <div className="ad-mobile-status">
              <span>--:--</span>
              <span>evidence · read-only</span>
            </div>
            <button type="button" className="ad-mobile-back" onClick={onBack}>
              ← Decisions
            </button>
            <div className="ad-mobile-title">
              <h2>{item.anomaly.scopeLabel}</h2>
              <p>
                {titleCaseCompact(item.anomaly.scopeType)} · anomaly · detected{" "}
                {mobileTimestamp(item.anomaly.detectedAt)}
              </p>
            </div>
            <article className="ad-mobile-heat">
              <strong>{item.anomaly.title}</strong>
              <span>{item.anomaly.detail}</span>
            </article>
            <p className="ad-mobile-copy">
              {item.anomaly.diagnostics[0] ??
                "The anomaly remains open in the server scan"}
              {citationItems[0] ? (
                <>
                  {" "}
                  <span className="ad-mobile-cite">[1]</span>
                </>
              ) : null}
              . Mobile keeps this as evidence review only.
            </p>
            <MetaMobileCitationList items={citationItems} />
            <div className="ad-mobile-desktop-note">
              Act on desktop — this device is read-only by design.
            </div>
          </div>
        </div>
      </section>
    );
  }

  const rec = item.rec;
  const metrics = structuredMetricsForRec(rec);
  const roasText =
    typeof metrics?.roas === "number" && Number.isFinite(metrics.roas)
      ? `${metrics.roas.toFixed(2)}x${typeof targetRoas === "number" && Number.isFinite(targetRoas) ? ` vs ${targetRoas.toFixed(2)}x target` : ""}`
      : "ROAS —";
  const spendText =
    typeof metrics?.spend === "number" && Number.isFinite(metrics.spend)
      ? formatMoney(metrics.spend, moneyCurrency)
      : "spend —";
  const citationItems = rec.evidence.slice(0, 2).map((evidence) => ({
    label: evidence.label,
    value: evidence.value,
  }));

  return (
    <section
      className="meta-mobile-decision-stage"
      data-testid="meta-mobile-evidence"
    >
      <div className="ad-mobile-device">
        <div className="ad-mobile-screen">
          <div className="ad-mobile-status">
            <span>--:--</span>
            <span>evidence · read-only</span>
          </div>
          <button type="button" className="ad-mobile-back" onClick={onBack}>
            ← Decisions
          </button>
          <div className="ad-mobile-title">
            <h2>{scopeNameForRec(rec)}</h2>
            <p>
              {titleCaseCompact(rec.level)} ·{" "}
              {rec.rowPresentation?.accountBadge ?? "account —"}
            </p>
          </div>
          <article className="ad-mobile-heat">
            <strong>
              {mobileDecisionLine(rec, targetRoas, moneyCurrency)}
            </strong>
            <span>
              {spendText} · {roasText}
            </span>
          </article>
          <p className="ad-mobile-copy">
            {rec.why ||
              rec.summary ||
              "Decision reasoning is unavailable in this payload"}
            {citationItems[0] ? (
              <>
                {" "}
                <span className="ad-mobile-cite">[1]</span>
              </>
            ) : null}
            ; confidence is {rec.confidence}
            {citationItems[1] ? (
              <>
                {" "}
                <span className="ad-mobile-cite">[2]</span>
              </>
            ) : null}
            .
          </p>
          <MetaMobileCitationList items={citationItems} />
          <div className="ad-mobile-desktop-note">
            Act on desktop — this device is read-only by design.
          </div>
        </div>
      </div>
    </section>
  );
}

function MetaMobileDecisionRow({
  rec,
  targetRoas,
  moneyCurrency,
  onOpen,
}: {
  rec: MetaRecommendation;
  targetRoas: number | null | undefined;
  moneyCurrency: string | null | undefined;
  onOpen: (rec: MetaRecommendation) => void;
}) {
  return (
    <article className="ad-mobile-row-card">
      <div>
        <h3>{scopeNameForRec(rec)}</h3>
        <p data-tone={mobileDecisionTone(rec)}>
          {mobileDecisionLine(rec, targetRoas, moneyCurrency)}
        </p>
      </div>
      <div className="ad-mobile-row-footer">
        <MobileDecisionConfidence confidence={rec.confidence} />
        <button type="button" onClick={() => onOpen(rec)}>
          Read evidence →
        </button>
      </div>
    </article>
  );
}

function MetaMobileDecisionsScreen({
  businessName,
  moneyCurrency,
  pulse,
  laneSnapshotDate,
  loading,
  error,
  anomalies,
  actionRows,
  watchingRows,
  targetRoas,
  onOpenRec,
  onOpenAnomaly,
}: {
  businessName?: string | null;
  moneyCurrency: string | null | undefined;
  pulse: MetaPulsePayload | null;
  laneSnapshotDate: string | null;
  loading: boolean;
  error: Error | null;
  anomalies: MetaAnomaly[];
  actionRows: MetaRecommendation[];
  watchingRows: MetaRecommendation[];
  targetRoas: number | null | undefined;
  onOpenRec: (rec: MetaRecommendation) => void;
  onOpenAnomaly: (anomaly: MetaAnomaly) => void;
}) {
  const actCount =
    loading || error ? "—" : actionRows.length + anomalies.length;
  const primaryRows = [...actionRows, ...watchingRows].slice(0, 2);
  return (
    <section
      className="meta-mobile-decision-stage"
      data-testid="meta-mobile-decisions"
    >
      <div className="ad-mobile-device">
        <div className="ad-mobile-screen">
          <div className="ad-mobile-status">
            <span>--:--</span>
            <span>
              {businessName ?? "Meta"} · Act now {actCount}
            </span>
          </div>
          <div className="ad-mobile-freshness">
            synced {mobileTimestamp(pulse?.lastSyncAt ?? null)} · snapshot{" "}
            {laneSnapshotDate ?? "—"}
          </div>
          {loading ? (
            <article className="ad-mobile-row-card">
              <h3>Decision queue</h3>
              <p>loading server snapshot —</p>
            </article>
          ) : error ? (
            <article className="ad-mobile-anomaly">
              <b>Decision queue unavailable.</b>
              <div>
                {error.message ||
                  "Missing data is withheld, never shown as zero."}
              </div>
            </article>
          ) : anomalies[0] ? (
            <button
              type="button"
              className="ad-mobile-anomaly ad-mobile-anomaly-button"
              onClick={() => onOpenAnomaly(anomalies[0]!)}
            >
              <b>Anomaly:</b> {anomalies[0].title}
              <div>
                detected {mobileTimestamp(anomalies[0].detectedAt)} · read
                evidence on mobile, act on desktop
              </div>
            </button>
          ) : (
            <article className="ad-mobile-anomaly">
              <b>No active anomaly.</b>
              <div>
                Rows still open evidence on mobile; execution stays
                desktop-only.
              </div>
            </article>
          )}
          {primaryRows.map((rec) => (
            <MetaMobileDecisionRow
              key={rec.id}
              rec={rec}
              targetRoas={targetRoas}
              moneyCurrency={moneyCurrency}
              onOpen={onOpenRec}
            />
          ))}
          {!loading && !error && primaryRows.length === 0 ? (
            <article className="ad-mobile-row-card">
              <h3>No high-confidence calls</h3>
              <p>server queue has no mobile-readable action rows</p>
            </article>
          ) : null}
          <div className="ad-mobile-desktop-note">
            Writes are desktop-only — rows here open evidence, never a pause
            button. Hit targets ≥44px.
          </div>
        </div>
      </div>
    </section>
  );
}

// Bounded triage-board helpers. These render only server-structured evidence;
// unavailable preview, hierarchy, and metric fields remain explicit.

function canonicalCreativeSearchMatch(
  decision: MetaCanonicalDecision,
  search: string,
) {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [
    decision.parentChain.ad?.name,
    decision.parentChain.ad?.id,
    decision.parentChain.creative?.name,
    decision.parentChain.creative?.id,
    decision.parentChain.campaign?.name,
    decision.parentChain.campaign?.id,
    decision.parentChain.adset?.name,
    decision.classification.buyerLabel,
    decision.sourceDecision.reason,
  ]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(query));
}

/**
 * The decisions-workspace contract stops at spend / purchases / ROAS. The
 * funnel, thumbstop, first-seen date and per-ad-set split the evidence window
 * draws are ad-grain facts served by `/api/meta/creatives`, which keeps its
 * own `requireBusinessAccess` gate. Reading them here adds no new authority.
 */
async function fetchCreativeEvidenceAdRows(input: {
  businessId: string;
  providerAccountId: string;
  creativeId: string;
  start: string;
  end: string;
}): Promise<CreativeEvidenceWindowExactAdRow[]> {
  const query = new URLSearchParams({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    creativeId: input.creativeId,
    groupBy: "ad",
    mediaMode: "metadata",
    start: input.start,
    end: input.end,
  });
  const response = await fetch(`/api/meta/creatives?${query.toString()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Ad-grain creative evidence is unavailable.");
  }
  const payload: unknown = await response.json();
  const rows: MetaCreativeApiRow[] =
    payload && typeof payload === "object" && Array.isArray((payload as { rows?: unknown }).rows)
      ? ((payload as { rows: MetaCreativeApiRow[] }).rows ?? [])
      : [];
  return rows
    .filter((row) => row.creative_id === input.creativeId)
    .map((row) => ({
      id: row.id,
      adsetId: row.adset_id ?? null,
      adsetName: row.adset_name ?? null,
      spend: numberOrNull(row.spend),
      purchaseValue: numberOrNull(row.purchase_value),
      roas: numberOrNull(row.roas),
      impressions: numberOrNull(row.impressions),
      linkClicks: numberOrNull(row.link_clicks),
      addToCart: numberOrNull(row.add_to_cart),
      purchases: numberOrNull(row.purchases),
      thumbstop: numberOrNull(row.thumbstop),
      launchDate: row.launch_date ?? null,
    }));
}

/**
 * The daily CTR / frequency trail behind the two sparkline cards.
 *
 * `meta_ad_daily` has stored date + ad_id + link_clicks + frequency all along —
 * indexed on (ad_id, date DESC) — but nothing read it as a series, so both
 * cards drew an empty path. `/api/meta/ads/series` is that read path and keeps
 * its own `requireBusinessAccess` gate.
 */
/**
 * The same daily trail, kept per ad, for the creative queue's row sparklines.
 *
 * The reference draws a CTR spark on every creative row and the adapter had no
 * series to give it, so each row rendered an empty box. The merged series the
 * evidence window uses would draw every row the same shape, so this asks the
 * route to group by ad. Capped by the route at 25 ads.
 */
async function fetchMetaQueueCtrSeries(input: {
  businessId: string;
  adIds: string[];
  start: string;
  end: string;
}): Promise<Map<string, number[]>> {
  if (input.adIds.length === 0) return new Map();
  const query = new URLSearchParams({
    businessId: input.businessId,
    adIds: input.adIds.join(","),
    start: input.start,
    end: input.end,
    groupBy: "ad",
  });
  const response = await fetch(`/api/meta/ads/series?${query.toString()}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("The per-ad daily series is unavailable.");
  const payload = (await response.json()) as {
    series?: Array<{ adId: string; points?: Array<{ ctr?: number | null }> }>;
  };
  const byAdId = new Map<string, number[]>();
  for (const entry of payload.series ?? []) {
    // The card is captioned "CTR · 28d" and the row beside it shows the
    // engine's `ctr_28d`, so the trail has to be the same all-clicks CTR.
    // `linkCtr` is a different measure and is currently 0 on every stored row.
    const values = (entry.points ?? [])
      .map((point) => point.ctr)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    // A single point is not a trend and the spark helper refuses it anyway.
    if (values.length >= 2) byAdId.set(entry.adId, values);
  }
  return byAdId;
}

async function fetchCreativeEvidenceAdSeries(input: {
  businessId: string;
  adIds: string[];
  start: string;
  end: string;
}): Promise<CreativeEvidenceWindowExactSeriesPayload> {
  const query = new URLSearchParams({
    businessId: input.businessId,
    adIds: input.adIds.join(","),
    start: input.start,
    end: input.end,
  });
  const response = await fetch(`/api/meta/ads/series?${query.toString()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("The per-ad daily series is unavailable.");
  }
  const payload = (await response.json()) as Partial<CreativeEvidenceWindowExactSeriesPayload>;
  return {
    adCount: typeof payload.adCount === "number" ? payload.adCount : 0,
    points: Array.isArray(payload.points) ? payload.points : [],
  };
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Does the served decision offer a Launchpad route at all?
 *
 * This reads the SERVED presentation code and nothing else. It does not decide
 * whether the route is authorized — that is the server's answer, given when the
 * handoff is minted. Keeping the two apart is the point: the screen may offer
 * the control the server captioned, and the server may still refuse it.
 */
function creativeEvidenceOffersLaunchpadRoute(input: {
  decision: MetaOsAdDecision | null;
  canonical: MetaCanonicalDecision;
}): boolean {
  const code = input.decision?.action.code ?? null;
  if (code !== "plan_promotion" && code !== "refresh_creative") return false;
  return Boolean(input.canonical.parentChain.creative?.id?.trim());
}

export interface MetaLaunchpadHandoffMintResult {
  ok: boolean;
  handoff: string | null;
  mode: string | null;
  message: string | null;
}

/**
 * Asks the server for a Launchpad handoff.
 *
 * The body NAMES a decision — business, account, decision id, snapshot id — and
 * asserts nothing about it. The authorized action, the mode, the eligibility
 * and the lineage all come back from the server, which re-reads the canonical
 * decision itself. This is the entire difference from the query string it
 * replaces: that URL carried claims, this one carries a question.
 */
export async function mintMetaLaunchpadHandoff(input: {
  businessId: string;
  providerAccountId: string;
  decisionId: string;
  sourceSnapshotId: string;
}): Promise<MetaLaunchpadHandoffMintResult> {
  let response: Response;
  try {
    response = await fetch("/api/meta/launchpad-handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(input),
    });
  } catch {
    return {
      ok: false,
      handoff: null,
      mode: null,
      message: "The launch handoff service could not be reached.",
    };
  }
  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  const message =
    typeof payload?.message === "string" && payload.message.trim()
      ? payload.message
      : null;
  const handoff =
    typeof payload?.handoff === "string" && payload.handoff.trim()
      ? payload.handoff
      : null;
  if (!response.ok || !handoff) {
    return {
      ok: false,
      handoff: null,
      mode: null,
      // Never invent a success sentence for a refusal, and never invent a
      // reason the server did not give.
      message: message ?? "The launch handoff was refused.",
    };
  }
  return {
    ok: true,
    handoff,
    mode: typeof payload?.mode === "string" ? payload.mode : null,
    message,
  };
}

/**
 * The Launchpad destination for a verified handoff.
 *
 * Only the reference travels. No mode, no step, no creative/campaign/ad-set
 * ids, no `fromMetaBriefing=true` — every one of those was a claim the URL had
 * no standing to make, and Launchpad was right to refuse them. What the launch
 * is FOR is read out of the handoff record server-side.
 */
function launchpadHandoffHref(input: {
  handoff: string;
  providerAccountId: string;
  pathname: string | null;
}): string {
  const params = new URLSearchParams({
    providerAccountId: input.providerAccountId,
    handoff: input.handoff,
  });
  return dashboardHrefForRouteFamily(
    `/platforms/meta/launchpad?${params.toString()}`,
    input.pathname ?? "",
  );
}

function creativeEvidenceStudioHref(input: {
  canonical: MetaCanonicalDecision;
  pathname: string | null;
}): string {
  const params = new URLSearchParams({
    providerAccountId: input.canonical.providerAccountId,
  });
  const creativeId = input.canonical.parentChain.creative?.id?.trim() || null;
  if (creativeId) params.set("creativeId", creativeId);
  return dashboardHrefForRouteFamily(
    `/platforms/meta/creatives?${params.toString()}`,
    input.pathname ?? "",
  );
}

function workspaceBannerPriority(banner: MetaWorkspaceBanner) {
  if (banner.id === "meta_write_kill_switch") return 0;
  if (banner.id === "dry_run_mode" || banner.id === "dry_run_only_guardrail")
    return 1;
  if (banner.id === "tracking_write_gate") return 2;
  if (banner.id === "reviewer_read_only" || banner.id === "workspace_read_only")
    return 3;
  if (banner.blocking) return 3;
  if (banner.id === "snapshot_health") return 4;
  if (banner.id === "data_readiness") return 5;
  return 6;
}

function workspaceBannerToneClass(banner: MetaWorkspaceBanner) {
  if (banner.tone === "danger") return "danger";
  if (banner.tone === "warning") return "warn";
  if (banner.tone === "success") return "success";
  return "info";
}

function workspaceBannerDetail(banner: MetaWorkspaceBanner) {
  if (banner.id === "tracking_write_gate") {
    return `${banner.detail} Pause, bid and rebuild writes ask for confirmation first. Hiding this banner does not unlock writes; the gate stays active.`;
  }
  if (banner.id === "meta_write_kill_switch") {
    return `${banner.detail} The queue stays readable; execute and route actions are locked until an Admin releases it.`;
  }
  return banner.detail;
}

function MetaWorkspacePostureBanners({
  banners,
  trackingDismissed,
  onDismissTracking,
  onOpenTrackingDetails,
}: {
  banners: MetaWorkspaceBanner[];
  trackingDismissed: boolean;
  onDismissTracking: () => void;
  onOpenTrackingDetails: () => void;
}) {
  const visibleBanners = [...banners]
    .filter(
      (banner) => !(banner.id === "tracking_write_gate" && trackingDismissed),
    )
    .sort(
      (left, right) =>
        workspaceBannerPriority(left) - workspaceBannerPriority(right),
    );
  if (visibleBanners.length === 0) return null;
  return (
    <div className="meta-posture-banners" data-testid="meta-posture-banners">
      {visibleBanners.map((banner) => {
        const tone = workspaceBannerToneClass(banner);
        return (
          <div
            key={banner.id}
            className={cn(
              "meta-posture-banner",
              `meta-posture-banner--${tone}`,
            )}
            data-banner-id={banner.id}
            data-banner-blocking={banner.blocking ? "true" : "false"}
            role={banner.blocking || tone === "danger" ? "alert" : "status"}
          >
            <span className="meta-posture-banner__mark" aria-hidden="true" />
            <span className="meta-posture-banner__title">{banner.title}</span>
            <span className="meta-posture-banner__detail">
              {workspaceBannerDetail(banner)}
            </span>
            <span className="meta-posture-banner__spacer" aria-hidden="true" />
            {banner.id === "meta_write_kill_switch" ? (
              <a
                className="meta-posture-banner__button"
                href="/platforms/meta/automation"
              >
                System Status
              </a>
            ) : null}
            {banner.id === "tracking_write_gate" ? (
              <>
                <button
                  type="button"
                  className="meta-posture-banner__button"
                  onClick={onOpenTrackingDetails}
                >
                  View details
                </button>
                <button
                  type="button"
                  className="meta-posture-banner__button meta-posture-banner__button--ghost"
                  onClick={onDismissTracking}
                >
                  Hide banner
                </button>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Header as-of cluster. Surfaces the divergent as-of contract already carried
 * by the payloads: ingest freshness (pulse.lastSyncAt), the served lane
 * snapshot date (lane-classify), and the engine version + run time (pulse).
 * Each value is real or an honest em dash — never fabricated "now".
 */
export function MetaPlatformPage({
  businessId,
  businessName,
  serverProviderAccountId = null,
}: MetaPlatformPageProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const selectedWindow = parseMetaWindow(searchParams.get("window"));
  const selectedStatusFilter: BriefingStatusFilter = "active";
  const initialLane = parseMetaWorkspaceLane(searchParams);
  const initialScope = parseMetaScope(searchParams);
  const requestedProviderAccountId =
    searchParams.get("providerAccountId")?.trim() || null;
  const [drillItem, setDrillItem] = useState<MetaDrillItem | null>(null);
  const [overlay, setOverlay] = useState<OverlayState>(EMPTY_OVERLAY);
  const [pendingPrimaryRec, setPendingPrimaryRec] =
    useState<MetaRecommendation | null>(null);
  const [trackingDismissed, setTrackingDismissed] = useState(false);
  /**
   * The compatibility answer is computed from the URL the operator arrived
   * with, once, so it states what THIS link did rather than re-announcing
   * itself every time the screen rewrites its own query string.
   */
  const arrivalCompatibility = useState(() =>
    describeMetaDeepLinkCompatibility(searchParams),
  )[0];
  /**
   * The Launchpad read site sends a refused handoff back here with its code.
   *
   * The code is validated against the closed refusal vocabulary and turned
   * into a sentence on this side; the URL never carries the sentence, so a
   * hand-edited link cannot put words on the screen. A refused handoff that
   * silently landed the operator on an empty Launchpad would read as success —
   * this is the half of the fail-closed path the operator can actually see.
   */
  const arrivalHandoffRefusal = useState(() =>
    parseLaunchpadHandoffRefusal(searchParams.get("handoffRefused")),
  )[0];
  const [notice, setNotice] = useState<MetaDecisionNotice | null>(
    arrivalHandoffRefusal
      ? {
          tone: "warning",
          title: "Launchpad handoff refused.",
          detail: describeLaunchpadHandoffRefusal(arrivalHandoffRefusal),
        }
      : arrivalCompatibility.length > 0
        ? {
            tone: "info",
            title:
              arrivalCompatibility.length === 1
                ? "One part of that link could not be restored."
                : `${arrivalCompatibility.length} parts of that link could not be restored.`,
            detail: metaDeepLinkCompatibilityDetail(arrivalCompatibility),
          }
        : null,
  );
  const [refreshingSnapshot, setRefreshingSnapshot] = useState(false);
  const [activeLane, setActiveLane] = useState<MetaLaneView>(initialLane);
  const [activeScope, setActiveScope] =
    useState<MetaDecisionCenterExactScope>(initialScope);
  const [labelModalOpen, setLabelModalOpen] = useState(false);
  const [rowSort, setRowSort] = useState<MetaRowSort>("money");
  // `q` is restored, not dropped: the retired contract's search parameter names
  // a control this surface actually has.
  const [rowSearch, setRowSearch] = useState(() =>
    parseMetaRowSearch(searchParams),
  );
  const [creativeDrill, setCreativeDrill] = useState<{
    decision: MetaOsAdDecision | null;
    canonical: MetaCanonicalDecision;
  } | null>(null);
  const latestSearchParamsRef = useRef(searchParams.toString());

  useEffect(() => {
    latestSearchParamsRef.current = searchParams.toString();
    setActiveLane(parseMetaWorkspaceLane(searchParams));
    setActiveScope(parseMetaScope(searchParams));
  }, [searchParams]);

  useEffect(() => {
    if (!labelModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLabelModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [labelModalOpen]);

  const providerAccountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", businessId],
    enabled: Boolean(businessId),
    queryFn: () => fetchMetaHistoryAccounts({ businessId }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const providerAccounts = providerAccountsQuery.data ?? [];
  const selectedProviderAccount = useMemo<MetaHistoryAccount | null>(() => {
    if (requestedProviderAccountId) {
      return (
        providerAccounts.find(
          (account) => account.id === requestedProviderAccountId,
        ) ?? null
      );
    }
    return providerAccounts.length === 1 ? providerAccounts[0]! : null;
  }, [providerAccounts, requestedProviderAccountId]);
  /**
   * Provider scope survives a failing accounts read.
   *
   * Every workspace read below is gated on this id, so when
   * `/api/meta/history/accounts` 500s the whole surface used to go empty even
   * for a business with exactly one assigned account the server had already
   * resolved. The server's answer is the fallback — it agrees with the client
   * rule (an unassigned requested id is refused, a multi-account business is
   * not chosen for), so it can only fill in, never widen. Presentation that
   * needs the account record (name, currency, timezone) still finds none and
   * stays on its honest em-dash path rather than inventing one.
   */
  const providerAccountId =
    selectedProviderAccount?.id ?? serverProviderAccountId ?? null;
  // KNOWN GAP, recorded rather than papered over. This clock only decides how
  // a BARE preset expands; a URL that states startDate/endDate wins outright,
  // and the shell states them on every navigation, so this is the first-load
  // edge. When the account record is unreadable the page falls to UTC while
  // the shell falls to the workspace timezone (app-topbar.tsx:259-263), so on
  // that edge the two can name different days. Closing it means forwarding the
  // business timezone as a server-owned prop through the shared shim; this
  // component deliberately has no client-store access, and reaching for one
  // here would rebuild the store-vs-server scope split just removed.
  const selectedAccountTimeZone = selectedProviderAccount?.timezone || "UTC";
  const selectedReferenceDate = getTodayIsoForTimeZone(selectedAccountTimeZone);
  const selectedDateRange = metaDateRangeFromParams(
    searchParams,
    selectedReferenceDate,
  );

  const creativeEvidenceCreativeId =
    creativeDrill?.canonical.parentChain.creative?.id?.trim() ||
    creativeDrill?.decision?.creativeId?.trim() ||
    null;
  const creativeEvidenceQuery = useQuery({
    queryKey: [
      "meta-creative-evidence-ad-rows",
      businessId,
      providerAccountId,
      creativeEvidenceCreativeId,
      selectedDateRange.start,
      selectedDateRange.end,
    ],
    enabled: Boolean(
      businessId && providerAccountId && creativeEvidenceCreativeId,
    ),
    queryFn: () =>
      fetchCreativeEvidenceAdRows({
        businessId,
        providerAccountId: providerAccountId!,
        creativeId: creativeEvidenceCreativeId!,
        start: selectedDateRange.start,
        end: selectedDateRange.end,
      }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  /**
   * The sparkline pair is the decision's own ad, not the creative's whole ad
   * set: the Frequency evidence key beside it is that ad's frequency, and a
   * cross-ad frequency would need a deduplicated reach Meta does not report.
   */
  const creativeEvidenceAdId =
    creativeDrill?.canonical.parentChain.ad?.id?.trim() ||
    creativeDrill?.decision?.adId?.trim() ||
    null;
  const creativeEvidenceSeriesQuery = useQuery({
    queryKey: [
      "meta-creative-evidence-series",
      businessId,
      creativeEvidenceAdId,
      selectedDateRange.start,
      selectedDateRange.end,
    ],
    enabled: Boolean(businessId && creativeEvidenceAdId),
    queryFn: () =>
      fetchCreativeEvidenceAdSeries({
        businessId,
        adIds: [creativeEvidenceAdId!],
        start: selectedDateRange.start,
        end: selectedDateRange.end,
      }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const workspaceQuery = useQuery({
    queryKey: [
      "meta-decisions-workspace",
      businessId,
      providerAccountId,
      selectedWindow,
      selectedStatusFilter,
      selectedDateRange.start,
      selectedDateRange.end,
    ],
    enabled: Boolean(businessId && providerAccountId),
    queryFn: () =>
      fetchDecisionsWorkspace(
        businessId,
        providerAccountId!,
        selectedWindow,
        selectedStatusFilter,
        selectedDateRange,
      ),
    // A transient upstream slowness (e.g. a cold route compile the first time the
    // decisions-workspace fan-out is hit) previously left a permanent empty shell
    // because retry was disabled. Retry with backoff so a one-off timeout self-heals.
    retry: 2,
    retryDelay: (attempt) => Math.min(1500 * 2 ** attempt, 6000),
  });
  /**
   * The CTR trail behind every creative row's sparkline.
   *
   * Keyed on the served ad ids so it refetches when the queue changes and not
   * when the operator types in the search box. Bounded to the route's own
   * 25-ad cap; rows beyond it keep the honest empty path rather than borrowing
   * another row's shape.
   */
  const queueCreativeAdIds = Array.from(
    new Set(
      (workspaceQuery.data?.os?.ads?.items ?? [])
        .map((decision) => decision.adId?.trim())
        .filter((adId): adId is string => Boolean(adId)),
    ),
  ).slice(0, 25);
  const queueCtrSeriesQuery = useQuery({
    queryKey: [
      "meta-queue-ctr-series",
      businessId,
      selectedDateRange.start,
      selectedDateRange.end,
      queueCreativeAdIds.join(","),
    ],
    enabled: Boolean(businessId) && queueCreativeAdIds.length > 0,
    queryFn: () =>
      fetchMetaQueueCtrSeries({
        businessId,
        adIds: queueCreativeAdIds,
        start: selectedDateRange.start,
        end: selectedDateRange.end,
      }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const pulseQuery = {
    data: workspaceQuery.data?.pulse,
    isLoading: workspaceQuery.isLoading,
    error: workspaceQuery.error,
  };
  const laneQuery = {
    data: workspaceQuery.data?.lanes,
    isLoading: workspaceQuery.isLoading,
    error: workspaceQuery.error,
  };
  const moneyCurrency = resolveMetaDecisionMoneyCurrency(
    pulseQuery.data?.currency,
    selectedProviderAccount?.currency,
  );
  const targetRoas = pulseQuery.data?.roas.target ?? null;
  const entityParam = searchParams.get("entity");
  const creativeSelection = parseMetaCreativeSelection(searchParams);
  // Stable dependency: `searchParams` is a fresh object every render, so the
  // restore effect keys on the identifiers themselves.
  const creativeSelectionKey = creativeSelection
    ? `${creativeSelection.adId ?? ""}|${creativeSelection.creativeId ?? ""}`
    : "";

  const anomalyQuery = useQuery({
    queryKey: [
      "meta-anomalies",
      businessId,
      providerAccountId,
      selectedWindow,
      selectedStatusFilter,
      selectedDateRange?.start ?? null,
      selectedDateRange?.end ?? null,
    ],
    enabled: Boolean(businessId && providerAccountId),
    queryFn: () =>
      fetchAnomalies(
        businessId,
        providerAccountId!,
        selectedStatusFilter,
        selectedDateRange,
      ),
  });
  useTierZeroFreshness({
    surface: "meta_decisions",
    isLoading: workspaceQuery.isLoading,
    isFetching: workspaceQuery.isFetching,
    error: workspaceQuery.error,
    asOf: measuredAsOf(workspaceQuery.data?.pulse.lastSyncAt ?? null),
    businessId,
    onRetry: () => void workspaceQuery.refetch(),
  });
  /**
   * The accounts read describes an account; it does not authorize a workspace.
   *
   * `/api/meta/history/accounts` supplies presentation metadata — display
   * name, currency, time zone. Scope authority comes from
   * `serverProviderAccountId` (assignment-verified server-side) or from a
   * picker selection made out of that same assignment-scoped list. Folding
   * this query's error and loading flags into the global briefing state meant
   * one failing metadata read blanked a Decisions surface whose workspace had
   * already loaded, and printed "Decision workspace could not load" over a
   * screen full of loaded decisions.
   *
   * LAW: when a provider account id exists, the workspace read proceeds and
   * owns the loading and error state alone. A metadata failure then downgrades
   * to the narrow warning below and the account's label/currency stay on their
   * honest em-dash path — never a fabricated name and never a default currency.
   * Only when there is no account id at all — nothing to read a workspace for —
   * does the metadata failure remain the blocking answer, because in that case
   * it genuinely is the reason nothing can be read.
   */
  const providerAccountMetadataError = (providerAccountsQuery.error ??
    null) as Error | null;
  const workspaceReadError = (pulseQuery.error ??
    laneQuery.error ??
    null) as Error | null;
  const briefingLoading =
    (providerAccountsQuery.isLoading && !providerAccountId) ||
    (Boolean(providerAccountId) &&
      (pulseQuery.isLoading || laneQuery.isLoading));
  const briefingError =
    workspaceReadError ??
    (providerAccountId ? null : providerAccountMetadataError);
  /**
   * Metadata degraded, workspace intact.
   *
   * Shown only when the workspace is readable, so it never competes with the
   * blocking banner. It states what is missing (the account record) rather
   * than implying the decisions on screen are suspect.
   */
  const providerAccountMetadataDegraded = Boolean(
    providerAccountMetadataError && providerAccountId,
  );
  /**
   * Retry is only a control if it retries the read that failed.
   *
   * The accounts read gates the workspace read whenever no server-authorized
   * account exists, so in that case refetching the workspace re-fires a
   * disabled query with a null account and changes nothing. Refetch accounts
   * first there; the workspace query re-enables itself the moment an account
   * exists. When an account id does exist, the blocking banner is the
   * workspace's own failure and the workspace is what must be retried.
   */
  const accountsReadIsTheBlockingFailure = Boolean(
    providerAccountMetadataError && !providerAccountId,
  );
  const briefingRetryPending = accountsReadIsTheBlockingFailure
    ? providerAccountsQuery.isFetching
    : workspaceQuery.isFetching;
  const retryBriefingRead = () =>
    accountsReadIsTheBlockingFailure
      ? providerAccountsQuery.refetch()
      : workspaceQuery.refetch();
  const campaignDefer = useDeferState({
    businessId,
    scopeType: "campaign",
    snapshotDate: laneQuery.data?.snapshotDate,
  });
  const adsetDefer = useDeferState({
    businessId,
    scopeType: "adset",
    snapshotDate: laneQuery.data?.snapshotDate,
  });

  const actionNow = laneQuery.data?.actionNow ?? [];
  const watching = laneQuery.data?.watching ?? [];
  const healthy = laneQuery.data?.healthy ?? [];
  const nonSales = laneQuery.data?.nonSales ?? [];
  const anomalies = anomalyQuery.data?.anomalies ?? [];

  // Row search + sort over structured server truth; missing-metric rows kept
  // last. Applied to the rendered rec lists only (tab counts stay lane totals).
  const visibleActionRecs = useMemo(
    () =>
      sortMetaRecs(
        actionNow.filter((rec) => metaRecSearchMatch(rec, rowSearch)),
        rowSort,
      ),
    [actionNow, rowSearch, rowSort],
  );
  const canonicalDecisionModel = workspaceQuery.data?.decisionReadModel ?? null;
  const creativeDecisionSection =
    canonicalDecisionModel?.status === "available"
      ? canonicalDecisionModel.queue.sections.creative_rotation
      : null;
  const inactiveStructureRows = laneQuery.data?.archive ?? [];
  const inactiveAdDecisions =
    canonicalDecisionModel?.queue.inactiveAssets?.items ?? [];
  const inactiveViewItems = useMemo(() => {
    const query = rowSearch.trim().toLowerCase();
    const structures = inactiveStructureRows
      .filter(
        (row) =>
          !query ||
          [row.name, row.campaignName ?? "", row.statusLabel].some((value) =>
            value.toLowerCase().includes(query),
          ),
      )
      .map((row) => ({ kind: "structure" as const, row, spend: row.spend }));
    const ads = inactiveAdDecisions
      .filter((decision) => canonicalCreativeSearchMatch(decision, rowSearch))
      .map((decision) => ({
        kind: "ad" as const,
        decision,
        spend: decision.metrics.spend ?? -1,
      }));
    return [...structures, ...ads].sort(
      (left, right) => right.spend - left.spend,
    );
  }, [inactiveAdDecisions, inactiveStructureRows, rowSearch]);
  // Presentation-only filters run over the server-selected top-N. They never
  // reclassify, rerank, or pull suppressed decisions into the client.
  const creativeActionDecisions = useMemo(() => {
    if (!creativeDecisionSection) return [] as MetaCanonicalDecision[];
    return creativeDecisionSection.items.filter((decision) =>
      canonicalCreativeSearchMatch(decision, rowSearch),
    );
  }, [creativeDecisionSection, rowSearch]);
  const visibleWatchingRecs = useMemo(
    () =>
      sortMetaRecs(
        watching.filter((rec) => metaRecSearchMatch(rec, rowSearch)),
        rowSort,
      ),
    [watching, rowSearch, rowSort],
  );
  const allRecs = useMemo(
    () => [...actionNow, ...watching],
    [actionNow, watching],
  );
  const adsetRecsByCampaign = useMemo(() => {
    const next = new Map<string, MetaRecommendation[]>();
    for (const rec of allRecs) {
      if (rec.level !== "adset" || !rec.campaignId) continue;
      next.set(rec.campaignId, [...(next.get(rec.campaignId) ?? []), rec]);
    }
    return next;
  }, [allRecs]);

  const trackingBlocked = isTrackingWriteBlocked(pulseQuery.data);
  const viewerReadOnlyReason = !workspaceQuery.data?.viewer
    ? "Decision authority is unavailable; write controls remain disabled."
    : workspaceQuery.data.viewer.readOnly
      ? (workspaceQuery.data.viewer.readOnlyReason ??
        "Current viewer is read-only; write controls are downgraded to review.")
      : null;
  const isViewerReadOnly = viewerReadOnlyReason !== null;
  const workspaceBanners = useMemo<MetaWorkspaceBanner[]>(() => {
    const served = workspaceQuery.data?.banners ?? [];
    if (served.length > 0) return served;
    const fallback: MetaWorkspaceBanner[] = [];
    const readiness = pulseQuery.data?.dataReadiness ?? null;
    if (readiness && (readiness.status !== "ok" || readiness.isPartial)) {
      fallback.push({
        id: "data_readiness",
        tone: "warning",
        title: "Data is not fully ready.",
        detail:
          readiness.notReadyReason ??
          "The selected range is partially verified; numbers may be incomplete.",
        blocking: false,
      });
    }
    if (trackingBlocked) {
      fallback.push({
        id: "tracking_write_gate",
        tone: "warning",
        title: "Tracking degraded — purchase signal may be incomplete.",
        detail:
          pulseQuery.data?.trackingHealth.detail ??
          "Hard actions stay gated until tracking is checked.",
        blocking: true,
      });
    }
    const snapshotHealth =
      pulseQuery.data?.snapshotHealth ?? laneQuery.data?.snapshotHealth ?? null;
    if (snapshotHealth && snapshotHealth.status !== "fresh") {
      fallback.push({
        id: "snapshot_health",
        tone: snapshotHealth.status === "missing" ? "danger" : "warning",
        title: "Decision snapshot is not fresh.",
        detail:
          snapshotHealth.staleReason ??
          "The served snapshot does not meet the current freshness contract.",
        blocking: snapshotHealth.status === "missing",
      });
    }
    if (workspaceQuery.data?.system.killSwitchEngaged) {
      fallback.push({
        id: "meta_write_kill_switch",
        tone: "danger",
        title: "Kill switch engaged.",
        detail:
          workspaceQuery.data.system.killSwitchReason ??
          "Meta writes are disabled by kill switch.",
        blocking: true,
      });
    }
    const viewer = workspaceQuery.data?.viewer ?? null;
    if (viewer?.readOnly && viewer.readOnlyReason) {
      fallback.push({
        id: viewer.isReviewer ? "reviewer_read_only" : "workspace_read_only",
        tone: "info",
        title: viewer.isReviewer
          ? "Reviewer access is read-only."
          : "Workspace access is read-only.",
        detail: viewer.readOnlyReason,
        blocking: false,
      });
    }
    return fallback;
  }, [workspaceQuery.data, pulseQuery.data, laneQuery.data, trackingBlocked]);

  const laneSnapshotDate = laneQuery.data?.snapshotDate ?? null;
  const deferredCount = campaignDefer.deferredCount + adsetDefer.deferredCount;

  const currentUrlParams = () =>
    new URLSearchParams(
      latestSearchParamsRef.current ||
        (typeof window === "undefined"
          ? searchParams.toString()
          : window.location.search),
    );

  const metaDecisionsHref = dashboardHrefForRouteFamily(
    "/platforms/meta",
    pathname,
  );

  const replaceMetaParams = (params: URLSearchParams) => {
    const query = params.toString();
    latestSearchParamsRef.current = query;
    router.replace(`${metaDecisionsHref}${query ? `?${query}` : ""}`);
  };

  const setDateRange = (next: DateWindowValue) => {
    const params = currentUrlParams();
    const nextWindow: MetaWindowKey =
      next.window === "7d" ||
      next.window === "14d" ||
      next.window === "28d" ||
      next.window === "90d"
        ? next.window
        : "custom";
    if (nextWindow === "28d") {
      params.delete("window");
    } else {
      params.set("window", nextWindow);
    }
    // Always state the dates, for presets too. Deleting them left the URL
    // saying only "7d" and every reader downstream re-resolving that name
    // against its own clock — which is how one picked preset became three
    // windows. The URL now carries the answer, not the question.
    params.set("startDate", next.start);
    params.set("endDate", next.end);
    const query = params.toString();
    const nextHref = `${metaDecisionsHref}${query ? `?${query}` : ""}`;
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", nextHref);
    }
    latestSearchParamsRef.current = query;
    router.replace(nextHref);
  };

  const selectExactWindow = (nextWindow: MetaDecisionCenterExactWindow) => {
    setDateRange(
      rangeValueToDateWindow(
        dateWindowToRangeValue({ window: nextWindow, start: "", end: "" }),
        selectedReferenceDate,
        // Completed days only — the same expansion the shell picker uses. This
        // read `includeCurrentDay: true`, so the in-page window tabs and the
        // shell picker disagreed by one day on the same preset name, and
        // today's part-day was counted as a whole one.
        { includeCurrentDay: DATE_WINDOW_INCLUDES_CURRENT_DAY },
      ),
    );
  };

  const setProviderAccount = (nextProviderAccountId: string) => {
    const params = currentUrlParams();
    if (nextProviderAccountId) {
      params.set("providerAccountId", nextProviderAccountId);
    } else {
      params.delete("providerAccountId");
    }
    params.delete("entity");
    setDrillItem(null);
    setCreativeDrill(null);
    replaceMetaParams(params);
  };

  /**
   * The search term is state the link carries, so it is written back.
   *
   * Restoring `q` on arrival but never re-minting it would make the URL lie
   * the other way: the operator filters, copies the address bar and sends a
   * colleague the unfiltered view. `replace` (not `push`) so typing does not
   * fill the history stack.
   */
  const setRowSearchParam = (next: string) => {
    setRowSearch(next);
    const params = currentUrlParams();
    const trimmed = next.trim().slice(0, META_DEEP_LINK_SEARCH_MAX_LENGTH);
    if (trimmed) params.set("q", trimmed);
    else params.delete("q");
    replaceMetaParams(params);
  };

  const selectScope = (next: MetaDecisionCenterExactScope) => {
    setActiveScope(next);
    const params = currentUrlParams();
    if (next === "creatives") params.set("scope", "creatives");
    else params.delete("scope");
    replaceMetaParams(params);
  };

  const selectLane = (next: MetaLaneView) => {
    setActiveLane(next);
    const params = currentUrlParams();
    params.delete("lane");
    if (next === "action") {
      params.delete("area");
      params.delete("segment");
    } else {
      params.set("area", "monitor");
      if (next === "watching") params.delete("segment");
      else if (next === "healthy") params.set("segment", "healthy");
      else if (next === "nonSales") params.set("segment", "out_of_scope");
      else params.set("segment", "structures");
    }
    replaceMetaParams(params);
  };

  const refreshDecisionData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["meta-decisions-workspace", businessId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["meta-anomalies", businessId],
      }),
    ]);
  };

  const refreshSnapshotNow = async () => {
    if (!businessId || refreshingSnapshot) return;
    if (isViewerReadOnly) {
      setNotice({
        tone: "info",
        title: "Snapshot refresh is unavailable.",
        detail:
          viewerReadOnlyReason ?? "Current viewer is read-only.",
      });
      return;
    }
    setRefreshingSnapshot(true);
    setNotice(null);
    try {
      const response = await fetch("/api/meta/snapshot/run-now", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({ businessId }),
      });
      const payload = await response.json().catch(() => null);
      const outcome = interpretMetaSnapshotRunResponse(response.ok, payload);
      if (!outcome.ok) throw new Error(outcome.message);
      setNotice({
        tone: outcome.status === "ran" ? "success" : "info",
        title:
          outcome.status === "cooldown"
            ? "Decision snapshot refresh is in cooldown."
            : outcome.status === "already_running"
              ? "Decision snapshot refresh is already running."
              : "Decision snapshot refreshed.",
      });
      await refreshDecisionData();
    } catch (error) {
      setNotice({
        tone: "danger",
        title: "Decision snapshot refresh failed.",
        detail: error instanceof Error ? error.message : null,
      });
    } finally {
      setRefreshingSnapshot(false);
    }
  };

  /**
   * True only when the response was actually recorded.
   *
   * The blanket `.catch(() => null)` this replaces absorbed transport errors
   * and never looked at the status at all, so a refused write was
   * indistinguishable from a stored one. The caller decides what to do with a
   * false; what it may not do is carry on as if the decision were recorded.
   */
  const markActed = async (
    rec: MetaRecommendation,
    subtype: string,
  ): Promise<boolean> => {
    if (isViewerReadOnly) return false;
    try {
      await postResponse({
        businessId,
        recId: rec.id,
        action: "acted",
        actionSubtype: subtype,
      });
      return true;
    } catch (error) {
      setNotice({
        tone: "danger",
        title: "Decision could not be recorded.",
        detail:
          error instanceof Error
            ? error.message
            : "The decision response endpoint refused the write.",
      });
      return false;
    }
  };

  const openOverlayForRec = (rec: MetaRecommendation, mode: MetaLaunchMode) => {
    if (mode === "apply_bid") {
      setNotice({
        tone: "info",
        title: "Recommendation is review-only.",
        detail:
          "Campaign and ad-set bid recommendations cannot write to Meta until a canonical execution-authority contract is available.",
      });
      openDrillForRec(rec);
      return;
    }
    setOverlay({ open: true, mode, rec });
  };

  const setEntityParam = (entityId: string | null) => {
    const params = currentUrlParams();
    if (entityId) {
      params.set("entity", entityId);
    } else {
      params.delete("entity");
    }
    replaceMetaParams(params);
  };

  const openDrillForRec = (rec: MetaRecommendation) => {
    emitProductInstrumentation({
      eventName: "decision_opened",
      surface: "meta_decisions",
      outcome: "ok",
      scope: "business",
      businessId,
    });
    setDrillItem({
      mode: "decision",
      rec,
      relatedRecs: rec.campaignId
        ? (adsetRecsByCampaign.get(rec.campaignId) ?? [])
        : [],
    });
    // Deep-link the open entity (a selection, not a drawer-local control).
    setEntityParam(rec.id);
  };

  // Deep-link restore: open the drawer for ?entity=<id> once lanes are loaded.
  useEffect(() => {
    if (!entityParam || drillItem) return;
    const rec = [...actionNow, ...watching, ...nonSales].find(
      (candidate) => candidate.id === entityParam,
    );
    if (rec) {
      setDrillItem({
        mode: "decision",
        rec,
        relatedRecs: rec.campaignId
          ? (adsetRecsByCampaign.get(rec.campaignId) ?? [])
          : [],
      });
    }
  }, [entityParam, laneQuery.data]);

  /**
   * Deep-link restore for a creative the URL names.
   *
   * `decisionsHrefForCreative` (lib/zero-base/creative/creative performance
   * rows) is a live producer of `creativeId` and `row=ad:<adId>`, and nothing
   * on this screen read either one — "Open in Decisions" landed on the queue
   * with the wrong scope and nothing selected, which is precisely the failure
   * that link's own contract says it is guarding against.
   *
   * Same law as the `?entity=` restore above: match only against decisions the
   * server actually served, and when the named row is not in the served
   * universe do nothing. A named-but-unserved creative gets no drill rather
   * than a fabricated one.
   */
  const findSelectedCanonicalDecision = () =>
    creativeSelection
      ? ([
          ...(creativeDecisionSection?.items ?? []),
          ...inactiveAdDecisions,
        ].find((decision) =>
          matchesMetaCreativeSelection(decision, creativeSelection),
        ) ?? null)
      : null;

  useEffect(() => {
    if (!creativeSelection || creativeDrill) return;
    const canonical = findSelectedCanonicalDecision();
    if (!canonical) return;
    // The presentation decision carries CTR, frequency and ad-set identity the
    // canonical envelope does not; null when the queue served no counterpart,
    // exactly as the review callback allows.
    const presentation =
      (workspaceQuery.data?.os?.ads?.items ?? []).find(
        (item) =>
          item.decisionId === canonical.decisionId &&
          item.sourceSnapshotId === canonical.sourceSnapshotId,
      ) ?? null;
    setCreativeDrill({ decision: presentation, canonical });
  }, [creativeSelectionKey, workspaceQuery.data]);

  /**
   * A selection the server did not serve is still a dropped parameter.
   *
   * The two restore effects above correctly refuse to fabricate a row for an
   * id the workspace did not serve — but refusing silently is the same
   * experience as ignoring the parameter: the operator pasted a link naming a
   * row and got the unfiltered queue with no explanation, and could not tell
   * whether the link was wrong, the window was wrong, or the screen was
   * broken. State it. The report is keyed and fires once per named selection,
   * so dismissing it stays dismissed and the screen does not nag.
   *
   * Deliberately computed from the served universe rather than from
   * `drillItem`/`creativeDrill`: those are set by the effects above during the
   * same commit, so reading them here would report a false miss on first pass.
   */
  const unservedSelectionReportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspaceQuery.data || workspaceQuery.isLoading || workspaceQuery.error)
      return;
    const unresolved: MetaDeepLinkCompatibilityEntry[] = [];
    const entityServed =
      !entityParam ||
      [...actionNow, ...watching, ...nonSales].some(
        (candidate) => candidate.id === entityParam,
      );
    if (entityParam && !entityServed) {
      unresolved.push({
        param: "entity",
        value: entityParam,
        behaviour:
          "the workspace did not serve that decision in this window, so no evidence drawer was opened",
      });
    }
    if (creativeSelection && !findSelectedCanonicalDecision()) {
      if (creativeSelection.adId) {
        unresolved.push({
          param: "row",
          value: `ad:${creativeSelection.adId}`,
          behaviour:
            "the workspace served no decision for that ad in this window, so no creative was selected",
        });
      }
      if (creativeSelection.creativeId) {
        unresolved.push({
          param: "creativeId",
          value: creativeSelection.creativeId,
          behaviour:
            "the workspace served no decision for that creative in this window, so no creative was selected",
        });
      }
    }
    if (unresolved.length === 0) return;
    const reportKey = unresolved
      .map((entry) => `${entry.param}=${entry.value}`)
      .join("|");
    if (unservedSelectionReportedRef.current === reportKey) return;
    unservedSelectionReportedRef.current = reportKey;
    const combined = [...arrivalCompatibility, ...unresolved];
    setNotice({
      tone: "info",
      title:
        combined.length === 1
          ? "One part of that link could not be restored."
          : `${combined.length} parts of that link could not be restored.`,
      detail: metaDeepLinkCompatibilityDetail(combined),
    });
  }, [
    entityParam,
    creativeSelectionKey,
    workspaceQuery.data,
    workspaceQuery.isLoading,
    workspaceQuery.error,
  ]);

  const isTrackingSensitiveRec = (rec: MetaRecommendation) => {
    return rec.actionKind === "route_launchpad_rebuild";
  };

  const performPrimary = async (rec: MetaRecommendation) => {
    if (isViewerReadOnly) {
      setNotice({
        tone: "info",
        title: "Read-only access.",
        detail: viewerReadOnlyReason,
      });
      openDrillForRec(rec);
      return;
    }
    setNotice(null);
    // Campaign/ad-set recommendation cards are advisory until they carry a
    // canonical decision-origin execution contract. launchModeForRec fails
    // closed for stale/injected execute_* values, so this path has no provider
    // mutation endpoint.
    const mode = launchModeForRec(rec);
    if (mode) {
      openOverlayForRec(rec, mode);
      return;
    }
    if (
      rec.actionKind === "execute_pause" ||
      rec.actionKind === "execute_resume" ||
      rec.actionKind === "execute_bid"
    ) {
      setNotice({
        tone: "info",
        title: "Recommendation is review-only.",
        detail:
          "The served hint carries no canonical provider-write authority; the evidence inspector holds what is known.",
      });
    }
    openDrillForRec(rec);
  };

  const handlePrimary = async (rec: MetaRecommendation) => {
    if (isViewerReadOnly) {
      openDrillForRec(rec);
      return;
    }
    if (trackingBlocked && isTrackingSensitiveRec(rec)) {
      setPendingPrimaryRec(rec);
      return;
    }
    await performPrimary(rec);
  };

  const confirmOverlay = async () => {
    const rec = overlay.rec;
    if (!rec) return;
    if (isViewerReadOnly) {
      setNotice({
        tone: "info",
        title: "Read-only access.",
        detail: viewerReadOnlyReason,
      });
      setOverlay(EMPTY_OVERLAY);
      openDrillForRec(rec);
      return;
    }
    setNotice(null);
    if (overlay.mode === "apply_bid") {
      setNotice({
        tone: "info",
        title: "Recommendation is review-only.",
        detail:
          "Campaign and ad-set bid recommendations cannot write to Meta without canonical execution authority.",
      });
      setOverlay(EMPTY_OVERLAY);
      openDrillForRec(rec);
      return;
    }
    const href = launchpadHrefForRec(rec, overlay.mode);
    const recorded = await markActed(
      rec,
      overlay.mode === "rebuild" ? "rebuild_clicked" : "audience_swap_clicked",
    );
    // Navigating on a refused write presented a failure as success: the
    // operator landed on Launchpad believing the decision was taken while it
    // was still queued in Action Now. Close the overlay so the danger notice
    // markActed just set is readable, and let the operator confirm again.
    if (!recorded) {
      setOverlay(EMPTY_OVERLAY);
      return;
    }
    // Say what did NOT travel. A campaign/ad-set recommendation has no
    // canonical ad-grain decision, so there is nothing to mint a
    // server-verified handoff from — Launchpad opens as a manual start in the
    // requested mode, and the decision stays where the evidence for it is.
    setNotice({
      tone: "info",
      title: "Launchpad opened without decision lineage.",
      detail:
        "This recommendation is at campaign/ad-set level, so no canonical ad decision could be carried into the launch. The wizard starts manually in the requested mode; the decision itself stays in Action now with its evidence.",
    });
    router.push(dashboardHrefForRouteFamily(href, pathname));
  };

  /**
   * The one real Decisions -> Launchpad handoff on this screen.
   *
   * The old primary was an `<a href>` into
   * `?fromMetaBriefing=true&sourceDecisionId=…&creativeIds=…&mode=…`. Every
   * one of those values was a claim written by the page that emitted the link,
   * so Launchpad refused all of it and the link did nothing.
   *
   * Now the click asks the server, which re-reads the canonical decision and
   * either mints a single-use handoff record or refuses with a reason. The
   * screen navigates only on `ok` — a refusal stays on the evidence window and
   * says why. Nothing here executes: a verified handoff opens a Launchpad
   * draft.
   */
  const [handoffPending, setHandoffPending] = useState(false);
  const openLaunchpadFromCanonicalDecision = async (
    canonical: MetaCanonicalDecision,
  ) => {
    if (handoffPending) return;
    if (isViewerReadOnly) {
      setNotice({
        tone: "info",
        title: "Read-only access.",
        detail: viewerReadOnlyReason,
      });
      return;
    }
    if (!providerAccountId) {
      setNotice({
        tone: "warning",
        title: "No Meta ad account is in scope.",
        detail:
          "A launch handoff is minted against an assigned provider account; none is resolved for this workspace.",
      });
      return;
    }
    setHandoffPending(true);
    setNotice(null);
    try {
      const minted = await mintMetaLaunchpadHandoff({
        businessId,
        providerAccountId,
        decisionId: canonical.decisionId,
        sourceSnapshotId: canonical.sourceSnapshotId,
      });
      if (!minted.ok || !minted.handoff) {
        setNotice({
          tone: "warning",
          title: "Launchpad handoff refused.",
          detail: minted.message ?? "The launch handoff was refused.",
        });
        return;
      }
      router.push(
        launchpadHandoffHref({
          handoff: minted.handoff,
          providerAccountId,
          pathname,
        }),
      );
    } finally {
      setHandoffPending(false);
    }
  };

  const loading = briefingLoading;
  const error = briefingError ?? ((anomalyQuery.error ?? null) as Error | null);

  const exactCanonicalKeys = new Set(
    creativeActionDecisions.map(
      (decision) => `${decision.decisionId}\u0000${decision.sourceSnapshotId}`,
    ),
  );
  const exactCreativeDecisions = (workspaceQuery.data?.os?.ads?.items ?? []).filter(
    (decision) =>
      exactCanonicalKeys.has(
        `${decision.decisionId}\u0000${decision.sourceSnapshotId}`,
      ) &&
      metaOsCreativeSearchMatch(decision, rowSearch),
  );
  const exactArchiveRows = inactiveViewItems.flatMap((item) =>
    item.kind === "structure" ? [item.row] : [],
  );
  const exactActionRows = sortMetaRecs(
    actionNow.filter(
      (recommendation) => metaRecSearchMatch(recommendation, rowSearch),
    ),
    rowSort,
  );
  const exactWatchingRows = sortMetaRecs(
    watching.filter(
      (recommendation) => metaRecSearchMatch(recommendation, rowSearch),
    ),
    rowSort,
  );
  const exactNonSalesRows = sortMetaRecs(
    nonSales.filter(
      (recommendation) => metaRecSearchMatch(recommendation, rowSearch),
    ),
    rowSort,
  );
  const exactHealthyRows = healthy.filter(
    (row) =>
      !rowSearch.trim() ||
      [row.name, row.campaignName ?? ""].some((value) =>
        value.toLowerCase().includes(rowSearch.trim().toLowerCase()),
      ),
  );
  const exactViewModel: MetaDecisionCenterExactViewModel = workspaceQuery.data
    ? buildMetaDecisionCenterExactViewModel({
        workspace: workspaceQuery.data,
        account: selectedProviderAccount,
        now: Date.now(),
        selection:
          drillItem && drillItem.mode !== "anomaly"
            ? {
                kind: "structure",
                recommendationId: drillItem.rec.id,
              }
            : undefined,
        overrides: {
          actionNow: exactActionRows,
          watching: exactWatchingRows,
          healthy: exactHealthyRows,
          nonSales: exactNonSalesRows,
          archive: exactArchiveRows,
          creatives: exactCreativeDecisions,
          canonicalDecisions: creativeActionDecisions,
          creativeCtrSeriesByAdId: queueCtrSeriesQuery.data,
          deferredCount,
        },
        callbacks: {
          onStructurePrimary:
            !isViewerReadOnly && !workspaceQuery.data.system.killSwitchEngaged
              ? (recommendation) => {
                  void handlePrimary(recommendation);
                }
              : undefined,
          onStructureMenu: openDrillForRec,
          onWatchingReview: openDrillForRec,
          onCreativeReview: (decision, canonicalDecision) => {
            if (canonicalDecision) {
              // The presentation decision carries CTR, frequency and the ad
              // set identity the canonical envelope does not; the evidence
              // window needs both.
              emitProductInstrumentation({
                eventName: "decision_evidence_viewed",
                surface: "meta_decisions",
                outcome: "ok",
                scope: "business",
                businessId,
              });
              setCreativeDrill({ decision, canonical: canonicalDecision });
              return;
            }
            setNotice({
              tone: "warning",
              title: "Canonical creative evidence is unavailable.",
              detail:
                "The served decision has no canonical envelope, so the evidence window cannot be opened for it.",
            });
          },
        },
      })
    : {
        activeWindow: exactWindowForMetaWindow(selectedWindow),
        identity: {
          accountLabel:
            selectedProviderAccount?.name ?? selectedProviderAccount?.id ?? null,
          currency: moneyCurrency,
        },
      };

  return (
    <div
      className={cn("ad-final meta-decisions-final", styles.metaPageRoot)}
      data-testid="meta-platform-page"
      data-workspace-query-status={workspaceQuery.status}
      data-workspace-fetch-status={workspaceQuery.fetchStatus}
    >
      {drillItem ? (
        <MetaMobileEvidenceScreen
          item={drillItem}
          targetRoas={targetRoas}
          moneyCurrency={moneyCurrency}
          onBack={() => setDrillItem(null)}
        />
      ) : (
        <MetaMobileDecisionsScreen
          businessName={businessName}
          moneyCurrency={moneyCurrency}
          pulse={pulseQuery.data ?? null}
          laneSnapshotDate={laneSnapshotDate}
          loading={loading}
          error={error}
          anomalies={anomalies}
          actionRows={visibleActionRecs}
          watchingRows={visibleWatchingRecs}
          targetRoas={targetRoas}
          onOpenRec={(rec) => openDrillForRec(rec)}
          onOpenAnomaly={(anomaly) =>
            setDrillItem({ mode: "anomaly", anomaly })
          }
        />
      )}

      <div className={styles.metaOsDesktop} data-testid="meta-os-decisions">
        {/*
          A failed accounts read is not "no assigned account". Offering the
          picker with "No assigned account" while the read that would have
          filled it is broken presents a read failure as an empty success; the
          blocking banner below states the failure instead.
        */}
        {!providerAccountsQuery.isLoading &&
        !providerAccountId &&
        !providerAccountMetadataError ? (
          <div className="banner warn" data-testid="meta-account-required">
            <div className="icon">i</div>
            <div className="msg">
              <b>Select a Meta ad account.</b>
              <span className="sub">
                Decisions stay withheld until an explicitly assigned provider
                account defines identity and currency scope.
              </span>
              <label>
                <span className="sr-only">Meta ad account</span>
                <select
                  aria-label="Meta ad account"
                  value=""
                  onChange={(event) =>
                    setProviderAccount(event.currentTarget.value)
                  }
                >
                  <option value="">
                    {providerAccounts.length === 0
                      ? "No assigned account"
                      : "Select account"}
                  </option>
                  {providerAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name ?? account.id}
                      {account.currency ? " · " + account.currency : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ) : null}

        {briefingError ? (
          <div
            className="banner danger"
            data-testid="meta-briefing-error"
            role="alert"
          >
            <div className="icon">!</div>
            <div className="msg">
              <b>Decision workspace could not load.</b>
              <span className="sub">
                {describeDecisionWorkspaceFailure(briefingError)}
              </span>
            </div>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="meta-briefing-retry"
              disabled={briefingRetryPending}
              // Retry the read that actually failed. This button always
              // refetched the workspace query, but when the accounts read is
              // the one that broke, `providerAccountId` is null and the
              // workspace query is disabled — so Retry re-fired a query that
              // could not succeed and only a full page reload recovered the
              // surface.
              onClick={() => void retryBriefingRead()}
            >
              {briefingRetryPending ? "Retrying..." : "Retry"}
            </button>
          </div>
        ) : null}

        {/*
          Narrow, and narrow on purpose: the account RECORD is missing, not the
          workspace. Same `banner warn` presentation as the integrity-scan
          notice, so nothing new is introduced to the layout; what changed is
          that this failure no longer escalates into the blocking banner above.
        */}
        {providerAccountMetadataDegraded ? (
          <div
            className="banner warn"
            data-testid="meta-account-metadata-warning"
            role="status"
          >
            <div className="icon">i</div>
            <div className="msg">
              <b>Account details are unavailable.</b>
              <span className="sub">
                The assigned account is in scope and its decisions loaded, but
                the account record could not be read, so its name and currency
                show as &quot;—&quot; rather than a guess.
                {providerAccountMetadataError
                  ? ` ${providerAccountMetadataError.message}`
                  : ""}
              </span>
            </div>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="meta-account-metadata-retry"
              disabled={providerAccountsQuery.isFetching}
              onClick={() => void providerAccountsQuery.refetch()}
            >
              {providerAccountsQuery.isFetching ? "Retrying..." : "Retry"}
            </button>
          </div>
        ) : null}

        {anomalyQuery.error && !briefingError ? (
          <div className="banner warn" data-testid="meta-anomaly-error" role="alert">
            <div className="icon">!</div>
            <div className="msg">
              <b>Integrity scan is unavailable.</b>
              <span className="sub">
                {anomalyQuery.error instanceof Error
                  ? anomalyQuery.error.message
                  : "Integrity evidence is withheld; the decision workspace remains readable."}
              </span>
            </div>
          </div>
        ) : null}

        {notice ? (
          <div
            className={cn("banner", metaNoticeToneClass(notice.tone))}
            data-testid="meta-decision-notice"
            role={notice.tone === "danger" ? "alert" : "status"}
          >
            <div className="icon">{notice.tone === "danger" ? "!" : "i"}</div>
            <div className="msg">
              <b>{notice.title}</b>
              <span className="sub">
                {notice.detail ??
                  selectedProviderAccount?.name ??
                  selectedProviderAccount?.id ??
                  "Selected account"}
              </span>
            </div>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setNotice(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {workspaceQuery.data?.decisionReadModel.status === "unavailable" ? (
          <div
            className="banner danger"
            data-testid="meta-decision-unavailable"
            role="alert"
          >
            <div className="icon">!</div>
            <div className="msg">
              <b>Canonical decision source is unavailable.</b>
              <span className="sub">
                {workspaceQuery.data.decisionReadModel.unavailable?.message ??
                  "Decision rows are withheld because source authority could not be verified."}
              </span>
            </div>
          </div>
        ) : null}

        <MetaWorkspacePostureBanners
          banners={workspaceBanners}
          trackingDismissed={trackingDismissed}
          onDismissTracking={() => setTrackingDismissed(true)}
          onOpenTrackingDetails={() =>
            setDrillItem(
              anomalies[0] ? { mode: "anomaly", anomaly: anomalies[0] } : null,
            )
          }
        />

        <MetaDecisionCenterExact
          viewModel={exactViewModel}
          lane={exactLaneForMetaLane(activeLane)}
          scope={activeScope}
          onScopeChange={selectScope}
          // Action Now keeps the reference's resting two-column state. Watching
          // opens the column only after Review picked a row, so the button has
          // somewhere to put the evidence instead of doing nothing.
          inspectorOpen={activeLane !== "watching" || drillItem !== null}
          onLaneChange={(lane) => selectLane(metaLaneForExactLane(lane))}
          onWindowChange={selectExactWindow}
          onRunSnapshot={
            providerAccountId && !refreshingSnapshot && !isViewerReadOnly
              ? () => void refreshSnapshotNow()
              : undefined
          }
          onNewCampaign={
            providerAccountId && !isViewerReadOnly
              ? () => {
                  // "+ New campaign" is a manual start, not a decision
                  // handoff. Sending `fromMetaBriefing=true&mode=duplicate`
                  // made Launchpad read the URL as decision lineage, and
                  // Launchpad deliberately fails that closed
                  // (hasServerAuthorizedLaunchpadHandoff is always false:
                  // URL identifiers are not execution authority). The handoff
                  // then suppressed launchpadMode/launchpadStep, so the button
                  // landed on "Source & mode" announcing missing lineage with
                  // the Duplicate card disabled — it never started anything.
                  // A real Duplicate needs a server-authorized lineage
                  // contract, not an opened gate; this button asks for the
                  // manual new-campaign start it is named after.
                  const params = new URLSearchParams({
                    providerAccountId,
                    launchpadMode: "new_campaign",
                    launchpadStep: "source",
                  });
                  router.push(
                    dashboardHrefForRouteFamily(
                      "/platforms/meta/launchpad?" + params.toString(),
                      pathname,
                    ),
                  );
                }
              : undefined
          }
          onManageLabels={
            providerAccountId && !isViewerReadOnly
              ? () => setLabelModalOpen(true)
              : undefined
          }
          onSortChange={setRowSort}
          onSearchChange={setRowSearchParam}
          initialQuery={rowSearch}
          onOpenCreativeStudio={() => {
            const query = providerAccountId
              ? "?providerAccountId=" + encodeURIComponent(providerAccountId)
              : "";
            router.push(
              dashboardHrefForRouteFamily(
                "/platforms/meta/creatives" + query,
                pathname,
              ),
            );
          }}
        />
      </div>

      {creativeDrill ? (
        <CreativeEvidenceWindowExact
          onClose={() => setCreativeDrill(null)}
          viewModel={buildCreativeEvidenceWindowExactViewModel({
            decision: creativeDrill.decision,
            canonical: creativeDrill.canonical,
            adRows: creativeEvidenceQuery.data,
            adSeries: creativeEvidenceSeriesQuery.data,
            fallbackCurrency: moneyCurrency,
            // The primary is a control, not a link, because the destination
            // does not exist until the server mints it. Same slot, same label,
            // same styling — what changed is that clicking it now produces a
            // verified handoff or a stated refusal instead of a URL Launchpad
            // was always going to throw away.
            callbacks: creativeEvidenceOffersLaunchpadRoute({
              decision: creativeDrill.decision,
              canonical: creativeDrill.canonical,
            })
              ? {
                  onPrimary: () => {
                    void openLaunchpadFromCanonicalDecision(
                      creativeDrill.canonical,
                    );
                  },
                }
              : undefined,
            hrefs: {
              primary: null,
              compareInStudio: creativeEvidenceStudioHref({
                canonical: creativeDrill.canonical,
                pathname,
              }),
              adsManager: buildMetaAdsManagerHref({
                providerAccountId: creativeDrill.canonical.providerAccountId,
                adId:
                  creativeDrill.canonical.parentChain.ad?.id ??
                  creativeDrill.decision?.adId ??
                  null,
              }),
            },
          })}
        />
      ) : null}

      {labelModalOpen ? (
        <div
          className="modal-backdrop meta-label-modal-backdrop"
          data-meta-label-management-modal
          onMouseDown={() => setLabelModalOpen(false)}
        >
          <div
            className="meta-label-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="meta-label-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="meta-label-modal-head">
              <div>
                <h2 id="meta-label-modal-title">Campaign context exceptions</h2>
                <p>
                  Automatic context is the default. Use an override only when
                  the inferred role is wrong.
                </p>
              </div>
              <button
                type="button"
                className="btn btn--ghost"
                aria-label="Close campaign context exceptions"
                onClick={() => setLabelModalOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="meta-label-modal-body">
              <MetaCampaignLabelsSection businessId={businessId} />
            </div>
          </div>
        </div>
      ) : null}

      <MetaLaunchpadOverlay
        open={overlay.open}
        mode={overlay.mode}
        item={{
          id: overlay.rec ? scopeIdForRec(overlay.rec) : "meta",
          name: overlay.rec ? scopeNameForRec(overlay.rec) : "Meta action",
          campaign: overlay.rec?.campaignName,
          proposedBidCap: overlay.rec
            ? (proposedBidDisplayValue(overlay.rec) ?? undefined)
            : undefined,
          currencyCode: moneyCurrency ?? undefined,
        }}
        onClose={() => setOverlay(EMPTY_OVERLAY)}
        onConfirm={confirmOverlay}
      />

      <TrackingConfirmModal
        open={pendingPrimaryRec != null}
        primaryLabel={trackingConfirmLabelForRec(pendingPrimaryRec)}
        onClose={() => setPendingPrimaryRec(null)}
        onConfirm={() => {
          const rec = pendingPrimaryRec;
          setPendingPrimaryRec(null);
          if (rec) void performPrimary(rec);
        }}
      />
    </div>
  );
}
