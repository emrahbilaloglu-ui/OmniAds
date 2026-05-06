"use client";

import { Badge } from "@/components/ui/badge";
import type { MetaBidStrategy } from "@/lib/meta/launch-write";

export interface LaunchpadBudgetState {
  mode: "CBO" | "ABO";
  schedule: "daily" | "lifetime";
  amount: string;
  bidStrategy: MetaBidStrategy;
  bidAmount: string;
}

const BID_STRATEGIES: Array<{ value: MetaBidStrategy; label: string }> = [
  { value: "LOWEST_COST_WITHOUT_CAP", label: "Lowest cost" },
  { value: "LOWEST_COST_WITH_BID_CAP", label: "Bid cap" },
  { value: "COST_CAP", label: "Cost cap" },
];

export function LaunchpadBudget({
  value,
  currency,
  expectedCpa,
  onChange,
}: {
  value: LaunchpadBudgetState;
  currency: string;
  expectedCpa?: number | null;
  onChange: (value: LaunchpadBudgetState) => void;
}) {
  const amount = Number(value.amount);
  const dailyLow =
    value.schedule === "daily" &&
    Number.isFinite(amount) &&
    expectedCpa != null &&
    expectedCpa > 0 &&
    amount < expectedCpa * 0.5;

  return (
    <section className="space-y-5" data-testid="launchpad-budget">
      <div>
        <h2 className="text-lg font-semibold">Budget</h2>
        <p className="text-sm text-muted-foreground">{currency}</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Segmented
          label="Budget level"
          value={value.mode}
          options={[
            ["CBO", "CBO"],
            ["ABO", "ABO"],
          ]}
          onChange={(mode) => onChange({ ...value, mode: mode as "CBO" | "ABO" })}
        />
        <Segmented
          label="Budget schedule"
          value={value.schedule}
          options={[
            ["daily", "Daily"],
            ["lifetime", "Lifetime"],
          ]}
          onChange={(schedule) =>
            onChange({ ...value, schedule: schedule as "daily" | "lifetime" })
          }
        />
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_220px]">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Amount</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={value.amount}
            onChange={(event) => onChange({ ...value, amount: event.target.value })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Bid strategy</span>
          <select
            value={value.bidStrategy}
            onChange={(event) =>
              onChange({
                ...value,
                bidStrategy: event.target.value as MetaBidStrategy,
              })
            }
            className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
          >
            {BID_STRATEGIES.map((strategy) => (
              <option key={strategy.value} value={strategy.value}>
                {strategy.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {value.bidStrategy !== "LOWEST_COST_WITHOUT_CAP" ? (
        <label className="block max-w-sm space-y-1.5">
          <span className="text-sm font-medium">Bid amount</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={value.bidAmount}
            onChange={(event) => onChange({ ...value, bidAmount: event.target.value })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
          />
        </label>
      ) : null}

      {dailyLow ? (
        <Badge className="border-amber-200 bg-amber-50 text-amber-900" variant="outline">
          Daily budget is below 0.5x expected CPA
        </Badge>
      ) : null}
    </section>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="inline-flex rounded-md border bg-muted p-1">
        {options.map(([optionValue, optionLabel]) => (
          <button
            key={optionValue}
            type="button"
            onClick={() => onChange(optionValue)}
            className={`rounded px-3 py-1.5 text-sm ${
              value === optionValue
                ? "bg-background font-medium shadow-sm"
                : "text-muted-foreground"
            }`}
          >
            {optionLabel}
          </button>
        ))}
      </div>
    </div>
  );
}
