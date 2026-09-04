"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  META_DECISIONS_AD_CANDIDATE_LIMIT,
  META_DECISIONS_AD_CANDIDATE_MAX_LIMIT,
  type MetaCanonicalDecision,
} from "@/lib/meta/decisions-workspace-contract";
import {
  describeDecisionWorkspaceFailure,
  MetaRequestFailure,
} from "@/lib/meta/workspace-failure";
import type {
  MetaOsAdDecision,
  MetaOsDecisionAction,
} from "@/lib/meta/decisions-os-contract";
import { dashboardHrefForRouteFamily } from "@/lib/dashboard-v2/screen-registry";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import {
  authorizeLaunchpadHandoff,
  describeLaunchpadHandoffRefusal,
  parseLaunchpadHandoffRefusal,
} from "@/lib/meta/launchpad-handoff-contract";
import {
  DATE_WINDOW_INCLUDES_CURRENT_DAY,
  resolveDateWindowFromParams,
} from "@/lib/dashboard/date-window-url";
import { cn } from "@/lib/utils";
import { MetaLaunchpadOverlay } from "@/components/meta/redesign/MetaLaunchpadOverlay";
import {
  authorizeMetaNativeAdPause,
  describeMetaNativeAdPauseFailure,
  executeMetaNativeAdPause,
  type MetaNativeAdPauseAuthorization,
} from "@/components/meta/redesign/meta-native-ad-pause";
import {
  MetaDecisionCenterExact,
  type MetaDecisionCenterExactDisplayValue,
  type MetaDecisionCenterExactInspectorViewModel,
  type MetaDecisionCenterExactLane,
  type MetaDecisionCenterExactScope,
  type MetaDecisionCenterExactTone,
  type MetaDecisionCenterExactViewModel,
  type MetaDecisionCenterExactWindow,
  type MetaDecisionCenterExactRowWorkflowChip,
  type MetaDecisionCenterExactWorkflow,
} from "@/components/meta/decision-center/MetaDecisionCenterExact";
import { BudgetDecisionEvidencePanel } from "@/components/meta/decision-center/BudgetDecisionEvidencePanel";
import { BudgetDryRunPanel } from "@/components/meta/decision-center/BudgetDryRunPanel";
import {
  buildMetaDecisionCenterExactViewModel,
  buildMetaStructureInventoryViewModel,
  type MetaDecisionCenterExactArchiveItem,
  type MetaStructureInventoryViewModel,
} from "@/components/meta/decision-center/meta-decision-center-exact-adapter";
import {
  CreativeEvidenceWindowExact,
  type CreativeEvidenceWindowExactViewModel,
} from "@/components/creatives/CreativeEvidenceWindowExact";
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
import { MutationCeremonyPanel } from "@/components/zero-base/meta/decisions/mutation-ceremony-panel";
import { buildMutationCeremonySeed } from "@/components/zero-base/meta/decisions/mutation-ceremony-seed";
import { toDecisionRow } from "@/lib/zero-base/meta/decisions-presentation";
import {
  useDecisionWorkflow,
  WORKFLOW_ACTION_LABELS,
  type DecisionWorkflowConflict,
  type DecisionWorkflowReadState,
} from "@/components/meta/redesign/use-decision-workflow";
import {
  reapplyPlan,
  WORKFLOW_STATE_LABEL,
} from "@/lib/zero-base/meta/workflow-view-model";
import type { WorkflowRecord } from "@/lib/decision-workflow";
import { buildDecisionWorkflowViewModel } from "@/components/meta/redesign/decision-workflow-view-model";
import { DECISION_WORKFLOW_KEY_CAP } from "@/lib/meta/decision-workflow-limits";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import {
  publishMetaSurfaceRefreshing,
  publishMetaSurfaceState,
} from "@/components/meta/meta-surface-state-live";
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
  /**
   * Whether decision ownership actions may run, read from the server's gate.
   *
   * `undefined` is a mount that proved nothing, and an unproven gate is closed
   * — the same fail-closed reading Launchpad's `executionEnabled` uses. The
   * workflow STATE is shown regardless; only the transitions are gated.
   */
  decisionWorkflowUiEnabled?: boolean;
  /**
   * The manual action sheet's own gate (`ZERO_BASE_MUTATION_UI_ENABLED`).
   *
   * A SECOND, independent flag from the workflow one — opening either does not
   * open the other — and, like every release gate here, off by default.
   */
  mutationUiEnabled?: boolean;
}

type AuthorizedMetaNativeAdPause = Extract<
  MetaNativeAdPauseAuthorization,
  { ok: true }
>;

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
  { ok: true; status: MetaSnapshotRunStatus } | { ok: false; message: string } {
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
  /*
   * The route answers in TWO envelope shapes, and this reads both.
   *
   * Its own validation failure is flat — `{ok:false, error:"missing_business_id",
   * message}` — while every guard it delegates to answers nested:
   * `rejectIfReviewerReadOnly` and the demo-authority guard both return
   * `{ok:false, error:{code, message}}`. Reading only the top level meant the
   * reviewer's own sentence, and now the demo refusal, reached the operator as
   * the generic "Snapshot refresh failed." — a refusal nobody can read is a
   * refusal they will retry.
   *
   * Neither sentence is composed here. This picks the one the server wrote.
   */
  const nested =
    record && typeof record.error === "object" && record.error !== null
      ? (record.error as { message?: unknown }).message
      : null;
  const served =
    typeof record?.message === "string" && record.message.trim()
      ? record.message
      : typeof nested === "string" && nested.trim()
        ? nested
        : null;
  const message =
    served ??
    (responseOk
      ? "Snapshot refresh returned an invalid response."
      : "Snapshot refresh failed.");
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

type MetaLaneView =
  | "action"
  | "needsres"
  | "watching"
  | "healthy"
  | "nonSales"
  | "archive";

/**
 * Two lane vocabularies reach this screen and both now resolve.
 *
 * The live one is `needsres|watching|healthy|nonSales|archive` (plus the
 * implicit `action`). The older one is `act|test|watch`, from the decisions URL
 * contract in `lib/zero-base/meta/decisions-url-state.ts`; links carrying it
 * still exist in pasted URLs and bookmarks. Those used to fall through the
 * default and render Action Now — a link that says `lane=watch` silently
 * showing a different lane is a lie about what the recipient is looking at.
 *
 * `test` was the one that could not be honoured: it is that contract's name for
 * the server's `blocked` state, and this queue had no lane for a blocked
 * decision, so the link resolved to Action Now and the recipient saw a
 * different set of rows. The Needs Resolution lane is that state, so `test`
 * lands where it always meant to.
 */
function parseMetaLaneView(value: string | null): MetaLaneView {
  if (
    value === "needsres" ||
    value === "watching" ||
    value === "healthy" ||
    value === "nonSales" ||
    value === "archive"
  )
    return value;
  if (value === "watch") return "watching";
  if (value === "test") return "needsres";
  if (value === "act") return "action";
  return "action";
}

/**
 * The level filter's state.
 *
 * A SET rather than one value, because that is the shape the decisions URL
 * contract mints (`levels=campaign,adset`) and a link that names two levels has
 * to round-trip as two. Empty means every level — the surface does not default
 * to one, so an operator who has chosen nothing is shown everything.
 */
export type MetaDecisionLevel = "campaign" | "adset" | "ad";

export const META_DECISION_LEVELS: readonly MetaDecisionLevel[] = [
  "campaign",
  "adset",
  "ad",
] as const;

/**
 * `levels` from the URL, restored rather than reported as dropped.
 *
 * `account` is in the older contract's vocabulary and has no row at this grain:
 * this queue serves campaigns, ad sets and ads, and there is no account-level
 * decision row to filter to. It is dropped from the SET here and named in the
 * compatibility report, which is the difference between honouring a link and
 * pretending to.
 */
export function parseMetaDecisionLevels(params: {
  get(name: string): string | null;
}): MetaDecisionLevel[] {
  const raw = params.get("levels")?.trim();
  if (!raw) return [];
  const requested = new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  // Canonical order, not the URL's, so two links selecting the same levels
  // produce the same state and the same serialisation.
  return META_DECISION_LEVELS.filter((level) => requested.has(level));
}

/** Levels the given scope can actually serve. */
export function levelsServedByScope(
  scope: MetaDecisionCenterExactScope,
): readonly MetaDecisionLevel[] {
  return scope === "creatives" ? ["ad"] : ["campaign", "adset"];
}

/**
 * Does this served level pass the filter?
 *
 * An empty filter passes everything. A row whose level the payload did not
 * state passes too — withholding a row because its grain was not served would
 * be filtering on the absence of evidence.
 */
export function metaRecLevelMatch(
  level: string | null | undefined,
  levels: readonly MetaDecisionLevel[],
): boolean {
  if (levels.length === 0) return true;
  const value = level?.trim().toLowerCase();
  if (!value) return true;
  return (levels as readonly string[]).includes(value);
}

function parseMetaWorkspaceLane(params: {
  get(name: string): string | null;
}): MetaLaneView {
  const legacyLane = params.get("lane");
  if (legacyLane) return parseMetaLaneView(legacyLane);
  if (params.get("area") !== "monitor") return "action";
  const segment = params.get("segment");
  if (segment === "needs_resolution") return "needsres";
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
function parseMetaScope(params: {
  get(name: string): string | null;
}): MetaDecisionCenterExactScope {
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
  return (params.get("q") ?? "")
    .trim()
    .slice(0, META_DEEP_LINK_SEARCH_MAX_LENGTH);
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
      // `test` is the older contract's name for the server's `blocked` state.
      // It used to have no lane here and collapsed into Action now, which is
      // why it was reported. The Needs Resolution lane IS that state, so the
      // link now lands where it always meant to and there is nothing to report.
      "test",
      "needsres",
      "watch",
      "watching",
      "healthy",
      "nonsales",
      "archive",
    ]);
    if (!restorable.has(lane)) {
      entries.push({
        param: "lane",
        value: rawLane,
        behaviour: "not a lane this queue serves; opened Action now",
      });
    }
  }

  /*
   * `levels` is applied now, so only the parts of it this queue cannot serve
   * are reported.
   *
   * The queue has campaign, ad-set and ad rows. `account` is in the older
   * contract's vocabulary and names a grain with no row here, so a link asking
   * for it is honoured as far as it goes and the rest is stated — and a link
   * asking ONLY for it is honoured as "every level", because filtering to a
   * grain that does not exist would empty the screen on the strength of a word.
   */
  const rawLevels = params.get("levels")?.trim() ?? "";
  if (rawLevels) {
    const requested = rawLevels
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const unservable = requested.filter(
      (level) => !(META_DECISION_LEVELS as readonly string[]).includes(level),
    );
    if (unservable.length > 0) {
      const kept = requested.filter((level) =>
        (META_DECISION_LEVELS as readonly string[]).includes(level),
      );
      entries.push({
        param: "levels",
        value: rawLevels,
        behaviour:
          `${unservable.join(", ")} names no row grain this queue serves; ` +
          (kept.length > 0
            ? `the filter was applied as ${kept.join(", ")}`
            : "every level is shown"),
      });
    }
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
      behaviour: "not a scope this queue serves; opened Campaigns & ad sets",
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

/** Does a served OS Ad decision answer the creative the URL named? */
function matchesMetaOsCreativeSelection(
  decision: MetaOsAdDecision,
  selection: { adId: string | null; creativeId: string | null },
): boolean {
  if (selection.adId && decision.adId.trim() === selection.adId) return true;
  return Boolean(
    selection.creativeId &&
    decision.creativeId?.trim() === selection.creativeId,
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

function mobileCreativeGroupIdForLane(
  lane: MetaLaneView,
): "act" | "blocked" | "monitor" | null {
  if (lane === "action") return "act";
  if (lane === "needsres") return "blocked";
  if (lane === "watching") return "monitor";
  return null;
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
    {
      rangePreset: selected === "custom" ? "custom" : selected,
      customStart: "",
      customEnd: "",
    },
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

async function readJson<T>(
  url: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : null;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new MetaRequestFailure({
        message:
          "The decision read timed out before the backend returned a complete workspace. Check the database connection, then retry.",
        status: 504,
        hasServerReason: true,
      });
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
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

// The dev workspace route gives each read-only upstream up to 45 seconds.
// Cutting the browser request at 30 seconds discarded healthy 200 responses
// observed at 30-31 seconds under local pool contention. This remains one
// bounded attempt (React Query retry is disabled), with enough headroom for
// the server to finish or return its own source-specific failure.
const DECISION_WORKSPACE_CLIENT_TIMEOUT_MS = 60_000;

function fetchDecisionsWorkspace(
  businessId: string,
  providerAccountId: string,
  window: MetaWindowKey,
  statusFilter: BriefingStatusFilter,
  adCandidateLimit: number,
  range?: Pick<DateWindowValue, "start" | "end">,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    businessId,
    providerAccountId,
    window,
    status_filter: statusFilter,
    adLimit: String(adCandidateLimit),
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
    { timeoutMs: DECISION_WORKSPACE_CLIENT_TIMEOUT_MS, signal },
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

export function metaBidApplyNotice(payload: unknown, currency?: string | null) {
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
      ? `Bid cap applied at ${formatCurrency(bidAmountMinor / 100, currency)}.`
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
 * The server action tuple is the authority boundary; the recommendation only
 * supplies the Launchpad variant after the two contracts agree.
 *
 * A recommendation can still carry a legacy `route_launchpad_*` hint while
 * `structureAction()` deliberately downgrades its served action to `manual` or
 * `review` (for example when Commercial Truth is unavailable). In that case
 * this must return null: opening Launchpad and recording the recommendation as
 * acted would contradict the server response currently on screen.
 */
function launchModeForServedStructureAction(
  recommendation: MetaRecommendation,
  action: MetaOsDecisionAction,
): MetaLaunchMode | null {
  if (action.intent !== "launchpad" || action.providerMutation !== null) {
    return null;
  }
  if (action.code !== recommendation.actionKind) return null;
  return launchModeForRec(recommendation);
}

function trackingConfirmLabelForStructureAction(
  action: MetaOsDecisionAction | null | undefined,
): string {
  if (action?.code === "route_launchpad_rebuild") return "Rebuild anyway";
  if (action?.code === "route_launchpad_duplicate") return "Duplicate anyway";
  return "Continue anyway";
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
    pulse?.trackingAnomalyActive ||
    pulse?.trackingHealth.status === "blocked" ||
    pulse?.trackingHealth.status === "degraded",
  );
}

/**
 * Resolution state of one of the evidence drawer's ad-grain helper reads.
 *
 * The drawer used to receive only `query.data`, which is `undefined` while the
 * read is in flight, `undefined` when it failed, and `undefined` when the
 * account genuinely has no rows. All three printed the same em-dash, so an
 * unreadable field was indistinguishable from an absent one. This narrows a
 * react-query result to the three cases the drawer can then state.
 *
 * A query that is disabled (no creative/ad identity to read against) reports
 * "loaded": nothing was withheld, there is simply no identity to ask about, and
 * an em-dash is the honest answer for that.
 */
function metaEvidenceReadState(query: {
  data: unknown;
  isError: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
}): "loading" | "error" | "unread" | "loaded" {
  if (query.isError) return "error";
  if (query.data !== undefined) return "loaded";
  if (query.fetchStatus === "fetching") return "loading";
  // No data, not fetching, no error: the read did not happen. It is paused
  // (react-query pauses when the browser is offline) or it was never enabled.
  // This returned "loaded", which told the window a completed read had found
  // nothing — so every cell printed the same em dash a real absence prints.
  return "unread";
}

/** The failed read's own message, never a message this client composed. */
function metaEvidenceReadError(query: {
  isError: boolean;
  error: unknown;
}): string | null {
  if (!query.isError) return null;
  const error = query.error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return null;
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
  inspector,
  targetRoas,
  moneyCurrency,
  onBack,
}: {
  item: MetaDrillItem;
  /**
   * The desktop's own evidence inspector for the SAME selected row. Mobile used
   * to stop at the legacy recommendation's `why` and two citations, so the two
   * surfaces disagreed about why a row could not be acted on. Optional because
   * the anomaly mode has no inspector model to speak of.
   */
  inspector?: MetaDecisionCenterExactInspectorViewModel | null;
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
          {inspector ? (
            <section
              className="ad-mobile-posture"
              data-mobile-posture="inspector"
              data-tone={
                inspector.blockerTone === "negative" ? "danger" : "info"
              }
            >
              <b>Authority &amp; readiness</b>
              <div>contract: {mobileDisplay(inspector.contractDetail)}</div>
              <div>readiness: {mobileDisplay(inspector.readiness)}</div>
              <div>blockers: {mobileDisplay(inspector.blockers)}</div>
              {/*
                What the server can STATE but cannot measure. It used to arrive
                inside `blockers` — `risk_tier_unclassified` sat there and
                vetoed every exact-Ad action, because the risk-tier producer is
                not persisted. Moving it out of the veto must not also move it
                off the phone: the desktop inspector grew an Advisories line and
                this one did not, so a phone silently stopped saying that risk
                is unclassified at all. Same fact, both surfaces.
              */}
              <div>advisories: {mobileDisplay(inspector.advisories)}</div>
              <div>{mobileDisplay(inspector.provenance)}</div>
            </section>
          ) : null}
          <div className="ad-mobile-desktop-note">
            Act on desktop — this device is read-only by design.
          </div>
        </div>
      </div>
    </section>
  );
}

/** Display rule shared with the exact desktop component: blank means unknown. */
function mobileDisplay(value: MetaDecisionCenterExactDisplayValue): string {
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "—";
  if (typeof value !== "string") return "—";
  return value.trim() || "—";
}

/** The mobile row card only paints three tones; everything else stays caution. */
function mobileToneAttr(
  tone: MetaDecisionCenterExactTone | null | undefined,
): "danger" | "positive" | "caution" {
  if (tone === "negative") return "danger";
  if (tone === "positive") return "positive";
  return "caution";
}

interface MetaMobileQueueRowModel {
  id: string;
  name: MetaDecisionCenterExactDisplayValue;
  meta?: MetaDecisionCenterExactDisplayValue;
  /**
   * The SERVED state, and the served blockers behind it.
   *
   * Mobile rendered 60 server-blocked rows with neither, so a decision the
   * engine withheld read as an ordinary recommendation on the phone while the
   * same payload showed it as BLOCKED on the desktop. That is the invariant
   * in INVARIANTS.md, not a styling gap.
   */
  stateLabel?: MetaDecisionCenterExactDisplayValue;
  stateTone?: MetaDecisionCenterExactTone;
  blockedNote?: MetaDecisionCenterExactDisplayValue;
  decisionLabel?: MetaDecisionCenterExactDisplayValue;
  decisionTone?: MetaDecisionCenterExactTone;
  money?: MetaDecisionCenterExactDisplayValue;
  moneySub?: MetaDecisionCenterExactDisplayValue;
  chips?: readonly MetaDecisionCenterExactDisplayValue[];
  actionLabel?: MetaDecisionCenterExactDisplayValue;
  onOpen?: () => void;
}

/**
 * The mobile queue for the active scope and lane, taken WHOLE from the exact
 * view model.
 *
 * No cap, no re-sort, no re-selection: whatever the desktop lane renders, this
 * renders. The previous surface sliced the first two rows of a legacy list, so
 * mobile could report "2" where the same payload gave the desktop 60.
 */
function mobileQueueRows(
  viewModel: MetaDecisionCenterExactViewModel,
  scope: MetaDecisionCenterExactScope,
  lane: MetaLaneView,
): MetaMobileQueueRowModel[] {
  if (scope === "creatives") {
    const selectedGroupId = mobileCreativeGroupIdForLane(lane);
    const creativeRows =
      viewModel.creativeGroups === undefined
        ? (viewModel.creativeDecisions ?? [])
        : viewModel.creativeGroups
            .filter(
              (group) => selectedGroupId === null || group.id === selectedGroupId,
            )
            .flatMap((group) => group.rows);
    return creativeRows.map((row) => ({
      id: row.id,
      name: row.name,
      meta: row.kindShort,
      decisionLabel: row.decisionLabel,
      decisionTone: row.decisionTone,
      stateLabel: row.stateLabel,
      stateTone: row.stateTone,
      blockedNote: row.blockedNote,
      money: row.money,
      moneySub: row.moneySub,
      chips: row.chips,
      actionLabel: row.actionLabel,
      onOpen: row.onOpen,
    }));
  }
  if (lane === "needsres") {
    /*
     * The blocked lane, on a phone.
     *
     * `actionLabel` is deliberately the read affordance rather than a verb: a
     * blocked decision has no authorized action, and the mobile surface is
     * read-only anyway. The blocker rides in `blockedNote`, which this row
     * model already draws for the creatives scope.
     */
    return (viewModel.needsResolutionRows ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      meta: row.lineage,
      decisionLabel: row.decisionLabel,
      decisionTone: row.decisionTone,
      stateLabel: "Blocked",
      stateTone: "warning" as const,
      blockedNote: row.blocker,
      money: row.money,
      moneySub: row.resolution,
      actionLabel: "Read evidence",
      onOpen: row.onOpen,
    }));
  }
  if (lane === "watching") {
    return (viewModel.watchingRows ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      meta: row.lineage,
      decisionLabel: row.segment,
      decisionTone: row.segmentTone,
      money: row.money,
      moneySub: row.note,
      actionLabel: "Review",
      onOpen: row.onOpen ?? row.onReview,
    }));
  }
  if (lane === "healthy") {
    return (viewModel.healthyGroups ?? []).map((group) => ({
      id: group.id,
      name: group.name,
      meta: group.strategy,
      decisionLabel: "Healthy",
      decisionTone: "positive" as const,
      money: group.rollup,
      chips: (group.adsets ?? []).map((adset) => adset.stats ?? adset.name),
      actionLabel: "No action",
    }));
  }
  if (lane === "nonSales") {
    return (viewModel.nonSales ?? []).map((card, index) => ({
      id: card.id ?? `nonsales-${index}`,
      name: card.name,
      meta: card.contextLabel,
      decisionLabel: card.level,
      decisionTone: "info" as const,
      moneySub: card.note,
      chips: (card.metrics ?? []).map(
        (metric) =>
          `${mobileDisplay(metric.label)} ${mobileDisplay(metric.value)}`,
      ),
      actionLabel: "Informational",
    }));
  }
  if (lane === "archive") {
    return (viewModel.archiveRows ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      meta: row.note,
      decisionLabel: row.status,
      decisionTone: row.statusTone,
      money: row.spend,
      actionLabel: row.showResume ? "Resume" : "Archived",
    }));
  }
  return (viewModel.actionRows ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    meta: row.lineage,
    decisionLabel: row.decisionLabel,
    decisionTone: row.decisionTone,
    money: row.money,
    moneySub: row.moneySub,
    chips: row.chips,
    actionLabel: row.actionLabel,
    onOpen: row.onOpen ?? row.onMenu,
  }));
}

/**
 * What the server says about its own authority, in the server's own words.
 *
 * Every field is read straight off the served payload. Nothing here is derived,
 * inferred or re-classified: an absent field stays absent rather than becoming
 * a reassuring default.
 */
interface MetaMobilePosture {
  viewerRole: string | null;
  viewerReadOnlyReason: string | null;
  killSwitchReason: string | null;
  adsSource: string | null;
  sourceHealth: string | null;
  structureSource: string | null;
  fallbackReason: string | null;
  readModelUnavailable: string | null;
  limitations: Array<{ code: string; message: string }>;
  capabilityGaps: Array<{ key: string; status: string; reason: string | null }>;
  inactiveAdCount: number | null;
  inactiveUnknownCount: number | null;
  adCandidates: {
    sourcePreCap: number;
    eligiblePreCap: number;
    selected: number;
    act: number;
    monitor: number;
    blocked: number;
  } | null;
}

function buildMetaMobilePosture(input: {
  workspace: MetaDecisionsWorkspacePayload | undefined;
  viewerReadOnlyReason: string | null;
}): MetaMobilePosture {
  const workspace = input.workspace;
  const osSource = workspace?.os?.source ?? null;
  const readModel = workspace?.decisionReadModel ?? null;
  const capabilities = readModel?.capabilities ?? null;
  const inactive = readModel?.queue?.inactiveAssets ?? null;
  const candidates = readModel?.queue?.adCandidates ?? null;
  return {
    viewerRole: workspace?.viewer?.role ?? null,
    viewerReadOnlyReason: input.viewerReadOnlyReason,
    killSwitchReason: workspace?.system.killSwitchEngaged
      ? (workspace.system.killSwitchReason ?? "Meta writes are disabled.")
      : null,
    adsSource: osSource?.adsSource ?? null,
    sourceHealth: osSource?.health ?? null,
    structureSource: osSource?.structureSource ?? null,
    fallbackReason:
      osSource?.fallbackReason ?? readModel?.source.fallbackReason ?? null,
    readModelUnavailable: readModel?.unavailable?.message ?? null,
    limitations: (workspace?.os?.limitations ?? []).map((limitation) => ({
      code: limitation.code,
      message: limitation.message,
    })),
    capabilityGaps: capabilities
      ? Object.entries(capabilities)
          .filter(([, state]) => state.status !== "available")
          .map(([key, state]) => ({
            key,
            status: state.status,
            reason: state.reason,
          }))
      : [],
    inactiveAdCount: inactive?.inactiveCount ?? null,
    inactiveUnknownCount: inactive?.unknownCount ?? null,
    adCandidates: candidates
      ? {
          sourcePreCap: candidates.preCapCount,
          eligiblePreCap: candidates.eligiblePreCapCount,
          selected: candidates.selectedCount,
          act: candidates.stateCounts.act.selectedCount,
          monitor: candidates.stateCounts.monitor.selectedCount,
          blocked: candidates.stateCounts.blocked.selectedCount,
        }
      : null,
  };
}

/**
 * The creative evidence screen, mobile.
 *
 * It is built from the SAME `buildCreativeEvidenceWindowExactViewModel` the
 * desktop drawer uses — same funnel, same facts, same authority block, same
 * diagnostics receipts, same read-state caption. The only difference is the
 * footer: the desktop drawer offers a primary action, and this one offers none,
 * because writes are desktop-only. The desktop drawer itself is a direct child
 * of the page root and is hidden by the mobile stylesheet, so without this
 * screen a creative row on mobile opened nothing at all.
 */
function MetaMobileCreativeEvidenceScreen({
  viewModel,
  onBack,
}: {
  viewModel: CreativeEvidenceWindowExactViewModel;
  onBack: () => void;
}) {
  const authority = viewModel.authority ?? [];
  const diagnostics = viewModel.diagnostics ?? [];
  const funnel = viewModel.funnel ?? [];
  const facts = viewModel.facts ?? [];
  return (
    <section
      className="meta-mobile-decision-stage"
      data-testid="meta-mobile-creative-evidence"
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
            <h2>{mobileDisplay(viewModel.name)}</h2>
            <p>
              {mobileDisplay(viewModel.kind)} · {mobileDisplay(viewModel.band)}
            </p>
          </div>
          {viewModel.readNotice ? (
            <section
              className="ad-mobile-posture"
              data-mobile-posture="read-state"
              data-tone={
                viewModel.readNotice.tone === "negative" ? "danger" : "info"
              }
            >
              <b>Evidence read</b>
              <div>{viewModel.readNotice.text}</div>
            </section>
          ) : null}
          <article className="ad-mobile-heat">
            <strong>{mobileDisplay(viewModel.verdict)}</strong>
            <span>
              {mobileDisplay(viewModel.money)} ·{" "}
              {mobileDisplay(viewModel.moneySub)}
            </span>
          </article>
          <p className="ad-mobile-copy">
            {(viewModel.reasons ?? [])
              .map((reason) => mobileDisplay(reason))
              .join(" ")}{" "}
            {mobileDisplay(viewModel.verdictSub)}
          </p>
          <MetaMobileCitationList
            items={funnel.map((step) => ({
              label: mobileDisplay(step.label),
              value:
                `${mobileDisplay(step.value)} ${mobileDisplay(step.sub)}`.trim(),
            }))}
          />
          <MetaMobileCitationList
            items={facts.map((fact) => ({
              label: mobileDisplay(fact.label),
              value: mobileDisplay(fact.value),
            }))}
          />
          {authority.length > 0 ? (
            <section
              className="ad-mobile-posture"
              data-mobile-posture="authority"
              data-tone="info"
            >
              <b>Authority &amp; eligibility</b>
              {authority.map((row) => (
                <div key={row.id}>
                  {mobileDisplay(row.label)}: {mobileDisplay(row.value)}
                </div>
              ))}
            </section>
          ) : null}
          {diagnostics.length > 0 ? (
            <details className="ad-mobile-diagnostics" data-mobile-diagnostics>
              <summary>Diagnostics · hashes &amp; lineage</summary>
              {diagnostics.map((row) => (
                <div key={row.id}>
                  {mobileDisplay(row.label)}: {mobileDisplay(row.value)}
                </div>
              ))}
            </details>
          ) : null}
          <div className="ad-mobile-desktop-note">
            {mobileDisplay(viewModel.provenance)} · Act on desktop — this device
            is read-only by design.
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * One row of the mobile queue, projected from the SAME exact view model the
 * desktop renders.
 *
 * It carries the server's own decision label, money line, chips and action
 * caption, and exactly one control: open evidence. The action caption is TEXT,
 * never a button — writes are desktop-only, and that law is enforced here by
 * never wiring `onPrimary`, not by hiding a disabled control.
 */
function MetaMobileQueueRow({
  id,
  name,
  meta,
  decisionLabel,
  decisionTone,
  stateLabel,
  stateTone,
  blockedNote,
  money,
  moneySub,
  chips,
  actionLabel,
  onOpen,
}: {
  id: string;
  name: MetaDecisionCenterExactDisplayValue;
  meta?: MetaDecisionCenterExactDisplayValue;
  decisionLabel?: MetaDecisionCenterExactDisplayValue;
  decisionTone?: MetaDecisionCenterExactTone;
  stateLabel?: MetaDecisionCenterExactDisplayValue;
  stateTone?: MetaDecisionCenterExactTone;
  blockedNote?: MetaDecisionCenterExactDisplayValue;
  money?: MetaDecisionCenterExactDisplayValue;
  moneySub?: MetaDecisionCenterExactDisplayValue;
  chips?: readonly MetaDecisionCenterExactDisplayValue[];
  actionLabel?: MetaDecisionCenterExactDisplayValue;
  onOpen?: () => void;
}) {
  const moneyLine = [mobileDisplay(money), mobileDisplay(moneySub)]
    .filter((value) => value !== "—")
    .join(" · ");
  return (
    <article className="ad-mobile-row-card" data-mobile-row-id={id}>
      <div>
        <h3>{mobileDisplay(name)}</h3>
        {meta ? <p data-tone="caution">{mobileDisplay(meta)}</p> : null}
        {/* The served state, before the decision label. A row the engine
            blocked must not read here as an ordinary recommendation. */}
        {stateLabel && mobileDisplay(stateLabel) !== "—" ? (
          <p
            data-mobile-state={String(stateLabel).trim()}
            data-tone={mobileToneAttr(stateTone)}
          >
            {mobileDisplay(stateLabel)}
          </p>
        ) : null}
        <p data-tone={mobileToneAttr(decisionTone)}>
          {mobileDisplay(decisionLabel)}
          {moneyLine ? ` · ${moneyLine}` : ""}
        </p>
        {chips && chips.length > 0 ? (
          <p data-tone="caution">
            {chips.map((chip) => mobileDisplay(chip)).join(" · ")}
          </p>
        ) : null}
        {/* The server's own blockers and next step, verbatim. */}
        {blockedNote && mobileDisplay(blockedNote) !== "—" ? (
          <p data-mobile-blocked-note="true" data-tone="caution">
            {mobileDisplay(blockedNote)}
          </p>
        ) : null}
      </div>
      <div className="ad-mobile-row-footer">
        <span className="ad-mobile-action-note">
          {mobileDisplay(actionLabel)} · desktop
        </span>
        {onOpen ? (
          <button type="button" onClick={onOpen}>
            Read evidence →
          </button>
        ) : null}
      </div>
    </article>
  );
}

/**
 * Everything the server says about its own authority, rendered ALONGSIDE the
 * rows rather than instead of them.
 *
 * The desktop equivalent (`creativesNotice`) only appears when the creative
 * queue is completely empty, so a degraded source under a full queue is silent
 * and the operator reads low-authority rows as ordinary ones. On this surface
 * the posture is unconditional: if the payload says the ad source is
 * `legacy_creative_review_only` with `health: degraded`, that sentence is on
 * screen whether there are 0 rows or 60.
 */
function MetaMobilePosturePanel({ posture }: { posture: MetaMobilePosture }) {
  const sourceLine = [
    posture.adsSource ? `ads ${titleCaseCompact(posture.adsSource)}` : null,
    posture.sourceHealth
      ? `health ${titleCaseCompact(posture.sourceHealth)}`
      : null,
    posture.structureSource
      ? `structure ${titleCaseCompact(posture.structureSource)}`
      : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const degraded =
    posture.sourceHealth !== null && posture.sourceHealth !== "healthy";
  return (
    <section
      className="ad-mobile-posture"
      data-mobile-posture="source"
      data-tone={degraded ? "danger" : "info"}
    >
      <b>Source authority</b>
      <div>{sourceLine || "—"}</div>
      {posture.fallbackReason ? (
        <div>fallback: {posture.fallbackReason}</div>
      ) : null}
      {posture.readModelUnavailable ? (
        <div>read model: {posture.readModelUnavailable}</div>
      ) : null}
      {posture.limitations.map((limitation) => (
        <div key={limitation.code} data-mobile-limitation={limitation.code}>
          {limitation.message}
        </div>
      ))}
      {posture.capabilityGaps.length > 0 ? (
        <div data-mobile-capability-gaps>
          capability gaps:{" "}
          {posture.capabilityGaps
            .map(
              (gap) =>
                `${titleCaseCompact(gap.key.replace(/([a-z])([A-Z])/g, "$1 $2"))} ${gap.status}`,
            )
            .join(" · ")}
        </div>
      ) : null}
    </section>
  );
}

/** Viewer authority, stated rather than implied by the absence of buttons. */
function MetaMobileAuthorityPanel({ posture }: { posture: MetaMobilePosture }) {
  return (
    <section
      className="ad-mobile-posture"
      data-mobile-posture="viewer"
      data-tone="info"
    >
      <b>Viewer authority</b>
      <div>
        role {posture.viewerRole ?? "—"} ·{" "}
        {posture.viewerReadOnlyReason
          ? "read-only"
          : "write-capable on desktop"}
      </div>
      {posture.viewerReadOnlyReason ? (
        <div>{posture.viewerReadOnlyReason}</div>
      ) : null}
      {posture.killSwitchReason ? (
        <div>kill switch: {posture.killSwitchReason}</div>
      ) : null}
      <div>
        This device is read-only by design: it shows every decision the desktop
        shows and executes none of them.
      </div>
    </section>
  );
}

/** Rows the server withheld from the live queues, counted rather than hidden. */
function MetaMobileWithheldPanel({ posture }: { posture: MetaMobilePosture }) {
  const lines: string[] = [];
  if (posture.inactiveAdCount !== null) {
    lines.push(
      `${posture.inactiveAdCount} inactive Ad${posture.inactiveAdCount === 1 ? "" : "s"}` +
        (posture.inactiveUnknownCount
          ? ` (${posture.inactiveUnknownCount} unknown status)`
          : "") +
        " withheld from the live queues",
    );
  }
  if (posture.adCandidates) {
    lines.push(
      `${posture.adCandidates.selected} of ${posture.adCandidates.eligiblePreCap} eligible exact Ad identities selected` +
        (posture.adCandidates.sourcePreCap !==
        posture.adCandidates.eligiblePreCap
          ? ` · ${posture.adCandidates.sourcePreCap} source identities before eligibility`
          : "") +
        " · " +
        `act ${posture.adCandidates.act} · monitor ${posture.adCandidates.monitor} · blocked ${posture.adCandidates.blocked}`,
    );
  }
  if (lines.length === 0) return null;
  return (
    <section
      className="ad-mobile-posture"
      data-mobile-posture="withheld"
      data-tone="info"
    >
      <b>Withheld from the queue</b>
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </section>
  );
}

/**
 * The mobile Decision surface.
 *
 * WHAT CHANGED AND WHY: this used to render its own reduced truth — legacy
 * `MetaRecommendation` rows only, capped at two, one anomaly, and no blocked or
 * monitor decisions, no inactive Ads, no capabilities, no source limitations and
 * no viewer authority. Desktop and mobile therefore disagreed about the same
 * backend. It now projects the SAME `MetaDecisionCenterExactViewModel` the
 * desktop renders, through the same scope/lane selection, uncapped. What did
 * NOT change is write authority: mobile still offers exactly one control per
 * row (open evidence) and states that execution is desktop-only.
 */
function MetaMobileDecisionsScreen({
  businessName,
  viewModel,
  structureInventory,
  posture,
  scope,
  lane,
  onScopeChange,
  onLaneChange,
  loading,
  error,
  anomalies,
  banners,
  historyHref,
  pathname,
  onClearSearch,
  onOpenAnomaly,
  anomalyError,
  canLoadMoreCreatives,
  loadingMoreCreatives,
  nextCreativeLimit,
  onLoadMoreCreatives,
}: {
  businessName?: string | null;
  viewModel: MetaDecisionCenterExactViewModel;
  structureInventory: MetaStructureInventoryViewModel;
  posture: MetaMobilePosture;
  scope: MetaDecisionCenterExactScope;
  lane: MetaLaneView;
  onScopeChange: (scope: MetaDecisionCenterExactScope) => void;
  onLaneChange: (lane: MetaLaneView) => void;
  loading: boolean;
  error: Error | null;
  anomalies: MetaAnomaly[];
  banners: MetaWorkspaceBanner[];
  historyHref: string;
  pathname: string | null;
  onClearSearch: () => void;
  onOpenAnomaly: (anomaly: MetaAnomaly) => void;
  anomalyError: Error | null;
  canLoadMoreCreatives: boolean;
  loadingMoreCreatives: boolean;
  nextCreativeLimit: number;
  onLoadMoreCreatives: () => void;
}) {
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const counts = viewModel.counts ?? {};
  const creativeLaneCounts = viewModel.operatorSummary?.scopeCounts?.creatives;
  const identity = viewModel.identity ?? {};
  const actCount = loading || error ? "—" : mobileDisplay(counts.action);
  const rows = mobileQueueRows(viewModel, scope, lane);
  if (loading || error) {
    return (
      <section
        className="meta-mobile-decision-stage"
        data-testid="meta-mobile-decisions"
        data-mobile-read-state={loading ? "loading" : "error"}
      >
        <div className="ad-mobile-device">
          <div className="ad-mobile-screen">
            <div className="ad-mobile-status">
              <span>Meta Decision Center</span>
              <span>{businessName ?? "Meta"}</span>
            </div>
            {loading ? (
              <article className="ad-mobile-row-card" role="status">
                <h3>Loading decision data</h3>
                <p>
                  Reading the assigned Meta account and its complete server
                  decision workspace.
                </p>
              </article>
            ) : (
              <article
                className="ad-mobile-anomaly"
                data-tone="danger"
                role="alert"
              >
                <b>Decision workspace could not load.</b>
                <div>
                  {error?.message ||
                    "Backend decision data is unavailable. Retry after connectivity recovers."}
                </div>
              </article>
            )}
          </div>
        </div>
      </section>
    );
  }
  return (
    <section
      className="meta-mobile-decision-stage"
      data-testid="meta-mobile-decisions"
      data-mobile-scope={scope}
      data-mobile-lane={lane}
    >
      <div className="ad-mobile-device">
        <div className="ad-mobile-screen">
          <div className="ad-mobile-status">
            <span>{mobileDisplay(identity.accountLabel)}</span>
            <span>
              {businessName ?? "Meta"} · Act now {actCount}
            </span>
          </div>
          <div className="ad-mobile-freshness">
            {mobileDisplay(identity.syncedLabel)} ·{" "}
            {mobileDisplay(identity.snapshotLabel)} ·{" "}
            {mobileDisplay(identity.engineLabel)} ·{" "}
            {mobileDisplay(identity.currency)}
          </div>

          <MetaMobileAuthorityPanel posture={posture} />
          <MetaMobilePosturePanel posture={posture} />

          {/*
            The budget-decision evidence, projected onto the phone.

            Below 720px the stylesheet hides every sibling of this stage, so
            the desktop-mounted `BudgetDecisionEvidencePanel` — a descendant of
            one of those siblings — was simply absent on a phone: both
            direction panels measured 0x0 on the authenticated route. This
            renders the SAME component from the SAME server-owned
            `viewModel.budgetEvidence` object the desktop reads. It re-derives
            nothing, adds no threshold, maps no direction to an action of its
            own, and creates no write authority: the panel's own CTAs stay
            disabled and mobile remains read-only.
          */}
          <BudgetDecisionEvidencePanel
            evidence={viewModel.budgetEvidence ?? null}
          />

          {/*
            D085 on the phone. Same server object, same component, same
            read-only law as the desktop mount.
          */}
          <BudgetDryRunPanel panel={viewModel.budgetDryRun ?? null} />

          {/*
            Same banners, same order as the desktop chrome
            (`workspaceBannerPriority`): a blocking kill switch must not sit
            below a tracking warning on one surface and above it on the other.
          */}
          {[...banners]
            .sort(
              (left, right) =>
                workspaceBannerPriority(left) - workspaceBannerPriority(right),
            )
            .map((banner) => {
              /*
                Same destination as the desk, from the same helper. A phone
                that is told an action's outcome is unknown and given no way to
                reach the screen that knows has been handed the alarm without
                the answer; the link is a READ, which is all this device does.
              */
              const destination = workspaceBannerDestination(
                banner,
                historyHref,
                pathname,
              );
              return (
                <article
                  key={banner.id}
                  className="ad-mobile-anomaly"
                  data-tone={banner.tone === "danger" ? "danger" : "info"}
                  data-mobile-banner={banner.id}
                  data-mobile-banner-scope={banner.scope ?? "workspace"}
                >
                  <b>{banner.title}</b>
                  <div>{banner.detail}</div>
                  {destination ? (
                    <a
                      className="meta-posture-banner__button"
                      href={destination.href}
                    >
                      {destination.label}
                    </a>
                  ) : null}
                </article>
              );
            })}

          {anomalyError ? (
            <article
              className="ad-mobile-anomaly"
              data-tone="warning"
              data-mobile-anomaly-error
            >
              <b>Integrity scan is unavailable.</b>
              <div>
                {anomalyError.message ||
                  "Integrity evidence is withheld; the decision queue remains readable."}
              </div>
            </article>
          ) : anomalies.length === 0 ? (
            <article className="ad-mobile-anomaly" data-tone="info">
              <b>No active anomaly.</b>
              <div>
                Rows still open evidence on mobile; execution stays
                desktop-only.
              </div>
            </article>
          ) : (
            anomalies.map((anomaly) => (
              <button
                key={anomaly.id}
                type="button"
                className="ad-mobile-anomaly ad-mobile-anomaly-button"
                onClick={() => onOpenAnomaly(anomaly)}
              >
                <b>Anomaly:</b> {anomaly.title}
                <div>
                  detected {mobileTimestamp(anomaly.detectedAt)} · read evidence
                  on mobile, act on desktop
                </div>
              </button>
            ))
          )}

          <nav className="ad-mobile-tabs" aria-label="Decision scope">
            {(
              [
                ["structure", "Campaigns & Ad sets", counts.structure],
                ["creatives", "Creatives", counts.creatives],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                aria-pressed={scope === key}
                data-active={scope === key ? "true" : "false"}
                onClick={() => onScopeChange(key)}
              >
                {label} {mobileDisplay(count)}
              </button>
            ))}
          </nav>

          {scope === "structure" ? (
            <nav className="ad-mobile-tabs" aria-label="Decision lane">
              {(
                [
                  ["action", "Action", counts.action],
                  // The same six lanes the desktop draws. A phone that offered
                  // five would put the blocked rows nowhere: they are no longer
                  // inside Action, so omitting the lane would hide them.
                  ["needsres", "Needs Resolution", counts.needsres],
                  ["watching", "Watching", counts.watching],
                  ["healthy", "Healthy", counts.healthy],
                  ["nonSales", "Non-sales", counts.nonsales],
                  ["archive", "Archive", counts.archive],
                ] as const
              ).map(([key, label, count]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={lane === key}
                  data-active={lane === key ? "true" : "false"}
                  onClick={() => onLaneChange(key)}
                >
                  {label} {mobileDisplay(count)}
                </button>
              ))}
            </nav>
          ) : (
            <nav
              className="ad-mobile-tabs"
              aria-label="Creative decision lane"
            >
              {(
                [
                  ["action", "Action", creativeLaneCounts?.action],
                  [
                    "needsres",
                    "Needs Resolution",
                    creativeLaneCounts?.needsResolution,
                  ],
                  ["watching", "Watching", creativeLaneCounts?.watching],
                ] as const
              ).map(([key, label, count]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={lane === key}
                  data-active={lane === key ? "true" : "false"}
                  onClick={() => onLaneChange(key)}
                >
                  {label} {mobileDisplay(count)}
                </button>
              ))}
            </nav>
          )}

          {rows.map((row) => (
            <MetaMobileQueueRow key={row.id} {...row} />
          ))}

          {scope === "creatives" && canLoadMoreCreatives ? (
            <button
              type="button"
              className="ad-mobile-row-card"
              data-mobile-load-more-creatives
              disabled={loadingMoreCreatives}
              onClick={onLoadMoreCreatives}
            >
              {loadingMoreCreatives
                ? "Loading more decisions…"
                : `Show more decisions · up to ${nextCreativeLimit}`}
            </button>
          ) : null}

          {!loading && !error && rows.length === 0 ? (
            <article className="ad-mobile-row-card">
              <h3>No rows in this lane</h3>
              <p>the server queue served none for this scope and lane</p>
            </article>
          ) : null}

          {scope === "structure" ? (
            <details
              className="ad-mobile-diagnostics"
              data-mobile-structure-inventory
              open={inventoryOpen}
              onToggle={(event) => setInventoryOpen(event.currentTarget.open)}
            >
              <summary>
                Account inventory ·{" "}
                {structureInventory.servedCount === null
                  ? "—"
                  : `${structureInventory.servedCount.toLocaleString("en-US")} served`}
              </summary>
              {inventoryOpen ? (
                <>
                  <div>
                    Complete campaign and ad-set census in server order. A row
                    here is inventory only and grants no action.
                  </div>
                  {structureInventory.searchApplied ? (
                    <div>
                      {structureInventory.shownCount.toLocaleString("en-US")}{" "}
                      rows match the active search.{" "}
                      <button type="button" onClick={onClearSearch}>
                        Clear active search
                      </button>
                    </div>
                  ) : null}
                  {structureInventory.unavailableReason ? (
                    <div data-mobile-structure-inventory-empty>
                      {structureInventory.unavailableReason}
                    </div>
                  ) : structureInventory.rows.length === 0 ? (
                    <div data-mobile-structure-inventory-empty>
                      No served entity matches the active search.
                    </div>
                  ) : (
                    structureInventory.rows.map((row) => (
                      <article
                        key={row.id}
                        className="ad-mobile-row-card"
                        data-mobile-structure-inventory-row={row.id}
                      >
                        <h3>{row.name}</h3>
                        <p>
                          {row.grain} · {row.lineage} · {row.status}
                        </p>
                        <p>
                          Spend {row.spend} · ROAS {row.roas} · Purchases{" "}
                          {row.purchases}
                        </p>
                        <p>
                          CPA {row.cpa} · CTR {row.ctr}
                        </p>
                        <p>Setup {row.configuration}</p>
                      </article>
                    ))
                  )}
                </>
              ) : null}
            </details>
          ) : null}

          <MetaMobileWithheldPanel posture={posture} />

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
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { rows?: unknown }).rows)
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
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
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
  const payload =
    (await response.json()) as Partial<CreativeEvidenceWindowExactSeriesPayload>;
  return {
    adCount: typeof payload.adCount === "number" ? payload.adCount : 0,
    points: Array.isArray(payload.points) ? payload.points : [],
  };
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Does the served decision offer a Launchpad route, and if not, why not?
 *
 * WHAT THIS REPLACED, AND WHY. The gate used to be
 * `code !== "plan_promotion" && code !== "refresh_creative"` — a hand-kept list
 * of presentation codes maintained on the client, i.e. a re-derivation of an
 * action the server had already decided. Two things were wrong with it. It read
 * the wrong field: `refresh_creative` is served with `intent: "brief"` and the
 * scope note "Creates a replacement brief; does not pause this ad", so the
 * screen mapped a brief to a Launchpad route on its own authority. And it could
 * only ever answer yes/no, so a decision the server would refuse still got a
 * live-looking button whose click produced a bare refusal toast.
 *
 * It now runs `authorizeLaunchpadHandoff` — the SAME function
 * `POST /api/meta/launchpad-handoff` runs before it mints anything, imported
 * from the pure contract module for exactly this reason. That law is
 * fail-closed on every count this surface must honour: a non-`native_exact`
 * source, `actionEligible !== true`, a missing authorized action, any
 * `decisionState` other than `act`, a non-null `heldAction`, any blocker, and
 * an authorized action with no Launchpad mode are each refused by name
 * (lib/meta/launchpad-handoff-contract.ts:288). So a blocked, held, pending or
 * review-only decision cannot be offered a route here, and the refusal the
 * client shows is the refusal the server would give.
 *
 * This still GRANTS nothing. The server re-reads the canonical decision and
 * re-runs the same law against its own copy; this call only decides whether the
 * screen offers the control and what it says when it does not.
 *
 * The account in scope is passed rather than the decision's own, so a decision
 * rendered outside its account refuses with `provider_account_mismatch`
 * instead of silently authorising itself.
 */
function creativeEvidenceLaunchpadRoute(input: {
  canonical: MetaCanonicalDecision | null;
  action: MetaOsDecisionAction | null;
  providerAccountId: string | null;
}): { offered: boolean; refusalReason: string | null } {
  /*
   * FAIL-CLOSED at the top: no envelope, no route.
   *
   * `authorizeLaunchpadHandoff` is the server's own law and it reads the
   * canonical decision — source authority, action eligibility, decision state,
   * held action, blockers. A row that has no canonical decision cannot be put
   * through it, and the one thing that must never happen is answering the
   * question from the presentation decision instead: a served action label is
   * not an eligibility verdict. So the refusal is stated here, in the same
   * shape a server refusal takes, and the footer explains itself rather than
   * going quietly inert.
   */
  if (!input.canonical) {
    return {
      offered: false,
      refusalReason:
        "This row was served with no canonical decision envelope, so no launch handoff can be authorized against it.",
    };
  }
  if (!input.providerAccountId) {
    return {
      offered: false,
      refusalReason:
        "No Meta ad account is in scope, so no launch handoff can be authorized.",
    };
  }
  const authorized = authorizeLaunchpadHandoff({
    decision: input.canonical,
    providerAccountId: input.providerAccountId,
  });
  if (!authorized.ok) {
    return {
      offered: false,
      refusalReason: describeLaunchpadHandoffRefusal(authorized.refusal),
    };
  }
  const servedActionMatches =
    authorized.authorization.authorizedAction === "scale"
      ? input.action?.code === "plan_promotion" &&
        input.action.intent === "launchpad" &&
        input.action.targetLevel === "ad" &&
        input.action.providerMutation === null
      : authorized.authorization.authorizedAction === "refresh"
        ? input.action?.code === "refresh_creative" &&
          input.action.intent === "brief" &&
          input.action.targetLevel === "ad" &&
          input.action.providerMutation === null
        : false;
  if (!servedActionMatches) {
    return {
      offered: false,
      refusalReason:
        "The served action does not match the canonical Launchpad authority. Reopen the row after a fresh server read-back.",
    };
  }
  // Launchpad selects a creative. A verified mode with nothing to select is a
  // route to an empty picker, so it stays closed and says which half is missing.
  if (!input.canonical.parentChain.creative?.id?.trim()) {
    return {
      offered: false,
      refusalReason:
        "The served decision names no creative, so Launchpad has nothing to preselect.",
    };
  }
  return { offered: true, refusalReason: null };
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

/**
 * Compare in Studio, scoped by whichever envelope named the creative.
 *
 * This is navigation, not authority: both envelopes state the provider account
 * and the creative id as plain served identity, and reading the presentation
 * decision's copy when the canonical one is absent asserts nothing about
 * eligibility. Returns null when neither names an account, because a Studio
 * link with no scope is a link to the wrong account's creatives.
 */
function creativeEvidenceStudioHref(input: {
  canonical: MetaCanonicalDecision | null;
  decision: MetaOsAdDecision | null;
  pathname: string | null;
}): string | null {
  const providerAccountId =
    input.canonical?.providerAccountId?.trim() ||
    input.decision?.providerAccountId?.trim() ||
    null;
  if (!providerAccountId) return null;
  const params = new URLSearchParams({ providerAccountId });
  const creativeId =
    input.canonical?.parentChain.creative?.id?.trim() ||
    input.decision?.creativeId?.trim() ||
    null;
  if (creativeId) params.set("creativeId", creativeId);
  return dashboardHrefForRouteFamily(
    `/platforms/meta/creatives?${params.toString()}`,
    input.pathname ?? "",
  );
}

/**
 * The ownership chip for one queue row (H09 `wf-chip`).
 *
 * The workflow overlay's state was reachable only by opening the inspector, so
 * a queue of forty rows could not be scanned for "which of these has somebody
 * already taken". `null` when the overlay was not read at all — a chip reading
 * "Open" for an unread overlay would be a claim about other people's work made
 * on no evidence — and `unknown` when the read itself failed, which is a
 * different fact and says so.
 */
function rowWorkflowChip(input: {
  readState: DecisionWorkflowReadState;
  record: WorkflowRecord | null;
}): MetaDecisionCenterExactRowWorkflowChip | null {
  if (input.readState === "idle") return null;
  if (input.readState !== "ready" || !input.record) {
    return {
      state: "unknown",
      label: "Ownership unknown",
      tone: "warning",
      detail:
        input.readState === "loading"
          ? "The workflow overlay is still being read."
          : "The workflow overlay could not be read for this row.",
    };
  }
  return {
    state: input.record.state,
    label: WORKFLOW_STATE_LABEL[input.record.state],
    tone: input.record.state === "resolved" ? "positive" : "neutral",
    detail: input.record.assigneeUserId
      ? `Owner ${input.record.assigneeUserId}`
      : input.record.snoozeUntil
        ? `Held until ${input.record.snoozeUntil}`
        : null,
  };
}

/**
 * The hook's conflict, shaped for the dialog that renders it.
 *
 * Returns null unless the conflict belongs to the decision the inspector is
 * describing: a 409 on another row is not this panel's business, and showing it
 * here would attribute somebody else's collision to the row on screen.
 */
function workflowConflict(
  conflict: DecisionWorkflowConflict | null,
  selectedDecisionKey: string | null,
  onKeepMine: (conflict: DecisionWorkflowConflict) => void,
  onTakeServer: () => void,
): MetaDecisionCenterExactWorkflow["conflict"] {
  if (!conflict || conflict.decisionKey !== selectedDecisionKey) return null;
  const plan = reapplyPlan({
    current: conflict.current,
    attempted: conflict.attempted,
    message: conflict.message,
  });
  return {
    currentStateLabel: WORKFLOW_STATE_LABEL[conflict.current.state],
    currentVersion: conflict.current.stateVersion,
    attemptedLabel: WORKFLOW_ACTION_LABELS[conflict.attempted.action],
    attemptedFromVersion: conflict.attempted.fromVersion,
    message: conflict.message,
    keepRefusedReason: plan.allowed ? null : plan.reason,
    onKeepMine: plan.allowed ? () => onKeepMine(conflict) : undefined,
    onTakeServer,
  };
}

/**
 * The provider's own campaign manager, for this exact account.
 *
 * A read-only way OUT, and nothing more. It is not an action: the operator
 * leaves this product and does whatever they do at Meta, and this page will
 * learn about it on the next sync like any other external change. It carries
 * no `data-ctl` because the design's control contract has no key for it —
 * `live:META-DEC-13 open` is the inactive-assets strip, and borrowing that key
 * would name this control as something it is not.
 *
 * Null when the account id is not the `act_<digits>` shape Meta's own URL takes.
 * A guessed id would open somebody else's account.
 */
function metaAdsManagerHref(providerAccountId: string | null): string | null {
  const match = providerAccountId?.trim().match(/^act_(\d+)$/);
  if (!match) return null;
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${match[1]}`;
}

/**
 * Where a brief is created from a decision (`live:CREATIVE-07 brief`).
 *
 * The Briefs surface already reads `creativeId`, `snapshotId` and `trigger`
 * from its URL and refuses creation without all three
 * (`canCreateBrief`) — but nothing in the product minted a link carrying them,
 * so the brief-from-decision flow was reachable only by hand-writing a URL.
 * This is that link.
 *
 * The window travels too. A brief is written against what the operator was
 * looking at, and landing them on the Studio's own stored range would describe
 * a different set of days than the decision they came from.
 */
function decisionBriefHref(input: {
  businessId: string;
  providerAccountId: string | null;
  creativeId: string;
  snapshotId: string;
  trigger: string;
  startDate: string | null;
  endDate: string | null;
  pathname: string | null;
}): string | null {
  if (!input.providerAccountId?.trim()) return null;
  const params = new URLSearchParams({
    providerAccountId: input.providerAccountId.trim(),
    creativeId: input.creativeId,
    snapshotId: input.snapshotId,
    trigger: input.trigger,
  });
  // The Studio's own spelling, which `scopeFromSearchParams` reads on this
  // route. A half window is not a window and is left off entirely.
  if (input.startDate && input.endDate && input.startDate <= input.endDate) {
    params.set("start", input.startDate);
    params.set("end", input.endDate);
  }
  /*
   * Written in the `/app` spelling on purpose.
   *
   * Briefs is a v2 surface with no pre-v2 route, so it has no legacy key in
   * `APP_PATH_BY_LEGACY_PATH`; a bare `/creative/briefs` would fall through
   * `dashboardHrefForRouteFamily` unchanged and produce a link to nothing. The
   * `/app` spelling is recognised, and the rewrite then keeps a `/c/:business`
   * reader inside the business they are explicitly scoped to.
   */
  return dashboardHrefForRouteFamily(
    `/app/creative/briefs?${params.toString()}`,
    input.pathname ?? "",
  );
}

/**
 * The evidence tokens that mean "this ad account was actually measured".
 *
 * Read from the served vocabulary, not guessed: `MetaEvidenceSource`
 * (lib/meta/operator-policy.ts:35) is "live" | "demo" | "snapshot" |
 * "fallback" | "unknown", and the pulse route adds "warehouse" for its
 * warehouse fast path (app/api/meta/account-pulse/route.ts:602 and :639).
 * Three of those six describe a real read of this account: a live provider
 * read, the warehouse rollup of the same rows, and a stored decision snapshot
 * — a measurement taken earlier is still a measurement. The other three do
 * not, and `metaEvidenceSourceNotice` states which for each.
 */
const META_MEASURED_EVIDENCE_SOURCES: ReadonlySet<string> = new Set([
  "live",
  "warehouse",
  "snapshot",
]);

/**
 * WHAT THE SERVED EVIDENCE TOKEN MAKES OF THE NUMBERS ON THIS PAGE.
 *
 * `pulse.dataReadiness.evidenceSource` names the read path that answered. The
 * readiness banner next to it fires on `status !== "ok" || isPartial`, and the
 * demo arm of `lib/meta/campaigns-source.ts:65-72` returns the HEALTHY value of
 * BOTH — `status: "ok"`, `isPartial: false` — wrapped around
 * `getDemoMetaCampaigns().rows`, which `app/api/meta/account-pulse/route.ts:855`
 * copies onto `pulse.dataReadiness` verbatim. So on a demo business no banner
 * fired, this token reached no surface at all, and the KPI strip drew
 * fabricated figures in exactly the format measured ones use. Nothing upstream
 * covered it either: the demo `PostureNotice` lives in
 * `components/zero-base/shell/client-shell.tsx`, and this page renders under
 * `app/(dashboard)/layout.tsx` -> `components/layout/dashboard-frame.tsx`,
 * where `grep -ric demo` returns 0.
 *
 * AN UNRECOGNISED TOKEN IS NAMED, NOT ASSUMED. The page contract types the
 * field as a bare `string`, so a seventh token can arrive. Treating an unknown
 * token as measured would re-open this exact hole for the next source, and
 * calling it fabricated would be a claim nothing supports — so the notice says
 * what the server sent and that this page cannot read it.
 *
 * IT REPORTS, AND NOTHING ELSE. No decision, no lane, no write authority: the
 * served numbers are still drawn exactly as served, and the operator is told
 * what they are.
 *
 * @returns null when the evidence IS a measurement of this account.
 */
export function metaEvidenceSourceNotice(
  evidenceSource: string | null | undefined,
): {
  kind: "demonstration" | "fallback" | "unnamed" | "unreadable";
  title: string;
  detail: string;
} | null {
  const source = (evidenceSource ?? "").trim().toLowerCase();
  if (META_MEASURED_EVIDENCE_SOURCES.has(source)) return null;
  if (source === "demo") {
    return {
      kind: "demonstration",
      title: "These are demonstration numbers, not measurements.",
      detail:
        "The account pulse was served with evidence source “demo”: the spend, revenue, ROAS and CPA on this page are sample values, not readings of this ad account.",
    };
  }
  if (source === "fallback") {
    return {
      kind: "fallback",
      title: "These numbers came from a fallback source.",
      detail:
        "The account pulse named its evidence source “fallback” rather than a measured read of this ad account, so the figures on this page are not this account's verified measurement.",
    };
  }
  if (source === "" || source === "unknown") {
    return {
      kind: "unnamed",
      title: "The source of these numbers is unnamed.",
      detail:
        "The account pulse did not name where its figures came from, so they cannot be read as this ad account's verified measurement.",
    };
  }
  return {
    kind: "unreadable",
    title: "The source of these numbers is one this page cannot read.",
    detail: `The account pulse named its evidence source “${source}”. This page has no reading for that token, so it cannot say whether those figures measure this ad account.`,
  };
}

/**
 * THE COUNT OF ACTIONS THAT FAILED WITHOUT TELLING ANYONE.
 *
 * `digest.actions.silentFailureCount`
 * (app/api/meta/decisions-workspace/route.ts:948-951) counts action-log rows
 * whose status is `silent_failure`. That status is written when the provider
 * outcome is AMBIGUOUS — `provider_outcome_ambiguous`, an observed successful
 * mutation attempt inside a failed call, or the explicit `silent_failure` code
 * (app/api/launchpad/meta/launch/route.ts:106-113,
 * app/api/launchpad/meta/bulk-ad-status/route.ts:154-160) — so the write may or
 * may not have landed at Meta and retry is suppressed pending reconciliation.
 * Until this notice existed the whole repo referenced the field exactly twice:
 * the route that computes it and the type that declares it. A count of silent
 * failures, itself silent, is the defect it counts.
 *
 * A ZERO IS A MEASURED "NOTHING FAILED" AND STAYS OFF SCREEN. A banner that
 * stands there saying "0" every day is a banner an operator stops reading, and
 * this one has to be read the day it appears.
 *
 * AND THE SAME GATE IS WHAT KEEPS A READ FAILURE FROM RENDERING AS AN EMPTY
 * SUCCESS. When the digest source tables are unreachable, or the compact
 * surface never asked for them, the route returns `unavailableReason` beside
 * the UNTOUCHED `emptyDecisionDigest` zeros (route.ts:736, :976, :1336) — so
 * every count that accompanies an `unavailableReason` is zero, the `> 0` gate
 * already withholds it, and this notice never says "nothing failed" in any
 * state at all: it only ever appears to report failures. `unavailableReason`
 * is deliberately NOT a second gate on top of that. A POSITIVE count can only
 * exist because the action-log query returned those rows, and suppressing a
 * measured positive because a sibling flag is set would render a measurement
 * as nothing — the mirror of the defect this notice closes.
 *
 * `verifiedCount` is the honest denominator and is stated with it: "2 of 3"
 * says how much of the workspace's recent activity is in doubt, where a bare
 * "2" does not.
 *
 * AND THE SENTENCE IS NEVER WIDER THAN THE MEASUREMENT UNDER IT. Both counts
 * are computed by filtering the rows the BOUNDED action-log query returned, so
 * past `META_ACTION_DIGEST_ROW_CAP` qualifying rows they describe the newest
 * page of the window and not the window — while "this account's action digest
 * since <date> carries M recorded actions" reads as the window's total. Every
 * number was measured and the frame around it was too wide, which is the same
 * family as a null status read as "archived" erasing 95% of an account's spend
 * from a rollup. When `countsTruncated` is set the title states a FLOOR ("at
 * least N") and the detail says the count covers only the newest page, names
 * the cap that produced it, and refuses to guess how many more the window
 * holds. An untruncated digest keeps saying exactly what it said before.
 *
 * IT REPORTS, AND NOTHING ELSE. It names no entity, asserts no outcome — the
 * whole point is that the outcome is unknown — and offers no way to act on it.
 * What it now does name is the READ-ONLY screen that can separate the two
 * outcomes it cannot: `/platforms/meta/history` labels each action-log row
 * `Silent failure` or `Verified`
 * (app/(dashboard)/platforms/meta/history/history-view.tsx:88-97,140-146) off
 * the same `meta_ads_action_log` rows (lib/meta/history-read-model.ts:502),
 * over a GET-only route. Raising an alarm and naming nowhere to take it was
 * the second half of this defect.
 */
export function metaSilentActionFailureNotice(
  digest:
    | {
        snapshotDate?: string | null;
        actions?: {
          verifiedCount?: number;
          silentFailureCount?: number;
          countedRowCap?: number | null;
          countsTruncated?: boolean | null;
        } | null;
      }
    | null
    | undefined,
): { title: string; detail: string } | null {
  if (!digest) return null;
  const silent = digest.actions?.silentFailureCount ?? 0;
  const verified = digest.actions?.verifiedCount ?? 0;
  if (!Number.isFinite(silent) || silent <= 0) return null;
  const total = verified + silent;
  const since = digest.snapshotDate?.trim()
    ? ` since ${digest.snapshotDate.trim()}`
    : "";
  const destination =
    " Meta History lists each recorded action on its own row with the outcome Meta reported.";
  if (digest.actions?.countsTruncated === true) {
    const cap = digest.actions?.countedRowCap;
    // The cap is named only when the payload actually served one. A digest
    // that reports truncation without saying what bound it still gets the
    // floor and the warning; inventing a bound to round out the sentence would
    // put a fabricated number where a measurement belongs.
    const capClause =
      typeof cap === "number" && Number.isFinite(cap) && cap > 0
        ? `, the most a ${cap}-row cap lets it read,`
        : ",";
    /*
     * The floor in the title is exact; the fourth sentence is not, and must not
     * pretend to be. `countsTruncated` is `rows.length >= cap`, which cannot
     * tell a window holding exactly `cap` rows -- a COMPLETE read -- from one
     * holding four thousand. Asserting "the window holds more" would put an
     * unmeasured positive claim in the same sentence that exists to stop a
     * measured count reading wider than its measurement. "May hold" is exactly
     * as strong as `>=` actually is. A real total would need a second COUNT(*)
     * over the same predicate on the hot decisions read, which is a cost this
     * sentence does not justify.
     */
    return {
      title: `At least ${silent} recorded action${silent === 1 ? "" : "s"} ended without a verified outcome.`,
      detail: `This account's action digest${since} counts only its ${total} most recent recorded action${total === 1 ? "" : "s"}${capClause} and of those ${verified} ${verified === 1 ? "is" : "are"} verified and ${silent} ${silent === 1 ? "is" : "are"} not. The window may hold more recorded actions than this count covers; whether it does, and how many, is unavailable here. An unverified action may or may not have landed at Meta.${destination}`,
    };
  }
  return {
    title: `${silent} recorded action${silent === 1 ? "" : "s"} ended without a verified outcome.`,
    detail: `This account's action digest${since} carries ${total} recorded action${total === 1 ? "" : "s"}: ${verified} verified, ${silent} not. An unverified action may or may not have landed at Meta, and this page cannot tell which.${destination}`,
  };
}

function workspaceBannerPriority(banner: MetaWorkspaceBanner) {
  if (banner.id === "meta_write_kill_switch") return 0;
  if (banner.id === "dry_run_mode" || banner.id === "dry_run_only_guardrail")
    return 1;
  if (banner.id === "tracking_write_gate") return 2;
  if (banner.id === "reviewer_read_only" || banner.id === "workspace_read_only")
    return 3;
  if (banner.blocking) return 3;
  // An action whose outcome nobody verified is a fact about the ACCOUNT, so it
  // ranks with snapshot freshness and above the readiness pair, which are
  // facts about the picture.
  if (banner.id === "silent_action_failures") return 4;
  if (banner.id === "snapshot_health") return 4;
  if (banner.id === "data_readiness") return 5;
  // Same question as data_readiness — can these numbers be trusted — so the
  // same rank; the two can fire together and read as one paragraph.
  if (banner.id === "readiness_evidence_source") return 5;
  return 6;
}

function workspaceBannerToneClass(banner: MetaWorkspaceBanner) {
  if (banner.tone === "danger") return "danger";
  if (banner.tone === "warning") return "warn";
  if (banner.tone === "success") return "success";
  return "info";
}

/**
 * The one banner in this strip that points somewhere.
 *
 * `silent_action_failures` reports an outcome NOBODY KNOWS, so a control that
 * retried, resumed or reconciled would be asserting an outcome the banner just
 * said is unknown — and this page has no write authority to assert it with.
 * A destination is a different thing: Meta History reads the same
 * `meta_ads_action_log` rows over a GET-only route and labels each one
 * `Silent failure` or `Verified`, which is exactly the distinction this banner
 * cannot draw. Naming it trades no safety for usefulness.
 *
 * Consistent with the strip rather than novel: `meta_write_kill_switch`
 * already carries a System Status link and `tracking_write_gate` a details
 * control, both rendered the same way and keyed on the same id.
 */
function workspaceBannerDestination(
  banner: MetaWorkspaceBanner,
  historyHref: string,
  pathname: string | null,
): { href: string; label: string } | null {
  const servedHref = banner.action?.href?.trim() ?? "";
  const servedLabel = banner.action?.label?.trim() ?? "";
  if (servedHref.startsWith("/") && servedLabel) {
    return {
      href: dashboardHrefForRouteFamily(servedHref, pathname ?? ""),
      label: servedLabel,
    };
  }
  if (banner.id === "meta_write_kill_switch") {
    return {
      href: dashboardHrefForRouteFamily(
        "/platforms/meta/automation",
        pathname ?? "",
      ),
      label: "System Status",
    };
  }
  if (banner.id === "silent_action_failures") {
    return { href: historyHref, label: "Meta History" };
  }
  return null;
}

function workspaceBannerDetail(banner: MetaWorkspaceBanner) {
  const scopeDetail =
    banner.scope === "target_hard_actions"
      ? " This applies to hard Scale/Cut authority; the rest of the queue remains readable."
      : "";
  if (banner.id === "tracking_write_gate") {
    return `${banner.detail} Pause, bid and rebuild writes ask for confirmation first. Hiding this banner does not unlock writes; the gate stays active.${scopeDetail}`;
  }
  if (banner.id === "meta_write_kill_switch") {
    return `${banner.detail} The queue stays readable; execute and route actions are locked until an Admin releases it.${scopeDetail}`;
  }
  return `${banner.detail}${scopeDetail}`;
}

function MetaWorkspacePostureBanners({
  banners,
  historyHref,
  pathname,
  trackingDismissed,
  onDismissTracking,
  onOpenTrackingDetails,
}: {
  banners: MetaWorkspaceBanner[];
  historyHref: string;
  pathname: string | null;
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

  const renderBanner = (banner: MetaWorkspaceBanner, primary: boolean) => {
    const tone = workspaceBannerToneClass(banner);
    const detail = workspaceBannerDetail(banner);
    const destination = workspaceBannerDestination(
      banner,
      historyHref,
      pathname,
    );
    return (
      <div
        key={banner.id}
        className={cn(
          "meta-posture-banner",
          `meta-posture-banner--${tone}`,
          primary && "meta-posture-banner--primary",
        )}
        data-banner-id={banner.id}
        data-banner-blocking={banner.blocking ? "true" : "false"}
        data-banner-scope={banner.scope ?? "workspace"}
        role={banner.blocking || tone === "danger" ? "alert" : "status"}
      >
        <span className="meta-posture-banner__mark" aria-hidden="true" />
        <span className="meta-posture-banner__title">{banner.title}</span>
        <span className="meta-posture-banner__detail" title={detail}>
          {detail}
        </span>
        <span className="meta-posture-banner__spacer" aria-hidden="true" />
        {destination ? (
          <a
            className="meta-posture-banner__button"
            href={destination.href}
          >
            {destination.label}
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
  };

  const blockingBanners = visibleBanners.filter(
    (banner) => banner.blocking || workspaceBannerToneClass(banner) === "danger",
  );
  const expandedBanners =
    blockingBanners.length > 0 ? blockingBanners : visibleBanners.slice(0, 1);
  const expandedIds = new Set(expandedBanners.map((banner) => banner.id));
  const informationalBanners = visibleBanners.filter(
    (banner) => !expandedIds.has(banner.id),
  );
  return (
    <div className="meta-posture-banners" data-testid="meta-posture-banners">
      <p className="meta-posture-banners__eyebrow">Current operating status</p>
      {expandedBanners.map((banner, index) => renderBanner(banner, index === 0))}
      {informationalBanners.length > 0 ? (
        <details className="meta-posture-banners__details">
          <summary>
            {informationalBanners.length} additional data note
            {informationalBanners.length === 1 ? "" : "s"}
          </summary>
          <div className="meta-posture-banners__detail-list">
            {informationalBanners.map((banner) => renderBanner(banner, false))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The served account inventory, browsable without going through Archive.
 *
 * MEASURED on Grandmix (5dbc7147-f051-4681-a4d6-20617170074f /
 * act_805150454596350, window 28d, snapshot 2026-08-18): the payload serves
 * `lanes.structureInventory` with 1,230 entities — 476 campaigns, 754 ad sets.
 * The lanes that render them are Action Now 3, Watching 19, Healthy 0,
 * Non-sales 0, Archive 1,211 structure rows (+83 withheld Ad decisions). So
 * 1,211 of 1,230 — 98.5% — were reachable ONLY by opening a lane named
 * Archive, and `os.structure.groups`, the server's grouped census of the same
 * 1,230 entities, was read at exactly one place in the client
 * (`structureNodesByRecommendationId`) purely to enrich rows that already had
 * a lane. It was served and rendered nowhere.
 *
 * WHAT THIS IS NOT. Inventory visibility is not recommendation or execution
 * eligibility (INVARIANTS.md). No row here carries an action, a lane, a
 * decision label, a priority or an urgency — not because they are suppressed
 * but because `MetaStructureInventoryEntity` never carried them, and the
 * builder behind this panel deliberately reads that contract instead of
 * `os.structure`, whose nodes do. There is no button, no menu and no row
 * click: the panel cannot hand anything to Launchpad or to a provider write,
 * and nothing in it re-files a row into a different lane. Rows the server put
 * in Archive are still in Archive; this panel says the account also HAS them.
 *
 * It renders inside the structure scope only, and only when the operator opens
 * it, so 1,230 rows never land in the DOM behind the creatives scope or behind
 * a closed disclosure.
 */
function MetaStructureInventoryPanel({
  view,
  open,
  onToggle,
  windowLabel,
}: {
  view: MetaStructureInventoryViewModel;
  open: boolean;
  onToggle: (open: boolean) => void;
  windowLabel: string;
}) {
  const served =
    view.servedCount === null ? "—" : view.servedCount.toLocaleString("en-US");
  const grains =
    view.campaignCount === null || view.adsetCount === null
      ? "—"
      : `${view.campaignCount.toLocaleString("en-US")} campaigns · ${view.adsetCount.toLocaleString(
          "en-US",
        )} ad sets`;
  return (
    <details
      className={styles.inventoryPanel}
      data-meta-structure-inventory
      data-meta-structure-inventory-served={served}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary>
        Account inventory
        <span data-meta-structure-inventory-summary>
          {served} served · {grains}
          {view.searchApplied
            ? ` · ${view.shownCount.toLocaleString("en-US")} match the search`
            : ""}
        </span>
      </summary>
      <p className={styles.inventoryNote}>
        Everything the server serves for this account, in the order it served
        it. Listing an entity here is not a recommendation and grants no action
        — decisions stay in the lanes above.
      </p>
      {/*
        The body is gated on the open state, not on the disclosure triangle.

        `<details>` renders its children whether or not it is open, so leaving
        the table unconditional put all 1,230 of Grandmix's served rows into
        the DOM on every render of the Decision Center, behind a closed
        triangle nobody had clicked. The summary line is always rendered, so
        the native toggle still fires and brings the table with it.
      */}
      {!open ? null : view.unavailableReason ? (
        <p className={styles.inventoryNote} data-meta-structure-inventory-empty>
          {view.unavailableReason}
        </p>
      ) : view.rows.length === 0 ? (
        <p className={styles.inventoryNote} data-meta-structure-inventory-empty>
          No served entity matches the search term. Clear it to see all {served}
          .
        </p>
      ) : (
        <div className={styles.inventoryScroll}>
          <table className={styles.inventoryTable}>
            <thead>
              <tr>
                <th>Entity</th>
                <th>Grain</th>
                <th>Campaign</th>
                <th>Status</th>
                <th>{`Spend · ${windowLabel}`}</th>
                <th>ROAS</th>
                <th>Purchases</th>
                {/*
                  CPA and CTR were served on every census row
                  (`MetaStructureInventoryEntity.metrics`) and rendered nowhere,
                  so the table could say what an entity spent and what it earned
                  but not what a purchase cost or how the creative was clicked.
                  Both are formatted in the adapter, which also states their
                  units. Frequency, the third unrendered metric on the same
                  object, is deliberately still absent — it is derived from a
                  reach figure summed across days, which counts one person once
                  per day and drags the ratio below the truth.
                  @see components/meta/decision-center/decision-payload-coverage.test.ts
                */}
                <th>CPA</th>
                <th>CTR</th>
                <th>Setup</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.id} data-meta-structure-inventory-row={row.id}>
                  <td>{row.name}</td>
                  <td>
                    <span className={styles.inventoryGrain}>{row.grain}</span>
                  </td>
                  <td>{row.lineage}</td>
                  <td>{row.status}</td>
                  <td>{row.spend}</td>
                  <td>{row.roas}</td>
                  <td>{row.purchases}</td>
                  <td>{row.cpa}</td>
                  <td>{row.ctr}</td>
                  <td>{row.configuration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function MetaNativeAdPauseDialog({
  open,
  adName,
  accountLabel,
  pending,
  confirmLocked,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  adName: string | null;
  accountLabel: string | null;
  pending: boolean;
  confirmLocked: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      data-meta-native-ad-pause-dialog
      onMouseDown={() => {
        if (!pending) onClose();
      }}
    >
      <div
        aria-describedby="meta-native-ad-pause-description"
        aria-labelledby="meta-native-ad-pause-title"
        aria-modal="true"
        className="meta-label-modal"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="meta-label-modal-head">
          <div>
            <h2 id="meta-native-ad-pause-title">Pause this exact Meta Ad?</h2>
            <p id="meta-native-ad-pause-description">
              {adName ?? "This Ad"} in{" "}
              {accountLabel ?? "the selected Meta account"} will be requested as
              PAUSED. The server will re-read the immutable decision lineage and
              live hierarchy before one provider attempt.
            </p>
          </div>
        </div>
        <div className="meta-label-modal-body">
          <p>
            No campaign, ad set, sibling Ad, budget or creative is changed by
            this control. An ambiguous provider result is quarantined for
            reconciliation and is never retried automatically.
          </p>
          {error ? (
            <p role="alert" data-meta-native-ad-pause-error>
              {error}
            </p>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--danger"
              data-meta-native-ad-pause-confirm
              disabled={pending || confirmLocked}
              onClick={onConfirm}
            >
              {pending
                ? "Pausing…"
                : confirmLocked
                  ? "Await fresh read-back"
                  : "Pause exact Ad"}
            </button>
          </div>
        </div>
      </div>
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
  decisionWorkflowUiEnabled: authorizedWorkflowUiEnabled,
  mutationUiEnabled: authorizedMutationUiEnabled,
}: MetaPlatformPageProps) {
  // `=== true` rather than `?? false`: any value other than a server's explicit
  // true reads as closed.
  const decisionWorkflowUiEnabled = authorizedWorkflowUiEnabled === true;
  // Exactly `true`, like every other gate on this surface: an absent, empty or
  // misspelled value is off, and `undefined` from a caller that has not been
  // threaded is off too.
  const mutationUiEnabled = authorizedMutationUiEnabled === true;
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
  const [pendingStructurePrimary, setPendingStructurePrimary] = useState<{
    recommendation: MetaRecommendation;
    action: MetaOsDecisionAction;
  } | null>(null);
  const [pendingNativePauseTracking, setPendingNativePauseTracking] =
    useState<AuthorizedMetaNativeAdPause | null>(null);
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
  const [rowSort, setRowSort] = useState<MetaRowSort>("money");
  const [adCandidateLimit, setAdCandidateLimit] = useState(
    META_DECISIONS_AD_CANDIDATE_LIMIT,
  );
  // `q` is restored, not dropped: the retired contract's search parameter names
  // a control this surface actually has.
  const [rowSearch, setRowSearch] = useState(() =>
    parseMetaRowSearch(searchParams),
  );
  /*
   * `levels` is restored too, and that is a change of posture.
   *
   * This surface used to have no level filter at all, so a link that said
   * "campaigns only" was reported as unhonoured and the recipient was shown
   * every ad set as well. The filter exists now, so the parameter is applied.
   */
  const [activeLevels, setActiveLevels] = useState<MetaDecisionLevel[]>(() =>
    parseMetaDecisionLevels(searchParams),
  );
  /*
   * Whether the operator has put the evidence panel away.
   *
   * Local rather than in the URL, and deliberately so: `live:close` says the
   * SELECTION state is kept in the URL, which it is — closing the panel does
   * not clear `row`, and a reload lands on the same row. What it does not
   * survive is a reload, because an operator who closed a panel three days ago
   * has not asked for it to stay closed forever.
   */
  const [inspectorDismissed, setInspectorDismissed] = useState(false);
  /**
   * The row whose manual action sheet is open, or null.
   *
   * The ceremony is a page-level overlay rather than a section of the
   * inspector: it is a four-step sequence with its own terminal states, and
   * burying it in a column that the operator can scroll away from is how a
   * receipt gets lost.
   */
  const [manualCeremonyRec, setManualCeremonyRec] =
    useState<MetaRecommendation | null>(null);
  /*
   * The row the evidence window is describing, in the two envelopes it can
   * arrive in. BOTH are nullable and at least one is always present.
   *
   * `canonical` used to be required, which made the canonical envelope the gate
   * on opening the window at all — and on a real account that gate is closed
   * for every row: Grandmix serves 60 ads, none of which joins a decision
   * snapshot. The served decision carries real evidence, so it opens the window
   * on its own; what travels with it is the envelope's ABSENCE, as `null`, so
   * the window can state it rather than infer around it.
   */
  const [creativeDrill, setCreativeDrill] = useState<{
    decision: MetaOsAdDecision | null;
    canonical: MetaCanonicalDecision | null;
  } | null>(null);
  const [nativeAdPauseAuthorization, setNativeAdPauseAuthorization] =
    useState<AuthorizedMetaNativeAdPause | null>(null);
  const [nativeAdPausePending, setNativeAdPausePending] = useState(false);
  const nativeAdPausePendingRef = useRef(false);
  const [nativeAdPauseLockedKey, setNativeAdPauseLockedKey] = useState<
    string | null
  >(null);
  const [nativeAdPauseError, setNativeAdPauseError] = useState<string | null>(
    null,
  );
  /*
   * The inventory disclosure is closed on arrival and its state lives here.
   *
   * Closed means the 1,230 served rows are not in the DOM at all: `<details>`
   * still mounts its children when it is collapsed, and mounting a table that
   * large behind a closed triangle on every render of the Decision Center is a
   * cost the operator never asked for.
   */
  const [structureInventoryOpen, setStructureInventoryOpen] = useState(false);
  const latestSearchParamsRef = useRef(searchParams.toString());

  useEffect(() => {
    latestSearchParamsRef.current = searchParams.toString();
    setActiveLane(parseMetaWorkspaceLane(searchParams));
    setActiveScope(parseMetaScope(searchParams));
  }, [searchParams]);

  useEffect(() => {
    if (!nativeAdPauseAuthorization || nativeAdPausePending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNativeAdPauseAuthorization(null);
        setNativeAdPauseError(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [nativeAdPauseAuthorization, nativeAdPausePending]);

  const providerAccountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", businessId],
    enabled: Boolean(businessId),
    queryFn: ({ signal }) =>
      fetchMetaHistoryAccounts({
        businessId,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      }),
    staleTime: 5 * 60 * 1000,
    retry: false,
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
    creativeDrill?.canonical?.parentChain.creative?.id?.trim() ||
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
    creativeDrill?.canonical?.parentChain.ad?.id?.trim() ||
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
      adCandidateLimit,
    ],
    enabled: Boolean(businessId && providerAccountId),
    queryFn: ({ signal }) =>
      fetchDecisionsWorkspace(
        businessId,
        providerAccountId!,
        selectedWindow,
        selectedStatusFilter,
        adCandidateLimit,
        selectedDateRange,
        signal,
      ),
    // A failed workspace fan-out is expensive and may already be holding a DB
    // connection. Repeating it automatically turned one outage into minutes of
    // spinner time and pool pressure. Surface the verified failure once; the
    // operator-controlled Retry above is the only retry.
    retry: false,
    refetchOnWindowFocus: false,
    /**
     * Keep the rows that are already on screen while the next window loads.
     *
     * §9 is explicit that a refresh is not a first load: *"Old data still on
     * screen while new data is fetched is not a first load, and blanking it to
     * a skeleton throws away readable evidence to show a spinner."* Changing
     * the window changes this query's key, so without this the operator's whole
     * queue was replaced by a skeleton every time — and the honest cost of
     * keeping it, that the previous window's figures are briefly under the new
     * window's label, is precisely what `refreshing-with-stale` discloses.
     */
    placeholderData: keepPreviousData,
  });

  /**
   * Forward the server's §9 envelope. Nothing is computed here.
   *
   * The route decides the state from facts only it has — which of the four
   * decision sources answered, and how many rows each returned — and puts the
   * envelope in the payload. This hands it to the region the page rendered
   * above this body, so a screen that has finished reading stops saying it is
   * still loading. `undefined` publishes null, which leaves the page's own
   * envelope showing rather than asserting anything.
   */
  useEffect(() => {
    publishMetaSurfaceState("meta-decisions", workspaceQuery.data?.readState ?? null);
  }, [workspaceQuery.data?.readState]);

  /**
   * A newer read is running over rows already on screen.
   *
   * Reported, not interpreted: `laterMetaSurfaceState` decides that this makes
   * the surface `refreshing-with-stale`. Without it a refresh presented the
   * previous window's figures under the new window's label with nothing saying
   * so — §9's fourth state, and the reason it exists.
   */
  useEffect(() => {
    publishMetaSurfaceRefreshing(
      "meta-decisions",
      // Either shape of the same fact: a refetch of the current window, or the
      // previous window's rows held on screen while the new one loads.
      (workspaceQuery.isFetching && workspaceQuery.data !== undefined) ||
        workspaceQuery.isPlaceholderData,
    );
  }, [workspaceQuery.isFetching, workspaceQuery.isPlaceholderData, workspaceQuery.data]);

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
  const inactiveStructureRows = laneQuery.data?.archive ?? [];
  const inactiveAdDecisions =
    canonicalDecisionModel?.queue.inactiveAssets?.items ?? [];
  /**
   * The two inactive grains, filtered by the search box and kept in the order
   * the server sent them.
   *
   * Split deliberately. The combined list below ranks both grains on spend for
   * the mobile inactive view, and the archive lane must NOT inherit that: a
   * ranking this page invents is not the ranking the server decided, and a
   * campaign's spend already contains its ad sets' and ads' spend, so one
   * money order across grains asserts a comparison no server made.
   */
  const inactiveServedGrains = useMemo(() => {
    const query = rowSearch.trim().toLowerCase();
    const structures = inactiveStructureRows.filter(
      (row) =>
        !query ||
        [row.name, row.campaignName ?? "", row.statusLabel].some((value) =>
          value.toLowerCase().includes(query),
        ),
    );
    const ads = inactiveAdDecisions.filter((decision) =>
      canonicalCreativeSearchMatch(decision, rowSearch),
    );
    return { structures, ads };
  }, [inactiveAdDecisions, inactiveStructureRows, rowSearch]);
  const inactiveViewItems = useMemo(() => {
    const structures = inactiveServedGrains.structures.map((row) => ({
      kind: "structure" as const,
      row,
      spend: row.spend,
    }));
    const ads = inactiveServedGrains.ads.map((decision) => ({
      kind: "ad" as const,
      decision,
      spend: decision.metrics.spend ?? -1,
    }));
    return [...structures, ...ads].sort(
      (left, right) => right.spend - left.spend,
    );
  }, [inactiveServedGrains]);
  /**
   * Every canonical envelope the payload carries, as a LOOKUP TABLE.
   *
   * LAW: section membership is a RANKING, not a visibility gate. This list is
   * handed to the exact adapter so a rendered Ad can find the canonical
   * decision its evidence window needs. It selects no rows, orders nothing, and
   * filters nothing -- the rows themselves come from `os.ads.items`, which is
   * the server's own Ad-grain selection.
   *
   * It used to be `queue.sections.creative_rotation` alone, which is the
   * compact operator queue capped at five. On Grandmix
   * (act_805150454596350) that section holds 5 `out_of_scope` decisions while
   * `os.ads.items` carries 60 live Ads, and the two sets do not intersect at
   * all -- so the Creatives scope rendered ZERO rows out of 60 served. The
   * union of `adCandidates` and every section is the widest set the payload
   * actually contains, and it is still only ever read by key.
   */
  const canonicalDecisionEnvelopes = useMemo(() => {
    const queue = canonicalDecisionModel?.queue;
    if (!queue) return [] as MetaCanonicalDecision[];
    const seen = new Set<string>();
    const envelopes: MetaCanonicalDecision[] = [];
    for (const decision of [
      ...(queue.adCandidates?.items ?? []),
      ...Object.values(queue.sections).flatMap((section) => section.items),
    ]) {
      const key = `${decision.decisionId}\u0000${decision.sourceSnapshotId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      envelopes.push(decision);
    }
    return envelopes;
  }, [canonicalDecisionModel]);
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

  const trackingBlocked = workspaceQuery.data
    ? workspaceQuery.data.system.trackingBlocked
    : isTrackingWriteBlocked(pulseQuery.data);
  const viewerReadOnlyReason = !workspaceQuery.data?.viewer
    ? "Decision authority is unavailable; write controls remain disabled."
    : workspaceQuery.data.viewer.readOnly
      ? (workspaceQuery.data.viewer.readOnlyReason ??
        "Current viewer is read-only; write controls are downgraded to review.")
      : null;
  const isViewerReadOnly = viewerReadOnlyReason !== null;
  const workspaceBanners = useMemo<MetaWorkspaceBanner[]>(() => {
    const served = workspaceQuery.data?.banners ?? [];
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
    /**
     * Two facts the server states that no banner on either side repeats.
     *
     * They are APPENDED to whichever set won, instead of being pushed onto
     * `fallback`, and that is the whole point: the fallback is discarded the
     * moment the server sends any banner at all, so a demo account that also
     * had a stale snapshot would have lost its demo disclosure to the snapshot
     * banner and gone back to drawing fabricated numbers in silence.
     *
     * SERVED STILL WINS. Neither id is produced by `workspaceBanners()` in
     * app/api/meta/decisions-workspace/route.ts:981-1100, so appending cannot
     * duplicate a served banner today; the id guards keep that true if the
     * route ever starts serving one, and the served copy is the one that
     * survives.
     */
    const base = served.length > 0 ? served : fallback;
    const notices: MetaWorkspaceBanner[] = [];
    const evidence = readiness
      ? metaEvidenceSourceNotice(readiness.evidenceSource)
      : null;
    /**
     * Withheld in exactly one case: the source is UNNAMED and the readiness
     * banner is already up. "unknown" is what `campaigns-source.ts` returns
     * when the range came back empty, which is the same event that fills
     * `notReadyReason` — there the readiness banner really does state the
     * consequence for the numbers, and a second warning repeating it is how a
     * banner strip turns into wallpaper. The demo arm, where that excuse is
     * false because NO banner fires at all, is not this branch.
     */
    const evidenceIsUnnamedWithReadinessBannerUp =
      evidence?.kind === "unnamed" &&
      base.some((banner) => banner.id === "data_readiness");
    if (
      evidence &&
      !evidenceIsUnnamedWithReadinessBannerUp &&
      !base.some((banner) => banner.id === "readiness_evidence_source")
    ) {
      notices.push({
        id: "readiness_evidence_source",
        tone: "warning",
        title: evidence.title,
        detail: evidence.detail,
        blocking: false,
      });
    }
    const silentFailures = metaSilentActionFailureNotice(
      workspaceQuery.data?.digest,
    );
    if (
      silentFailures &&
      !base.some((banner) => banner.id === "silent_action_failures")
    ) {
      notices.push({
        id: "silent_action_failures",
        tone: "danger",
        title: silentFailures.title,
        detail: silentFailures.detail,
        blocking: false,
      });
    }
    return notices.length > 0 ? [...base, ...notices] : base;
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
  /**
   * Where the silent-failure banner sends a reader.
   *
   * Scoped to the SAME business and provider account this page is answering
   * for, because the journal picks its own account otherwise and an operator
   * sent to a different account's record would be reading someone else's
   * actions to explain this account's alarm. `buildMetaScopedHref` drops
   * either id when it is empty rather than writing a blank one, so an
   * unresolved account degrades to the journal's own default instead of a
   * malformed query.
   *
   * Routed through `dashboardHrefForRouteFamily` for the same reason every
   * other link on this page is: `/platforms/meta/history` and its `/app`
   * twin are the same screen, and a link that leaves the family the operator
   * is browsing in is a link that logs them out of it.
   */
  const metaHistoryHref = dashboardHrefForRouteFamily(
    buildMetaScopedHref("/platforms/meta/history", {
      businessId,
      providerAccountId,
    }),
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

  const setProviderAccount = (nextProviderAccountId: string) => {
    const params = currentUrlParams();
    if (nextProviderAccountId) {
      params.set("providerAccountId", nextProviderAccountId);
    } else {
      params.delete("providerAccountId");
    }
    params.delete("entity");
    setDrillItem(null);
    setNativeAdPauseAuthorization(null);
    setNativeAdPauseError(null);
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
    setDrillItem(null);
    setInspectorDismissed(false);
    const params = currentUrlParams();
    params.delete("entity");
    if (next === "creatives") params.set("scope", "creatives");
    else params.delete("scope");
    replaceMetaParams(params);
  };

  const selectLane = (next: MetaLaneView) => {
    setActiveLane(next);
    setDrillItem(null);
    setInspectorDismissed(false);
    const params = currentUrlParams();
    params.delete("entity");
    params.delete("lane");
    if (next === "action") {
      params.delete("area");
      params.delete("segment");
    } else {
      params.set("area", "monitor");
      if (next === "watching") params.delete("segment");
      else if (next === "needsres") params.set("segment", "needs_resolution");
      else if (next === "healthy") params.set("segment", "healthy");
      else if (next === "nonSales") params.set("segment", "out_of_scope");
      else params.set("segment", "structures");
    }
    replaceMetaParams(params);
  };

  /**
   * The level filter, written to the URL the way the link contract spells it.
   *
   * `levels` is the decisions URL contract's own parameter name and shape
   * (`levels=campaign,adset`), so a view narrowed here produces a link that a
   * colleague opens narrowed the same way — which is the whole of
   * `live:META-DEC-02 level`'s "URL param (INV-18)" clause. Empty deletes the
   * parameter rather than writing an empty one, so the default view has the
   * short URL and two equivalent states serialise identically.
   */
  const selectLevels = (next: MetaDecisionLevel[]) => {
    setActiveLevels(next);
    const params = currentUrlParams();
    if (next.length === 0) params.delete("levels");
    else params.set("levels", next.join(","));
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
        detail: viewerReadOnlyReason ?? "Current viewer is read-only.",
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
    // Opening any row un-dismisses the panel: the operator asked for it back.
    setInspectorDismissed(false);
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
  const findSelectedCreativeDecisionPair = () => {
    if (!creativeSelection) return null;
    const canonicalPool = [
      // Same widening as the queue: a deep link may name any Ad the payload
      // carries, not just the five the compact section ranked highest.
      ...canonicalDecisionEnvelopes,
      ...inactiveAdDecisions,
    ];
    const servedDecision = (workspaceQuery.data?.os?.ads?.items ?? []).find(
      (decision) => matchesMetaOsCreativeSelection(decision, creativeSelection),
    );

    if (servedDecision) {
      // Join only by immutable decision lineage. A pending-native row may have
      // an older canonical row with the same ad/creative identity; attaching
      // that stale envelope by identity would turn "pending" into evidence it
      // was not served with.
      const canonical =
        canonicalPool.find(
          (decision) =>
            decision.decisionId === servedDecision.decisionId &&
            decision.sourceSnapshotId === servedDecision.sourceSnapshotId,
        ) ?? null;
      return { decision: servedDecision, canonical };
    }

    const canonical =
      canonicalPool.find((decision) =>
        matchesMetaCreativeSelection(decision, creativeSelection),
      ) ?? null;
    if (!canonical) return null;
    const decision =
      (workspaceQuery.data?.os?.ads?.items ?? []).find(
        (item) =>
          item.decisionId === canonical.decisionId &&
          item.sourceSnapshotId === canonical.sourceSnapshotId,
      ) ?? null;
    return { decision, canonical };
  };

  useEffect(() => {
    if (!creativeSelection || creativeDrill) return;
    const pair = findSelectedCreativeDecisionPair();
    if (!pair) return;
    setCreativeDrill(pair);
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
    if (
      !workspaceQuery.data ||
      workspaceQuery.isLoading ||
      workspaceQuery.error
    )
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
    if (creativeSelection && !findSelectedCreativeDecisionPair()) {
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

  const isTrackingSensitiveStructureAction = (action: MetaOsDecisionAction) => {
    return (
      action.intent === "launchpad" && action.code === "route_launchpad_rebuild"
    );
  };

  const performPrimary = async (
    rec: MetaRecommendation,
    action: MetaOsDecisionAction,
  ) => {
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
    // The served action tuple owns routing authority. `rec.actionKind` is used
    // only to choose the Launchpad variant after code+intent agree; a server
    // downgrade to review/manual therefore cannot be routed or marked acted.
    const mode = launchModeForServedStructureAction(rec, action);
    if (mode) {
      openOverlayForRec(rec, mode);
      return;
    }
    setNotice({
      tone: "info",
      title: "Recommendation is review-only.",
      detail:
        action.scopeNote?.trim() ||
        `${action.label || "This recommendation"} carries no routed execution authority on this surface.`,
    });
    openDrillForRec(rec);
  };

  const handlePrimary = async (
    rec: MetaRecommendation,
    action: MetaOsDecisionAction,
  ) => {
    if (isViewerReadOnly) {
      openDrillForRec(rec);
      return;
    }
    if (trackingBlocked && isTrackingSensitiveStructureAction(action)) {
      setPendingStructurePrimary({ recommendation: rec, action });
      return;
    }
    await performPrimary(rec, action);
  };

  const confirmOverlay = () => {
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
    // Say what did NOT travel. A campaign/ad-set recommendation has no
    // canonical ad-grain decision, so there is nothing to mint a
    // server-verified handoff from — Launchpad opens as a manual start in the
    // requested mode, and the decision stays where the evidence for it is.
    // Opening a wizard is not an operator outcome: no `acted` response is
    // recorded until an actual execution or durable action receipt exists.
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
  const handoffPendingRef = useRef(false);
  /**
   * @param servedAction the decision's OWN action tuple, exactly as the payload
   *   carried it. It is never sent to the server — the mint body names a
   *   decision and asserts nothing — and it is never used to decide anything
   *   here. It is carried so a refusal can be reported under the label and
   *   scope note the server itself wrote, instead of a sentence this page
   *   composed about an action it re-derived.
   */
  const openLaunchpadFromCanonicalDecision = async (
    canonical: MetaCanonicalDecision,
    servedAction: MetaOsDecisionAction | null,
  ) => {
    if (handoffPendingRef.current) return;
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
    handoffPendingRef.current = true;
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
        const refusal = minted.message ?? "The launch handoff was refused.";
        setNotice({
          tone: "warning",
          title: "Launchpad handoff refused.",
          // The server's reason first, then the SERVER's own caption for the
          // control that was refused — label, code and intent, verbatim off the
          // tuple that travelled here. This is the only use the tuple gets, and
          // it is the point of carrying it: a refusal that cannot name what was
          // refused sends the operator back to guess, and re-deriving that name
          // from the decision label would put a classification in an action's
          // place.
          detail: servedAction
            ? `${refusal} Refused control: ${servedAction.label} (${servedAction.code}, intent ${servedAction.intent}).`
            : refusal,
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
      handoffPendingRef.current = false;
      setHandoffPending(false);
    }
  };

  const loading = briefingLoading;
  const error = briefingError;
  const anomalyError = (anomalyQuery.error ?? null) as Error | null;

  /**
   * The creative queue is the full set the server served for this account.
   *
   * `os.ads.items` IS the server's Ad-grain selection: deduplicated by ad id,
   * ordered `act` -> `blocked` -> `monitor` then by priority, and already cut
   * to `queue.adCandidates.limit` (60). Intersecting it with the compact
   * `creative_rotation` section on top of that was a second, client-side
   * selection with no contract behind it, and it discarded every Ad the server
   * had served as blocked or pending. Search is the only filter that stays:
   * the operator asked for it and can see and clear it.
   */
  const exactCreativeDecisions = (
    workspaceQuery.data?.os?.ads?.items ?? []
  ).filter(
    (decision) =>
      metaOsCreativeSearchMatch(decision, rowSearch) &&
      // Every row in this scope is an ad, so the filter is a single question:
      // does the selection include the ad grain at all.
      metaRecLevelMatch("ad", activeLevels),
  );
  const servedCreativeCount = workspaceQuery.data?.os?.ads?.items.length ?? 0;
  const eligibleCreativeCount =
    workspaceQuery.data?.os?.ads?.eligiblePreCapCount ?? servedCreativeCount;
  const nextAdCandidateLimit = Math.min(
    adCandidateLimit + META_DECISIONS_AD_CANDIDATE_LIMIT,
    META_DECISIONS_AD_CANDIDATE_MAX_LIMIT,
  );
  const canLoadMoreCreatives =
    adCandidateLimit < META_DECISIONS_AD_CANDIDATE_MAX_LIMIT &&
    eligibleCreativeCount > servedCreativeCount;
  const loadMoreCreatives = () => {
    if (!canLoadMoreCreatives || workspaceQuery.isFetching) return;
    setAdCandidateLimit(nextAdCandidateLimit);
  };
  /**
   * The archive lane gets BOTH grains it was already holding in memory.
   *
   * `inactiveViewItems` merges the served campaign/ad-set archive rows with the
   * Ad-grain decisions the read model withheld from the live queues. This line
   * used to be `item.kind === "structure" ? [item.row] : []`, so every one of
   * those Ads was fetched, filtered against the search box, and then dropped:
   * 83 served inactive Ads on Grandmix (act_805150454596350) and 319 on TheSwaf
   * (act_822913786458311) rendered as zero rows.
   *
   * Grouped by grain, and each grain in the order the SERVER sent it.
   *
   * Built from `inactiveServedGrains`, not from `inactiveViewItems`: the
   * latter is ranked on spend for the mobile view, and reading the archive out
   * of it would have re-ordered rows the server ordered while a comment right
   * here claimed it did not. Sort order is engine output, so it travels
   * untouched and the adapter names the grain on every row.
   */
  const exactArchiveRows: MetaDecisionCenterExactArchiveItem[] = [
    ...inactiveServedGrains.structures.map((row) => ({
      kind: "structure" as const,
      row,
    })),
    ...inactiveServedGrains.ads.map((decision) => ({
      kind: "ad" as const,
      decision,
    })),
  ];
  /*
   * Search and level, applied together and in that order.
   *
   * Both are row filters over the SAME served arrays, so they compose: a link
   * that carries `q=broad&levels=campaign` narrows twice, and neither is
   * allowed to widen the other. Level is checked against the row's own served
   * grain — a row whose level the payload did not state is kept, because
   * dropping it would be filtering on the absence of evidence.
   */
  const rowLevelMatch = (level: string | null | undefined) =>
    metaRecLevelMatch(level, activeLevels);
  const exactActionRows = sortMetaRecs(
    actionNow.filter(
      (recommendation) =>
        metaRecSearchMatch(recommendation, rowSearch) &&
        rowLevelMatch(recommendation.level),
    ),
    rowSort,
  );
  const exactWatchingRows = sortMetaRecs(
    watching.filter(
      (recommendation) =>
        metaRecSearchMatch(recommendation, rowSearch) &&
        rowLevelMatch(recommendation.level),
    ),
    rowSort,
  );
  const exactNonSalesRows = sortMetaRecs(
    nonSales.filter(
      (recommendation) =>
        metaRecSearchMatch(recommendation, rowSearch) &&
        rowLevelMatch(recommendation.level),
    ),
    rowSort,
  );
  const exactHealthyRows = healthy.filter(
    (row) =>
      (!rowSearch.trim() ||
        [row.name, row.campaignName ?? ""].some((value) =>
          value.toLowerCase().includes(rowSearch.trim().toLowerCase()),
        )) &&
      rowLevelMatch(row.level),
  );
  /*
   * The served census, built once per payload / search term.
   *
   * It honours the SAME search box the queue toolbar owns, because that box
   * already filters every lane on this page and a second, invisible filter
   * would be a table narrowing itself for no visible reason. The panel reports
   * the served total beside the matched total so a typed term can never look
   * like a shrinking account.
   */
  const structureInventoryView = useMemo(
    () =>
      buildMetaStructureInventoryViewModel({
        workspace: workspaceQuery.data,
        fallbackCurrency: moneyCurrency,
        search: rowSearch,
      }),
    [moneyCurrency, rowSearch, workspaceQuery.data],
  );
  /**
   * The operator workflow overlay, on the body an operator actually reaches.
   *
   * `/api/meta/decision-workflow` has carried all seven transitions with
   * `expectedVersion` optimistic concurrency for some time; its only caller
   * lived in a zero-base Decisions body that no route mounts (plan §5.1
   * finding 14). D2 says port the behaviour into the production visual owner,
   * so it is read here and rendered in the inspector's own Workflow section.
   *
   * The served keys are the decision ids this render is showing. They are
   * capped, because the endpoint caps its own key list and sending more than it
   * accepts would turn a partial answer into an unread overlay for every row.
   */
  const servedDecisionKeys = useMemo(
    () =>
      [
        ...exactActionRows,
        ...exactWatchingRows,
        ...exactNonSalesRows,
      ]
        .map((recommendation) => recommendation.id)
        .filter(Boolean)
        .slice(0, DECISION_WORKFLOW_KEY_CAP),
    [exactActionRows, exactNonSalesRows, exactWatchingRows],
  );
  const selectedDecisionKey =
    drillItem && drillItem.mode !== "anomaly" ? drillItem.rec.id : null;
  /**
   * The actions ship refused.
   *
   * The design draws the workflow's OUTPUT — a "Deferred" watch segment and a
   * "Let cook until …" row note — but draws no assign / acknowledge / snooze /
   * resolve controls. §18 of the plan says a write control the design does not
   * carry is not added on this pass: it ships absent-with-reason, or in a
   * separately approved round. So the state is shown (which the design already
   * implies) and the controls are present and refusing, behind
   * `META_DECISION_WORKFLOW_UI`, which defaults off.
   *
   * A reviewer or a read-only viewer is refused first, because that is the more
   * specific fact and the one they can act on.
   */
  const workflowActionsRefusedReason = isViewerReadOnly
    ? viewerReadOnlyReason
    : !decisionWorkflowUiEnabled
      ? "Decision ownership actions are not enabled on this workspace yet. The current state is shown above."
      : null;
  const workflow = useDecisionWorkflow({
    businessId,
    servedDecisionKeys,
    selectedDecisionKey,
    enabled: decisionWorkflowUiEnabled,
  });

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
            : /*
               * `null` suppresses the inspector; `undefined` lets the adapter
               * fall back to the first Action Now row.
               *
               * The distinction is the whole of the close control: without it,
               * closing the panel cleared the drill, the adapter re-selected
               * the first row and the panel reopened on the next render.
               */
              inspectorDismissed
              ? null
              : undefined,
        defaultSelectionLane:
          activeScope === "structure" &&
          (activeLane === "action" ||
            activeLane === "needsres" ||
            activeLane === "watching")
            ? activeLane
            : "action",
        overrides: {
          actionNow: exactActionRows,
          watching: exactWatchingRows,
          healthy: exactHealthyRows,
          nonSales: exactNonSalesRows,
          archive: exactArchiveRows,
          creatives: exactCreativeDecisions,
          canonicalDecisions: canonicalDecisionEnvelopes,
          creativeCtrSeriesByAdId: queueCtrSeriesQuery.data,
          deferredCount,
        },
        callbacks: {
          briefHref: (lineage) =>
            decisionBriefHref({
              businessId,
              providerAccountId,
              creativeId: lineage.creativeId,
              snapshotId: lineage.snapshotId,
              trigger: lineage.trigger,
              startDate: workspaceQuery.data?.lanes.startDate ?? null,
              endDate: workspaceQuery.data?.lanes.endDate ?? null,
              pathname,
            }),
          onStructurePrimary:
            !isViewerReadOnly && !workspaceQuery.data.system.killSwitchEngaged
              ? (recommendation, action) => {
                  void handlePrimary(recommendation, action);
                }
              : undefined,
          onStructureMenu: openDrillForRec,
          onWatchingReview: openDrillForRec,
          onCreativeReview: (decision, canonicalDecision) => {
            /*
             * Every served row opens. The canonical envelope is carried, not
             * required.
             *
             * The presentation decision carries the engine's reading — why now,
             * assessment, blockers, resolution, lane, availability and the ad's
             * own metrics — and the canonical envelope carries the audit half.
             * This used to refuse the open whenever the second was missing and
             * put up a warning banner instead, which on an account whose ads
             * source has degraded is EVERY row: the operator was told the
             * evidence was unavailable while the engine's own evidence sat
             * unread in the payload.
             *
             * So `canonicalDecision` travels as it came, `null` included. It is
             * never substituted and never reconstructed, and the window states
             * which half it is missing rather than filling it in.
             */
            emitProductInstrumentation({
              eventName: "decision_evidence_viewed",
              surface: "meta_decisions",
              outcome: "ok",
              scope: "business",
              businessId,
            });
            setNativeAdPauseAuthorization(null);
            setNativeAdPauseError(null);
            setCreativeDrill({ decision, canonical: canonicalDecision });
          },
        },
      })
    : {
        activeWindow: exactWindowForMetaWindow(selectedWindow),
        identity: {
          accountLabel:
            selectedProviderAccount?.name ??
            selectedProviderAccount?.id ??
            null,
          currency: moneyCurrency,
        },
      };

  /**
   * The Workflow section, composed onto the inspector the adapter already
   * built.
   *
   * Composed here rather than threaded through
   * `buildMetaDecisionCenterExactViewModel`, because the adapter's job is to
   * turn the workspace payload into presentation and the workflow overlay is a
   * separate read with its own lifecycle. Threading it through would give the
   * adapter a dependency on a fetch it does not perform.
   */
  const inspectorWorkflow = selectedDecisionKey
    ? buildDecisionWorkflowViewModel({
        readState: workflow.readState,
        unavailableReason: workflow.unavailableReason,
        record: workflow.recordFor(selectedDecisionKey),
        actionsRefusedReason: workflowActionsRefusedReason,
        pending: workflow.pendingKey === selectedDecisionKey,
        /*
         * The 409, rendered.
         *
         * The hook has always returned a structured conflict and the page has
         * always thrown it away, so a refused transition changed the row's
         * state on screen and said nothing. Neither choice is automatic:
         * re-applying overwrites what the other operator just did, and the
         * operator has to be the one who decides that.
         *
         * `reapplyPlan` probes the REAL state machine with the server's fresh
         * record, so "keep mine" is offered only when the transition still
         * applies — and when it does not, it says why instead of failing again.
         */
        conflict: workflowConflict(
          workflow.conflict,
          selectedDecisionKey,
          (conflict) => {
            void workflow.submit(
              conflict.decisionKey,
              conflict.attempted.action,
              conflict.current,
              conflict.values,
            );
          },
          workflow.dismissConflict,
        ),
        onAction: (action, record, values) => {
          void workflow.submit(selectedDecisionKey, action, record, values);
        },
      })
    : null;
  /**
   * The manual action sheet's posture for the selected row.
   *
   * Two independent refusals, and the more specific one wins: a reviewer or a
   * read-only workspace is told about THEM, and only then is the gate reported.
   * Absent entirely when nothing is selected — there is no row to act on.
   */
  const inspectorManualAction: NonNullable<
    MetaDecisionCenterExactViewModel["inspector"]
  >["manualAction"] = selectedDecisionKey
    ? {
        label: "Open manual action",
        refusalReason: isViewerReadOnly
          ? viewerReadOnlyReason
          : workspaceQuery.data?.system.killSwitchEngaged
            ? "Meta writes are stopped for this workspace, so no manual action can be prepared."
            : !mutationUiEnabled
              ? "The manual action sheet is not enabled on this workspace yet. The decision and its evidence are shown above."
              : null,
        onOpen:
          mutationUiEnabled &&
          !isViewerReadOnly &&
          !workspaceQuery.data?.system.killSwitchEngaged &&
          drillItem &&
          drillItem.mode !== "anomaly"
            ? () => setManualCeremonyRec(drillItem.rec)
            : undefined,
      }
    : null;
  /*
   * The per-row ownership chip, attached after the adapter has built the rows.
   *
   * Composed here for the same reason the inspector's Workflow section is: the
   * adapter turns the workspace payload into presentation and performs no
   * fetch, and the overlay is a separate read with its own lifecycle.
   */
  const withWorkflowChip = <T extends { id: string }>(rows: readonly T[]) =>
    rows.map((row) => ({
      ...row,
      workflowChip: rowWorkflowChip({
        readState: workflow.readState,
        record: workflow.recordFor(row.id),
      }),
    }));
  const exactViewModelWithRowChips: MetaDecisionCenterExactViewModel = {
    ...exactViewModel,
    ...(exactViewModel.actionRows
      ? { actionRows: withWorkflowChip(exactViewModel.actionRows) }
      : {}),
    ...(exactViewModel.needsResolutionRows
      ? {
          needsResolutionRows: withWorkflowChip(
            exactViewModel.needsResolutionRows,
          ),
        }
      : {}),
  };
  const exactViewModelWithWorkflow: MetaDecisionCenterExactViewModel =
    exactViewModelWithRowChips.inspector
      ? {
          ...exactViewModelWithRowChips,
          inspector: {
            ...exactViewModelWithRowChips.inspector,
            ...(inspectorWorkflow ? { workflow: inspectorWorkflow } : {}),
            manualAction: inspectorManualAction,
          },
        }
      : exactViewModelWithRowChips;

  // Served authority the mobile surface states beside its rows. Read-only
  // projection of already-fetched fields: no extra query, no derivation.
  const mobilePosture = buildMetaMobilePosture({
    workspace: workspaceQuery.data,
    viewerReadOnlyReason,
  });

  /**
   * The server's verdict on this decision's Launchpad route, taken once.
   *
   * Read here rather than at each call site so the footer control, the mobile
   * screen and the authority row that explains them cannot disagree about
   * whether a route exists.
   */
  const creativeEvidenceLaunchpad = creativeDrill
    ? creativeEvidenceLaunchpadRoute({
        canonical: creativeDrill.canonical,
        action: creativeDrill.decision?.action ?? null,
        providerAccountId,
      })
    : null;
  const creativeEvidenceAction = creativeDrill?.decision?.action ?? null;
  const creativeEvidenceIsNativePause = Boolean(
    creativeEvidenceAction?.code === "cut" &&
    creativeEvidenceAction.intent === "execute" &&
    creativeEvidenceAction.targetLevel === "ad" &&
    creativeEvidenceAction.providerMutation === "pause",
  );
  const creativeEvidenceNativePause = creativeEvidenceIsNativePause
    ? authorizeMetaNativeAdPause({
        businessId,
        providerAccountId,
        decision: creativeDrill?.decision ?? null,
        canonical: creativeDrill?.canonical ?? null,
      })
    : null;
  const creativeEvidencePrimaryAuthority: {
    kind: "launchpad_handoff" | "native_ad_pause";
    offered: boolean;
    refusalReason: string | null;
  } | null = creativeEvidenceIsNativePause
    ? creativeEvidenceNativePause?.ok
      ? isViewerReadOnly
        ? {
            kind: "native_ad_pause",
            offered: false,
            refusalReason:
              viewerReadOnlyReason ??
              "Current viewer is not authorized to mutate Meta Ads.",
          }
        : workspaceQuery.data?.system.killSwitchEngaged
          ? {
              kind: "native_ad_pause",
              offered: false,
              refusalReason:
                workspaceQuery.data.system.killSwitchReason ??
                "Meta writes are disabled by the kill switch.",
            }
          : {
              kind: "native_ad_pause",
              offered: true,
              refusalReason: null,
            }
      : {
          kind: "native_ad_pause",
          offered: false,
          refusalReason:
            creativeEvidenceNativePause?.refusalReason ??
            "Exact-Ad pause authority is unavailable.",
        }
    : creativeEvidenceLaunchpad
      ? {
          kind: "launchpad_handoff",
          offered: creativeEvidenceLaunchpad.offered,
          refusalReason: creativeEvidenceLaunchpad.refusalReason,
        }
      : null;
  const creativeEvidenceNativePauseControl =
    creativeEvidencePrimaryAuthority?.kind === "native_ad_pause" &&
    creativeEvidencePrimaryAuthority.offered &&
    creativeEvidenceNativePause?.ok
      ? creativeEvidenceNativePause
      : null;

  /**
   * The evidence inputs the desktop drawer and the mobile screen share.
   *
   * ONE object, spread into both builds. They previously repeated the same
   * twelve fields, which is how the two surfaces drift into two different
   * accounts of one decision: every field added to one and missed on the other
   * is a fact a phone silently stops showing. The desktop call adds the FOOTER
   * — callbacks and hrefs — and nothing else, because writes are desktop-only
   * and the evidence must be identical.
   */
  const creativeEvidenceSharedInput = creativeDrill
    ? {
        decision: creativeDrill.decision,
        canonical: creativeDrill.canonical,
        adRows: creativeEvidenceQuery.data,
        adSeries: creativeEvidenceSeriesQuery.data,
        // An unresolved helper read and an account with no ad-grain rows used
        // to reach the drawer identically (both `undefined`), so a failing
        // query printed the same em-dash as a real absence. The state travels
        // with the data now.
        adRowsState: metaEvidenceReadState(creativeEvidenceQuery),
        adSeriesState: metaEvidenceReadState(creativeEvidenceSeriesQuery),
        adRowsErrorMessage: metaEvidenceReadError(creativeEvidenceQuery),
        adSeriesErrorMessage: metaEvidenceReadError(
          creativeEvidenceSeriesQuery,
        ),
        capabilities:
          workspaceQuery.data?.decisionReadModel.capabilities ?? null,
        // The generation the whole queue was read from. Without it the window
        // states row-grain authority while staying silent about the authority
        // of the queue that produced the row.
        source: workspaceQuery.data?.decisionReadModel.source ?? null,
        launchpadRoute: creativeEvidenceLaunchpad,
        primaryActionAuthority: creativeEvidencePrimaryAuthority,
        fallbackCurrency: moneyCurrency,
      }
    : null;

  const creativeEvidenceViewModel: CreativeEvidenceWindowExactViewModel =
    creativeEvidenceSharedInput
      ? buildCreativeEvidenceWindowExactViewModel(creativeEvidenceSharedInput)
      : {};

  const closeNativeAdPauseDialog = () => {
    if (nativeAdPausePending) return;
    setNativeAdPauseAuthorization(null);
    setNativeAdPauseError(null);
  };

  const confirmNativeAdPause = async () => {
    if (
      !nativeAdPauseAuthorization ||
      nativeAdPausePendingRef.current ||
      nativeAdPauseAuthorization.request.idempotencyKey ===
        nativeAdPauseLockedKey
    )
      return;
    nativeAdPausePendingRef.current = true;
    setNativeAdPausePending(true);
    setNativeAdPauseError(null);
    const result = await executeMetaNativeAdPause({
      request: nativeAdPauseAuthorization.request,
    });
    if (!result.ok) {
      setNativeAdPauseError(describeMetaNativeAdPauseFailure(result));
      if (
        result.reconciliationRequired ||
        result.retryAllowed === false ||
        result.providerOutcomeAmbiguous === true ||
        result.providerMutationSucceeded === true
      ) {
        setNativeAdPauseLockedKey(
          nativeAdPauseAuthorization.request.idempotencyKey,
        );
      }
      nativeAdPausePendingRef.current = false;
      setNativeAdPausePending(false);
      return;
    }

    setNativeAdPauseAuthorization(null);
    setNativeAdPauseError(null);
    setNativeAdPauseLockedKey(null);
    setCreativeDrill(null);
    nativeAdPausePendingRef.current = false;
    setNativeAdPausePending(false);
    setNotice({
      tone: "success",
      title: result.duplicate
        ? "Exact Ad pause was already verified."
        : "Exact Ad paused.",
      detail: result.message,
    });
    await refreshDecisionData();
  };

  return (
    <div
      className={cn("ad-final meta-decisions-final", styles.metaPageRoot)}
      data-testid="meta-platform-page"
      data-workspace-query-status={workspaceQuery.status}
      data-workspace-fetch-status={workspaceQuery.fetchStatus}
    >
      {/*
        The mobile Decision surface. The stylesheet shows exactly this subtree
        below 720px and hides every sibling, so whatever is NOT projected here
        is invisible to a phone. It therefore renders the same
        `exactViewModel` the desktop renders — same rows, same counts, same
        scope/lane state — and adds the served posture (viewer authority,
        source authority, limitations, capability gaps, withheld inventory)
        that the desktop states in its own chrome.
      */}
      {creativeDrill ? (
        <MetaMobileCreativeEvidenceScreen
          viewModel={creativeEvidenceViewModel}
          onBack={() => setCreativeDrill(null)}
        />
      ) : drillItem ? (
        <MetaMobileEvidenceScreen
          item={drillItem}
          // The same composed inspector the desktop reads, so the phone shows
          // the same ownership state rather than a version without it.
          inspector={exactViewModelWithWorkflow.inspector}
          targetRoas={targetRoas}
          moneyCurrency={moneyCurrency}
          onBack={() => setDrillItem(null)}
        />
      ) : (
        <MetaMobileDecisionsScreen
          businessName={businessName}
          viewModel={exactViewModel}
          structureInventory={structureInventoryView}
          posture={mobilePosture}
          scope={activeScope}
          lane={activeLane}
          onScopeChange={selectScope}
          onLaneChange={selectLane}
          loading={loading}
          error={error}
          anomalies={anomalies}
          banners={workspaceBanners}
          historyHref={metaHistoryHref}
          pathname={pathname}
          onClearSearch={() => setRowSearchParam("")}
          anomalyError={anomalyError}
          canLoadMoreCreatives={canLoadMoreCreatives}
          loadingMoreCreatives={workspaceQuery.isFetching}
          nextCreativeLimit={nextAdCandidateLimit}
          onLoadMoreCreatives={loadMoreCreatives}
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

        {briefingLoading && !workspaceQuery.data ? (
          <div
            className="banner info"
            data-testid="meta-briefing-loading"
            role="status"
            aria-live="polite"
          >
            <div className="icon">i</div>
            <div className="msg">
              <b>Loading decision data.</b>
              <span className="sub">
                Reading the assigned Meta account and its complete server
                decision workspace for this date range.
              </span>
            </div>
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
          <div
            className="banner warn"
            data-testid="meta-anomaly-error"
            role="alert"
          >
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
          historyHref={metaHistoryHref}
          pathname={pathname}
          trackingDismissed={trackingDismissed}
          onDismissTracking={() => setTrackingDismissed(true)}
          onOpenTrackingDetails={() =>
            setDrillItem(
              anomalies[0] ? { mode: "anomaly", anomaly: anomalies[0] } : null,
            )
          }
        />

        {workspaceQuery.data ? (
          <MetaDecisionCenterExact
            viewModel={exactViewModelWithWorkflow}
            lane={exactLaneForMetaLane(activeLane)}
            scope={activeScope}
            onScopeChange={selectScope}
            // Every decision-bearing structure lane keeps the reference's
            // selected-row + evidence-rail resting state. Closing the rail is
            // still explicit and remains closed until the operator changes lane.
            inspectorOpen={!inspectorDismissed}
            onLaneChange={(lane) => selectLane(metaLaneForExactLane(lane))}
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
            adsManagerHref={metaAdsManagerHref(providerAccountId)}
            onCloseInspector={() => {
              setInspectorDismissed(true);
              setDrillItem(null);
            }}
            onSortChange={setRowSort}
            levels={activeLevels}
            onLevelsChange={selectLevels}
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
        ) : null}
        {/*
          The manual action sheet.

          Mounted only when the operator asked for it AND the server-read gate
          is open: `ZERO_BASE_MUTATION_UI_ENABLED` defaults off, so on a shipped
          workspace this is never constructed and no request it could make is
          ever issued. The row is mapped through the same `toDecisionRow` the
          ceremony's other caller uses, so both drive the panel with one shape.
        */}
        {manualCeremonyRec && mutationUiEnabled ? (
          <div
            aria-label="Manual action"
            className="meta-manual-ceremony"
            data-meta-manual-ceremony={manualCeremonyRec.id}
            role="dialog"
          >
            <button
              onClick={() => setManualCeremonyRec(null)}
              type="button"
            >
              Close manual action
            </button>
            <MutationCeremonyPanel
              row={toDecisionRow(manualCeremonyRec)}
              seed={buildMutationCeremonySeed({
                businessId,
                viewer: {
                  // The served viewer, forwarded. The panel refuses on its own
                  // authority as well; this is what it refuses ABOUT.
                  isReviewer: workspaceQuery.data?.viewer?.isReviewer ?? false,
                  /*
                   * A demo workspace is a property of the BUSINESS, not of the
                   * served viewer envelope — which carries `isReviewer` and
                   * `readOnly` and nothing about demo. The payload's own
                   * evidence source is where the product records it, and a
                   * false here would be a claim rather than a reading, so the
                   * served token is what decides.
                   */
                  demo:
                    pulseQuery.data?.dataReadiness?.evidenceSource === "demo",
                  role: workspaceQuery.data?.viewer?.role ?? null,
                },
                newMutationId: () =>
                  typeof crypto !== "undefined" && "randomUUID" in crypto
                    ? crypto.randomUUID()
                    : `${manualCeremonyRec.id}:${Date.now()}`,
              })}
            />
          </div>
        ) : null}

        {activeScope === "creatives" && canLoadMoreCreatives ? (
          <div data-meta-load-more-creatives>
            <button
              type="button"
              className="btn btn--sm"
              disabled={workspaceQuery.isFetching}
              onClick={loadMoreCreatives}
            >
              {workspaceQuery.isFetching
                ? "Loading more decisions…"
                : `Show more decisions · up to ${nextAdCandidateLimit}`}
            </button>
          </div>
        ) : null}

        {/*
          The census, under the queue it is not part of.

          It renders only inside the structure scope: the creatives scope has
          its own served set and a campaign/ad-set census sitting beneath it
          would be a list with no relationship to what is above it.
        */}
        {workspaceQuery.data && activeScope === "structure" ? (
          <MetaStructureInventoryPanel
            view={structureInventoryView}
            open={structureInventoryOpen}
            onToggle={setStructureInventoryOpen}
            windowLabel={exactViewModel.activeWindow ?? "—"}
          />
        ) : null}
      </div>

      {creativeDrill && creativeEvidenceSharedInput ? (
        <CreativeEvidenceWindowExact
          onClose={() => {
            if (nativeAdPausePending || nativeAdPauseAuthorization) return;
            setNativeAdPauseAuthorization(null);
            setNativeAdPauseError(null);
            setCreativeDrill(null);
          }}
          viewModel={buildCreativeEvidenceWindowExactViewModel({
            ...creativeEvidenceSharedInput,
            // The primary is a control, not a link, because the destination
            // does not exist until the server mints it. Same slot, same label,
            // same styling — what changed is that clicking it now produces a
            // verified handoff or a stated refusal instead of a URL Launchpad
            // was always going to throw away.
            //
            // The callback receives the SERVED action tuple by reference. It is
            // not rebuilt, renamed or narrowed on the way: `action.code`,
            // `action.intent` and `action.providerMutation` reach this boundary
            // exactly as the payload carried them, and the handler asserts
            // nothing about them — it names a decision and lets the server
            // re-read it.
            //
            // The `&& creativeDrill.canonical` is the fail-closed half, not a
            // type ceremony: `openLaunchpadFromCanonicalDecision` mints against
            // a canonical decision, and a row that has none must reach no
            // provider-write path at all. `creativeEvidenceLaunchpadRoute`
            // already refuses such a row, so the two agree; this makes the
            // agreement unfalsifiable rather than assumed.
            callbacks: creativeEvidenceNativePauseControl
              ? {
                  onPrimary: (action: MetaOsDecisionAction) => {
                    if (action !== creativeDrill.decision?.action) {
                      setNotice({
                        tone: "danger",
                        title: "Served action changed.",
                        detail:
                          "The evidence control no longer matches the decision row. Reopen the row before acting.",
                      });
                      return;
                    }
                    const requestWasLocked =
                      creativeEvidenceNativePauseControl.request
                        .idempotencyKey === nativeAdPauseLockedKey;
                    setNativeAdPauseError(
                      requestWasLocked
                        ? "This exact pause request already has a non-retryable or reconciliation result. Wait for a fresh server read-back before acting again."
                        : null,
                    );
                    if (trackingBlocked && !requestWasLocked) {
                      setPendingNativePauseTracking(
                        creativeEvidenceNativePauseControl,
                      );
                      return;
                    }
                    setNativeAdPauseAuthorization(
                      creativeEvidenceNativePauseControl,
                    );
                  },
                }
              : creativeEvidenceLaunchpad?.offered && creativeDrill.canonical
                ? {
                    onPrimary: (action: MetaOsDecisionAction) => {
                      void openLaunchpadFromCanonicalDecision(
                        creativeDrill.canonical!,
                        action,
                      );
                    },
                  }
                : undefined,
            hrefs: {
              primary: null,
              compareInStudio: creativeEvidenceStudioHref({
                canonical: creativeDrill.canonical,
                decision: creativeDrill.decision,
                pathname,
              }),
              adsManager: buildMetaAdsManagerHref({
                providerAccountId:
                  creativeDrill.canonical?.providerAccountId ??
                  creativeDrill.decision?.providerAccountId ??
                  null,
                adId:
                  creativeDrill.canonical?.parentChain.ad?.id ??
                  creativeDrill.decision?.adId ??
                  null,
              }),
            },
          })}
        />
      ) : null}

      <MetaNativeAdPauseDialog
        open={nativeAdPauseAuthorization !== null}
        adName={
          creativeDrill?.canonical?.parentChain.ad?.name ??
          creativeDrill?.decision?.adName ??
          null
        }
        accountLabel={
          selectedProviderAccount?.name ??
          selectedProviderAccount?.id ??
          providerAccountId
        }
        pending={nativeAdPausePending}
        confirmLocked={
          nativeAdPauseAuthorization?.request.idempotencyKey ===
          nativeAdPauseLockedKey
        }
        error={nativeAdPauseError}
        onClose={closeNativeAdPauseDialog}
        onConfirm={() => {
          void confirmNativeAdPause();
        }}
      />

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
        open={
          pendingStructurePrimary != null || pendingNativePauseTracking != null
        }
        primaryLabel={
          pendingNativePauseTracking
            ? "Pause anyway"
            : trackingConfirmLabelForStructureAction(
                pendingStructurePrimary?.action,
              )
        }
        description={
          pendingNativePauseTracking
            ? "Pausing an exact Ad while tracking is degraded may rely on incomplete purchase evidence. Continue to the exact-Ad confirmation, or resolve tracking first?"
            : undefined
        }
        onClose={() => {
          setPendingStructurePrimary(null);
          setPendingNativePauseTracking(null);
        }}
        onConfirm={() => {
          const pendingPause = pendingNativePauseTracking;
          const pending = pendingStructurePrimary;
          setPendingStructurePrimary(null);
          setPendingNativePauseTracking(null);
          if (pendingPause) {
            if (
              isViewerReadOnly ||
              workspaceQuery.data?.system.killSwitchEngaged
            ) {
              setNotice({
                tone: "danger",
                title: "Exact-Ad pause is no longer available.",
                detail:
                  viewerReadOnlyReason ??
                  workspaceQuery.data?.system.killSwitchReason ??
                  "Meta writes are unavailable. Reopen the row after a fresh server read-back.",
              });
              return;
            }
            setNativeAdPauseError(null);
            setNativeAdPauseAuthorization(pendingPause);
            return;
          }
          if (pending) {
            void performPrimary(pending.recommendation, pending.action);
          }
        }}
      />
    </div>
  );
}
