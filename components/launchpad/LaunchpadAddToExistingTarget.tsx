"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { formatMoney as formatAccountMoney } from "@/components/meta/redesign/meta-card-utils";
import { summarizeAttributionSpec, type MetaAttributionSpecItem } from "@/lib/launchpad/attribution-presets";
import type { MetaAddToExistingCopyMode } from "@/lib/launchpad/meta";

export interface LaunchpadExistingCampaign {
  id: string;
  name: string;
  objective: string | null;
  status: string | null;
  effectiveStatus: string | null;
  dailyBudgetMinor: number | null;
  lifetimeBudgetMinor: number | null;
  isAdsetBudgetSharingEnabled: boolean;
  adsetCount: number;
  lastSpend28d: number;
}

export interface LaunchpadExistingAdSet {
  id: string;
  name: string;
  status: string | null;
  effectiveStatus: string | null;
  optimizationGoal: string | null;
  billingEvent: string | null;
  pixelId: string | null;
  customEventType: string | null;
  dailyBudgetMinor: number | null;
  lifetimeBudgetMinor: number | null;
  attributionSpec: MetaAttributionSpecItem[];
  attributionSummary?: string;
  targeting: {
    geoCountries: string[];
    ageMin: number;
    ageMax: number;
    advantageAudience: boolean;
    placementSummary: string;
  };
  currentAdCount: number;
  last7dSpend: number;
  last7dRoas: number | null;
}

export interface LaunchpadAddToExistingState {
  targetCampaign: LaunchpadExistingCampaign | null;
  targetAdset: LaunchpadExistingAdSet | null;
  targetCampaigns?: LaunchpadExistingCampaign[];
  targetAdsetsByCampaignId?: Record<string, LaunchpadExistingAdSet | null>;
  copyMode: MetaAddToExistingCopyMode;
  nameOverrides: Record<string, string>;
}

type CampaignAdsetLoadStatus = "loading" | "loaded" | "error";

const EMPTY_STATE: LaunchpadAddToExistingState = {
  targetCampaign: null,
  targetAdset: null,
  targetCampaigns: [],
  targetAdsetsByCampaignId: {},
  copyMode: "reuse_creative",
  nameOverrides: {},
};

const ADSET_RETRY_DELAYS_MS = [250, 750];

function delay(ms: number) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Could not load ad sets.";
}

async function readAdsetPayload(response: Response) {
  if (!response.ok) {
    throw new Error(`Ad set request failed with ${response.status}`);
  }
  const payload = (await response.json().catch(() => null)) as { adsets?: unknown } | null;
  if (!Array.isArray(payload?.adsets)) {
    throw new Error("Ad set response was invalid.");
  }
  return payload.adsets as LaunchpadExistingAdSet[];
}

export async function fetchLaunchpadCampaignAdsets({
  businessId,
  campaign,
  retryDelaysMs = ADSET_RETRY_DELAYS_MS,
  fetchImpl = fetch,
}: {
  businessId: string;
  campaign: Pick<LaunchpadExistingCampaign, "id" | "adsetCount">;
  retryDelaysMs?: number[];
  fetchImpl?: typeof fetch;
}) {
  let lastError = "Could not load ad sets.";
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const response = await fetchImpl(
        `/api/launchpad/meta/adsets?businessId=${encodeURIComponent(businessId)}&campaignId=${encodeURIComponent(campaign.id)}`,
      );
      const adsets = await readAdsetPayload(response);
      const expectedAdsets = campaign.adsetCount > 0;
      if (adsets.length > 0 || !expectedAdsets) {
        return { ok: true, adsets, attempts: attempt + 1, error: null };
      }
      lastError = "Campaign reported active ad sets, but none were returned.";
    } catch (error) {
      lastError = getErrorMessage(error);
    }

    const retryDelay = retryDelaysMs[attempt];
    if (retryDelay != null) await delay(retryDelay);
  }

  return { ok: false, adsets: [], attempts: retryDelaysMs.length + 1, error: lastError };
}

function formatMoneyMinor(value: number | null | undefined, currency: string | null) {
  if (value == null || !Number.isFinite(value)) return "Budget unavailable";
  return formatAccountMoney(value / 100, currency);
}

function formatMoney(value: number | null | undefined, currency: string | null) {
  return formatAccountMoney(value, currency);
}

export function makeDefaultAddToExistingTargetState(): LaunchpadAddToExistingState {
  return EMPTY_STATE;
}

export interface LaunchpadExistingTargetSelection {
  campaign: LaunchpadExistingCampaign;
  adset: LaunchpadExistingAdSet;
}

export function getSelectedExistingCampaigns(value: LaunchpadAddToExistingState) {
  return value.targetCampaigns?.length
    ? value.targetCampaigns
    : value.targetCampaign
      ? [value.targetCampaign]
      : [];
}

export function getSelectedExistingTargets(value: LaunchpadAddToExistingState) {
  const adsetsByCampaignId = value.targetAdsetsByCampaignId ?? {};
  return getSelectedExistingCampaigns(value).flatMap((campaign) => {
    const adset =
      adsetsByCampaignId[campaign.id] ??
      (value.targetCampaign?.id === campaign.id ? value.targetAdset : null);
    return adset ? [{ campaign, adset }] : [];
  });
}

function buildTargetState(input: {
  campaigns: LaunchpadExistingCampaign[];
  adsetsByCampaignId: Record<string, LaunchpadExistingAdSet | null>;
  copyMode?: MetaAddToExistingCopyMode;
  nameOverrides: Record<string, string>;
}): LaunchpadAddToExistingState {
  const firstCampaign = input.campaigns[0] ?? null;
  return {
    targetCampaign: firstCampaign,
    targetAdset: firstCampaign ? input.adsetsByCampaignId[firstCampaign.id] ?? null : null,
    targetCampaigns: input.campaigns,
    targetAdsetsByCampaignId: input.adsetsByCampaignId,
    copyMode: input.copyMode ?? "reuse_creative",
    nameOverrides: input.nameOverrides,
  };
}

export function defaultCreativeAddName(creative: MetaCreativeRow) {
  return `${creative.name} (added)`;
}

export function LaunchpadAddToExistingTarget({
  businessId,
  value,
  selectedCreatives,
  currency = null,
  onChange,
  campaignOptions,
  adsetOptions,
}: {
  businessId: string;
  value: LaunchpadAddToExistingState;
  selectedCreatives: MetaCreativeRow[];
  currency?: string | null;
  onChange: (value: LaunchpadAddToExistingState) => void;
  campaignOptions?: LaunchpadExistingCampaign[];
  adsetOptions?: LaunchpadExistingAdSet[];
}) {
  const [campaigns, setCampaigns] = useState<LaunchpadExistingCampaign[]>(campaignOptions ?? []);
  const [adsetsByCampaignId, setAdsetsByCampaignId] = useState<Record<string, LaunchpadExistingAdSet[]>>({});
  const [adsetLoadStatusByCampaignId, setAdsetLoadStatusByCampaignId] = useState<
    Record<string, CampaignAdsetLoadStatus>
  >({});
  const [adsetReloadNonce, setAdsetReloadNonce] = useState(0);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [showAllObjectives, setShowAllObjectives] = useState(false);
  const [search, setSearch] = useState("");
  const selectedCampaigns = useMemo(() => getSelectedExistingCampaigns(value), [value]);
  const selectedTargets = useMemo(() => getSelectedExistingTargets(value), [value]);
  const selectedCampaignIds = useMemo(
    () => selectedCampaigns.map((campaign) => campaign.id),
    [selectedCampaigns],
  );
  const activeCopyMode = value.copyMode ?? "reuse_creative";

  useEffect(() => {
    if (campaignOptions) setCampaigns(campaignOptions);
  }, [campaignOptions]);

  useEffect(() => {
    if (!adsetOptions) return;
    setAdsetsByCampaignId((current) => {
      const next = { ...current };
      selectedCampaignIds.forEach((campaignId) => {
        next[campaignId] = adsetOptions;
      });
      return next;
    });
    setAdsetLoadStatusByCampaignId((current) => {
      const next = { ...current };
      selectedCampaignIds.forEach((campaignId) => {
        next[campaignId] = "loaded";
      });
      return next;
    });
  }, [adsetOptions, selectedCampaignIds]);

  useEffect(() => {
    if (!businessId || campaignOptions) return;
    let cancelled = false;
    setCampaignLoading(true);
    const objective = showAllObjectives ? "ALL" : "OUTCOME_SALES";
    fetch(
      `/api/launchpad/meta/campaigns?businessId=${encodeURIComponent(businessId)}&objective=${encodeURIComponent(objective)}`,
    )
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setCampaigns(Array.isArray(payload?.campaigns) ? payload.campaigns : []);
      })
      .catch(() => {
        if (!cancelled) setCampaigns([]);
      })
      .finally(() => {
        if (!cancelled) setCampaignLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, campaignOptions, showAllObjectives]);

  useEffect(() => {
    if (!businessId || selectedCampaignIds.length === 0 || adsetOptions) {
      if (selectedCampaignIds.length === 0 && !adsetOptions) {
        setAdsetsByCampaignId({});
        setAdsetLoadStatusByCampaignId({});
      }
      return;
    }
    let cancelled = false;
    const selectedIdSet = new Set(selectedCampaignIds);
    setAdsetsByCampaignId((current) =>
      Object.fromEntries(Object.entries(current).filter(([campaignId]) => selectedIdSet.has(campaignId))),
    );
    setAdsetLoadStatusByCampaignId((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([campaignId]) => selectedIdSet.has(campaignId)),
      ) as Record<string, CampaignAdsetLoadStatus>;
      selectedCampaigns.forEach((campaign) => {
        next[campaign.id] = "loading";
      });
      return next;
    });

    void (async () => {
      for (const campaign of selectedCampaigns) {
        const result = await fetchLaunchpadCampaignAdsets({ businessId, campaign });
        if (cancelled) return;
        if (result.ok) {
          setAdsetsByCampaignId((current) => ({
            ...current,
            [campaign.id]: result.adsets,
          }));
        }
        setAdsetLoadStatusByCampaignId((current) => ({
          ...current,
          [campaign.id]: result.ok ? "loaded" : "error",
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adsetOptions, adsetReloadNonce, businessId, selectedCampaignIds, selectedCampaigns]);

  const filteredCampaigns = useMemo(() => {
    const query = search.trim().toLowerCase();
    return campaigns.filter((campaign) =>
      query ? campaign.name.toLowerCase().includes(query) || campaign.id.includes(query) : true,
    );
  }, [campaigns, search]);

  const selectedCount = selectedCreatives.length;
  const currentAdCount = selectedTargets.reduce((sum, target) => sum + target.adset.currentAdCount, 0);
  const afterCount = currentAdCount + selectedTargets.length * selectedCount;
  const hasSelectedCampaigns = selectedCampaigns.length > 0;

  function setCampaignSelected(campaign: LaunchpadExistingCampaign, selected: boolean) {
    const nextCampaigns = selected
      ? [...selectedCampaigns, campaign].filter(
          (item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index,
        )
      : selectedCampaigns.filter((item) => item.id !== campaign.id);
    const nextAdsetsByCampaignId = { ...(value.targetAdsetsByCampaignId ?? {}) };
    if (!selected) delete nextAdsetsByCampaignId[campaign.id];
    onChange(
      buildTargetState({
        campaigns: nextCampaigns,
        adsetsByCampaignId: nextAdsetsByCampaignId,
        copyMode: activeCopyMode,
        nameOverrides: value.nameOverrides,
      }),
    );
  }

  function setCampaignAdset(
    campaign: LaunchpadExistingCampaign,
    adset: LaunchpadExistingAdSet | null,
  ) {
    onChange(
      buildTargetState({
        campaigns: selectedCampaigns,
        adsetsByCampaignId: {
          ...(value.targetAdsetsByCampaignId ?? {}),
          [campaign.id]: adset,
        },
        copyMode: activeCopyMode,
        nameOverrides: value.nameOverrides,
      }),
    );
  }

  function setCopyMode(copyMode: MetaAddToExistingCopyMode) {
    onChange(
      buildTargetState({
        campaigns: selectedCampaigns,
        adsetsByCampaignId: value.targetAdsetsByCampaignId ?? {},
        copyMode,
        nameOverrides: value.nameOverrides,
      }),
    );
  }

  return (
    <section className="space-y-5" data-testid="launchpad-add-to-existing-target">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">Existing target</h2>
        <p className="text-[13px] text-[var(--muted)]">
          Pick one or more ACTIVE campaigns and choose the ad set under each campaign — exactly one ad set per campaign.
        </p>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-sm">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-[var(--muted-2)]" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search campaigns"
            className="h-9 w-full rounded-[6px] border border-[var(--border-2)] bg-[var(--surface)] pl-8 pr-3 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--brand)]"
          />
        </div>
        <button
          type="button"
          className={showAllObjectives ? "btn btn--primary btn--sm" : "btn btn--sm"}
          onClick={() => {
            setShowAllObjectives((current) => !current);
            onChange(
              buildTargetState({
                campaigns: [],
                adsetsByCampaignId: {},
                copyMode: activeCopyMode,
                nameOverrides: value.nameOverrides,
              }),
            );
          }}
        >
          All objectives
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <p className="text-[13px] font-semibold text-[var(--ink)]">Campaigns</p>
            <span className="chip">{selectedCampaigns.length} selected</span>
          </div>
          <div className="max-h-[360px] divide-y divide-[var(--border)] overflow-auto">
            {filteredCampaigns.map((campaign) => {
              const checked = selectedCampaignIds.includes(campaign.id);
              return (
                <label
                  key={campaign.id}
                  className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-[var(--hover)]"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={campaignLoading}
                    onChange={(event) => setCampaignSelected(campaign, event.target.checked)}
                    className="mt-1 h-4 w-4 accent-[var(--ink)]"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-[var(--ink)]">{campaign.name}</span>
                    <span className="mono mt-1 block text-[11px] text-[var(--muted)]">
                      {campaign.objective ?? "unknown"} ·{" "}
                      {campaign.isAdsetBudgetSharingEnabled ? "CBO" : "ABO"} ·{" "}
                      {campaign.adsetCount} ad sets · {formatMoney(campaign.lastSpend28d, currency)} 28d
                    </span>
                  </span>
                </label>
              );
            })}
            {filteredCampaigns.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-[var(--muted)]">
                {campaignLoading ? "Loading campaigns..." : "No campaigns found."}
              </p>
            ) : null}
          </div>
        </div>

        <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <p className="text-[13px] font-semibold text-[var(--ink)]">Ad sets</p>
            <span className="chip">{selectedTargets.length} ready</span>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {!hasSelectedCampaigns ? (
              <p className="px-4 py-3 text-[13px] text-[var(--muted)]">Select campaigns first.</p>
            ) : null}
            {selectedCampaigns.map((campaign) => {
              const campaignAdsets = adsetsByCampaignId[campaign.id] ?? [];
              const selectedAdset = (value.targetAdsetsByCampaignId ?? {})[campaign.id] ?? null;
              const loadStatus = adsetLoadStatusByCampaignId[campaign.id];
              const isPendingInitialLoad = campaign.adsetCount > 0 && !loadStatus;
              const campaignAdsetsLoading = loadStatus === "loading" || isPendingInitialLoad;
              const campaignAdsetsFailed = loadStatus === "error" && campaignAdsets.length === 0;
              return (
                <div key={campaign.id} className="space-y-2 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-[var(--ink)]">{campaign.name}</p>
                    <p className="text-[11px] text-[var(--muted)]">
                      {campaignAdsetsLoading
                        ? "Loading ad sets..."
                        : campaignAdsetsFailed
                          ? `${campaign.adsetCount} expected ad set${campaign.adsetCount === 1 ? "" : "s"} did not load`
                          : `${campaignAdsets.length} ACTIVE ad sets`}
                    </p>
                  </div>
                  {campaignAdsetsFailed ? (
                    <div className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--warn-bd)] bg-[var(--warn-bg)] px-3 py-2 text-[11.5px] text-[var(--warn)]">
                      <span>Ad sets could not be loaded. Retry without changing the campaign selection.</span>
                      <button
                        type="button"
                        onClick={() => setAdsetReloadNonce((current) => current + 1)}
                        className="shrink-0 rounded-[5px] border border-[var(--warn-bd)] bg-[var(--surface)] px-2 py-1 font-medium text-[var(--warn)] hover:bg-[var(--warn-bg)]"
                      >
                        Retry
                      </button>
                    </div>
                  ) : null}
                  <select
                    value={selectedAdset?.id ?? ""}
                    disabled={campaignAdsetsLoading || campaignAdsetsFailed}
                    onChange={(event) => {
                      const targetAdset =
                        campaignAdsets.find((item) => item.id === event.target.value) ?? null;
                      setCampaignAdset(campaign, targetAdset);
                    }}
                    className="h-10 w-full rounded-[6px] border border-[var(--border-2)] bg-[var(--surface)] px-3 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--brand)] disabled:opacity-60"
                  >
                    <option value="">
                      {campaignAdsetsLoading
                        ? "Loading ad sets..."
                        : campaignAdsetsFailed
                          ? "Retry loading ad sets"
                          : "Choose ad set"}
                    </option>
                    {campaignAdsets.map((adset) => (
                      <option key={adset.id} value={adset.id}>
                        {adset.name} / {adset.status ?? "unknown"} /{" "}
                        {adset.optimizationGoal ?? "unknown"} /{" "}
                        {formatMoneyMinor(adset.dailyBudgetMinor ?? adset.lifetimeBudgetMinor, currency)} / pixel{" "}
                        {adset.pixelId ?? "n/a"} / ROAS{" "}
                        {adset.last7dRoas == null ? "n/a" : adset.last7dRoas.toFixed(2)}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {selectedTargets.length > 0 ? (
        <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4" data-testid="launchpad-existing-adset-preview">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-semibold text-[var(--ink)]">
              {selectedTargets.length} target ad set{selectedTargets.length === 1 ? "" : "s"}
            </p>
            <span className="chip">{selectedCampaigns.length} campaigns</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Summary label="Targeting" value="Inherited per ad set" />
            <Summary label="Pixel + event" value="Inherited per ad set" />
            <Summary label="Attribution" value="Inherited per ad set" />
            <Summary label="Current ads" value={`${currentAdCount}`} numeric />
            <Summary label="After launch" value={`${selectedCount} creatives -> ${afterCount} ads`} />
            <Summary label="Targets" value={`${selectedTargets.length} ad sets`} />
          </div>
          <div className="mt-4 divide-y divide-[var(--border)] overflow-hidden rounded-[8px] border border-[var(--border)]">
            {selectedTargets.map(({ campaign, adset }) => (
              <div key={`${campaign.id}:${adset.id}`} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 truncate text-[13px] font-medium text-[var(--ink)]">{adset.name}</p>
                  <span className="chip">{adset.status ?? "unknown"}</span>
                  <span className="chip">{adset.optimizationGoal ?? "unknown"}</span>
                </div>
                <p className="mono mt-1 truncate text-[11px] text-[var(--muted)]">
                  {campaign.name} · {adset.pixelId ?? "n/a"} ·{" "}
                  {adset.attributionSummary ?? summarizeAttributionSpec(adset.attributionSpec)}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4" data-testid="launchpad-copy-mode">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-semibold text-[var(--ink)]">Creative copy mode</p>
          <span className="chip">
            {activeCopyMode === "reuse_creative" ? "Duplicate" : "Recreate"}
          </span>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <button
            type="button"
            onClick={() => setCopyMode("reuse_creative")}
            className={`rounded-[8px] border px-3 py-3 text-left text-[13px] transition ${
              activeCopyMode === "reuse_creative"
                ? "border-[var(--ink)] bg-[var(--surface-3)] text-[var(--ink)]"
                : "border-[var(--border-2)] bg-[var(--surface)] text-[var(--ink-3)] hover:bg-[var(--hover)]"
            }`}
          >
            <span className="block font-medium">Duplicate</span>
            <span className="mt-1 block text-[11.5px] text-[var(--muted)]">
              Use the existing Meta creative object.
            </span>
          </button>
          <button
            type="button"
            disabled
            aria-describedby="launchpad-rebuild-creative-review-only"
            className={`rounded-[8px] border px-3 py-3 text-left text-[13px] transition ${
              activeCopyMode === "rebuild_creative"
                ? "border-[var(--ink)] bg-[var(--surface-3)] text-[var(--ink)]"
                : "border-[var(--border-2)] bg-[var(--surface)] text-[var(--ink-3)]"
            }`}
          >
            <span className="block font-medium">
              Recreate exact ad · review-only
            </span>
            <span
              id="launchpad-rebuild-creative-review-only"
              className="mt-1 block text-[11.5px] text-[var(--muted)]"
            >
              Unavailable until image, creative, and ad writes each have a
              durable step receipt.
            </span>
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
        <div className="border-b border-[var(--border)] px-4 py-3 text-[13px] font-semibold text-[var(--ink)]">Ad names</div>
        <div className="divide-y divide-[var(--border)]">
          {selectedCreatives.map((creative) => {
            const name = value.nameOverrides[creative.creativeId] ?? defaultCreativeAddName(creative);
            return (
              <div key={creative.creativeId} className="grid gap-3 px-4 py-3 md:grid-cols-[56px_1fr_1.4fr] md:items-center">
                <CreativeRenderSurface
                  id={creative.id}
                  name={creative.name}
                  preview={creative.preview}
                  size="thumb"
                  mode="asset"
                  assetFallbacks={[
                    creative.tableThumbnailUrl,
                    creative.thumbnailUrl,
                    creative.imageUrl,
                    creative.preview.image_url,
                    creative.preview.poster_url,
                  ]}
                />
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-[var(--ink)]">{creative.name}</p>
                  <p className="mono text-[11px] text-[var(--muted)]">{creative.creativeId}</p>
                </div>
                <input
                  value={name}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      nameOverrides: {
                        ...value.nameOverrides,
                        [creative.creativeId]: event.target.value,
                      },
                    })
                  }
                  className="h-10 w-full rounded-[6px] border border-[var(--border-2)] bg-[var(--surface)] px-3 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--brand)]"
                  aria-label={`Ad name for ${creative.name}`}
                />
              </div>
            );
          })}
          {selectedCreatives.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-[var(--muted)]">Select creatives first.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Summary({ label, value, numeric = false }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div className="min-w-0 rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
      <p className="text-[11px] text-[var(--muted)]">{label}</p>
      <p
        className={
          numeric
            ? "mt-0.5 text-[22px] font-[650] leading-none tracking-[-0.02em] tabular-nums text-[var(--ink)]"
            : "truncate text-[13px] font-medium text-[var(--ink)]"
        }
      >
        {value}
      </p>
    </div>
  );
}
