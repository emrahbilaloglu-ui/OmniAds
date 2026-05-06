"use client";

import { Badge } from "@/components/ui/badge";

export interface LaunchpadCampaignBasicsState {
  name: string;
  smartPromotion: boolean;
  specialAdCategories: string[];
}

const SPECIAL_AD_CATEGORIES = ["HOUSING", "EMPLOYMENT", "CREDIT", "ISSUES_ELECTIONS_POLITICS"];

export function LaunchpadCampaignBasics({
  value,
  onChange,
}: {
  value: LaunchpadCampaignBasicsState;
  onChange: (value: LaunchpadCampaignBasicsState) => void;
}) {
  function toggleCategory(category: string) {
    const selected = new Set(value.specialAdCategories);
    if (selected.has(category)) selected.delete(category);
    else selected.add(category);
    onChange({ ...value, specialAdCategories: Array.from(selected) });
  }

  return (
    <section className="space-y-5" data-testid="launchpad-campaign-basics">
      <div>
        <h2 className="text-lg font-semibold">Campaign basics</h2>
        <p className="text-sm text-muted-foreground">Status will start paused</p>
      </div>

      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Campaign name</span>
        <input
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
        />
      </label>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Objective</p>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="secondary">Sales</Badge>
            <span className="text-sm text-muted-foreground">OUTCOME_SALES</span>
          </div>
        </div>
        <label className="flex items-center justify-between rounded-md border p-3">
          <span>
            <span className="block text-sm font-medium">Advantage+ shopping</span>
            <span className="block text-xs text-muted-foreground">GUIDED_CREATION</span>
          </span>
          <input
            type="checkbox"
            checked={value.smartPromotion}
            onChange={(event) =>
              onChange({ ...value, smartPromotion: event.target.checked })
            }
          />
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Special ad categories</p>
        <div className="flex flex-wrap gap-2">
          {SPECIAL_AD_CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              onClick={() => toggleCategory(category)}
              className={`rounded-md border px-3 py-2 text-sm ${
                value.specialAdCategories.includes(category)
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground"
              }`}
            >
              {category.replaceAll("_", " ")}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
