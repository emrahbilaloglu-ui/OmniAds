"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { summarizeAttributionSpec, type MetaAttributionSpecItem } from "@/lib/launchpad/attribution-presets";

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
  nameOverrides: Record<string, string>;
}

type CampaignAdsetLoadStatus = "loading" | "loaded" | "error";

const EMPTY_STATE: LaunchpadAddToExistingState = {
  targetCampaign: null,
  targetAdset: null,
  targetCampaigns: [],
  targetAdsetsByCampaignId: {},
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

function formatMoneyMinor(value: number | null | undefined) {
  if (!value) return "No budget";
  return `$${(value / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatMoney(value: number | null | undefined) {
  if (!value) return "$0";
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
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
  nameOverrides: Record<string, string>;
}): LaunchpadAddToExistingState {
  const firstCampaign = input.campaigns[0] ?? null;
  return {
    targetCampaign: firstCampaign,
    targetAdset: firstCampaign ? input.adsetsByCampaignId[firstCampaign.id] ?? null : null,
    targetCampaigns: input.campaigns,
    targetAdsetsByCampaignId: input.adsetsByCampaignId,
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
  onChange,
  campaignOptions,
  adsetOptions,
}: {
  businessId: string;
  value: LaunchpadAddToExistingState;
  selectedCreatives: MetaCreativeRow[];
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
        nameOverrides: value.nameOverrides,
      }),
    );
  }

  return (
    <section className="space-y-5" data-testid="launchpad-add-to-existing-target">
      <div>
        <h2 className="text-lg font-semibold">Existing target</h2>
        <p className="text-sm text-muted-foreground">
          Pick one or more ACTIVE campaigns and choose the ad set under each campaign.
        </p>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-sm">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search campaigns"
            className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none focus:border-primary"
          />
        </div>
        <Button
          type="button"
          variant={showAllObjectives ? "default" : "outline"}
          size="sm"
          onClick={() => {
            setShowAllObjectives((current) => !current);
            onChange(
              buildTargetState({
                campaigns: [],
                adsetsByCampaignId: {},
                nameOverrides: value.nameOverrides,
              }),
            );
          }}
        >
          All objectives
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="rounded-md border">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <p className="text-sm font-semibold">Campaigns</p>
            <Badge variant="outline">{selectedCampaigns.length} selected</Badge>
          </div>
          <div className="max-h-[360px] divide-y overflow-auto">
            {filteredCampaigns.map((campaign) => {
              const checked = selectedCampaignIds.includes(campaign.id);
              return (
                <label
                  key={campaign.id}
                  className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-muted/30"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={campaignLoading}
                    onChange={(event) => setCampaignSelected(campaign, event.target.checked)}
                    className="mt-1 h-4 w-4"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{campaign.name}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {campaign.objective ?? "unknown"} /{" "}
                      {campaign.isAdsetBudgetSharingEnabled ? "CBO" : "ABO"} /{" "}
                      {campaign.adsetCount} ad sets / {formatMoney(campaign.lastSpend28d)} 28d
                    </span>
                  </span>
                </label>
              );
            })}
            {filteredCampaigns.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                {campaignLoading ? "Loading campaigns..." : "No campaigns found."}
              </p>
            ) : null}
          </div>
        </div>

        <div className="rounded-md border">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <p className="text-sm font-semibold">Ad sets</p>
            <Badge variant="outline">{selectedTargets.length} ready</Badge>
          </div>
          <div className="divide-y">
            {!hasSelectedCampaigns ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">Select campaigns first.</p>
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
                    <p className="truncate text-sm font-medium">{campaign.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {campaignAdsetsLoading
                        ? "Loading ad sets..."
                        : campaignAdsetsFailed
                          ? `${campaign.adsetCount} expected ad set${campaign.adsetCount === 1 ? "" : "s"} did not load`
                          : `${campaignAdsets.length} ACTIVE ad sets`}
                    </p>
                  </div>
                  {campaignAdsetsFailed ? (
                    <div className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <span>Ad sets could not be loaded. Retry without changing the campaign selection.</span>
                      <button
                        type="button"
                        onClick={() => setAdsetReloadNonce((current) => current + 1)}
                        className="shrink-0 rounded border border-amber-300 bg-white px-2 py-1 font-medium text-amber-900 hover:bg-amber-100"
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
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary disabled:opacity-60"
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
                        {formatMoneyMinor(adset.dailyBudgetMinor ?? adset.lifetimeBudgetMinor)} / pixel{" "}
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
        <div className="rounded-md border p-4" data-testid="launchpad-existing-adset-preview">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">
              {selectedTargets.length} target ad set{selectedTargets.length === 1 ? "" : "s"}
            </p>
            <Badge variant="outline">{selectedCampaigns.length} campaigns</Badge>
          </div>
          <div className="grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-3">
            <Summary label="Targeting" value="Inherited per ad set" />
            <Summary label="Pixel + event" value="Inherited per ad set" />
            <Summary label="Attribution" value="Inherited per ad set" />
            <Summary label="Current ads" value={`${currentAdCount}`} />
            <Summary label="After launch" value={`${selectedCount} creatives -> ${afterCount} ads`} />
            <Summary label="Targets" value={`${selectedTargets.length} ad sets`} />
          </div>
          <div className="mt-4 divide-y rounded-md border">
            {selectedTargets.map(({ campaign, adset }) => (
              <div key={`${campaign.id}:${adset.id}`} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">{adset.name}</p>
                  <Badge variant="outline">{adset.status ?? "unknown"}</Badge>
                  <Badge variant="outline">{adset.optimizationGoal ?? "unknown"}</Badge>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {campaign.name} / {adset.pixelId ?? "n/a"} /{" "}
                  {adset.attributionSummary ?? summarizeAttributionSpec(adset.attributionSpec)}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="rounded-md border">
        <div className="border-b px-4 py-3 text-sm font-semibold">Ad names</div>
        <div className="divide-y">
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
                  <p className="truncate text-sm font-medium">{creative.name}</p>
                  <p className="text-xs text-muted-foreground">{creative.creativeId}</p>
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
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label={`Ad name for ${creative.name}`}
                />
              </div>
            );
          })}
          {selectedCreatives.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">Select creatives first.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/20 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate font-medium">{value}</p>
    </div>
  );
}
