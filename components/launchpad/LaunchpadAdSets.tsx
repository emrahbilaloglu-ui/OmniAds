"use client";

import { Copy, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { LaunchpadBudgetState } from "@/components/launchpad/LaunchpadBudget";
import type { MetaBidStrategy } from "@/lib/meta/launch-write";

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
  attributionWindow: "1d_click" | "7d_click" | "1d_view";
  budgetAmount: string;
  bidStrategy: MetaBidStrategy;
  bidAmount: string;
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
    attributionWindow: "7d_click",
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

export function LaunchpadAdSets({
  value,
  campaignName,
  budget,
  onChange,
}: {
  value: LaunchpadAdSetState[];
  campaignName: string;
  budget: LaunchpadBudgetState;
  onChange: (value: LaunchpadAdSetState[]) => void;
}) {
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
              <TextField
                label="Pixel"
                value={adSet.pixelId}
                placeholder="pixel id"
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

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <SelectField
                label="Attribution"
                value={adSet.attributionWindow}
                options={["7d_click", "1d_click", "1d_view"]}
                onChange={(attributionWindow) =>
                  updateAdSet(index, {
                    ...adSet,
                    attributionWindow: attributionWindow as LaunchpadAdSetState["attributionWindow"],
                  })
                }
              />
              {budget.mode === "ABO" ? (
                <>
                  <TextField
                    label="Budget"
                    type="number"
                    value={adSet.budgetAmount}
                    onChange={(budgetAmount) =>
                      updateAdSet(index, { ...adSet, budgetAmount })
                    }
                  />
                  <SelectField
                    label="Bid strategy"
                    value={adSet.bidStrategy}
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
                </>
              ) : null}
            </div>

            {budget.mode === "ABO" && adSet.bidStrategy !== "LOWEST_COST_WITHOUT_CAP" ? (
              <div className="mt-3 max-w-xs">
                <TextField
                  label="Bid amount"
                  type="number"
                  value={adSet.bidAmount}
                  onChange={(bidAmount) => updateAdSet(index, { ...adSet, bidAmount })}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
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
