"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Tags } from "lucide-react";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import {
  META_CAMPAIGN_KINDS,
  META_CAMPAIGN_TEST_DIMENSIONS,
  labelKindDisplay,
  testDimensionDisplay,
  type MetaCampaignKind,
  type MetaCampaignLabel,
  type MetaCampaignLabelInput,
  type MetaCampaignTestDimension,
} from "@/lib/meta/campaign-label-types";
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";
import { cn } from "@/lib/utils";

interface MetaCampaignLabelsSectionProps {
  /**
   * The assignment-verified account this Decisions surface is scoped to.
   *
   * `null` is "no single account resolved", not "every account": the reads
   * below then return whatever the server serves for an unscoped request, and
   * the server is the only thing that may widen scope.
   */
  providerAccountId?: string | null;
  businessId: string;
  /**
   * Whether the label controls may write. **Defaults to false.**
   *
   * §18 of the Meta market-ready plan: "Decisions label writer — Decisions'tan
   * kaldır." The reason is in INVARIANTS: a campaign's kind selects the
   * calibration cell the resolver grades against, so editing a label from the
   * Decisions surface changes the baseline the decisions on that same screen
   * were produced under — and the write then invalidates and re-fetches them,
   * so the operator watches the verdicts move because of an input they just
   * changed. A decision-reading surface must not host a decision-input write.
   *
   * The coverage READ stays, because "campaign_label_missing" is a real
   * decision blocker (GC-036, GC-042) and the operator has to be able to see
   * which campaigns are unlabelled. Only the editing is withdrawn, and the
   * section says where it moved rather than silently losing the controls.
   */
  canWriteLabels?: boolean;
}

interface CampaignsPayload {
  rows: MetaCampaignRow[];
}

interface LabelsPayload {
  labels: MetaCampaignLabel[];
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String(
            (payload as { error?: { message?: unknown } }).error?.message ??
              `Request failed (${response.status})`,
          )
        : payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message?: unknown }).message)
          : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

/**
 * Both reads are scoped to the selected provider account.
 *
 * They were business-scoped only, so on a business with several assigned Meta
 * accounts this section listed every account's campaigns and labels underneath
 * a Decisions surface that names one account — and the cache key could not tell
 * the accounts apart, so switching served the previous account's rows from
 * cache. That is the plan's rollback trigger 3.
 *
 * The account travels as `providerAccountId`, the one canonical parameter name
 * (WP4); the server re-verifies it against this business's assignments and
 * refuses an id it is not assigned, so a URL cannot widen scope here.
 */
function fetchCampaigns(businessId: string, providerAccountId: string | null) {
  const params = new URLSearchParams({ businessId, includePrev: "1" });
  if (providerAccountId) params.set("providerAccountId", providerAccountId);
  return readJson<CampaignsPayload>(`/api/meta/campaigns?${params.toString()}`);
}

function fetchLabels(
  businessId: string,
  providerAccountId: string | null,
  campaignIds: string[],
) {
  const params = new URLSearchParams({ businessId });
  if (providerAccountId) params.set("providerAccountId", providerAccountId);
  if (campaignIds.length > 0) params.set("campaignIds", campaignIds.join(","));
  return readJson<LabelsPayload>(
    `/api/meta/campaign-labels?${params.toString()}`,
  );
}

function isActiveCampaign(row: MetaCampaignRow) {
  return String(row.status ?? "").toUpperCase() === "ACTIVE";
}

function isLabelableCampaign(row: MetaCampaignRow) {
  const status = String(row.status ?? "").toUpperCase();
  return status !== "DELETED" && status !== "ARCHIVED";
}

function labelTone(kind: MetaCampaignKind | null) {
  if (kind === "main")
    return "border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]";
  if (kind === "test") return "border-[var(--adc-info-bd)] bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)]";
  if (kind === "mixed") return "border-slate-200 bg-slate-50 text-slate-700";
  return "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]";
}

function CampaignLabelBadge({ label }: { label: MetaCampaignLabel | null }) {
  const text = label ? labelKindDisplay(label.kind) : "Automatic";
  const suffix =
    label?.kind === "test" ? testDimensionDisplay(label.testDimension) : null;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium",
        labelTone(label?.kind ?? null),
      )}
      data-campaign-kind={label?.kind ?? "automatic"}
    >
      <Tags className="inline-block shrink-0" size={10} aria-hidden="true" />
      <span>{text}</span>
      {suffix ? (
        <span className="truncate text-[10px] opacity-75">· {suffix}</span>
      ) : null}
    </span>
  );
}

/**
 * Why the label controls are read-only on Decisions.
 *
 * Rendered beside them rather than hidden: a control that simply disappears
 * reads as "this product cannot label campaigns", which is false, and leaves
 * the operator with a decision blocker they cannot see how to clear.
 */
export const LABEL_WRITE_MOVED =
  "Campaign labels are read-only here. A label chooses the baseline these decisions are graded against, so it is not edited from the screen showing them.";

function compactCampaignName(row: MetaCampaignRow) {
  return row.name || row.id;
}

export function MetaCampaignLabelsSection({
  businessId,
  providerAccountId = null,
  canWriteLabels = false,
}: MetaCampaignLabelsSectionProps) {
  const queryClient = useQueryClient();
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const campaignsQuery = useQuery({
    queryKey: ["meta-campaigns-for-labels", businessId, providerAccountId],
    enabled: Boolean(businessId),
    queryFn: () => fetchCampaigns(businessId, providerAccountId),
  });

  const campaignRows = campaignsQuery.data?.rows ?? [];
  const labelableCampaigns = useMemo(() => {
    const active = campaignRows.filter(isActiveCampaign);
    return active.length > 0
      ? active
      : campaignRows.filter(isLabelableCampaign);
  }, [campaignRows]);
  const activeCount = useMemo(
    () => campaignRows.filter(isActiveCampaign).length,
    [campaignRows],
  );
  const campaignScopeLabel = activeCount > 0 ? "active" : "recent";
  const campaignScopeText = campaignsQuery.isLoading
    ? "Loading campaign list."
    : activeCount > 0
      ? "Active campaigns receive automatic context; this table stores exceptions only."
      : "No active campaigns were returned; showing recent non-archived campaigns so existing exceptions can be reviewed.";

  const campaignIds = useMemo(
    () => labelableCampaigns.map((row) => row.id).filter(Boolean),
    [labelableCampaigns],
  );

  const sortedCampaigns = useMemo(
    () =>
      [...labelableCampaigns].sort((left, right) => {
        const leftActive = isActiveCampaign(left) ? 1 : 0;
        const rightActive = isActiveCampaign(right) ? 1 : 0;
        return rightActive - leftActive || right.spend - left.spend;
      }),
    [labelableCampaigns],
  );
  const visibleSortedCampaigns = sortedCampaigns.slice(0, 12);

  const labelsQuery = useQuery({
    // Business, ACCOUNT and the campaign set. Without the account, switching
    // accounts served the previous one's labels from cache.
    queryKey: [
      "meta-campaign-labels",
      businessId,
      providerAccountId,
      campaignIds.join(","),
    ],
    enabled: Boolean(businessId) && campaignIds.length > 0,
    queryFn: () => fetchLabels(businessId, providerAccountId, campaignIds),
  });

  const labelMap = useMemo(() => {
    const next = new Map<string, MetaCampaignLabel>();
    for (const label of labelsQuery.data?.labels ?? []) {
      next.set(label.campaignId, label);
    }
    return next;
  }, [labelsQuery.data?.labels]);

  const campaignsWithoutOverride = useMemo(
    () => labelableCampaigns.filter((row) => !labelMap.has(row.id)),
    [labelableCampaigns, labelMap],
  );

  const writeLabels = async (labels: MetaCampaignLabelInput[]) => {
    if (labels.length === 0) return;
    setSavingIds((current) => {
      const next = new Set(current);
      labels.forEach((label) => next.add(label.campaignId));
      return next;
    });
    setNotice(null);
    try {
      const response = await fetch("/api/meta/campaign-labels", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({ businessId, labels }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String(
                (payload as { error?: { message?: unknown } }).error?.message ??
                  "Campaign label update failed.",
              )
            : "Campaign label update failed.";
        throw new Error(message);
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["meta-campaign-labels", businessId],
        }),
        queryClient.invalidateQueries({ queryKey: ["meta-lanes", businessId] }),
        queryClient.invalidateQueries({
          queryKey: ["meta-decisions-workspace", businessId],
        }),
        // Label coverage renders in the pulse strip; it went stale after
        // label saves because the pulse query was never invalidated.
        queryClient.invalidateQueries({
          queryKey: ["meta-account-pulse", businessId],
        }),
      ]);
      setNotice(
        labels.length === 1
          ? "Campaign context correction saved."
          : `${labels.length} campaign context corrections saved.`,
      );
    } finally {
      setSavingIds((current) => {
        const next = new Set(current);
        labels.forEach((label) => next.delete(label.campaignId));
        return next;
      });
    }
  };

  const updateKind = (campaign: MetaCampaignRow, kind: MetaCampaignKind) => {
    // Refused here as well as on the control. A disabled select is a
    // presentation fact; this is the one that holds if anything reaches the
    // handler another way.
    if (!canWriteLabels) return;
    const existing = labelMap.get(campaign.id);
    void writeLabels([
      {
        campaignId: campaign.id,
        providerAccountId: campaign.accountId,
        campaignName: compactCampaignName(campaign),
        kind,
        testDimension: kind === "test" ? existing?.testDimension : null,
        source: "user",
      },
    ]);
  };

  const updateTestDimension = (
    campaign: MetaCampaignRow,
    testDimension: MetaCampaignTestDimension | null,
  ) => {
    if (!canWriteLabels) return;
    const existing = labelMap.get(campaign.id);
    if (!existing || existing.kind !== "test") return;
    void writeLabels([
      {
        campaignId: campaign.id,
        providerAccountId: campaign.accountId,
        campaignName: compactCampaignName(campaign),
        kind: "test",
        testDimension,
        source: "user",
      },
    ]);
  };

  const loading = campaignsQuery.isLoading || labelsQuery.isLoading;
  const error = campaignsQuery.error ?? labelsQuery.error;

  return (
    <section
      id="campaign-labels"
      className="scroll-mt-40 rounded-2xl border border-slate-200 bg-white p-4"
      data-meta-campaign-labels-section
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700">
          <Tags
            className="inline-block shrink-0"
            size={15}
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[14px] font-semibold text-slate-950">
              Context corrections
            </h2>
            {!loading && !error ? (
              campaignsWithoutOverride.length > 0 ? (
                <span className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600">
                  {campaignsWithoutOverride.length} automatic
                </span>
              ) : (
                <span className="rounded-md border border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--adc-pos-fg)]">
                  All shown campaigns use overrides
                </span>
              )
            ) : null}
            {notice ? (
              <span className="text-[11.5px] text-[var(--adc-pos-fg)]">{notice}</span>
            ) : null}
            {!loading && !error ? (
              <span className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600">
                {labelableCampaigns.length} {campaignScopeLabel}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[12px] leading-snug text-slate-500">
            Automatic Main, Test, and Mixed context is the default. Inferred
            roles remain review-only until the authority gate is validated; an
            override is needed only when the inferred role is wrong. {campaignScopeText}
          </p>
          {canWriteLabels ? null : (
            /*
             * Stated, not hidden. A control that vanishes reads as "this
             * product cannot label campaigns", which is false — and it leaves
             * the operator holding a `campaign_label_missing` blocker with no
             * visible way to clear it.
             */
            <p
              className="mt-1 text-[12px] leading-snug text-slate-500"
              data-campaign-label-write-notice
              role="note"
            >
              {LABEL_WRITE_MOVED}
            </p>
          )}
        </div>
      </div>

      {loading ? (
        <div className="mt-3 grid gap-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="h-11 animate-pulse rounded-lg bg-slate-100"
            />
          ))}
        </div>
      ) : error ? (
        <div className="mt-3 rounded-lg border border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)] px-3 py-2 text-[12px] text-[var(--adc-danger-fg)]">
          {error instanceof Error
            ? error.message
            : "Campaign context failed to load."}
        </div>
      ) : (
        <div
          className="mt-3 overflow-x-auto rounded-xl border border-slate-200"
          data-campaign-labels-list
        >
          <div className="grid min-w-[710px] grid-cols-[minmax(240px,1fr)_110px_120px_130px_110px] items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">
            <div>Campaign</div>
            <div>Current</div>
            <div>Kind</div>
            <div>Test dimension</div>
            <div className="text-right">Spend</div>
          </div>
          <div className="divide-y divide-slate-100">
            {visibleSortedCampaigns.map((campaign) => {
              const label = labelMap.get(campaign.id) ?? null;
              const saving = savingIds.has(campaign.id);
              return (
                <div
                  key={campaign.id}
                  className="grid min-w-[710px] grid-cols-[minmax(240px,1fr)_110px_120px_130px_110px] items-center gap-2 px-3 py-2 text-[12px]"
                  data-campaign-label-row={campaign.id}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-900">
                      {campaign.name}
                    </div>
                    <div className="truncate text-[11px] text-slate-500">
                      {campaign.accountId}
                    </div>
                  </div>
                  <CampaignLabelBadge label={label} />
                  <select
                    className="h-8 rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                    value={label?.kind ?? ""}
                    disabled={saving || !canWriteLabels}
                    title={canWriteLabels ? undefined : LABEL_WRITE_MOVED}
                    aria-label={`Campaign kind for ${campaign.name}`}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      if (
                        !META_CAMPAIGN_KINDS.includes(next as MetaCampaignKind)
                      )
                        return;
                      updateKind(campaign, next as MetaCampaignKind);
                    }}
                  >
                    <option value="" disabled>
                      Select
                    </option>
                    {META_CAMPAIGN_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {labelKindDisplay(kind)}
                      </option>
                    ))}
                  </select>
                  <select
                    className="h-8 rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-700 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                    value={
                      label?.kind === "test" ? (label.testDimension ?? "") : ""
                    }
                    disabled={saving || !canWriteLabels || label?.kind !== "test"}
                    title={canWriteLabels ? undefined : LABEL_WRITE_MOVED}
                    aria-label={`Test dimension for ${campaign.name}`}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      updateTestDimension(
                        campaign,
                        next &&
                          META_CAMPAIGN_TEST_DIMENSIONS.includes(
                            next as MetaCampaignTestDimension,
                          )
                          ? (next as MetaCampaignTestDimension)
                          : null,
                      );
                    }}
                  >
                    <option value="">None</option>
                    {META_CAMPAIGN_TEST_DIMENSIONS.map((dimension) => (
                      <option key={dimension} value={dimension}>
                        {testDimensionDisplay(dimension)}
                      </option>
                    ))}
                  </select>
                  <div className="text-right font-mono tabular-nums text-slate-700">
                    {formatCurrency(campaign.spend, campaign.currency)}
                    <div className="text-[10.5px] text-slate-400">
                      {formatRoas(campaign.roas)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {labelableCampaigns.length > 12 ? (
            <div className="border-t border-slate-100 px-3 py-2 text-[11.5px] text-slate-500">
              Showing 12 of {labelableCampaigns.length} {campaignScopeLabel}{" "}
              campaigns.
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
