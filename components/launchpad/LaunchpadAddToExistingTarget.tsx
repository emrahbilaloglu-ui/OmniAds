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
  nameOverrides: Record<string, string>;
}

const EMPTY_STATE: LaunchpadAddToExistingState = {
  targetCampaign: null,
  targetAdset: null,
  nameOverrides: {},
};

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
  const [adsets, setAdsets] = useState<LaunchpadExistingAdSet[]>(adsetOptions ?? []);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [adsetLoading, setAdsetLoading] = useState(false);
  const [showAllObjectives, setShowAllObjectives] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (campaignOptions) setCampaigns(campaignOptions);
  }, [campaignOptions]);

  useEffect(() => {
    if (adsetOptions) setAdsets(adsetOptions);
  }, [adsetOptions]);

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
    if (!businessId || !value.targetCampaign?.id || adsetOptions) {
      if (!value.targetCampaign?.id && !adsetOptions) setAdsets([]);
      return;
    }
    let cancelled = false;
    setAdsetLoading(true);
    fetch(
      `/api/launchpad/meta/adsets?businessId=${encodeURIComponent(businessId)}&campaignId=${encodeURIComponent(value.targetCampaign.id)}`,
    )
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setAdsets(Array.isArray(payload?.adsets) ? payload.adsets : []);
      })
      .catch(() => {
        if (!cancelled) setAdsets([]);
      })
      .finally(() => {
        if (!cancelled) setAdsetLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adsetOptions, businessId, value.targetCampaign?.id]);

  const filteredCampaigns = useMemo(() => {
    const query = search.trim().toLowerCase();
    return campaigns.filter((campaign) =>
      query ? campaign.name.toLowerCase().includes(query) || campaign.id.includes(query) : true,
    );
  }, [campaigns, search]);

  const selectedAdset = value.targetAdset;
  const selectedCount = selectedCreatives.length;
  const afterCount = selectedAdset ? selectedAdset.currentAdCount + selectedCount : selectedCount;

  return (
    <section className="space-y-5" data-testid="launchpad-add-to-existing-target">
      <div>
        <h2 className="text-lg font-semibold">Existing target</h2>
        <p className="text-sm text-muted-foreground">
          Pick an ACTIVE campaign and ad set. Pixel, attribution, targeting, and budget are inherited.
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
            onChange({ ...value, targetCampaign: null, targetAdset: null });
          }}
        >
          All objectives
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Campaign</span>
            <select
              value={value.targetCampaign?.id ?? ""}
              disabled={campaignLoading}
              onChange={(event) => {
                const campaign = campaigns.find((item) => item.id === event.target.value) ?? null;
                onChange({ ...value, targetCampaign: campaign, targetAdset: null });
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            >
              <option value="">Choose campaign</option>
              {filteredCampaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name} / {campaign.objective ?? "unknown"} /{" "}
                  {campaign.isAdsetBudgetSharingEnabled ? "CBO" : "ABO"} /{" "}
                  {campaign.adsetCount} ad sets / {formatMoney(campaign.lastSpend28d)} 28d
                </option>
              ))}
            </select>
          </label>
          {campaignLoading ? <p className="text-sm text-muted-foreground">Loading campaigns...</p> : null}
        </div>

        <div className="space-y-2">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Ad set</span>
            <select
              value={value.targetAdset?.id ?? ""}
              disabled={!value.targetCampaign || adsetLoading}
              onChange={(event) => {
                const targetAdset = adsets.find((item) => item.id === event.target.value) ?? null;
                onChange({ ...value, targetAdset });
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary disabled:opacity-60"
            >
              <option value="">
                {value.targetCampaign ? "Choose ad set" : "Choose a campaign first"}
              </option>
              {adsets.map((adset) => (
                <option key={adset.id} value={adset.id}>
                  {adset.name} / {adset.status ?? "unknown"} / {adset.optimizationGoal ?? "unknown"} /{" "}
                  {formatMoneyMinor(adset.dailyBudgetMinor ?? adset.lifetimeBudgetMinor)} / pixel{" "}
                  {adset.pixelId ?? "n/a"} / ROAS {adset.last7dRoas == null ? "n/a" : adset.last7dRoas.toFixed(2)}
                </option>
              ))}
            </select>
          </label>
          {adsetLoading ? <p className="text-sm text-muted-foreground">Loading ad sets...</p> : null}
        </div>
      </div>

      {selectedAdset ? (
        <div className="rounded-md border p-4" data-testid="launchpad-existing-adset-preview">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{selectedAdset.name}</p>
            <Badge variant="outline">{selectedAdset.status ?? "unknown"}</Badge>
            <Badge variant="outline">{selectedAdset.optimizationGoal ?? "unknown"}</Badge>
          </div>
          <div className="grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-3">
            <Summary label="Targeting" value={`${selectedAdset.targeting.geoCountries.join(", ") || "n/a"} / ${selectedAdset.targeting.ageMin}-${selectedAdset.targeting.ageMax}`} />
            <Summary label="Audience" value={selectedAdset.targeting.advantageAudience ? "Advantage+ Audience" : "Manual audience"} />
            <Summary label="Placements" value={selectedAdset.targeting.placementSummary} />
            <Summary label="Pixel + event" value={`${selectedAdset.pixelId ?? "n/a"} / ${selectedAdset.customEventType ?? "n/a"}`} />
            <Summary label="Attribution" value={selectedAdset.attributionSummary ?? summarizeAttributionSpec(selectedAdset.attributionSpec)} />
            <Summary label="Budget" value={formatMoneyMinor(selectedAdset.dailyBudgetMinor ?? selectedAdset.lifetimeBudgetMinor)} />
            <Summary label="Current ads" value={`${selectedAdset.currentAdCount}`} />
            <Summary label="7d spend / ROAS" value={`${formatMoney(selectedAdset.last7dSpend)} / ${selectedAdset.last7dRoas == null ? "n/a" : `${selectedAdset.last7dRoas.toFixed(2)}x`}`} />
            <Summary label="After launch" value={`${selectedCount} creatives -> ${afterCount} ads`} />
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
