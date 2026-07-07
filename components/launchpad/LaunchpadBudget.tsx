"use client";

import type { MetaBidStrategy } from "@/lib/meta/launch-write";

export interface LaunchpadBudgetState {
  mode: "CBO" | "ABO";
  schedule?: "daily" | "lifetime";
  amount?: string;
  bidStrategy?: MetaBidStrategy;
  bidAmount?: string;
}

const BID_STRATEGIES: Array<{ value: MetaBidStrategy; label: string }> = [
  { value: "LOWEST_COST_WITHOUT_CAP", label: "Lowest cost" },
  { value: "LOWEST_COST_WITH_BID_CAP", label: "Bid cap" },
  { value: "COST_CAP", label: "Cost cap" },
];

export function nextLaunchpadBudgetForMode(
  value: LaunchpadBudgetState,
  mode: "CBO" | "ABO",
): LaunchpadBudgetState {
  return mode === "ABO"
    ? {
        mode: "ABO",
        schedule: undefined,
        amount: undefined,
        bidStrategy: undefined,
        bidAmount: undefined,
      }
    : {
        mode: "CBO",
        schedule: value.schedule ?? "daily",
        amount: value.amount ?? "50",
        bidStrategy: value.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
        bidAmount: value.bidAmount ?? "",
      };
}

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
  const amount = Number(value.amount ?? "");
  const dailyLow =
    (value.schedule ?? "daily") === "daily" &&
    Number.isFinite(amount) &&
    expectedCpa != null &&
    expectedCpa > 0 &&
    amount < expectedCpa * 0.5;

  return (
    <section className="space-y-5" data-testid="launchpad-budget">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">Budget</h2>
        <p className="mono text-[12px] text-[var(--muted)]">account currency {currency}</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Segmented
          label="Budget level"
          value={value.mode}
          options={[
            ["CBO", "CBO"],
            ["ABO", "ABO"],
          ]}
          onChange={(mode) => {
            const nextMode = mode as "CBO" | "ABO";
            onChange(nextLaunchpadBudgetForMode(value, nextMode));
          }}
        />
        {value.mode === "CBO" ? (
          <Segmented
            label="Budget schedule"
            value={value.schedule ?? "daily"}
            options={[
              ["daily", "Daily"],
              ["lifetime", "Lifetime"],
            ]}
            onChange={(schedule) =>
              onChange({ ...value, schedule: schedule as "daily" | "lifetime" })
            }
          />
        ) : null}
      </div>

      {value.mode === "CBO" ? (
        <div className="grid gap-3 md:grid-cols-[1fr_220px]">
          <label className="block space-y-1.5">
            <span className="text-[12px] font-medium text-[var(--ink-2)]">Campaign amount</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={value.amount ?? ""}
              onChange={(event) => onChange({ ...value, amount: event.target.value })}
              className="h-10 w-full rounded-[6px] border border-[var(--border-2)] bg-[var(--surface)] px-3 text-[15px] font-medium tabular-nums text-[var(--ink)] outline-none focus:border-[var(--brand)]"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[12px] font-medium text-[var(--ink-2)]">Campaign bid strategy</span>
            <select
              value={value.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP"}
              onChange={(event) =>
                onChange({
                  ...value,
                  bidStrategy: event.target.value as MetaBidStrategy,
                })
              }
              className="h-10 w-full rounded-[6px] border border-[var(--border-2)] bg-[var(--surface)] px-3 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--brand)]"
            >
              {BID_STRATEGIES.map((strategy) => (
                <option key={strategy.value} value={strategy.value}>
                  {strategy.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <p className="rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-[13px] text-[var(--muted)]">
          ABO uses budgets on each ad set. Campaign-level amount and bid fields are omitted.
        </p>
      )}

      {value.mode === "CBO" && value.bidStrategy !== "LOWEST_COST_WITHOUT_CAP" ? (
        <label className="block max-w-sm space-y-1.5">
          <span className="text-[12px] font-medium text-[var(--ink-2)]">Campaign bid amount</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={value.bidAmount ?? ""}
            onChange={(event) => onChange({ ...value, bidAmount: event.target.value })}
            className="h-10 w-full rounded-[6px] border border-[var(--border-2)] bg-[var(--surface)] px-3 text-[13px] tabular-nums text-[var(--ink)] outline-none focus:border-[var(--brand)]"
          />
        </label>
      ) : null}

      {dailyLow ? (
        <span className="chip chip--warn w-fit">
          <span className="dot" />
          Daily budget is below 0.5x expected CPA
        </span>
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
      <p className="text-[12px] font-medium text-[var(--ink-2)]">{label}</p>
      <div className="inline-flex rounded-[6px] border border-[var(--border-2)] bg-[var(--surface-3)] p-1">
        {options.map(([optionValue, optionLabel]) => (
          <button
            key={optionValue}
            type="button"
            onClick={() => onChange(optionValue)}
            className={`rounded-[5px] px-3 py-1.5 text-[13px] transition-colors ${
              value === optionValue
                ? "bg-[var(--surface)] font-medium text-[var(--ink)] shadow-[var(--shadow-sm)]"
                : "text-[var(--muted)] hover:text-[var(--ink-2)]"
            }`}
          >
            {optionLabel}
          </button>
        ))}
      </div>
    </div>
  );
}
