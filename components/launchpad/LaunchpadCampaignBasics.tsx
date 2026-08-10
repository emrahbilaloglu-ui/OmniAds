"use client";

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
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">Campaign basics</h2>
        <p className="text-[13px] text-[var(--muted)]">Status will start paused</p>
      </div>

      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium text-[var(--ink-2)]">Campaign name</span>
        <input
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
          className="h-10 w-full rounded-[6px] border border-[var(--border-2)] bg-[var(--surface)] px-3 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--brand)]"
        />
      </label>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-3">
          <p className="text-[12px] font-semibold uppercase tracking-[0.04em] text-[var(--muted)]">Objective</p>
          <div className="mt-2 flex items-center gap-2">
            <span className="chip chip--info">Sales</span>
            <span className="mono text-[12px] text-[var(--muted)]">OUTCOME_SALES</span>
          </div>
        </div>
        <label className="flex cursor-pointer items-center justify-between rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-3">
          <span>
            <span className="block text-[13px] font-medium text-[var(--ink)]">Advantage+ shopping</span>
            <span className="mono block text-[12px] text-[var(--muted)]">GUIDED_CREATION</span>
          </span>
          <input
            type="checkbox"
            checked={value.smartPromotion}
            onChange={(event) =>
              onChange({ ...value, smartPromotion: event.target.checked })
            }
            className="accent-[var(--ink)]"
          />
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-[13px] font-medium text-[var(--ink)]">Special ad categories</p>
        <div className="flex flex-wrap gap-2">
          {SPECIAL_AD_CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              onClick={() => toggleCategory(category)}
              className={`rounded-[6px] border px-3 py-2 text-[12.5px] transition-colors ${
                value.specialAdCategories.includes(category)
                  ? "border-[var(--ink)] bg-[var(--ink)] text-white"
                  : "border-[var(--border-2)] bg-[var(--surface)] text-[var(--ink-3)] hover:bg-[var(--hover)]"
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
