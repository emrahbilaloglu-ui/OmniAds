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
  MetaOsStructureGroup,
  MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";
import {
  META_DECISIONS_AD_CANDIDATE_LIMIT,
  META_DECISIONS_AD_CANDIDATE_MAX_LIMIT,
} from "@/lib/meta/decisions-workspace-contract";
import type {
  MetaDecisionsWorkspacePayload,
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

type Layer = "structure" | "ads";
type SelectedDecision =
  | { kind: "structure"; value: MetaOsStructureNode }
  | { kind: "ad"; value: MetaOsAdDecision };

interface AnomaliesPayload {
  anomalies: MetaAnomaly[];
  snapshotDate: string | null;
  count: number;
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

function actionTone(action: MetaOsDecisionAction) {
  if (action.providerMutation === "pause" || action.code === "cut") return "danger";
  if (action.code.includes("policy") || action.code.includes("delivery")) return "caution";
  if (
    action.code.includes("resolve") ||
    action.code.includes("tracking") ||
    action.code.includes("landing") ||
    action.code.includes("checkout")
  ) return "caution";
  if (action.code.includes("budget") || action.code.includes("promotion")) return "positive";
  if (action.intent === "brief" || action.intent === "launchpad") return "info";
  return "neutral";
}

function assessmentTone(value: string) {
  if (/winner|above target/i.test(value)) return "positive";
  if (/underperform|below target/i.test(value)) return "danger";
  if (/fatigue|risk|blocked|bottleneck|incomplete/i.test(value)) return "caution";
  return "neutral";
}

const DECISION_LANES: MetaOsDecisionLane[] = ["act", "blocked", "monitor"];

function laneLabel(lane: MetaOsDecisionLane) {
  if (lane === "act") return "Act Now";
  if (lane === "blocked") return "Needs Resolution";
  return "Monitoring";
}

function presentationLaneCount(
  presentation: MetaDecisionsWorkspacePayload["os"] | null | undefined,
  layer: Layer,
  lane: MetaOsDecisionLane,
) {
  if (!presentation) return 0;
  const group = layer === "structure" ? presentation.structure : presentation.ads;
  if (lane === "act") return group.actCount;
  if (lane === "blocked") return group.blockedCount;
  return group.monitorCount;
}

function adsEmptyDetail(
  presentation: MetaDecisionsWorkspacePayload["os"],
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
  presentation: MetaDecisionsWorkspacePayload["os"] | null | undefined,
  layer: Layer,
  current: MetaOsDecisionLane,
) {
  if (presentationLaneCount(presentation, layer, current) > 0) return current;
  return (
    DECISION_LANES.find(
      (candidate) =>
        presentationLaneCount(presentation, layer, candidate) > 0,
    ) ?? current
  );
}

export function nextAdCandidateLimit(current: number) {
  return Math.min(
    current + META_DECISIONS_AD_CANDIDATE_LIMIT,
    META_DECISIONS_AD_CANDIDATE_MAX_LIMIT,
  );
}

function lifecycleLabel(value: MetaOsStructureNode["lifecycleRole"] | MetaOsAdDecision["lifecycleRole"]) {
  if (value === "label_needed") return "Label needed";
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
    dateWindowToRangeValue({ window: window === "custom" ? "28d" : window, start: "", end: "" }),
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
  const requestedProviderAccountId = searchParams.get("providerAccountId")?.trim() || null;
  const requestedCreativeId = searchParams.get("creativeId")?.trim() || null;
  const [layer, setLayer] = useState<Layer>(requestedCreativeId ? "ads" : "structure");
  const [lanesByLayer, setLanesByLayer] = useState<
    Record<Layer, MetaOsDecisionLane>
  >({ structure: "act", ads: "act" });
  const [selected, setSelected] = useState<SelectedDecision | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [adCandidateLimit, setAdCandidateLimit] = useState(
    META_DECISIONS_AD_CANDIDATE_LIMIT,
  );

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
      return providerAccounts.find((account) => account.id === requestedProviderAccountId) ?? null;
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
        adLimit: String(adCandidateLimit),
      });
      if (windowKey === "custom") {
        params.set("startDate", selectedDateRange.start);
        params.set("endDate", selectedDateRange.end);
      }
      return readJson<MetaDecisionsWorkspacePayload>(
        `/api/meta/decisions-workspace?${params.toString()}`,
      );
    },
    placeholderData: (previous) => previous,
    retry: 2,
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
      return readJson<AnomaliesPayload>(`/api/meta/anomalies?${params.toString()}`);
    },
    retry: 1,
  });

  const workspace = workspaceQuery.data ?? null;
  const presentation = workspace?.os ?? null;
  const lane = lanesByLayer[layer];
  const currency =
    selectedAccount?.currency ?? workspace?.system.currency ?? businessCurrency ?? null;
  const structureGroups = presentation?.structure.groups ?? [];
  const adItems = presentation?.ads.items ?? [];
  const visibleStructureGroups = useMemo(
    () =>
      structureGroups.filter(
        (group) =>
          group.campaign.lane === lane || group.adsets.some((adset) => adset.lane === lane),
      ),
    [lane, structureGroups],
  );
  const visibleAds = useMemo(
    () => adItems.filter((item) => item.lane === lane),
    [adItems, lane],
  );
  const structureCount = presentationLaneCount(presentation, "structure", lane);
  const adsCount = presentationLaneCount(presentation, "ads", lane);
  const layerCount = layer === "structure" ? structureCount : adsCount;
  const blockingBanner = workspace?.banners.find((banner) => banner.blocking) ?? null;
  const integrityCount = (anomaliesQuery.data?.count ?? 0) + (blockingBanner ? 1 : 0);
  const freshAt = workspace?.system.laneSnapshotCreatedAt ?? workspace?.pulse.lastSyncAt ?? null;
  const remainingAds = Math.max(
    0,
    (presentation?.ads.eligiblePreCapCount ?? 0) - adItems.length,
  );
  const canLoadMoreAds =
    remainingAds > 0 && adCandidateLimit < META_DECISIONS_AD_CANDIDATE_MAX_LIMIT;

  useEffect(() => {
    setSelected(null);
    setHowOpen(false);
    setAdCandidateLimit(META_DECISIONS_AD_CANDIDATE_LIMIT);
  }, [providerAccountId]);

  useEffect(() => {
    if (!presentation) return;
    setLanesByLayer((current) => {
      let changed = false;
      const next = { ...current };
      for (const targetLayer of ["structure", "ads"] as const) {
        const fallback = resolveAvailableDecisionLane(
          presentation,
          targetLayer,
          current[targetLayer],
        );
        if (fallback !== current[targetLayer]) {
          next[targetLayer] = fallback;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [presentation]);

  useEffect(() => {
    if (!requestedCreativeId) return;
    const item = adItems.find(
      (candidate) =>
        candidate.creativeId === requestedCreativeId ||
        candidate.adId === requestedCreativeId,
    );
    if (!item) return;
    setLayer("ads");
    setLanesByLayer((current) => ({ ...current, ads: item.lane }));
    setSelected({ kind: "ad", value: item });
  }, [adItems, requestedCreativeId]);

  const chooseAccount = (accountId: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("providerAccountId", accountId);
    next.delete("creativeId");
    setAccountMenuOpen(false);
    router.replace(`/platforms/meta?${next.toString()}`);
  };

  const chooseDateRange = (nextValue: ReturnType<typeof dateWindowToRangeValue>) => {
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
    router.replace(`/platforms/meta${next.toString() ? `?${next.toString()}` : ""}`);
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
              <strong>{selectedAccount?.name ?? "Select a Meta account"}</strong>
              <span>
                {providerAccountId ?? "account required"} · {currency ?? "currency —"}
              </span>
            </span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          {accountMenuOpen ? (
            <div className={styles.accountMenu} role="listbox">
              <div className={styles.menuHeading}>Assigned accounts · no cross-account totals</div>
              {providerAccounts.map((account) => (
                <button
                  type="button"
                  key={account.id}
                  role="option"
                  aria-selected={account.id === providerAccountId}
                  onClick={() => chooseAccount(account.id)}
                >
                  <span className={styles.accountMark}>{accountMark(account.name)}</span>
                  <span className={styles.accountCopy}>
                    <strong>{account.name}</strong>
                    <span>{account.id} · {account.currency ?? "currency —"}</span>
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
          {workspace?.system.killSwitchEngaged ? "Writes stopped" : "Business STOP"}
        </Link>
      </header>

      {blockingBanner ? (
        <div className={styles.blockerBand} role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <strong>{blockingBanner.title}</strong>
          <span>{blockingBanner.detail}</span>
          <Link href={buildMetaScopedHref("/platforms/meta/automation", routeScope)}>Review controls</Link>
        </div>
      ) : integrityCount > 0 ? (
        <div className={styles.integrityBand} role="status">
          <Info size={13} aria-hidden="true" />
          <span>{integrityCount} integrity item{integrityCount === 1 ? "" : "s"} available in evidence.</span>
          <button type="button" onClick={() => setStatusOpen(true)}>
            View evidence
          </button>
        </div>
      ) : null}

      <div className={styles.layerBar}>
        <div role="tablist" className={styles.layerTabs}>
          {(["structure", "ads"] as const).map((value) => {
            const count = DECISION_LANES.reduce(
              (sum, candidate) =>
                sum + presentationLaneCount(presentation, value, candidate),
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
                {value === "structure" ? "Structure" : "Ads"}
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
          <Link href={buildMetaScopedHref("/platforms/meta/history", routeScope)} className={styles.historyLink}>
            <History size={13} aria-hidden="true" /> History
          </Link>
        </div>
      </div>

      <div className={styles.laneBar}>
        <div className={styles.laneSwitch} aria-label="Decision state">
          {DECISION_LANES.map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={lane === value}
              onClick={() => {
                setLanesByLayer((current) => ({
                  ...current,
                  [layer]: value,
                }));
                setSelected(null);
                setHowOpen(false);
              }}
            >
              {laneLabel(value)}
              <span>{presentationLaneCount(presentation, layer, value)}</span>
            </button>
          ))}
        </div>
        <span className={styles.listCaption}>
          {layer === "structure"
            ? `${visibleStructureGroups.length} campaigns · sorted by highest urgency`
            : `${visibleAds.length} shown · ${presentation?.ads.statePreCapCounts[lane] ?? visibleAds.length} eligible in ${laneLabel(lane)}`}
        </span>
      </div>

      <div className={styles.workspace} data-inspector-open={Boolean(selected)}>
        <div className={styles.listPane}>
          {providerAccountsQuery.isLoading || workspaceQuery.isLoading ? (
            <DecisionState title="Loading decision workspace" detail="Reading the account-scoped server presentation." />
          ) : providerAccountsQuery.isError || workspaceQuery.isError ? (
            <DecisionState
              title="Decision workspace unavailable"
              detail={
                (providerAccountsQuery.error as Error | null)?.message ??
                (workspaceQuery.error as Error | null)?.message ??
                "The server presentation could not be loaded."
              }
              danger
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
          ) : layer === "ads" && workspace?.decisionReadModel?.status === "unavailable" ? (
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
                lane === "act"
                  ? "No actions in this layer"
                  : lane === "blocked"
                    ? "No unresolved decisions in this layer"
                    : "Nothing is currently monitoring"
              }
              detail={
                layer === "ads"
                  ? adsEmptyDetail(presentation, lane)
                  : "No server-presented rows match this layer and state."
              }
            />
          ) : layer === "structure" ? (
            <StructureList
              groups={visibleStructureGroups}
              currency={currency}
              expandedGroups={expandedGroups}
              onToggle={toggleGroup}
              onSelect={(value) => setSelected({ kind: "structure", value })}
              selected={selected}
            />
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
              blocked={Boolean(blockingBanner || workspace?.viewer?.readOnly)}
              blockReason={blockingBanner?.title ?? workspace?.viewer?.readOnlyReason ?? null}
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
}: {
  title: string;
  detail: string;
  danger?: boolean;
}) {
  return (
    <div className={styles.emptyState} data-danger={danger}>
      <strong>{title}</strong>
      <span>{detail}</span>
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
              aria-label={expanded ? "Collapse ad set decisions" : "Expand ad set decisions"}
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            <StructureRow
              node={group.campaign}
              currency={currency}
              childCount={group.adsets.length}
              selected={
                selected?.kind === "structure" && selected.value.id === group.campaign.id
              }
              onSelect={() => onSelect(group.campaign)}
            />
            {expanded
              ? group.adsets.map((adset) => (
                  <StructureRow
                    key={adset.id}
                    node={adset}
                    currency={currency}
                    selected={selected?.kind === "structure" && selected.value.id === adset.id}
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
  selected,
  onSelect,
  child = false,
}: {
  node: MetaOsStructureNode;
  currency: string | null;
  childCount?: number;
  selected: boolean;
  onSelect: () => void;
  child?: boolean;
}) {
  return (
    <button
      type="button"
      className={styles.structureRow}
      data-child={child}
      data-selected={selected}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className={styles.rowMain}>
        <span className={styles.rowHeadline}>
          <span className={styles.actionChip} data-tone={actionTone(node.action)}>
            {node.action.label}
          </span>
          <strong>{node.name}</strong>
        </span>
        <span className={styles.rowMeta}>
          <span>{lifecycleLabel(node.lifecycleRole)}</span>
          <span>{titleCase(node.budgetMode)}</span>
          <span>{node.level === "campaign" ? "Campaign" : "Ad Set"}</span>
          {childCount > 0 ? <span>{childCount} ad set decision{childCount === 1 ? "" : "s"}</span> : null}
          {node.suppressedAlternativeCount > 0 ? (
            <span>{node.suppressedAlternativeCount} lower-priority alternative suppressed</span>
          ) : null}
        </span>
      </span>
      <span className={styles.rowMetrics}>
        <strong>{money(node.metrics.spend, node.metrics.currency ?? currency)}</strong>
        <span>{metric(node.metrics.roas, "×")} ROAS</span>
        <small>{node.assessment}</small>
      </span>
      <ChevronRight size={13} className={styles.rowChevron} aria-hidden="true" />
    </button>
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
          data-selected={selected?.kind === "ad" && selected.value.id === item.id}
          key={item.id}
          onClick={() => onSelect(item)}
        >
          <span
            className={styles.thumbnail}
            style={item.thumbnailUrl ? { backgroundImage: `url(${JSON.stringify(item.thumbnailUrl)})` } : undefined}
          >
            {!item.thumbnailUrl ? "AD" : null}
          </span>
          <span className={styles.rowMain}>
            <span className={styles.rowHeadline}>
              <span className={styles.actionChip} data-tone={actionTone(item.action)}>
                {item.action.label}
              </span>
              <strong>{item.adName}</strong>
            </span>
            <span className={styles.parentChain}>
              {item.campaignName ?? item.campaignId ?? "Campaign unavailable"} › {item.adsetName ?? item.adsetId ?? "Ad set unavailable"}
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
            <span><strong>{metric(item.metrics.roas, "×")}</strong><small>ROAS · creative</small></span>
            <span><strong>{metric(item.metrics.purchases)}</strong><small>Purchases · creative</small></span>
            <span><strong>{money(item.metrics.spend, item.metrics.currency ?? currency)}</strong><small>Spend · creative</small></span>
          </span>
          <span className={styles.assessmentBlock}>
            <span className={styles.assessmentChip} data-tone={assessmentTone(item.assessment)}>
              {item.assessment}
            </span>
            <small>Decision confidence {titleCase(item.confidence)} · {item.riskTier ? titleCase(item.riskTier) : "Risk unclassified"}</small>
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

  const saveCampaignRoleCorrection = async () => {
    if (!ad?.campaignId || !campaignRoleCorrection || readOnly) return;
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
              campaignId: ad.campaignId,
              providerAccountId,
              campaignName: ad.campaignName,
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
          <span className={styles.actionChip} data-tone={actionTone(action)}>{action.label}</span>
          <small>{ad ? "Ad" : titleCase(structure!.level)}</small>
          <h2>{entityName}</h2>
          <span className={styles.objectId}>{entityId ?? "provider identity unavailable"}</span>
        </div>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close inspector">
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
            <div><span>Campaign</span><strong>{ad.campaignName ?? ad.campaignId ?? "—"}</strong></div>
            <div><span>Ad Set</span><strong>{ad.adsetName ?? ad.adsetId ?? "—"}</strong></div>
            <div><span>Creative</span><strong>{ad.creativeName ?? ad.creativeId}</strong></div>
          </section>
        ) : (
          <section className={styles.identitySection}>
            <div><span>Budget owner</span><strong>{titleCase(structure!.budgetOwner)}</strong></div>
            <div><span>Budget mode</span><strong>{titleCase(structure!.budgetMode)}</strong></div>
            <div><span>Control owner</span><strong>{titleCase(structure!.controlOwner)}</strong></div>
          </section>
        )}

        <section className={styles.inspectorSection}>
          <h3>Verified facts</h3>
          <div className={styles.factGrid}>
            <div><span>Spend</span><strong>{money(metrics.spend, metrics.currency ?? currency)}</strong><small>{metrics.grain}</small></div>
            <div><span>ROAS</span><strong>{metric(metrics.roas, "×")}</strong><small>Meta-attributed</small></div>
            <div><span>Purchases</span><strong>{metric(metrics.purchases)}</strong><small>{metrics.grain}</small></div>
            <div><span>Target</span><strong>{metric(metrics.effectiveTargetRoas, "×")}</strong><small>commercial truth</small></div>
          </div>
          {ad ? (
            <p className={styles.truthNote}>These metrics are creative-context evidence. They are not presented as ad-grain performance.</p>
          ) : null}
        </section>

        <section className={styles.assessmentSection}>
          <span className={styles.assessmentChip} data-tone={assessmentTone(assessment)}>{assessment}</span>
          <div><span>Confidence</span><strong>{titleCase(confidence)}</strong></div>
          <div><span>Priority</span><strong>{titleCase(value.priority.band)}</strong></div>
          {ad ? <div><span>Risk</span><strong>{ad.riskTier ? titleCase(ad.riskTier) : "Unclassified"}</strong></div> : null}
          {ad?.resolution ? <div><span>Resolution owner</span><strong>{titleCase(ad.resolution.owner)}</strong></div> : null}
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
            {blockers.map((item) => <p key={item.code}>{item.label}</p>)}
          </section>
        ) : null}

        <section className={styles.howSection}>
          <button type="button" onClick={onToggleHow}>
            {howOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            How this was decided
            <span>raw · versioned</span>
          </button>
          {howOpen ? (
            <dl>
              <dt>Raw engine label</dt><dd>{ad ? ad.rawLabel ?? "—" : "See source recommendation"}</dd>
              <dt>Published label</dt><dd>{ad ? ad.publishedLabel : action.code}</dd>
              <dt>Engine version</dt><dd>{ad ? ad.engineVersion : structure!.priority.version}</dd>
              <dt>Engine score</dt><dd>{ad ? ad.confidenceScore.toFixed(2) : "—"}</dd>
            </dl>
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
            {ad?.resolution?.code === "resolve_campaign_role" && ad.campaignId ? (
              <div className={styles.roleCorrection}>
                <div className={styles.roleOptions} aria-label="Correct automatic campaign role">
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
            ) : null}
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
          <Link className={styles.primaryLink} href={buildMetaScopedHref("/platforms/meta/creatives?tab=briefs", { businessId, providerAccountId })}>
            Create Creative Brief <ChevronRight size={13} />
          </Link>
        ) : (
          <div className={styles.reviewActions}>
            <span>No simulated preflight or receipt is shown.</span>
            <a href={providerAccountHref(providerAccountId)} target="_blank" rel="noreferrer">
              Review in Ads Manager <ExternalLink size={12} />
            </a>
          </div>
        )}
      </div>
    </aside>
  );
}
