"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleStop,
  ExternalLink,
  History,
  Info,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { MetaAnomaly } from "@/lib/meta/anomalies";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import type {
  MetaOsAdDecision,
  MetaOsDecisionAction,
  MetaOsDecisionLane,
  MetaOsDecisionsPresentation,
  MetaOsInactiveAsset,
  MetaOsStructureBidConfiguration,
  MetaOsStructureGroup,
  MetaOsStructureNode,
  MetaOsWorkspaceBanner,
} from "@/lib/meta/decisions-os-contract";
import {
  META_DECISIONS_AD_CANDIDATE_LIMIT,
  META_DECISIONS_AD_CANDIDATE_MAX_LIMIT,
} from "@/lib/meta/decisions-workspace-contract";
import { metaDecisionSourceFallbackDetail } from "@/lib/meta/decision-source-health";
import type {
  MetaDecisionsOsWorkspacePayload,
  MetaWindowKey,
} from "@/components/meta/redesign/types";
import {
  DateRangePicker,
  dateWindowToRangeValue,
  getTodayIsoForTimeZone,
  normalizeDateWindowBounds,
  rangeValueToDateWindow,
  type DateWindowValue,
} from "@/components/date-range/DateRangePicker";
import styles from "./DecisionsOsView.module.css";

interface DecisionsOsViewProps {
  businessId: string;
  businessName?: string | null;
  currency?: string | null;
}

export function AdDecisionAuthorityTrail({ ad }: { ad: MetaOsAdDecision }) {
  const evidence = ad.authorityProvenance;
  const unavailable = evidence?.availability !== "available";
  return (
    <dl data-testid="ad-decision-authority-trail">
      <dt>Mathematical / semantic verdict</dt>
      <dd>
        {unavailable
          ? "Historical provenance unavailable"
          : titleCase(evidence.preAuthorityLabel)}
      </dd>
      <dt>Post-authority raw label</dt>
      <dd>{evidence?.postAuthorityRawLabel ?? "Unavailable"}</dd>
      <dt>Published label</dt>
      <dd>{evidence?.publishedLabel ?? ad.publishedLabel}</dd>
      <dt>First authority blocker</dt>
      <dd>
        {evidence?.firstBlocker
          ? `${evidence.firstBlocker.label}. ${evidence.firstBlocker.explanation}`
          : unavailable
            ? "Historical provenance unavailable"
            : "None"}
      </dd>
      <dt>Engine version</dt>
      <dd>{ad.engineVersion}</dd>
      <dt>Engine score</dt>
      <dd>{ad.confidenceScore.toFixed(2)}</dd>
    </dl>
  );
}

type DecisionLayer = "structure" | "ads";
type Layer = DecisionLayer | "inactive";
type StructureDecisionFilter = "all" | MetaOsDecisionLane;
type StructureStatusFilter = "all" | "active" | "paused" | "issues" | "unknown";
type SelectedDecision =
  | { kind: "structure"; value: MetaOsStructureNode }
  | { kind: "ad"; value: MetaOsAdDecision };

interface AnomaliesPayload {
  anomalies: MetaAnomaly[];
  snapshotDate: string | null;
  count: number;
}

interface StructureConfigurationPayload {
  configuration: MetaOsStructureBidConfiguration;
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

function accountMark(name: string | null | undefined) {
  const mark = (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return mark || "—";
}

function relativeTime(value: string | null | undefined) {
  if (!value) return "updated —";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "updated —";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}

function titleCase(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function money(value: number | null, currency: string | null) {
  if (value === null) return "—";
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} · currency unknown`;
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function metric(value: number | null, suffix = "") {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function bidValue(
  value: number | null,
  format: "currency" | "roas" | null,
  currency: string | null,
) {
  if (value === null) return "—";
  return format === "roas" ? metric(value, "×") : money(value, currency);
}

function dateTime(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function actionTone(action: MetaOsDecisionAction) {
  if (action.providerMutation === "pause" || action.code === "cut")
    return "danger";
  if (action.code.includes("policy") || action.code.includes("delivery"))
    return "caution";
  if (
    action.code.includes("resolve") ||
    action.code.includes("tracking") ||
    action.code.includes("landing") ||
    action.code.includes("checkout")
  )
    return "caution";
  if (action.code.includes("budget") || action.code.includes("promotion"))
    return "positive";
  if (action.intent === "brief" || action.intent === "launchpad") return "info";
  return "neutral";
}

function assessmentTone(value: string) {
  if (/winner|above target/i.test(value)) return "positive";
  if (/underperform|below target/i.test(value)) return "danger";
  if (/fatigue|risk|blocked|bottleneck|incomplete|pending/i.test(value))
    return "caution";
  return "neutral";
}

const DECISION_LANES: MetaOsDecisionLane[] = ["act", "blocked", "monitor"];
const STRUCTURE_DECISION_FILTERS: StructureDecisionFilter[] = [
  "all",
  ...DECISION_LANES,
];

function structureDecisionFilterLabel(value: StructureDecisionFilter) {
  return value === "all" ? "All" : laneLabel(value);
}

function structureStatusBucket(
  status: string | null,
): Exclude<StructureStatusFilter, "all"> {
  const normalized = status?.trim().toUpperCase() ?? "";
  if (normalized === "ACTIVE") return "active";
  if (
    normalized === "PAUSED" ||
    normalized === "ARCHIVED" ||
    normalized === "DELETED" ||
    normalized.startsWith("CAMPAIGN_PAUSED")
  ) {
    return "paused";
  }
  if (!normalized || normalized === "UNKNOWN" || normalized === "UNAVAILABLE") {
    return "unknown";
  }
  return "issues";
}

function laneLabel(lane: MetaOsDecisionLane) {
  if (lane === "act") return "Act Now";
  if (lane === "blocked") return "Needs Resolution";
  return "Monitoring";
}

/**
 * Lane counts, or null when there is no server presentation yet.
 *
 * Returning 0 while the workspace is still loading — or after it failed — put a
 * literal "Act Now 0" on screen, which a buyer scanning the tabs reads as
 * "nothing to act on today". An unknown count renders as a dash instead.
 */
export function presentationLaneCount(
  presentation: MetaDecisionsOsWorkspacePayload["os"] | null | undefined,
  layer: DecisionLayer,
  lane: MetaOsDecisionLane,
): number | null {
  if (!presentation) return null;
  const group =
    layer === "structure" ? presentation.structure : presentation.ads;
  if (lane === "act") return group.actCount;
  if (lane === "blocked") return group.blockedCount;
  return group.monitorCount;
}

function adsEmptyDetail(
  presentation: MetaDecisionsOsWorkspacePayload["os"],
  lane: MetaOsDecisionLane,
) {
  const withheld = [
    presentation.ads.omittedAmbiguousIdentity > 0
      ? `${presentation.ads.omittedAmbiguousIdentity} ambiguous creative-to-ad identities`
      : null,
    presentation.ads.omittedWithoutVerifiedAdId > 0
      ? `${presentation.ads.omittedWithoutVerifiedAdId} missing verified ad identities`
      : null,
    presentation.ads.omittedNotApplicable > 0
      ? `${presentation.ads.omittedNotApplicable} not-applicable rows`
      : null,
  ].filter((value): value is string => Boolean(value));
  if (withheld.length > 0) {
    return `No ${laneLabel(lane)} rows are available. Withheld safely: ${withheld.join(
      ", ",
    )}.`;
  }
  return "No server-presented rows match this layer and state.";
}

export function resolveAvailableDecisionLane(
  presentation: MetaDecisionsOsWorkspacePayload["os"] | null | undefined,
  layer: DecisionLayer,
  current: MetaOsDecisionLane,
) {
  if ((presentationLaneCount(presentation, layer, current) ?? 0) > 0) return current;
  return (
    DECISION_LANES.find(
      (candidate) => (presentationLaneCount(presentation, layer, candidate) ?? 0) > 0,
    ) ?? current
  );
}

export function nextAdCandidateLimit(current: number) {
  return Math.min(
    current + META_DECISIONS_AD_CANDIDATE_LIMIT,
    META_DECISIONS_AD_CANDIDATE_MAX_LIMIT,
  );
}

export function resolveGlobalBlockingBanner(
  banners: readonly MetaOsWorkspaceBanner[] | null | undefined,
) {
  return (
    banners?.find(
      (banner) =>
        banner.blocking && (banner.scope ?? "workspace") === "workspace",
    ) ?? null
  );
}

export function isExactAdExecutionSourceBlocked(
  source: MetaOsDecisionsPresentation["source"] | null | undefined,
  selected:
    | { kind: "structure" }
    | { kind: "ad"; value: { action: { intent: string } } }
    | null
    | undefined,
) {
  return (
    source?.adsSource === "legacy_creative_review_only" &&
    selected?.kind === "ad" &&
    selected.value.action.intent === "execute"
  );
}

export function preserveDecisionWorkspacePlaceholder<T>(
  previous: T | undefined,
  previousQuery: { queryKey: readonly unknown[] } | undefined,
  businessId: string,
  providerAccountId: string | null,
) {
  const previousKey = previousQuery?.queryKey;
  if (
    previousKey?.[0] !== "meta-decisions-os-v2" ||
    previousKey[1] !== businessId ||
    previousKey[2] !== providerAccountId
  ) {
    return undefined;
  }
  return previous;
}

export function isCampaignRoleCorrectionTarget(selected: {
  kind: "structure" | "ad";
  value: { level?: string; campaignId?: string | null };
}) {
  return (
    selected.kind === "structure" &&
    selected.value.level === "campaign" &&
    Boolean(selected.value.campaignId?.trim())
  );
}

function lifecycleLabel(
  value:
    MetaOsStructureNode["lifecycleRole"] | MetaOsAdDecision["lifecycleRole"],
) {
  if (value === "label_needed" || value === "unknown")
    return "Auto-classifying";
  return titleCase(value);
}

function providerAccountHref(accountId: string) {
  return `https://business.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(
    accountId.replace(/^act_/, ""),
  )}`;
}

function decisionsDateRangeFromParams(
  params: { get(name: string): string | null },
  referenceDate: string,
): DateWindowValue {
  const rawWindow = params.get("window");
  const window =
    rawWindow === "7d" ||
    rawWindow === "14d" ||
    rawWindow === "28d" ||
    rawWindow === "90d" ||
    rawWindow === "custom"
      ? rawWindow
      : "28d";
  if (window === "custom") {
    const start = params.get("startDate") ?? "";
    const end = params.get("endDate") ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return normalizeDateWindowBounds(
        { window, start, end },
        { maxDate: referenceDate },
      );
    }
  }
  return rangeValueToDateWindow(
    dateWindowToRangeValue({
      window: window === "custom" ? "28d" : window,
      start: "",
      end: "",
    }),
    referenceDate,
  );
}

export function DecisionsOsView({
  businessId,
  businessName,
  currency: businessCurrency,
}: DecisionsOsViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedProviderAccountId =
    searchParams.get("providerAccountId")?.trim() || null;
  const requestedCreativeId = searchParams.get("creativeId")?.trim() || null;
  const [layer, setLayer] = useState<Layer>(
    requestedCreativeId ? "ads" : "structure",
  );
  const [structureDecisionFilter, setStructureDecisionFilter] =
    useState<StructureDecisionFilter>("all");
  const [structureStatusFilter, setStructureStatusFilter] =
    useState<StructureStatusFilter>("all");
  const [adsLane, setAdsLane] = useState<MetaOsDecisionLane>("act");
  const [selected, setSelected] = useState<SelectedDecision | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [requestedCreativeUnresolved, setRequestedCreativeUnresolved] =
    useState(false);
  const [adCandidateLimit, setAdCandidateLimit] = useState(
    META_DECISIONS_AD_CANDIDATE_LIMIT,
  );
  const [inactiveVisibleLimit, setInactiveVisibleLimit] = useState(50);
  const [structureVisibleLimit, setStructureVisibleLimit] = useState(50);

  const providerAccountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", businessId],
    enabled: Boolean(businessId),
    queryFn: () => fetchMetaHistoryAccounts({ businessId }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const providerAccounts = providerAccountsQuery.data ?? [];
  const selectedAccount = useMemo<MetaHistoryAccount | null>(() => {
    if (requestedProviderAccountId) {
      return (
        providerAccounts.find(
          (account) => account.id === requestedProviderAccountId,
        ) ?? null
      );
    }
    return providerAccounts.length === 1 ? providerAccounts[0]! : null;
  }, [providerAccounts, requestedProviderAccountId]);
  const providerAccountId = selectedAccount?.id ?? null;
  const accountTimeZone = selectedAccount?.timezone || "UTC";
  const accountReferenceDate = getTodayIsoForTimeZone(accountTimeZone);
  const selectedDateRange = decisionsDateRangeFromParams(
    searchParams,
    accountReferenceDate,
  );
  const windowKey = selectedDateRange.window as MetaWindowKey;
  const routeScope = { businessId, providerAccountId };

  const workspaceQuery = useQuery({
    queryKey: [
      "meta-decisions-os-v2",
      businessId,
      providerAccountId,
      windowKey,
      selectedDateRange.start,
      selectedDateRange.end,
      adCandidateLimit,
    ],
    enabled: Boolean(businessId && providerAccountId),
    queryFn: () => {
      const params = new URLSearchParams({
        businessId,
        providerAccountId: providerAccountId!,
        window: windowKey,
        status_filter: "all",
        surface: "os",
        adLimit: String(adCandidateLimit),
      });
      if (windowKey === "custom") {
        params.set("startDate", selectedDateRange.start);
        params.set("endDate", selectedDateRange.end);
      }
      return readJson<MetaDecisionsOsWorkspacePayload>(
        `/api/meta/decisions-workspace?${params.toString()}`,
      );
    },
    placeholderData: (previous, previousQuery) =>
      preserveDecisionWorkspacePlaceholder(
        previous,
        previousQuery,
        businessId,
        providerAccountId,
      ),
    retry: 2,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const anomaliesQuery = useQuery({
    queryKey: [
      "meta-decisions-os-v2-anomalies",
      businessId,
      providerAccountId,
      windowKey,
      selectedDateRange.end,
    ],
    enabled: Boolean(businessId && providerAccountId),
    queryFn: () => {
      const params = new URLSearchParams({
        businessId,
        providerAccountId: providerAccountId!,
        activeOnly: "1",
        status_filter: "active",
      });
      if (windowKey === "custom") params.set("endDate", selectedDateRange.end);
      return readJson<AnomaliesPayload>(
        `/api/meta/anomalies?${params.toString()}`,
      );
    },
    retry: 1,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const workspace = workspaceQuery.data ?? null;
  const presentation = workspace?.os ?? null;
  const lane = layer === "ads" ? adsLane : "monitor";
  const currency =
    selectedAccount?.currency ??
    workspace?.system.currency ??
    businessCurrency ??
    null;
  const structureGroups = presentation?.structure.groups ?? [];
  const adItems = presentation?.ads.items ?? [];
  const inactiveItems = presentation?.inactive?.items ?? [];
  const visibleInactiveItems = inactiveItems.slice(0, inactiveVisibleLimit);
  const remainingInactiveItems = Math.max(
    0,
    inactiveItems.length - visibleInactiveItems.length,
  );
  const filteredStructureGroups = useMemo(
    () =>
      structureGroups.flatMap((group) => {
        const matches = (node: MetaOsStructureNode) =>
          (structureDecisionFilter === "all" ||
            node.lane === structureDecisionFilter) &&
          (structureStatusFilter === "all" ||
            structureStatusBucket(node.status) === structureStatusFilter);
        const campaignMatches = matches(group.campaign);
        const adsets = group.adsets.filter(matches);
        if (!campaignMatches && adsets.length === 0) return [];
        return [{ ...group, adsets }];
      }),
    [structureDecisionFilter, structureGroups, structureStatusFilter],
  );
  const visibleStructureGroups = filteredStructureGroups.slice(
    0,
    structureVisibleLimit,
  );
  const remainingStructureGroups = Math.max(
    0,
    filteredStructureGroups.length - visibleStructureGroups.length,
  );
  const visibleAds = useMemo(
    () => adItems.filter((item) => item.lane === lane),
    [adItems, lane],
  );
  const structureCount = filteredStructureGroups.length;
  const adsCount = presentationLaneCount(presentation, "ads", adsLane);
  const layerCount =
    layer === "structure"
      ? structureCount
      : layer === "ads"
        ? adsCount
        : inactiveItems.length;
  const workspaceBanners: MetaOsWorkspaceBanner[] = workspace?.banners ?? [];
  const targetAuthorityBanner =
    workspaceBanners.find((banner) => banner.scope === "target_hard_actions") ??
    null;
  const blockingBanner = resolveGlobalBlockingBanner(workspaceBanners);
  const degradedAdSource =
    presentation?.source.adsSource === "legacy_creative_review_only";
  const exactAdSourceBlocked = isExactAdExecutionSourceBlocked(
    presentation?.source,
    selected,
  );
  const sourceFallbackReason =
    presentation?.source.fallbackReason ?? "native_fallback_unspecified";
  const sourceFallbackDetail =
    metaDecisionSourceFallbackDetail(sourceFallbackReason);
  const integrityCount =
    (anomaliesQuery.data?.count ?? 0) + (blockingBanner ? 1 : 0);
  const freshAt =
    workspace?.system.laneSnapshotCreatedAt ??
    workspace?.pulse.lastSyncAt ??
    null;
  const remainingAds = Math.max(
    0,
    (presentation?.ads.eligiblePreCapCount ?? 0) - adItems.length,
  );
  const canLoadMoreAds =
    remainingAds > 0 &&
    adCandidateLimit < META_DECISIONS_AD_CANDIDATE_MAX_LIMIT;

  useEffect(() => {
    setSelected(null);
    setHowOpen(false);
    setAdCandidateLimit(META_DECISIONS_AD_CANDIDATE_LIMIT);
    setInactiveVisibleLimit(50);
    setStructureVisibleLimit(50);
    setStructureDecisionFilter("all");
    setStructureStatusFilter("all");
  }, [providerAccountId]);

  useEffect(() => {
    if (!presentation) return;
    setAdsLane((current) =>
      resolveAvailableDecisionLane(presentation, "ads", current),
    );
  }, [presentation]);

  useEffect(() => {
    if (!requestedCreativeId) {
      setRequestedCreativeUnresolved(false);
      return;
    }
    const item = adItems.find(
      (candidate) =>
        candidate.creativeId === requestedCreativeId ||
        candidate.adId === requestedCreativeId,
    );
    if (!item) {
      // The creative exists, but its decision is outside the loaded page. This
      // used to return silently, so arriving from "Open Decisions" looked as if
      // the app had lost the creative. Say so, and offer the way to reach it.
      if (presentation) setRequestedCreativeUnresolved(true);
      return;
    }
    setRequestedCreativeUnresolved(false);
    setLayer("ads");
    setAdsLane(item.lane);
    setSelected({ kind: "ad", value: item });
  }, [adItems, presentation, requestedCreativeId]);

  const chooseAccount = (accountId: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("providerAccountId", accountId);
    next.delete("creativeId");
    setAccountMenuOpen(false);
    router.replace(`/platforms/meta?${next.toString()}`);
  };

  const chooseDateRange = (
    nextValue: ReturnType<typeof dateWindowToRangeValue>,
  ) => {
    const nextRange = rangeValueToDateWindow(nextValue, accountReferenceDate);
    const nextWindow: MetaWindowKey =
      nextRange.window === "7d" ||
      nextRange.window === "14d" ||
      nextRange.window === "28d" ||
      nextRange.window === "90d"
        ? nextRange.window
        : "custom";
    const next = new URLSearchParams(searchParams.toString());
    if (nextWindow === "28d") next.delete("window");
    else next.set("window", nextWindow);
    if (nextWindow === "custom") {
      next.set("startDate", nextRange.start);
      next.set("endDate", nextRange.end);
    } else {
      next.delete("startDate");
      next.delete("endDate");
    }
    setAdCandidateLimit(META_DECISIONS_AD_CANDIDATE_LIMIT);
    setStructureVisibleLimit(50);
    router.replace(
      `/platforms/meta${next.toString() ? `?${next.toString()}` : ""}`,
    );
  };

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  return (
    <section
      className={styles.root}
      data-testid="meta-decisions-v2"
      data-provider-writes="none"
      data-workspace-query-status={workspaceQuery.status}
      data-workspace-fetch-status={workspaceQuery.fetchStatus}
    >
      <header className={styles.header}>
        <div className={styles.accountControl}>
          <button
            type="button"
            className={styles.accountButton}
            onClick={() => setAccountMenuOpen((open) => !open)}
            aria-haspopup="listbox"
            aria-expanded={accountMenuOpen}
          >
            <span className={styles.accountMark}>
              {accountMark(selectedAccount?.name ?? businessName)}
            </span>
            <span className={styles.accountCopy}>
              <strong>
                {selectedAccount?.name ?? "Select a Meta account"}
              </strong>
              <span>
                {providerAccountId ?? "account required"} ·{" "}
                {currency ?? "currency —"}
              </span>
            </span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          {accountMenuOpen ? (
            <div className={styles.accountMenu} role="listbox">
              <div className={styles.menuHeading}>
                Assigned accounts · no cross-account totals
              </div>
              {providerAccounts.map((account) => (
                <button
                  type="button"
                  key={account.id}
                  role="option"
                  aria-selected={account.id === providerAccountId}
                  onClick={() => chooseAccount(account.id)}
                >
                  <span className={styles.accountMark}>
                    {accountMark(account.name)}
                  </span>
                  <span className={styles.accountCopy}>
                    <strong>{account.name}</strong>
                    <span>
                      {account.id} · {account.currency ?? "currency —"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <span className={styles.headerDivider} />
        <div className={styles.titleBlock}>
          <h1>Decisions</h1>
          <span>{relativeTime(freshAt)}</span>
        </div>
        <div className={styles.headerSpacer} />
        <div className={styles.statusControl}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="System status"
            onClick={() => setStatusOpen((open) => !open)}
          >
            <Info size={14} aria-hidden="true" />
          </button>
          {statusOpen ? (
            <div className={styles.statusPopover}>
              <div className={styles.menuHeading}>System status</div>
              <dl>
                <dt>Snapshot</dt>
                <dd>{workspace?.system.snapshotHealth?.status ?? "unknown"}</dd>
                <dt>Engine</dt>
                <dd>{workspace?.system.engineVersion ?? "—"}</dd>
                <dt>Currency</dt>
                <dd>{currency ?? "unknown"}</dd>
                <dt>Ad identity omissions</dt>
                <dd>{presentation?.ads.omittedWithoutVerifiedAdId ?? 0}</dd>
                <dt>Ambiguous creative use</dt>
                <dd>{presentation?.ads.omittedAmbiguousIdentity ?? 0}</dd>
                <dt>Not applicable</dt>
                <dd>{presentation?.ads.omittedNotApplicable ?? 0}</dd>
              </dl>
              {(anomaliesQuery.data?.anomalies.length ?? 0) > 0 ? (
                <ul className={styles.statusEvidenceList}>
                  {anomaliesQuery.data!.anomalies.slice(0, 5).map((anomaly) => (
                    <li key={anomaly.id}>{anomaly.title}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
        <Link
          href={buildMetaScopedHref(
            "/platforms/meta/automation#business-stop",
            routeScope,
          )}
          className={styles.stopLink}
          data-engaged={workspace?.system.killSwitchEngaged === true}
        >
          <CircleStop size={13} aria-hidden="true" />
          {workspace?.system.killSwitchEngaged
            ? "Writes stopped"
            : "Business STOP"}
        </Link>
      </header>

      {degradedAdSource ? (
        <div
          className={styles.blockerBand}
          role="alert"
          data-testid="meta-decision-source-health"
          data-source-health="degraded"
          data-scope="account_ad_source"
          data-fallback-reason={sourceFallbackReason}
          data-blocking="true"
        >
          <AlertTriangle size={14} aria-hidden="true" />
          <strong>Native Ad decisions are degraded.</strong>
          <span>
            {sourceFallbackDetail} Legacy rows remain review-only; exact Ad
            actions are withheld. Source: {sourceFallbackReason}.
          </span>
        </div>
      ) : null}

      {targetAuthorityBanner ? (
        <div
          className={styles.blockerBand}
          role="status"
          data-scope="target_hard_actions"
        >
          <AlertTriangle size={14} aria-hidden="true" />
          <strong>{targetAuthorityBanner.title}</strong>
          <span>{targetAuthorityBanner.detail}</span>
          <Link
            href={targetAuthorityBanner.action?.href ?? "/commercial-truth"}
          >
            {targetAuthorityBanner.action?.label ?? "Review commercial truth"}
          </Link>
        </div>
      ) : null}

      {blockingBanner ? (
        <div className={styles.blockerBand} role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <strong>{blockingBanner.title}</strong>
          <span>{blockingBanner.detail}</span>
          <Link
            href={buildMetaScopedHref("/platforms/meta/automation", routeScope)}
          >
            Review controls
          </Link>
        </div>
      ) : integrityCount > 0 ? (
        <div className={styles.integrityBand} role="status">
          <Info size={13} aria-hidden="true" />
          <span>
            {integrityCount} integrity item{integrityCount === 1 ? "" : "s"}{" "}
            available in evidence.
          </span>
          <button type="button" onClick={() => setStatusOpen(true)}>
            View evidence
          </button>
        </div>
      ) : null}

      {/* Arriving from another surface for a specific creative whose decision is
          outside the loaded page. Saying nothing here reads as "the app lost my
          creative", so the cap is stated and the way past it is offered. */}
      {requestedCreativeUnresolved ? (
        <div className={styles.integrityBand} role="status">
          <Info size={13} aria-hidden="true" />
          <span>
            This creative&rsquo;s decision is outside the {adItems.length} loaded
            {adItems.length === 1 ? " row" : " rows"}.
          </span>
          {canLoadMoreAds ? (
            <button
              type="button"
              disabled={workspaceQuery.isFetching}
              onClick={() =>
                setAdCandidateLimit((current) => nextAdCandidateLimit(current))
              }
            >
              {workspaceQuery.isFetching ? "Loading" : "Load more decisions"}
            </button>
          ) : (
            <button type="button" onClick={() => setStatusOpen(true)}>
              View evidence
            </button>
          )}
        </div>
      ) : null}

      <div className={styles.layerBar}>
        <div role="tablist" className={styles.layerTabs}>
          {(
            [
              { value: "structure", label: "Structure" },
              { value: "ads", label: "Ads" },
              { value: "inactive", label: "Inactive assets" },
            ] as const
          ).map(({ value, label }) => {
            const count =
              value === "inactive"
                ? inactiveItems.length
                : value === "structure"
                  ? structureGroups.length
                  : DECISION_LANES.reduce(
                      (sum, candidate) =>
                        sum +
                        (presentationLaneCount(presentation, value, candidate) ?? 0),
                      0,
                    );
            return (
              <button
                type="button"
                role="tab"
                aria-selected={layer === value}
                key={value}
                onClick={() => {
                  setLayer(value);
                  setSelected(null);
                  setHowOpen(false);
                }}
              >
                {label}
                <span>{count}</span>
              </button>
            );
          })}
        </div>
        <div className={styles.layerTools}>
          <DateRangePicker
            value={dateWindowToRangeValue(selectedDateRange)}
            onChange={chooseDateRange}
            label="Decision date range"
            testId="meta-decisions-date-range-picker"
            showComparisonTrigger={false}
            rangePresets={[
              "today",
              "yesterday",
              "7d",
              "14d",
              "28d",
              "90d",
              "thisMonth",
              "lastMonth",
              "custom",
            ]}
            referenceDate={accountReferenceDate}
            timeZoneLabel={accountTimeZone}
            align="end"
          />
          <Link
            href={buildMetaScopedHref("/platforms/meta/history", routeScope)}
            className={styles.historyLink}
          >
            <History size={13} aria-hidden="true" /> History
          </Link>
        </div>
      </div>

      <div className={styles.laneBar}>
        {layer === "inactive" ? (
          <div className={styles.advisoryOnly}>
            Advisory only · provider writes disabled
          </div>
        ) : layer === "structure" ? (
          <>
            <div
              className={styles.laneSwitch}
              aria-label="Structure decision state"
              data-structure="true"
            >
              {STRUCTURE_DECISION_FILTERS.map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={structureDecisionFilter === value}
                  onClick={() => {
                    setStructureDecisionFilter(value);
                    setStructureVisibleLimit(50);
                    setSelected(null);
                    setHowOpen(false);
                  }}
                >
                  {structureDecisionFilterLabel(value)}
                  <span>
                    {value === "all"
                      ? structureGroups.length
                      : presentationLaneCount(presentation, "structure", value)}
                  </span>
                </button>
              ))}
            </div>
            <label className={styles.statusFilter}>
              <span>Delivery</span>
              <select
                aria-label="Filter Structure by delivery status"
                value={structureStatusFilter}
                onChange={(event) => {
                  setStructureStatusFilter(
                    event.target.value as StructureStatusFilter,
                  );
                  setStructureVisibleLimit(50);
                  setSelected(null);
                }}
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="paused">Paused or archived</option>
                <option value="issues">Delivery issues</option>
                <option value="unknown">Status unknown</option>
              </select>
            </label>
          </>
        ) : (
          <div className={styles.laneSwitch} aria-label="Decision state">
            {DECISION_LANES.map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={adsLane === value}
                onClick={() => {
                  setAdsLane(value);
                  setSelected(null);
                  setHowOpen(false);
                }}
              >
                {laneLabel(value)}
                <span>{presentationLaneCount(presentation, "ads", value) ?? "—"}</span>
              </button>
            ))}
          </div>
        )}
        <span className={styles.listCaption}>
          {layer === "structure"
            ? `${visibleStructureGroups.length} of ${filteredStructureGroups.length} campaigns · urgency first`
            : layer === "ads"
              ? `${visibleAds.length} shown · ${presentation?.ads.statePreCapCounts[lane] ?? visibleAds.length} rows in ${laneLabel(lane)}`
              : `${inactiveItems.length} closed or status-unknown assets`}
        </span>
      </div>

      <div className={styles.workspace} data-inspector-open={Boolean(selected)}>
        <div className={styles.listPane}>
          {providerAccountsQuery.isLoading || workspaceQuery.isLoading ? (
            <DecisionState
              title="Loading decision workspace"
              detail="Reading the account-scoped server presentation."
            />
          ) : providerAccountsQuery.isError || workspaceQuery.isError ? (
            <DecisionState
              title="Decision workspace unavailable"
              detail={
                (providerAccountsQuery.error as Error | null)?.message ??
                (workspaceQuery.error as Error | null)?.message ??
                "The server presentation could not be loaded."
              }
              danger
              retrying={
                providerAccountsQuery.isFetching || workspaceQuery.isFetching
              }
              onRetry={() => {
                if (providerAccountsQuery.isError) void providerAccountsQuery.refetch();
                if (workspaceQuery.isError) void workspaceQuery.refetch();
              }}
            />
          ) : !providerAccountId ? (
            <DecisionState
              title="Select one Meta account"
              detail="Data stays withheld until an explicit provider account is selected. Cross-account totals are never formed."
            />
          ) : !presentation ? (
            <DecisionState
              title="Decision presentation unavailable"
              detail="The UI will not derive actions from legacy recommendation fields."
            />
          ) : layer === "ads" &&
            workspace?.decisionReadModel?.status === "unavailable" &&
            visibleAds.length === 0 ? (
            <DecisionState
              title="Ads decisions unavailable"
              detail={
                workspace.decisionReadModel.unavailable?.message ??
                "The account-scoped decision source is unavailable."
              }
              danger
            />
          ) : layerCount === 0 ? (
            <DecisionState
              title={
                layer === "inactive"
                  ? "No inactive asset recommendations"
                  : lane === "act"
                    ? "No actions in this layer"
                    : lane === "blocked"
                      ? "No unresolved decisions in this layer"
                      : "Nothing is currently monitoring"
              }
              detail={
                layer === "inactive"
                  ? "Closed assets remain outside current Decisions. Historical snapshots stay available in History."
                  : layer === "ads"
                    ? adsEmptyDetail(presentation, lane)
                    : "No campaigns or ad sets match the selected filters."
              }
            />
          ) : layer === "inactive" ? (
            <>
              <InactiveAssetsList
                items={visibleInactiveItems}
                currency={currency}
              />
              {remainingInactiveItems > 0 ? (
                <button
                  type="button"
                  className={styles.loadMoreButton}
                  onClick={() =>
                    setInactiveVisibleLimit((current) => current + 50)
                  }
                >
                  Show more inactive assets ({remainingInactiveItems} remaining)
                </button>
              ) : null}
            </>
          ) : layer === "structure" ? (
            <>
              <StructureList
                groups={visibleStructureGroups}
                currency={currency}
                expandedGroups={expandedGroups}
                onToggle={toggleGroup}
                onSelect={(value) => setSelected({ kind: "structure", value })}
                selected={selected}
              />
              {remainingStructureGroups > 0 ? (
                <button
                  type="button"
                  className={styles.loadMoreButton}
                  onClick={() =>
                    setStructureVisibleLimit((current) => current + 50)
                  }
                >
                  Show more campaigns ({remainingStructureGroups} remaining)
                </button>
              ) : null}
            </>
          ) : (
            <>
              <AdsList
                items={visibleAds}
                currency={currency}
                onSelect={(value) => setSelected({ kind: "ad", value })}
                selected={selected}
              />
              {canLoadMoreAds ? (
                <button
                  type="button"
                  className={styles.loadMoreButton}
                  disabled={workspaceQuery.isFetching}
                  onClick={() =>
                    setAdCandidateLimit((current) =>
                      nextAdCandidateLimit(current),
                    )
                  }
                >
                  {workspaceQuery.isFetching
                    ? "Loading"
                    : `Show more decisions (${remainingAds} remaining)`}
                </button>
              ) : null}
            </>
          )}
        </div>

        {selected && providerAccountId ? (
          <>
            <button
              type="button"
              className={styles.inspectorScrim}
              aria-label="Close decision inspector"
              onClick={() => setSelected(null)}
            />
            <DecisionInspector
              key={`${selected.kind}:${selected.value.id}`}
              selected={selected}
              businessId={businessId}
              providerAccountId={providerAccountId}
              currency={currency}
              blocked={Boolean(
                blockingBanner ||
                (selected.kind === "ad" && exactAdSourceBlocked) ||
                workspace?.viewer?.readOnly,
              )}
              blockReason={
                blockingBanner?.title ??
                (selected.kind === "ad" && exactAdSourceBlocked
                  ? "Exact Ad actions are withheld while the native decision source is degraded."
                  : null) ??
                workspace?.viewer?.readOnlyReason ??
                null
              }
              readOnly={workspace?.viewer?.readOnly === true}
              howOpen={howOpen}
              onToggleHow={() => setHowOpen((open) => !open)}
              onWorkspaceRefresh={() => workspaceQuery.refetch()}
              onClose={() => setSelected(null)}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}

function DecisionState({
  title,
  detail,
  danger = false,
  onRetry,
  retrying = false,
}: {
  title: string;
  detail: string;
  danger?: boolean;
  /** Present only when the caller can actually re-run the read. */
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className={styles.emptyState} data-danger={danger}>
      <strong>{title}</strong>
      <span>{detail}</span>
      {onRetry ? (
        // A failed read used to leave a full browser reload as the only way
        // forward, mid-triage.
        <button type="button" onClick={onRetry} disabled={retrying}>
          {retrying ? "Retrying" : "Try again"}
        </button>
      ) : null}
    </div>
  );
}

function StructureList({
  groups,
  currency,
  expandedGroups,
  onToggle,
  onSelect,
  selected,
}: {
  groups: MetaOsStructureGroup[];
  currency: string | null;
  expandedGroups: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (node: MetaOsStructureNode) => void;
  selected: SelectedDecision | null;
}) {
  return (
    <div className={styles.decisionList} data-testid="structure-decision-list">
      {groups.map((group) => {
        const expanded = expandedGroups.has(group.id);
        return (
          <div className={styles.structureGroup} key={group.id}>
            <button
              type="button"
              className={styles.expandButton}
              onClick={() => onToggle(group.id)}
              aria-label={
                expanded
                  ? "Collapse ad set decisions"
                  : "Expand ad set decisions"
              }
            >
              {expanded ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
            </button>
            <StructureRow
              node={group.campaign}
              currency={currency}
              childCount={group.adsets.length}
              groupUrgency={group.highestUrgency}
              urgentAdsetCount={group.urgentAdsetCount}
              selected={
                selected?.kind === "structure" &&
                selected.value.id === group.campaign.id
              }
              onSelect={() => onSelect(group.campaign)}
            />
            {expanded
              ? group.adsets.map((adset) => (
                  <StructureRow
                    key={adset.id}
                    node={adset}
                    currency={currency}
                    selected={
                      selected?.kind === "structure" &&
                      selected.value.id === adset.id
                    }
                    onSelect={() => onSelect(adset)}
                    child
                  />
                ))
              : null}
          </div>
        );
      })}
    </div>
  );
}

function StructureRow({
  node,
  currency,
  childCount = 0,
  groupUrgency,
  urgentAdsetCount = 0,
  selected,
  onSelect,
  child = false,
}: {
  node: MetaOsStructureNode;
  currency: string | null;
  childCount?: number;
  groupUrgency?: MetaOsStructureGroup["highestUrgency"];
  urgentAdsetCount?: number;
  selected: boolean;
  onSelect: () => void;
  child?: boolean;
}) {
  const nodeUrgency = node.urgency ?? {
    level: "none" as const,
    rank: 0,
    label: "No alert",
    reason: null,
  };
  const presentedUrgency = child ? nodeUrgency : (groupUrgency ?? nodeUrgency);
  const urgencyLabel =
    !child && nodeUrgency.level === "none" && urgentAdsetCount > 0
      ? `${urgentAdsetCount} urgent ad set${urgentAdsetCount === 1 ? "" : "s"}`
      : presentedUrgency.label;
  return (
    <button
      type="button"
      className={styles.structureRow}
      data-child={child}
      data-selected={selected}
      data-urgency={presentedUrgency.level}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className={styles.rowMain}>
        <span className={styles.rowHeadline}>
          <span
            className={styles.actionChip}
            data-tone={actionTone(node.action)}
          >
            {node.action.label}
          </span>
          {presentedUrgency.level !== "none" ? (
            <span
              className={styles.urgencyBadge}
              data-level={presentedUrgency.level}
              title={presentedUrgency.reason ?? urgencyLabel}
            >
              <AlertTriangle size={11} aria-hidden="true" />
              {urgencyLabel}
            </span>
          ) : null}
          <strong>{node.name}</strong>
        </span>
        <span className={styles.rowMeta}>
          <span>{lifecycleLabel(node.lifecycleRole)}</span>
          <span>{titleCase(node.budgetMode)}</span>
          <span>{node.level === "campaign" ? "Campaign" : "Ad Set"}</span>
          {node.bidConfiguration?.strategyLabel ||
          node.bidConfiguration?.strategyType ? (
            <span>
              {node.bidConfiguration.strategyLabel ??
                titleCase(node.bidConfiguration.strategyType)}
            </span>
          ) : null}
          {childCount > 0 ? (
            <span>
              {childCount} ad set{childCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {node.suppressedAlternativeCount > 0 ? (
            <span>
              {node.suppressedAlternativeCount} lower-priority alternative
              suppressed
            </span>
          ) : null}
        </span>
      </span>
      <span className={styles.rowMetrics}>
        <strong>
          {money(node.metrics.spend, node.metrics.currency ?? currency)}
        </strong>
        <span>{metric(node.metrics.roas, "×")} ROAS</span>
        <small>{node.assessment}</small>
      </span>
      <ChevronRight
        size={13}
        className={styles.rowChevron}
        aria-hidden="true"
      />
    </button>
  );
}

function InactiveAssetsList({
  items,
  currency,
}: {
  items: MetaOsInactiveAsset[];
  currency: string | null;
}) {
  return (
    <div className={styles.decisionList} data-testid="inactive-assets-list">
      {items.map((item) => (
        <div className={styles.inactiveRow} key={item.id}>
          <span className={styles.rowMain}>
            <span className={styles.rowHeadline}>
              <span className={styles.actionChip} data-tone="neutral">
                {item.advisoryLabel}
              </span>
              <strong>{item.name}</strong>
            </span>
            <span className={styles.parentChain}>
              {[item.campaignName, item.adsetName]
                .filter(Boolean)
                .join(" › ") || "No parent context"}
            </span>
            <span className={styles.rowMeta}>
              <span>{titleCase(item.level)}</span>
              <span>{item.status}</span>
              <span>{titleCase(item.confidence)} confidence</span>
              <span>No provider write</span>
            </span>
            <span className={styles.inactiveReason}>{item.advisoryReason}</span>
          </span>
          <span className={styles.rowMetrics}>
            <strong>
              {money(item.metrics.spend, item.metrics.currency ?? currency)}
            </strong>
            <span>{metric(item.metrics.roas, "×")} ROAS</span>
            <small>Historical evidence</small>
          </span>
        </div>
      ))}
    </div>
  );
}

function AdsList({
  items,
  currency,
  onSelect,
  selected,
}: {
  items: MetaOsAdDecision[];
  currency: string | null;
  onSelect: (item: MetaOsAdDecision) => void;
  selected: SelectedDecision | null;
}) {
  return (
    <div className={styles.decisionList} data-testid="ads-decision-list">
      {items.map((item) => (
        <button
          type="button"
          className={styles.adRow}
          data-selected={
            selected?.kind === "ad" && selected.value.id === item.id
          }
          key={item.id}
          onClick={() => onSelect(item)}
        >
          <span
            className={styles.thumbnail}
            style={
              item.thumbnailUrl
                ? {
                    backgroundImage: `url(${JSON.stringify(item.thumbnailUrl)})`,
                  }
                : undefined
            }
          >
            {!item.thumbnailUrl ? "AD" : null}
          </span>
          <span className={styles.rowMain}>
            <span className={styles.rowHeadline}>
              <span
                className={styles.actionChip}
                data-tone={actionTone(item.action)}
              >
                {item.action.label}
              </span>
              <strong>{item.adName}</strong>
            </span>
            <span className={styles.parentChain}>
              {item.campaignName ?? item.campaignId ?? "Campaign unavailable"} ›{" "}
              {item.adsetName ?? item.adsetId ?? "Ad set unavailable"}
            </span>
            <span className={styles.rowMeta}>
              <span>{lifecycleLabel(item.lifecycleRole)}</span>
              <span>Ad {item.adId}</span>
              <span>
                {item.resolution
                  ? `${titleCase(item.resolution.owner)} resolution`
                  : "Creative-context metrics"}
              </span>
            </span>
          </span>
          <span className={styles.adMetrics}>
            <span>
              <strong>{metric(item.metrics.roas, "×")}</strong>
              <small>
                ROAS ·{" "}
                {item.decisionAvailability === "pending_native_evidence"
                  ? "pending"
                  : item.sourceGrain === "ad"
                    ? "ad"
                    : "creative"}
              </small>
            </span>
            <span>
              <strong>{metric(item.metrics.purchases)}</strong>
              <small>
                Purchases ·{" "}
                {item.decisionAvailability === "pending_native_evidence"
                  ? "pending"
                  : item.sourceGrain === "ad"
                    ? "ad"
                    : "creative"}
              </small>
            </span>
            <span>
              <strong>
                {money(item.metrics.spend, item.metrics.currency ?? currency)}
              </strong>
              <small>
                Spend ·{" "}
                {item.decisionAvailability === "pending_native_evidence"
                  ? "pending"
                  : item.sourceGrain === "ad"
                    ? "ad"
                    : "creative"}
              </small>
            </span>
          </span>
          <span className={styles.assessmentBlock}>
            <span
              className={styles.assessmentChip}
              data-tone={assessmentTone(item.assessment)}
            >
              {item.assessment}
            </span>
            <small>
              Decision confidence {titleCase(item.confidence)} ·{" "}
              {item.riskTier ? titleCase(item.riskTier) : "Risk unclassified"}
            </small>
            <span>{item.action.scopeNote}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function DecisionInspector({
  selected,
  businessId,
  providerAccountId,
  currency,
  blocked,
  blockReason,
  readOnly,
  howOpen,
  onToggleHow,
  onWorkspaceRefresh,
  onClose,
}: {
  selected: SelectedDecision;
  businessId: string;
  providerAccountId: string;
  currency: string | null;
  blocked: boolean;
  blockReason: string | null;
  readOnly: boolean;
  howOpen: boolean;
  onToggleHow: () => void;
  onWorkspaceRefresh: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [campaignRoleCorrection, setCampaignRoleCorrection] = useState<
    "main" | "test" | "mixed" | null
  >(null);
  const [campaignRoleSaving, setCampaignRoleSaving] = useState(false);
  const [campaignRoleNotice, setCampaignRoleNotice] = useState<string | null>(
    null,
  );
  const ad = selected.kind === "ad" ? selected.value : null;
  const structure = selected.kind === "structure" ? selected.value : null;
  const campaignRoleTarget = isCampaignRoleCorrectionTarget(selected)
    ? structure
    : null;
  useEffect(() => {
    setCampaignRoleCorrection(null);
    setCampaignRoleNotice(null);
  }, [campaignRoleTarget?.campaignId]);
  const structureConfigurationQuery = useQuery({
    queryKey: [
      "meta-structure-configuration-v1",
      businessId,
      providerAccountId,
      structure?.level ?? null,
      structure?.providerEntityId ?? null,
    ],
    enabled: Boolean(structure?.providerEntityId),
    queryFn: () => {
      const params = new URLSearchParams({
        businessId,
        providerAccountId,
        level: structure!.level,
        entityId: structure!.providerEntityId!,
      });
      return readJson<StructureConfigurationPayload>(
        `/api/meta/structure-configuration?${params.toString()}`,
      );
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const value = ad ?? structure!;
  const action = value.action;
  const metrics = value.metrics;
  const entityName = ad ? ad.adName : structure!.name;
  const entityId = ad ? ad.adId : structure!.providerEntityId;
  const assessment = value.assessment;
  const whyNow = value.whyNow;
  const confidence = value.confidence;
  const blockers = ad ? ad.blockers : [];
  const monitor = value.lane === "monitor";
  const resolutionBlocked = value.lane === "blocked";
  const hydratedBidConfiguration =
    structureConfigurationQuery.data?.configuration ?? null;
  const bidConfiguration = hydratedBidConfiguration
    ? {
        ...structure?.bidConfiguration,
        ...hydratedBidConfiguration,
        budgetUtilization:
          structure?.bidConfiguration?.budgetUtilization ??
          hydratedBidConfiguration.budgetUtilization,
      }
    : (structure?.bidConfiguration ?? null);

  const saveCampaignRoleCorrection = async () => {
    if (!campaignRoleTarget?.campaignId || !campaignRoleCorrection || readOnly)
      return;
    setCampaignRoleSaving(true);
    setCampaignRoleNotice(null);
    try {
      const response = await fetch("/api/meta/campaign-labels", {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({
          businessId,
          labels: [
            {
              campaignId: campaignRoleTarget.campaignId,
              providerAccountId,
              campaignName: campaignRoleTarget.campaignName,
              kind: campaignRoleCorrection,
              testDimension: null,
              source: "user",
            },
          ],
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String(
                (payload as { error?: { message?: unknown } }).error?.message ??
                  "Campaign role correction failed.",
              )
            : "Campaign role correction failed.";
        throw new Error(message);
      }
      setCampaignRoleNotice("Campaign role correction saved.");
      await onWorkspaceRefresh();
    } catch (error) {
      setCampaignRoleNotice(
        error instanceof Error
          ? error.message
          : "Campaign role correction failed.",
      );
    } finally {
      setCampaignRoleSaving(false);
    }
  };

  return (
    <aside className={styles.inspector} aria-label="Decision inspector">
      <div className={styles.inspectorHeader}>
        <div>
          <span className={styles.actionChip} data-tone={actionTone(action)}>
            {action.label}
          </span>
          <small>{ad ? "Ad" : titleCase(structure!.level)}</small>
          <h2>{entityName}</h2>
          <span className={styles.objectId}>
            {entityId ?? "provider identity unavailable"}
          </span>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onClose}
          aria-label="Close inspector"
        >
          <X size={14} />
        </button>
      </div>

      <div className={styles.inspectorScroll}>
        <section className={styles.inspectorSection}>
          <h3>Why now</h3>
          <p>{whyNow}</p>
        </section>

        {ad ? (
          <section className={styles.identitySection}>
            <div>
              <span>Campaign</span>
              <strong>{ad.campaignName ?? ad.campaignId ?? "—"}</strong>
            </div>
            <div>
              <span>Ad Set</span>
              <strong>{ad.adsetName ?? ad.adsetId ?? "—"}</strong>
            </div>
            <div>
              <span>Creative</span>
              <strong>{ad.creativeName ?? ad.creativeId}</strong>
            </div>
          </section>
        ) : (
          <section className={styles.identitySection}>
            <div>
              <span>Budget owner</span>
              <strong>{titleCase(structure!.budgetOwner)}</strong>
            </div>
            <div>
              <span>Budget mode</span>
              <strong>{titleCase(structure!.budgetMode)}</strong>
            </div>
            <div>
              <span>Control owner</span>
              <strong>{titleCase(structure!.controlOwner)}</strong>
            </div>
          </section>
        )}

        {structure && bidConfiguration ? (
          <section className={styles.inspectorSection}>
            <h3>Provider configuration</h3>
            <div className={styles.factGrid}>
              <div>
                <span>Bid strategy</span>
                <strong>
                  {bidConfiguration.strategyLabel ??
                    titleCase(bidConfiguration.strategyType)}
                </strong>
                <small>
                  {structure.optimizationGoal ?? "optimization unknown"}
                </small>
              </div>
              <div>
                <span>Current bid / target</span>
                <strong>
                  {bidValue(
                    bidConfiguration.currentValue,
                    bidConfiguration.currentValueFormat,
                    currency,
                  )}
                </strong>
                <small>{structure.status ?? "status unknown"}</small>
              </div>
              <div>
                <span>Previous bid / target</span>
                <strong>
                  {bidValue(
                    bidConfiguration.previousValue,
                    bidConfiguration.previousValueFormat,
                    currency,
                  )}
                </strong>
                <small>
                  {structureConfigurationQuery.isPending &&
                  bidConfiguration.previousValueCapturedAt === null
                    ? "Loading change history..."
                    : structureConfigurationQuery.isError &&
                        bidConfiguration.previousValueCapturedAt === null
                      ? "Change history unavailable"
                      : dateTime(bidConfiguration.previousValueCapturedAt)}
                </small>
              </div>
              <div>
                <span>Budget utilization</span>
                <strong>
                  {bidConfiguration.budgetUtilization === null
                    ? "—"
                    : `${Math.round(
                        bidConfiguration.budgetUtilization * 100,
                      )}%`}
                </strong>
                <small>
                  {bidConfiguration.dailyBudget !== null
                    ? `${money(bidConfiguration.dailyBudget, currency)} daily`
                    : bidConfiguration.lifetimeBudget !== null
                      ? `${money(
                          bidConfiguration.lifetimeBudget,
                          currency,
                        )} lifetime`
                      : "budget unknown"}
                </small>
              </div>
            </div>
          </section>
        ) : null}

        {campaignRoleTarget ? (
          <section className={styles.inspectorSection}>
            <h3>Campaign role</h3>
            <div className={styles.roleSummary}>
              <strong>
                {lifecycleLabel(campaignRoleTarget.lifecycleRole)}
              </strong>
              <span>
                {campaignRoleTarget.campaignRoleSource === "user_override"
                  ? "User override"
                  : campaignRoleTarget.campaignRoleSource === "automatic"
                    ? "Automatic"
                    : "Unresolved"}
                {` · ${titleCase(
                  campaignRoleTarget.campaignRoleConfidence ?? "unknown",
                )} confidence`}
              </span>
            </div>
            <details className={styles.roleEditor}>
              <summary>Correct campaign role</summary>
              <p className={styles.roleHelp}>
                Classification is automatic. Save an override only when this
                campaign role is wrong; it will take priority on later
                decisions.
              </p>
              <div className={styles.roleCorrection}>
                <div
                  className={styles.roleOptions}
                  aria-label="Correct automatic campaign role"
                >
                  {(["main", "test", "mixed"] as const).map((role) => (
                    <button
                      type="button"
                      key={role}
                      aria-pressed={campaignRoleCorrection === role}
                      disabled={campaignRoleSaving || readOnly}
                      onClick={() => {
                        setCampaignRoleCorrection(role);
                        setCampaignRoleNotice(null);
                      }}
                    >
                      {titleCase(role)}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className={styles.saveRoleButton}
                  disabled={
                    campaignRoleSaving ||
                    readOnly ||
                    campaignRoleCorrection === null
                  }
                  onClick={() => void saveCampaignRoleCorrection()}
                >
                  {campaignRoleSaving ? "Saving" : "Save correction"}
                </button>
                {campaignRoleNotice ? (
                  <span className={styles.roleNotice} aria-live="polite">
                    {campaignRoleNotice}
                  </span>
                ) : null}
              </div>
            </details>
          </section>
        ) : null}

        <section className={styles.inspectorSection}>
          <h3>Verified facts</h3>
          <div className={styles.factGrid}>
            <div>
              <span>Spend</span>
              <strong>
                {money(metrics.spend, metrics.currency ?? currency)}
              </strong>
              <small>{metrics.grain}</small>
            </div>
            <div>
              <span>ROAS</span>
              <strong>{metric(metrics.roas, "×")}</strong>
              <small>Meta-attributed</small>
            </div>
            <div>
              <span>Purchases</span>
              <strong>{metric(metrics.purchases)}</strong>
              <small>{metrics.grain}</small>
            </div>
            <div>
              <span>Target</span>
              <strong>{metric(metrics.effectiveTargetRoas, "×")}</strong>
              <small>commercial truth</small>
            </div>
          </div>
          {ad?.campaignId ? (
            <div className={styles.campaignRoleFact}>
              <span>Campaign role</span>
              <strong>{lifecycleLabel(ad.lifecycleRole)}</strong>
              <small>
                {ad.campaignRoleSource === "user_override"
                  ? "User override"
                  : ad.campaignRoleSource === "automatic"
                    ? "Automatic"
                    : "Unresolved"}
                {` · ${titleCase(ad.campaignRoleConfidence)} confidence`}
              </small>
            </div>
          ) : null}
          {ad?.decisionAvailability === "pending_native_evidence" ? (
            <p className={styles.truthNote}>
              Meta currently reports this Ad as ACTIVE. Exact Ad-grain decision
              and performance evidence are still pending, so no action is
              authorized.
            </p>
          ) : ad?.sourceGrain === "creative_context" ? (
            <p className={styles.truthNote}>
              These metrics are creative-context evidence. They are not
              presented as ad-grain performance.
            </p>
          ) : ad ? (
            <p className={styles.truthNote}>
              These metrics and the served decision are keyed to this exact Ad
              ID.
            </p>
          ) : null}
        </section>

        <section className={styles.assessmentSection}>
          <span
            className={styles.assessmentChip}
            data-tone={assessmentTone(assessment)}
          >
            {assessment}
          </span>
          <div>
            <span>Confidence</span>
            <strong>{titleCase(confidence)}</strong>
          </div>
          <div>
            <span>Priority</span>
            <strong>{titleCase(value.priority.band)}</strong>
          </div>
          {ad ? (
            <div>
              <span>Risk</span>
              <strong>
                {ad.riskTier ? titleCase(ad.riskTier) : "Unclassified"}
              </strong>
            </div>
          ) : null}
          {ad?.resolution ? (
            <div>
              <span>Resolution owner</span>
              <strong>{titleCase(ad.resolution.owner)}</strong>
            </div>
          ) : null}
        </section>

        {structure ? (
          <section className={styles.inspectorSection}>
            <h3>Expected impact</h3>
            <p>{structure.expectedImpact || "Cannot calculate"}</p>
          </section>
        ) : null}

        {blockers.length > 0 ? (
          <section className={styles.warningSection}>
            <h3>Missing / stale / conflicting evidence</h3>
            {blockers.map((item) => (
              <p key={item.code}>{item.label}</p>
            ))}
          </section>
        ) : null}

        <section className={styles.howSection}>
          <button type="button" onClick={onToggleHow}>
            {howOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            How this was decided
            <span>raw · versioned</span>
          </button>
          {howOpen ? (
            ad ? (
              <AdDecisionAuthorityTrail ad={ad} />
            ) : (
              <dl>
                <dt>Source recommendation</dt>
                <dd>{action.code}</dd>
                <dt>Recommendation version</dt>
                <dd>{structure!.priority.version}</dd>
              </dl>
            )
          ) : null}
        </section>
      </div>

      <div className={styles.inspectorFooter}>
        {monitor ? (
          <div className={styles.monitoringBox}>
            <strong>Monitoring · no provider write</strong>
            <span>{action.scopeNote}</span>
          </div>
        ) : resolutionBlocked ? (
          <div className={styles.blockedBox} data-resolution="true">
            <strong>{action.label}</strong>
            <span>{ad?.resolution?.nextStep ?? action.scopeNote}</span>
          </div>
        ) : blocked ? (
          <div className={styles.blockedBox}>
            <strong>Action blocked</strong>
            <span>{blockReason ?? "Write authority is unavailable."}</span>
          </div>
        ) : action.intent === "launchpad" ? (
          <Link
            className={styles.primaryLink}
            href={buildMetaScopedHref(
              "/platforms/meta/launchpad",
              { businessId, providerAccountId },
              ad
                ? {
                    sourceDecisionId: ad.decisionId,
                    sourceDecisionSnapshotId: ad.sourceSnapshotId,
                    creativeIds: ad.creativeId,
                    mode: "duplicate",
                  }
                : {
                    sourceDecisionId: structure?.sourceRecommendationId ?? "",
                  },
            )}
          >
            Open in Launchpad <ChevronRight size={13} />
          </Link>
        ) : action.intent === "brief" ? (
          <Link
            className={styles.primaryLink}
            href={buildMetaScopedHref("/platforms/meta/creatives?tab=briefs", {
              businessId,
              providerAccountId,
            })}
          >
            Create Creative Brief <ChevronRight size={13} />
          </Link>
        ) : (
          <div className={styles.reviewActions}>
            <span>No simulated preflight or receipt is shown.</span>
            <a
              href={providerAccountHref(providerAccountId)}
              target="_blank"
              rel="noreferrer"
            >
              Review in Ads Manager <ExternalLink size={12} />
            </a>
          </div>
        )}
      </div>
    </aside>
  );
}
