"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { LaunchpadBudgetState } from "@/components/launchpad/LaunchpadBudget";
import type { MetaBidStrategy } from "@/lib/meta/launch-write";
import {
  ATTRIBUTION_DIMENSIONS,
  ATTRIBUTION_PRESETS,
  DEFAULT_ATTRIBUTION_PRESET_ID,
  attributionSpecHasClick,
  getAttributionPresetById,
  summarizeAttributionSpec,
  type AttributionPreset,
  type MetaAttributionSpecItem,
} from "@/lib/launchpad/attribution-presets";

export interface LaunchpadAdSetState {
  clientId: string;
  name: string;
  optimizationGoal: "OFFSITE_CONVERSIONS" | "VALUE" | "LANDING_PAGE_VIEWS";
  pixelId: string;
  customEventType: "PURCHASE" | "ADD_TO_CART" | "INITIATE_CHECKOUT";
  countries: string;
  ageMin: string;
  ageMax: string;
  advantageAudience: boolean;
  advantagePlacements: boolean;
  publisherPlatforms: string[];
  facebookPositions: string[];
  instagramPositions: string[];
  attributionPresetId: AttributionPreset["id"];
  attributionSpec: MetaAttributionSpecItem[];
  budgetAmount?: string;
  bidStrategy?: MetaBidStrategy;
  bidAmount?: string;
}

export interface LaunchpadPixelOption {
  id: string;
  name: string | null;
  lastSpend28d: number;
  lastUpdatedAt: string | null;
  isMostUsed: boolean;
}

export function makeDefaultLaunchpadAdSet(index: number, campaignName: string): LaunchpadAdSetState {
  return {
    clientId:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `adset-${Date.now()}-${index}`,
    name: `${campaignName || "Campaign"} - ${index}`,
    optimizationGoal: "OFFSITE_CONVERSIONS",
    pixelId: "",
    customEventType: "PURCHASE",
    countries: "US",
    ageMin: "18",
    ageMax: "65",
    advantageAudience: true,
    advantagePlacements: true,
    publisherPlatforms: ["facebook", "instagram"],
    facebookPositions: ["feed", "story", "reels"],
    instagramPositions: ["stream", "story", "reels"],
    attributionPresetId: DEFAULT_ATTRIBUTION_PRESET_ID,
    attributionSpec:
      getAttributionPresetById(DEFAULT_ATTRIBUTION_PRESET_ID)?.attributionSpec ?? [
        { event_type: "CLICK_THROUGH", window_days: 7 },
      ],
    budgetAmount: "25",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    bidAmount: "",
  };
}

const OPTIMIZATION_GOALS = [
  "OFFSITE_CONVERSIONS",
  "VALUE",
  "LANDING_PAGE_VIEWS",
] as const;

const CUSTOM_EVENTS = ["PURCHASE", "ADD_TO_CART", "INITIATE_CHECKOUT"] as const;
const PUBLISHERS = ["facebook", "instagram", "audience_network", "messenger"];
const FACEBOOK_POSITIONS = ["feed", "story", "reels", "marketplace", "video_feeds"];
const INSTAGRAM_POSITIONS = ["stream", "story", "reels", "explore"];

export function resetHiddenAdSetBudgetFieldsForMode(
  value: LaunchpadAdSetState[],
  mode: LaunchpadBudgetState["mode"],
) {
  return value.map((adSet) =>
    mode === "CBO"
      ? {
          ...adSet,
          budgetAmount: undefined,
          bidStrategy: undefined,
          bidAmount: undefined,
        }
      : {
          ...adSet,
          budgetAmount: adSet.budgetAmount ?? "25",
          bidStrategy: adSet.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
          bidAmount: adSet.bidAmount ?? "",
        },
  );
}

export function LaunchpadAdSets({
  value,
  businessId,
  campaignName,
  budget,
  onChange,
  pixelOptions,
}: {
  value: LaunchpadAdSetState[];
  businessId?: string;
  campaignName: string;
  budget: LaunchpadBudgetState;
  onChange: (value: LaunchpadAdSetState[]) => void;
  pixelOptions?: LaunchpadPixelOption[];
}) {
  const [pixels, setPixels] = useState<LaunchpadPixelOption[]>(pixelOptions ?? []);
  const [pixelsLoading, setPixelsLoading] = useState(false);

  useEffect(() => {
    if (pixelOptions) setPixels(pixelOptions);
  }, [pixelOptions]);

  useEffect(() => {
    if (!businessId || pixelOptions) return;
    let cancelled = false;
    setPixelsLoading(true);
    fetch(`/api/launchpad/meta/pixels?businessId=${encodeURIComponent(businessId)}`)
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setPixels(Array.isArray(payload?.pixels) ? payload.pixels : []);
      })
      .catch(() => {
        if (!cancelled) setPixels([]);
      })
      .finally(() => {
        if (!cancelled) setPixelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, pixelOptions]);

  const sortedPixels = useMemo(
    () =>
      [...pixels].sort(
        (a, b) =>
          (b.lastSpend28d ?? 0) - (a.lastSpend28d ?? 0) ||
          Date.parse(b.lastUpdatedAt ?? "") - Date.parse(a.lastUpdatedAt ?? ""),
      ),
    [pixels],
  );

  useEffect(() => {
    let changed = false;
    const mostUsed = sortedPixels.find((pixel) => pixel.isMostUsed) ?? sortedPixels[0] ?? null;
    const modeNormalized = resetHiddenAdSetBudgetFieldsForMode(value, budget.mode);
    if (modeNormalized.some((adSet, index) => {
      const original = value[index];
      return (
        original &&
        (adSet.budgetAmount !== original.budgetAmount ||
          adSet.bidStrategy !== original.bidStrategy ||
          adSet.bidAmount !== original.bidAmount)
      );
    })) {
      changed = true;
    }
    const next = modeNormalized.map((adSet) => {
      if (!pixelsLoading && sortedPixels.length === 0 && adSet.pixelId) {
        changed = true;
        return { ...adSet, pixelId: "" };
      }
      if (!adSet.pixelId && mostUsed) {
        changed = true;
        return { ...adSet, pixelId: mostUsed.id };
      }
      return adSet;
    });
    if (changed) onChange(next);
  }, [budget.mode, onChange, pixelsLoading, sortedPixels, value]);

  function updateAdSet(index: number, next: LaunchpadAdSetState) {
    onChange(value.map((item, itemIndex) => (itemIndex === index ? next : item)));
  }

  function addAdSet() {
    onChange([...value, makeDefaultLaunchpadAdSet(value.length + 1, campaignName)]);
  }

  function duplicateAdSet(index: number) {
    const source = value[index];
    if (!source) return;
    onChange([
      ...value,
      {
        ...source,
        clientId:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${source.clientId}-copy`,
        name: `${source.name} copy`,
      },
    ]);
  }

  function removeAdSet(index: number) {
    if (value.length <= 1) return;
    onChange(value.filter((_, itemIndex) => itemIndex !== index));
  }

  return (
    <section className="space-y-5" data-testid="launchpad-adsets">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Ad sets</h2>
          <p className="text-sm text-muted-foreground">
            Each ad set inherits all selected creatives
          </p>
        </div>
        <Button type="button" size="sm" onClick={addAdSet}>
          <Plus className="h-4 w-4" />
          Add ad set
        </Button>
      </div>

      <div className="space-y-4">
        {value.map((adSet, index) => (
          <div key={adSet.clientId} className="rounded-md border p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">Ad set {index + 1}</p>
                <Badge variant="outline">7d click immutable</Badge>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="icon-sm" onClick={() => duplicateAdSet(index)}>
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  disabled={value.length <= 1}
                  onClick={() => removeAdSet(index)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <TextField
                label="Name"
                value={adSet.name}
                onChange={(name) => updateAdSet(index, { ...adSet, name })}
              />
              <SelectField
                label="Optimization"
                value={adSet.optimizationGoal}
                options={OPTIMIZATION_GOALS}
                onChange={(optimizationGoal) =>
                  updateAdSet(index, {
                    ...adSet,
                    optimizationGoal: optimizationGoal as LaunchpadAdSetState["optimizationGoal"],
                  })
                }
              />
              <PixelField
                value={adSet.pixelId}
                pixels={sortedPixels}
                loading={pixelsLoading}
                onChange={(pixelId) => updateAdSet(index, { ...adSet, pixelId })}
              />
              <SelectField
                label="Event"
                value={adSet.customEventType}
                options={CUSTOM_EVENTS}
                onChange={(customEventType) =>
                  updateAdSet(index, {
                    ...adSet,
                    customEventType: customEventType as LaunchpadAdSetState["customEventType"],
                  })
                }
              />
              <TextField
                label="Countries"
                value={adSet.countries}
                placeholder="US, CA"
                onChange={(countries) => updateAdSet(index, { ...adSet, countries })}
              />
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  label="Age min"
                  type="number"
                  value={adSet.ageMin}
                  onChange={(ageMin) => updateAdSet(index, { ...adSet, ageMin })}
                />
                <TextField
                  label="Age max"
                  type="number"
                  value={adSet.ageMax}
                  onChange={(ageMax) => updateAdSet(index, { ...adSet, ageMax })}
                />
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <CheckboxRow
                label="Advantage+ Audience"
                checked={adSet.advantageAudience}
                onChange={(advantageAudience) =>
                  updateAdSet(index, { ...adSet, advantageAudience })
                }
              />
              <CheckboxRow
                label="Advantage+ Placements"
                checked={adSet.advantagePlacements}
                onChange={(advantagePlacements) =>
                  updateAdSet(index, { ...adSet, advantagePlacements })
                }
              />
            </div>

            {!adSet.advantagePlacements ? (
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <MultiCheck
                  label="Publishers"
                  options={PUBLISHERS}
                  value={adSet.publisherPlatforms}
                  onChange={(publisherPlatforms) =>
                    updateAdSet(index, { ...adSet, publisherPlatforms })
                  }
                />
                <MultiCheck
                  label="Facebook"
                  options={FACEBOOK_POSITIONS}
                  value={adSet.facebookPositions}
                  onChange={(facebookPositions) =>
                    updateAdSet(index, { ...adSet, facebookPositions })
                  }
                />
                <MultiCheck
                  label="Instagram"
                  options={INSTAGRAM_POSITIONS}
                  value={adSet.instagramPositions}
                  onChange={(instagramPositions) =>
                    updateAdSet(index, { ...adSet, instagramPositions })
                  }
                />
              </div>
            ) : null}

            <div className="mt-4 space-y-3">
              <AttributionField
                adSet={adSet}
                onChange={(next) => updateAdSet(index, next)}
              />
              {budget.mode === "ABO" ? (
                <div className="grid gap-3 md:grid-cols-3">
                  <TextField
                    label="Ad set budget"
                    type="number"
                    value={adSet.budgetAmount ?? ""}
                    onChange={(budgetAmount) =>
                      updateAdSet(index, { ...adSet, budgetAmount })
                    }
                  />
                  <SelectField
                    label="Ad set bid strategy"
                    value={adSet.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP"}
                    options={[
                      "LOWEST_COST_WITHOUT_CAP",
                      "LOWEST_COST_WITH_BID_CAP",
                      "COST_CAP",
                    ]}
                    onChange={(bidStrategy) =>
                      updateAdSet(index, {
                        ...adSet,
                        bidStrategy: bidStrategy as MetaBidStrategy,
                      })
                    }
                  />
                  {adSet.bidStrategy !== "LOWEST_COST_WITHOUT_CAP" ? (
                    <TextField
                      label="Ad set bid amount"
                      type="number"
                      value={adSet.bidAmount ?? ""}
                      onChange={(bidAmount) => updateAdSet(index, { ...adSet, bidAmount })}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AttributionField({
  adSet,
  onChange,
}: {
  adSet: LaunchpadAdSetState;
  onChange: (value: LaunchpadAdSetState) => void;
}) {
  const hasClick = attributionSpecHasClick(adSet.attributionSpec);
  const activeSpec = new Set(
    adSet.attributionSpec.map((item) => `${item.event_type}:${item.window_days}`),
  );
  return (
    <div className="rounded-md border p-3" data-testid="launchpad-attribution-field">
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Attribution preset</span>
        <select
          value={adSet.attributionPresetId}
          onChange={(event) => {
            const preset = getAttributionPresetById(event.target.value);
            if (!preset) return;
            onChange({
              ...adSet,
              attributionPresetId: preset.id,
              attributionSpec: preset.attributionSpec,
            });
          }}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
        >
          {ATTRIBUTION_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      {adSet.attributionPresetId === "custom" ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {ATTRIBUTION_DIMENSIONS.map((dimension) => {
            const key = `${dimension.event_type}:${dimension.window_days}`;
            const checked = activeSpec.has(key);
            return (
              <label key={key} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...adSet.attributionSpec, dimension]
                      : adSet.attributionSpec.filter(
                          (item) =>
                            item.event_type !== dimension.event_type ||
                            item.window_days !== dimension.window_days,
                        );
                    const ordered = ATTRIBUTION_DIMENSIONS.filter((item) =>
                      next.some(
                        (selected) =>
                          selected.event_type === item.event_type &&
                          selected.window_days === item.window_days,
                      ),
                    );
                    onChange({ ...adSet, attributionSpec: ordered });
                  }}
                />
                {dimension.event_type === "CLICK_THROUGH"
                  ? `Click ${dimension.window_days}-day`
                  : dimension.event_type === "VIEW_THROUGH"
                    ? `View ${dimension.window_days}-day`
                    : `Engaged video view ${dimension.window_days}-day`}
              </label>
            );
          })}
        </div>
      ) : null}
      <div className="mt-3 rounded-md bg-muted/30 p-2 text-xs">
        <span className="font-medium">attribution_spec preview: </span>
        <code>{JSON.stringify(adSet.attributionSpec)}</code>
      </div>
      {!hasClick ? (
        <Badge className="mt-2 border-rose-200 bg-rose-50 text-rose-800" variant="outline">
          At least one click window is required
        </Badge>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {summarizeAttributionSpec(adSet.attributionSpec)}
        </p>
      )}
    </div>
  );
}

function formatPixelLabel(pixel: LaunchpadPixelOption) {
  const name = pixel.name ? `${pixel.name} / ` : "";
  return `${name}${pixel.id} / 28d spend $${pixel.lastSpend28d.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  })}`;
}

function PixelField({
  value,
  pixels,
  loading,
  onChange,
}: {
  value: string;
  pixels: LaunchpadPixelOption[];
  loading: boolean;
  onChange: (value: string) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-1.5">
        <span className="text-sm font-medium">Pixel</span>
        <div className="flex h-10 items-center rounded-md border px-3 text-sm text-muted-foreground">
          Loading pixels...
        </div>
      </div>
    );
  }
  if (pixels.length === 0) {
    return (
      <div className="space-y-1.5">
        <span className="text-sm font-medium">Pixel</span>
        <Badge className="border-rose-200 bg-rose-50 text-rose-800" variant="outline">
          No active pixel found for this business
        </Badge>
      </div>
    );
  }
  if (pixels.length === 1) {
    const pixel = pixels[0];
    return (
      <div className="space-y-1.5">
        <span className="text-sm font-medium">Pixel</span>
        <div className="flex h-10 items-center rounded-md border bg-muted/20 px-3 text-sm">
          {pixel ? formatPixelLabel(pixel) : value}
        </div>
      </div>
    );
  }
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">Pixel</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
      >
        <option value="">Choose pixel</option>
        {pixels.map((pixel) => (
          <option key={pixel.id} value={pixel.id}>
            {formatPixelLabel(pixel)}
            {pixel.isMostUsed ? " / most used" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextField({
  label,
  value,
  type = "text",
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  type?: "text" | "number";
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckboxRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function MultiCheck({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const selected = new Set(value);
  return (
    <div className="rounded-md border p-3">
      <p className="mb-2 text-sm font-medium">{label}</p>
      <div className="space-y-2">
        {options.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={selected.has(option)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(option);
                else next.delete(option);
                onChange(Array.from(next));
              }}
            />
            {option.replaceAll("_", " ")}
          </label>
        ))}
      </div>
    </div>
  );
}
