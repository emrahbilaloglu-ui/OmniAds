"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";
import {
  BUSINESS_COUNTRY_PRIORITY_TIERS,
  BUSINESS_COUNTRY_SCALE_OVERRIDES,
  BUSINESS_COUNTRY_SERVICEABILITY,
  BUSINESS_DECISION_BID_REGIMES,
  BUSINESS_DECISION_CALIBRATION_CHANNELS,
  BUSINESS_DECISION_OBJECTIVE_FAMILIES,
  BUSINESS_ISSUE_STATUSES,
  BUSINESS_PROMO_SEVERITIES,
  BUSINESS_PROMO_TYPES,
  BUSINESS_STOCK_PRESSURE_STATUSES,
  createEmptyBusinessCommercialTruthSnapshot,
  createEmptyDecisionCalibrationProfile,
  createEmptyCountryEconomicsRow,
  createEmptyOperatingConstraints,
  createEmptyPromoCalendarEvent,
  createEmptyTargetPack,
  type BusinessCommercialTruthSnapshot,
  type BusinessDecisionCalibrationProfile,
} from "@/src/types/business-commercial";

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface CommercialTruthSettingsResponse {
  snapshot: BusinessCommercialTruthSnapshot;
  permissions: {
    canEdit: boolean;
    reason: string | null;
    role: "admin" | "collaborator" | "guest";
  };
}

// ---------------------------------------------------------------------------
// Design primitives
// ---------------------------------------------------------------------------

function CtSection({
  eyebrow,
  title,
  subtitle,
  tooltip,
  action,
  children,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  tooltip?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
        <div className="flex min-w-0 flex-col gap-1">
          {eyebrow && (
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              {eyebrow}
            </p>
          )}
          <div className="flex items-center gap-2">
            <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-slate-900">{title}</h2>
            {tooltip ? <CtTooltip content={tooltip} /> : null}
          </div>
          {subtitle && (
            <p className="text-[12.5px] leading-snug text-slate-500">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      <div className="p-6">{children}</div>
    </section>
  );
}

function CtTooltip({ content }: { content: string }) {
  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        aria-label={content}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 outline-none hover:border-slate-300 hover:text-slate-700 focus:border-slate-400 focus:text-slate-700"
      >
        <Info size={12} strokeWidth={2.2} aria-hidden="true" />
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 hidden w-72 -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11.5px] font-medium leading-snug text-slate-600 shadow-lg group-hover:block group-focus-within:block"
      >
        {content}
      </span>
    </span>
  );
}

function CtField({
  label,
  helper,
  tooltip,
  children,
}: {
  label: string;
  helper?: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="text-[12.5px] font-semibold text-slate-900">{label}</label>
        {tooltip ? <CtTooltip content={tooltip} /> : null}
      </div>
      {children}
      {helper && (
        <p className="text-[11.5px] leading-snug text-slate-500">{helper}</p>
      )}
    </div>
  );
}

function CtNumberInput({
  value,
  onChange,
  suffix,
  prefix,
  disabled,
  testId,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  suffix?: string;
  prefix?: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex h-10 items-center gap-1.5 rounded-[10px] border border-slate-200 bg-white px-3">
      {prefix && <span className="text-[13px] text-slate-400">{prefix}</span>}
      <input
        type="number"
        step="0.01"
        value={value ?? ""}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
        className="min-w-0 flex-1 bg-transparent text-[14px] font-medium text-slate-900 tabular-nums outline-none disabled:cursor-not-allowed disabled:opacity-60"
      />
      {suffix && <span className="text-[13px] text-slate-500">{suffix}</span>}
    </div>
  );
}

function CtSelect({
  value,
  onChange,
  options,
  disabled,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        data-testid={testId}
        className="h-10 w-full appearance-none rounded-[10px] border border-slate-200 bg-white pl-3 pr-9 text-[13px] font-medium text-slate-900 outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
      >
        <path
          d="M2.5 4l2.5 2.5L7.5 4"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function CtTextInput({
  value,
  onChange,
  placeholder,
  multiline,
  disabled,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  const baseClass =
    "w-full rounded-[10px] border border-slate-200 bg-white px-3 py-2.5 text-[13px] font-medium text-slate-900 outline-none disabled:cursor-not-allowed disabled:opacity-60";
  return multiline ? (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={3}
      disabled={disabled}
      data-testid={testId}
      className={`${baseClass} resize-y`}
    />
  ) : (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      data-testid={testId}
      className={`${baseClass} h-10`}
    />
  );
}

function CtStatCard({
  label,
  value,
  helper,
  dominant,
}: {
  label: string;
  value: string;
  helper: string;
  dominant?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-2xl p-[18px] ${
        dominant
          ? "bg-slate-900 text-white"
          : "border border-slate-200 bg-slate-50 text-slate-900"
      }`}
    >
      <p
        className={`text-[10.5px] font-semibold uppercase tracking-[0.14em] ${
          dominant ? "text-white/70" : "text-slate-500"
        }`}
      >
        {label}
      </p>
      <p
        className={`tabular-nums leading-none tracking-[-0.025em] ${
          dominant ? "text-[38px] font-bold text-white" : "text-[26px] font-bold text-slate-900"
        }`}
      >
        {value}
      </p>
      <p
        className={`text-[11.5px] leading-snug ${
          dominant ? "text-white/65" : "text-slate-500"
        }`}
      >
        {helper}
      </p>
    </div>
  );
}

function CtGhostBtn({
  onClick,
  disabled,
  testId,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="h-8 rounded-lg border border-slate-200 bg-white px-3 text-[12.5px] font-semibold text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function CtIconCircleBtn({
  onClick,
  disabled,
  testId,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function CtEmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-[10px] border border-dashed border-slate-300 bg-slate-50 px-4 py-3.5 text-[12.5px] leading-snug text-slate-500">
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 1: Decision Coverage
// ---------------------------------------------------------------------------

const COVERAGE_TONE = {
  complete: { dot: "bg-emerald-500", ring: "shadow-[0_0_0_3px_rgb(16,185,129,0.13)]", badge: "bg-emerald-50 text-emerald-700", label: "Complete" },
  optional: { dot: "bg-slate-400", ring: "shadow-[0_0_0_3px_rgb(148,163,184,0.13)]", badge: "bg-slate-100 text-slate-600", label: "Optional" },
  missing:  { dot: "bg-amber-400", ring: "shadow-[0_0_0_3px_rgb(245,158,11,0.13)]", badge: "bg-amber-50 text-amber-700", label: "Missing" },
  blocking: { dot: "bg-rose-500",  ring: "shadow-[0_0_0_3px_rgb(244,63,94,0.13)]",  badge: "bg-rose-50 text-rose-700",   label: "Blocking" },
};
type CoverageToneKey = keyof typeof COVERAGE_TONE;

function DecisionCoverageSection({ snapshot }: { snapshot: BusinessCommercialTruthSnapshot }) {
  const coverage = snapshot.coverage;

  const rows: Array<{
    id: string;
    label: string;
    detail: string;
    status: CoverageToneKey;
  }> = [
    {
      id: "thresholds",
      label: "Thresholds",
      detail: coverage?.thresholds
        ? `Target ROAS ${coverage.thresholds.targetRoas ?? "—"}x · Break-even ROAS ${coverage.thresholds.breakEvenRoas ?? "—"}x`
        : "Not configured",
      status: snapshot.targetPack ? "complete" : "blocking",
    },
    {
      id: "actionCeil",
      label: "Action ceilings",
      detail: (coverage?.actionCeilings?.length ?? 0) > 0
        ? (coverage?.actionCeilings ?? []).map((a) => a.replaceAll("_", " ")).join(", ")
        : "None active",
      status: "complete",
    },
    {
      id: "countryEconomics",
      label: "Country economics",
      detail: snapshot.countryEconomics.length > 0
        ? `${snapshot.countryEconomics.length} GEO override${snapshot.countryEconomics.length !== 1 ? "s" : ""}`
        : "Global cost structure applies to all locations",
      status: snapshot.countryEconomics.length > 0 ? "complete" : "optional",
    },
    {
      id: "calibration",
      label: "Calibration bootstrap",
      detail: (snapshot.calibrationProfiles?.length ?? 0) > 0
        ? `${snapshot.calibrationProfiles?.length ?? 0} calibration profile${(snapshot.calibrationProfiles?.length ?? 0) !== 1 ? "s" : ""}`
        : "No calibration profiles",
      status: (snapshot.calibrationProfiles?.length ?? 0) > 0 ? "complete" : "optional",
    },
    {
      id: "promo",
      label: "Promo calendar",
      detail: snapshot.promoCalendar.length > 0
        ? `${snapshot.promoCalendar.length} promo window${snapshot.promoCalendar.length !== 1 ? "s" : ""}`
        : "No promo windows",
      status: "optional",
    },
    {
      id: "operating",
      label: "Operating constraints",
      detail: snapshot.operatingConstraints
        ? `Site: ${snapshot.operatingConstraints.siteIssueStatus} · Stock: ${snapshot.operatingConstraints.stockPressureStatus}`
        : "Not configured",
      status: snapshot.operatingConstraints ? "complete" : "optional",
    },
  ];

  const blockingRows = rows.filter((r) => r.status === "blocking");

  return (
    <CtSection
      eyebrow="Section 1"
      title="Decision Coverage"
      subtitle="What Adsecute has so it can run with confidence. Blocking items hold the engine on conservative fallbacks."
      tooltip="This summary separates true blockers from optional context. Empty Country Economics is informational; it means global economics are used for every location."
    >
      {blockingRows.length > 0 && (
        <div className="mb-4 flex gap-3 rounded-[10px] border-l-4 border-amber-400 bg-amber-50 px-4 py-3.5">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="mt-0.5 shrink-0">
            <path d="M9 1.5l8 14H1l8-14z" fill="#fbbf24" stroke="#b45309" strokeWidth="1.2" strokeLinejoin="round"/>
            <path d="M9 6.5v4M9 12.5v.6" stroke="#7c2d12" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
          <div className="flex flex-col gap-1">
            <p className="text-[13px] font-bold text-amber-800">Blocking reasons</p>
            <p className="text-[12.5px] leading-snug text-amber-900">
              {blockingRows.map((r) => r.detail).join(" · ")}. The engine stays on conservative fallbacks until these clear.
            </p>
          </div>
        </div>
      )}
      <div
        className="grid overflow-hidden rounded-xl border border-slate-200"
        style={{ gridTemplateColumns: "1fr 1fr" }}
        data-testid="commercial-coverage-summary"
      >
        {rows.map((r, i) => {
          const tone = COVERAGE_TONE[r.status as keyof typeof COVERAGE_TONE] ?? COVERAGE_TONE.optional;
          const col = i % 2;
          const row = Math.floor(i / 2);
          return (
            <div
              key={r.id}
              className={`grid items-center gap-2.5 bg-white px-3.5 py-2.5 ${row > 0 ? "border-t border-slate-100" : ""} ${col === 1 ? "border-l border-slate-100" : ""}`}
              style={{ gridTemplateColumns: "12px 1fr auto" }}
            >
              <div className={`h-2 w-2 shrink-0 rounded-full ${tone.dot} ${tone.ring}`} />
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="truncate text-[12.5px] font-semibold text-slate-900">{r.label}</p>
                <p className="truncate text-[11.5px] text-slate-500">{r.detail}</p>
              </div>
              <span className={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10.5px] font-semibold ${tone.badge}`}>
                {tone.label}
              </span>
            </div>
          );
        })}
      </div>
    </CtSection>
  );
}

// ---------------------------------------------------------------------------
// Section 2: Cost Structure
// ---------------------------------------------------------------------------

interface CostInputs {
  cogs: number | null;
  shipping: number | null;
  fulfillment: number | null;
  processing: number | null;
}

const EMPTY_COST_INPUTS: CostInputs = {
  cogs: null,
  shipping: null,
  fulfillment: null,
  processing: null,
};

function fromRatioToPct(value: number | null | undefined) {
  return value == null ? null : Math.round(value * 10_000) / 100;
}

function fromPctToRatio(value: number | null | undefined) {
  return value == null ? null : Math.max(0, Math.min(1, value / 100));
}

function costInputsFromSnapshot(snapshot: BusinessCommercialTruthSnapshot): CostInputs {
  const costStructure = snapshot.targetPack?.costStructure;
  if (!costStructure) return { ...EMPTY_COST_INPUTS };
  return {
    cogs: fromRatioToPct(costStructure.cogsPercent),
    shipping: fromRatioToPct(costStructure.shippingPercent),
    fulfillment: fromRatioToPct(costStructure.fulfillmentPercent),
    processing: fromRatioToPct(costStructure.paymentProcessingPercent),
  };
}

function hasAnyCostInput(costs: CostInputs) {
  return Object.values(costs).some((value) => value !== null);
}

function roundRatio(value: number) {
  return Math.round(value * 100) / 100;
}

function CostStructureSection({
  costs,
  onChange,
  totalCost,
  breakEven,
  disabled,
}: {
  costs: CostInputs;
  onChange: (k: keyof CostInputs, v: number | null) => void;
  totalCost: number;
  breakEven: number;
  disabled?: boolean;
}) {
  return (
    <CtSection
      eyebrow="Section 2"
      title="Cost Structure"
      subtitle="All inputs are manual. SKU-level cost data isn't reliable from APIs — your blended numbers are what we use."
      tooltip="These percentages are saved as Commercial Truth and used to derive break-even ROAS. They do not overwrite the separate Overview cost model."
    >
      <div className="grid grid-cols-2 gap-4">
        <CtField
          label="Blended COGS"
          helper="Average cost of goods as % of revenue, blended across your product mix."
          tooltip="Use the average product cost across the order mix. If individual SKU margins vary, enter the blended rate you want decisions to assume."
        >
          <CtNumberInput value={costs.cogs} onChange={(v) => onChange("cogs", v)} suffix="%" disabled={disabled} testId="commercial-cost-cogs" />
        </CtField>
        <CtField
          label="Shipping cost"
          helper="What you pay per shipment — not what the customer pays. Free-shipping stores still pay this."
          tooltip="Enter your actual outbound shipping cost as a share of revenue. This keeps ROAS targets from treating subsidized shipping as free margin."
        >
          <CtNumberInput value={costs.shipping} onChange={(v) => onChange("shipping", v)} suffix="%" disabled={disabled} testId="commercial-cost-shipping" />
        </CtField>
        <CtField
          label="Fulfillment cost"
          helper="Warehouse, 3PL, or pick-and-pack cost per order."
          tooltip="Include warehouse handling, 3PL, packaging, and pick-and-pack costs that scale with order volume."
        >
          <CtNumberInput value={costs.fulfillment} onChange={(v) => onChange("fulfillment", v)} suffix="%" disabled={disabled} testId="commercial-cost-fulfillment" />
        </CtField>
        <CtField
          label="Payment processing"
          helper="Credit card and gateway fees."
          tooltip="Add card, gateway, marketplace, or payment provider fees. This is a variable cost, so it directly affects break-even ROAS."
        >
          <CtNumberInput value={costs.processing} onChange={(v) => onChange("processing", v)} suffix="%" disabled={disabled} testId="commercial-cost-processing" />
        </CtField>
      </div>
      <div className="mt-5 grid gap-3" style={{ gridTemplateColumns: "1fr 1.4fr" }}>
        <CtStatCard
          label="Total variable cost"
          value={`${totalCost.toFixed(1)}%`}
          helper="Sum of the four cost inputs"
        />
        <CtStatCard
          dominant
          label="Break-even ROAS"
          value={isFinite(breakEven) ? `${breakEven.toFixed(2)}x` : "—"}
          helper="1 ÷ (1 − total variable cost). Below this, every dollar of ad spend loses money on variable costs alone."
        />
      </div>
    </CtSection>
  );
}

// ---------------------------------------------------------------------------
// Section 3: ROAS Scenario Guide
// ---------------------------------------------------------------------------

const DEFAULT_SPEND_LEVELS = [10000, 20000, 30000, 50000, 100000];

function fmtMoney(n: number) {
  if (!isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtPct(n: number) {
  return (n * 100).toFixed(1) + "%";
}

function RoasScenarioSection({
  targetRoas,
  costPct,
  breakEven,
}: {
  targetRoas: number;
  costPct: number;
  breakEven: number;
}) {
  const [spendLevels, setSpendLevels] = useState<number[]>(DEFAULT_SPEND_LEVELS);
  const [columnRoas, setColumnRoas] = useState<number[]>(DEFAULT_SPEND_LEVELS.map(() => targetRoas));

  const prevRoasRef = { current: targetRoas };
  useEffect(() => {
    setColumnRoas((rs) => rs.map((r) => (Math.abs(r - prevRoasRef.current) < 0.001 ? targetRoas : r)));
  }, [targetRoas]);

  useEffect(() => {
    setColumnRoas((rs) => {
      if (rs.length === spendLevels.length) return rs;
      const next = rs.slice(0, spendLevels.length);
      while (next.length < spendLevels.length) next.push(targetRoas);
      return next;
    });
  }, [spendLevels.length]);

  const resetRoas = () => setColumnRoas(spendLevels.map(() => targetRoas));

  const cols = spendLevels.map((spend, i) => {
    const roas = columnRoas[i] ?? targetRoas;
    const revenue = spend * roas;
    const variable = revenue * costPct;
    const grossProfit = revenue - variable;
    const netProfit = grossProfit - spend;
    const margin = revenue > 0 ? netProfit / revenue : 0;
    return { spend, roas, revenue, variable, grossProfit, netProfit, margin };
  });

  let bestIdx = -1;
  let bestProfit = -Infinity;
  cols.forEach((c, i) => {
    if (c.netProfit > bestProfit) { bestProfit = c.netProfit; bestIdx = i; }
  });

  const rows: { label: string; values: string[]; neg?: boolean[]; highlight?: boolean; muted?: boolean }[] = [
    { label: "Ad-attributed revenue", values: cols.map((c) => fmtMoney(c.revenue)) },
    { label: "Variable costs", values: cols.map((c) => fmtMoney(c.variable)) },
    { label: "Gross profit", values: cols.map((c) => fmtMoney(c.grossProfit)), neg: cols.map((c) => c.grossProfit < 0) },
    { label: "Ad spend", values: cols.map((c) => fmtMoney(c.spend)) },
    { label: "Net profit", values: cols.map((c) => fmtMoney(c.netProfit)), neg: cols.map((c) => c.netProfit < 0), highlight: true },
    { label: "Net margin", values: cols.map((c) => fmtPct(c.margin)), neg: cols.map((c) => c.netProfit < 0) },
  ];

  return (
    <CtSection
      eyebrow="Section 3"
      title="ROAS Scenario Guide"
      subtitle="Compare how spend × ROAS combinations stack up. Edit spend levels in the header and ROAS per column — the table recalculates live."
      action={<CtGhostBtn onClick={resetRoas}>Reset ROAS to {targetRoas.toFixed(2)}x</CtGhostBtn>}
    >
      <div className="overflow-hidden rounded-xl border border-slate-200">
        {/* Header row: spend inputs */}
        <div
          className="grid bg-slate-900 text-white"
          style={{ gridTemplateColumns: `200px repeat(${cols.length}, minmax(0, 1fr))` }}
        >
          <div className="px-4 py-3 text-[11px] font-bold uppercase tracking-[0.14em] text-white/70">
            Spend / month
          </div>
          {spendLevels.map((s, i) => (
            <div
              key={i}
              className={`flex items-center justify-end border-l border-white/10 p-2 ${i === bestIdx ? "bg-emerald-500/20" : ""}`}
            >
              <div className="flex h-8 items-center gap-0.5 rounded-lg bg-white/10 px-2.5 text-[13px] font-bold tabular-nums text-white">
                <span>$</span>
                <input
                  type="number"
                  step={1000}
                  min={0}
                  value={s}
                  onChange={(e) => {
                    const next = spendLevels.slice();
                    next[i] = parseFloat(e.target.value) || 0;
                    setSpendLevels(next);
                  }}
                  className="w-20 bg-transparent text-right outline-none"
                />
              </div>
            </div>
          ))}
        </div>

        {/* ROAS row: editable per column */}
        <div
          className="grid border-b border-slate-200 bg-amber-50"
          style={{ gridTemplateColumns: `200px repeat(${cols.length}, minmax(0, 1fr))` }}
        >
          <div className="flex flex-col justify-center px-4 py-2.5">
            <p className="text-[12px] font-bold text-amber-800">Target ROAS</p>
            <p className="text-[10.5px] text-amber-700">edit per column</p>
          </div>
          {columnRoas.map((r, i) => {
            const belowBE = r > 0 && r < breakEven;
            return (
              <div key={i} className="flex items-center justify-end border-l border-amber-200/60 p-2">
                <div
                  className={`flex h-8 items-center gap-0.5 rounded-lg px-2.5 text-[13px] font-bold tabular-nums ${
                    i === bestIdx
                      ? "bg-emerald-500 text-white"
                      : belowBE
                        ? "border border-rose-400 bg-rose-50 text-rose-800"
                        : "border border-amber-200 bg-amber-100/60 text-amber-900"
                  }`}
                >
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    value={r}
                    onChange={(e) => {
                      const next = columnRoas.slice();
                      next[i] = parseFloat(e.target.value) || 0;
                      setColumnRoas(next);
                    }}
                    className="w-14 bg-transparent text-right outline-none"
                  />
                  <span>x</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Body rows */}
        {rows.map((r, ri) => (
          <div
            key={ri}
            className={`grid border-t border-slate-100 ${r.highlight ? "bg-slate-900" : ri % 2 === 0 ? "bg-white" : "bg-slate-50/60"}`}
            style={{ gridTemplateColumns: `200px repeat(${cols.length}, minmax(0, 1fr))` }}
          >
            <div
              className={`px-4 py-3 text-[12.5px] ${r.highlight ? "font-bold text-white" : r.muted ? "text-slate-500" : "font-medium text-slate-900"}`}
            >
              {r.label}
            </div>
            {r.values.map((v, j) => {
              const isNeg = r.neg?.[j] ?? false;
              const isBest = j === bestIdx;
              return (
                <div
                  key={j}
                  className={`border-l px-3.5 py-3 text-right text-[13px] tabular-nums ${
                    r.highlight
                      ? `border-white/10 font-bold ${isNeg ? "text-rose-300" : "text-white"} ${isBest ? "bg-emerald-500/18" : ""}`
                      : `border-slate-100 ${isNeg ? "bg-rose-50 text-rose-700 font-medium" : isBest && !r.muted ? "bg-emerald-50 font-semibold text-slate-900" : r.muted ? "text-slate-500" : "text-slate-900"}`
                  }`}
                >
                  {v}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </CtSection>
  );
}

// ---------------------------------------------------------------------------
// Section 4: Target ROAS
// ---------------------------------------------------------------------------

function TargetRoasSection({
  targetRoas,
  onChange,
  breakEven,
  manualBreakEven,
  onManualBreakEvenChange,
  costStructureActive,
  disabled,
}: {
  targetRoas: number | null | undefined;
  onChange: (v: number | null) => void;
  breakEven: number;
  manualBreakEven: number | null | undefined;
  onManualBreakEvenChange: (v: number | null) => void;
  costStructureActive: boolean;
  disabled?: boolean;
}) {
  const val = targetRoas ?? 0;
  const ratio = isFinite(breakEven) && breakEven > 0 ? val / breakEven : 0;

  let statusBg: string, statusBorder: string, statusDot: string, statusText: string, statusMsg: string;
  if (!val || val <= 0) {
    statusBg = "bg-slate-50"; statusBorder = "border-slate-200"; statusDot = "bg-slate-400"; statusText = "text-slate-500";
    statusMsg = "Set a target above zero.";
  } else if (isFinite(breakEven) && val < breakEven) {
    statusBg = "bg-rose-50"; statusBorder = "border-rose-200"; statusDot = "bg-rose-500"; statusText = "text-rose-700";
    statusMsg = "Below break-even — this target loses money on variable costs alone.";
  } else if (ratio < 1.2) {
    statusBg = "bg-amber-50"; statusBorder = "border-amber-200"; statusDot = "bg-amber-400"; statusText = "text-amber-700";
    statusMsg = "Close to break-even — limited buffer for volatility or returns.";
  } else {
    const above = (val - breakEven).toFixed(2);
    statusBg = "bg-emerald-50"; statusBorder = "border-emerald-200"; statusDot = "bg-emerald-500"; statusText = "text-emerald-700";
    statusMsg = `${above}x above break-even — healthy margin buffer.`;
  }

  return (
    <CtSection
      eyebrow="Section 4"
      title="Target ROAS"
      subtitle="The single performance target the engine compares every campaign against."
      tooltip="Target ROAS is persisted to the Commercial Truth target pack and is read by Creative and Meta decision engines as the primary efficiency threshold."
    >
      <div className="grid items-center gap-6" style={{ gridTemplateColumns: "minmax(240px, 360px) 1fr" }}>
        <div className="flex flex-col gap-3">
          <div className="flex h-14 items-center gap-1.5 rounded-[10px] border border-slate-200 bg-white px-4">
            <input
              type="number"
              step={0.1}
              min={0}
              value={val || ""}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
              data-testid="commercial-target-roas"
              className="min-w-0 flex-1 bg-transparent text-[28px] font-bold tabular-nums tracking-[-0.02em] text-slate-900 outline-none disabled:opacity-60"
            />
            <span className="text-[18px] text-slate-500">x</span>
          </div>
          <div className={`flex items-center gap-2 rounded-[10px] border px-3 py-2.5 ${statusBg} ${statusBorder}`}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
            <p className={`text-[12.5px] font-semibold leading-snug ${statusText}`}>{statusMsg}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500">Break-even ROAS</p>
            <p className="text-[22px] font-bold tabular-nums tracking-[-0.02em] text-slate-900">
              {isFinite(breakEven) && breakEven > 0 ? `${breakEven.toFixed(2)}x` : "—"}
            </p>
            <p className="text-[11.5px] text-slate-500">Derived from your cost structure</p>
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500">Break-even ROAS (manual)</p>
              <CtTooltip content="Use this only when cost structure is unavailable. Once cost structure is filled, derived break-even ROAS becomes the source of truth." />
            </div>
            <CtNumberInput
              value={costStructureActive ? breakEven : manualBreakEven}
              onChange={onManualBreakEvenChange}
              suffix="x"
              disabled={disabled || costStructureActive}
              testId="commercial-break-even-roas"
            />
            <p className="text-[11.5px] text-slate-500">
              {costStructureActive
                ? "Cost structure is filled, so derived break-even will be saved."
                : "Override if cost inputs are unavailable."}
            </p>
          </div>
        </div>
      </div>
    </CtSection>
  );
}

// ---------------------------------------------------------------------------
// Section 5: Country Economics
// ---------------------------------------------------------------------------

const COUNTRY_OPTIONS = [
  { value: "", label: "Select country" },
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
  { value: "GB", label: "United Kingdom" },
  { value: "AU", label: "Australia" },
  { value: "DE", label: "Germany" },
  { value: "FR", label: "France" },
  { value: "NL", label: "Netherlands" },
  { value: "SE", label: "Sweden" },
  { value: "NO", label: "Norway" },
  { value: "TR", label: "Turkey" },
];

function CountryEconomicsSection({
  rows,
  onAdd,
  onUpdate,
  onRemove,
  disabled,
}: {
  rows: BusinessCommercialTruthSnapshot["countryEconomics"];
  onAdd: () => void;
  onUpdate: (i: number, field: string, value: unknown) => void;
  onRemove: (i: number) => void;
  disabled?: boolean;
}) {
  return (
    <CtSection
      eyebrow="Section 5"
      title="Country Economics"
      subtitle="Optional. Override the global cost structure for specific countries when shipping or COGS materially differ."
      tooltip="Leave this empty when every country should use the same global cost structure. Add rows only for locations with materially different costs, margins, or serviceability."
      action={<CtGhostBtn onClick={onAdd} disabled={disabled} testId="commercial-add-country">+ Add country</CtGhostBtn>}
    >
      {rows.length === 0 ? (
        <CtEmptyState message="Country Economics is not filled in. Adsecute will evaluate every location with the same global cost structure." />
      ) : (
        <div className="flex flex-col gap-2">
          <div
            className="grid px-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-400"
            style={{ gridTemplateColumns: "1.4fr 1fr 1fr 1.6fr 36px" }}
          >
            <span>Country</span>
            <span className="flex items-center gap-1.5">
              Economics multiplier
              <CtTooltip content="Multiplier for country-level economics. Above 1 means this country needs stronger economics to scale; below 1 means economics are easier than the global baseline." />
            </span>
            <span className="flex items-center gap-1.5">
              Margin modifier
              <CtTooltip content="Adjustment to margin for this country when shipping, duties, returns, or local pricing materially changes profitability." />
            </span>
            <span>Notes</span>
            <span />
          </div>
          {rows.map((r, i) => (
            <div
              key={`${r.countryCode || "row"}-${i}`}
              className="grid items-center gap-2.5"
              style={{ gridTemplateColumns: "1.4fr 1fr 1fr 1.6fr 36px" }}
            >
              <CtSelect
                value={r.countryCode}
                onChange={(v) => onUpdate(i, "countryCode", v.toUpperCase())}
                options={COUNTRY_OPTIONS}
                disabled={disabled}
                testId={`commercial-country-code-${i}`}
              />
              <CtNumberInput
                value={r.economicsMultiplier}
                onChange={(v) => onUpdate(i, "economicsMultiplier", v)}
                disabled={disabled}
                testId={`commercial-economics-multiplier-${i}`}
              />
              <CtNumberInput
                value={r.marginModifier}
                onChange={(v) => onUpdate(i, "marginModifier", v)}
                disabled={disabled}
                testId={`commercial-margin-modifier-${i}`}
              />
              <CtTextInput
                value={r.notes ?? ""}
                onChange={(v) => onUpdate(i, "notes", v || null)}
                placeholder="Why this override?"
                disabled={disabled}
                testId={`commercial-country-notes-${i}`}
              />
              <CtIconCircleBtn onClick={() => onRemove(i)} disabled={disabled} testId={`commercial-remove-country-${i}`}>
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M2 2L9 9M9 2L2 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </CtIconCircleBtn>
            </div>
          ))}
        </div>
      )}
    </CtSection>
  );
}

// ---------------------------------------------------------------------------
// Section 6: Promo Calendar
// ---------------------------------------------------------------------------

function PromoCalendarSection({
  rows,
  onAdd,
  onUpdate,
  onRemove,
  disabled,
}: {
  rows: BusinessCommercialTruthSnapshot["promoCalendar"];
  onAdd: () => void;
  onUpdate: (i: number, field: string, value: unknown) => void;
  onRemove: (i: number) => void;
  disabled?: boolean;
}) {
  return (
    <CtSection
      eyebrow="Section 6"
      title="Promo Calendar"
      subtitle="Optional. Tell the engine when revenue is lifted by a promotion so scaling decisions don't read promo lift as creative strength."
      action={<CtGhostBtn onClick={onAdd} disabled={disabled}>+ Add promo window</CtGhostBtn>}
    >
      {rows.length === 0 ? (
        <CtEmptyState message="No promo windows yet. Operating mode will still match — just without promo-aware scaling caps." />
      ) : (
        <div className="flex flex-col gap-2">
          <div
            className="grid px-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-400"
            style={{ gridTemplateColumns: "1.6fr 1fr 1fr 1fr 36px" }}
          >
            <span>Name</span>
            <span>Start</span>
            <span>End</span>
            <span>Severity</span>
            <span />
          </div>
          {rows.map((r, i) => (
            <div
              key={r.eventId}
              className="grid items-center gap-2.5"
              style={{ gridTemplateColumns: "1.6fr 1fr 1fr 1fr 36px" }}
            >
              <CtTextInput
                value={r.title}
                onChange={(v) => onUpdate(i, "title", v)}
                placeholder="e.g. Spring Sale"
                disabled={disabled}
              />
              <input
                type="date"
                value={r.startDate}
                onChange={(e) => onUpdate(i, "startDate", e.target.value)}
                disabled={disabled}
                className="h-10 w-full rounded-[10px] border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-900 outline-none disabled:opacity-60"
              />
              <input
                type="date"
                value={r.endDate}
                onChange={(e) => onUpdate(i, "endDate", e.target.value)}
                disabled={disabled}
                className="h-10 w-full rounded-[10px] border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-900 outline-none disabled:opacity-60"
              />
              <CtSelect
                value={r.severity}
                onChange={(v) => onUpdate(i, "severity", v)}
                options={BUSINESS_PROMO_SEVERITIES.map((s) => ({ value: s, label: s }))}
                disabled={disabled}
              />
              <CtIconCircleBtn onClick={() => onRemove(i)} disabled={disabled}>
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M2 2L9 9M9 2L2 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </CtIconCircleBtn>
            </div>
          ))}
        </div>
      )}
    </CtSection>
  );
}

// ---------------------------------------------------------------------------
// Section 7: Site Health & Stock Pressure
// ---------------------------------------------------------------------------

function SiteHealthSection({
  constraints,
  onUpdate,
  disabled,
}: {
  constraints: NonNullable<BusinessCommercialTruthSnapshot["operatingConstraints"]>;
  onUpdate: (field: string, value: unknown) => void;
  disabled?: boolean;
}) {
  const issueOpts = BUSINESS_ISSUE_STATUSES.map((s) => ({ value: s, label: s }));
  const stockOpts = BUSINESS_STOCK_PRESSURE_STATUSES.map((s) => ({ value: s, label: s }));

  return (
    <CtSection
      eyebrow="Section 7"
      title="Site Health &amp; Stock Pressure"
      subtitle="Operational blockers that should hold scaling decisions until cleared."
      tooltip="These guardrails tell the decision engine when performance should not be scaled because fulfillment, tracking, checkout, feed, or inventory conditions are unreliable."
    >
      <div className="grid grid-cols-2 gap-4">
        <CtField label="Site issue" tooltip="Use watch or critical when site speed, uptime, product pages, or landing pages could distort conversion performance.">
          <CtSelect value={constraints.siteIssueStatus} onChange={(v) => onUpdate("siteIssueStatus", v)} options={issueOpts} disabled={disabled} />
        </CtField>
        <CtField label="Checkout issue" tooltip="Mark checkout issues when payment, shipping, discount, or checkout UX problems can suppress purchases independently of ad quality.">
          <CtSelect value={constraints.checkoutIssueStatus} onChange={(v) => onUpdate("checkoutIssueStatus", v)} options={issueOpts} disabled={disabled} />
        </CtField>
        <CtField label="Conversion tracking" tooltip="Use this when pixel/CAPI/event attribution is unreliable. Bad tracking should cap decision confidence even if ads appear strong or weak.">
          <CtSelect value={constraints.conversionTrackingIssueStatus} onChange={(v) => onUpdate("conversionTrackingIssueStatus", v)} options={issueOpts} disabled={disabled} />
        </CtField>
        <CtField label="Feed issue" tooltip="Use this for catalog, product availability, price, image, or feed sync issues that can affect campaign delivery and conversion quality.">
          <CtSelect value={constraints.feedIssueStatus} onChange={(v) => onUpdate("feedIssueStatus", v)} options={issueOpts} disabled={disabled} />
        </CtField>
        <CtField label="Stock pressure" tooltip="Set watch when inventory is tight and blocked when scale should stop until stock recovers. This prevents profitable-looking demand from creating fulfillment risk.">
          <CtSelect
            value={constraints.stockPressureStatus}
            onChange={(v) => onUpdate("stockPressureStatus", v)}
            options={stockOpts}
            disabled={disabled}
            testId="commercial-stock-pressure"
          />
        </CtField>
        <CtField label="Manual do-not-scale reason" tooltip="A human override that explains why scale actions should stay blocked even when metrics look eligible.">
          <CtTextInput
            value={constraints.manualDoNotScaleReason ?? ""}
            onChange={(v) => onUpdate("manualDoNotScaleReason", v || null)}
            placeholder="Optional override note"
            disabled={disabled}
          />
        </CtField>
      </div>
    </CtSection>
  );
}

// ---------------------------------------------------------------------------
// Section 8: Decision Calibration
// ---------------------------------------------------------------------------

const CALIBRATION_CARDS = [
  { id: "conservative" as const, title: "Conservative", desc: "Tight ceilings, hold-on-no-data. Best for new accounts or volatile periods." },
  { id: "balanced" as const, title: "Balanced", desc: "Default. Step-ups at 20% with weekly review cadence." },
  { id: "aggressive" as const, title: "Aggressive", desc: "Faster ceilings, larger increments. Mature accounts with stable signal only." },
];

const ACTION_CEILING_OPTIONS = [
  { value: "", label: "No ceiling" },
  { value: "review_hold", label: "Review hold" },
  { value: "review_reduce", label: "Review reduce" },
  { value: "monitor_low_truth", label: "Monitor low truth" },
  { value: "degraded_no_scale", label: "Degraded no scale" },
];

function CalibrationSection({
  riskPosture,
  onRiskPostureChange,
  profiles,
  onAddProfile,
  onUpdateProfile,
  onRemoveProfile,
  disabled,
}: {
  riskPosture: string;
  onRiskPostureChange: (v: string) => void;
  profiles: BusinessDecisionCalibrationProfile[];
  onAddProfile: () => void;
  onUpdateProfile: (
    index: number,
    field: keyof BusinessDecisionCalibrationProfile,
    value: unknown,
  ) => void;
  onRemoveProfile: (index: number) => void;
  disabled?: boolean;
}) {
  return (
    <CtSection
      eyebrow="Section 8"
      title="Decision Calibration"
      subtitle="How aggressive the engine is with scale-up actions before live feedback exists."
      tooltip="Risk posture sets the default operating stance. Calibration profiles add channel/objective/bid-regime multipliers and ceilings when a decision matches that profile."
    >
      <div className="grid grid-cols-3 gap-3">
        {CALIBRATION_CARDS.map((o) => {
          const active = riskPosture === o.id;
          return (
            <button
              key={o.id}
              type="button"
              disabled={disabled}
              onClick={() => onRiskPostureChange(o.id)}
              data-testid={`commercial-risk-posture-${o.id}`}
              aria-pressed={active}
              className={`flex flex-col gap-1.5 rounded-xl border p-4 text-left transition-colors ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-semibold">{o.title}</span>
                {active && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M3 7.5l2.5 2.5L11 4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <span className={`text-[12px] leading-snug ${active ? "text-white/70" : "text-slate-500"}`}>
                {o.desc}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-5 flex items-center justify-between gap-4 border-t border-slate-100 pt-5">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <p className="text-[13px] font-bold text-slate-900">Calibration profiles</p>
            <CtTooltip content="Use profiles to tune ROAS/CPA thresholds and confidence/action ceilings for a specific channel, objective family, bid regime, and decision archetype." />
          </div>
          <p className="text-[12px] text-slate-500">
            Optional. Profiles are matched by channel + objective + bid regime + archetype.
          </p>
        </div>
        <CtGhostBtn onClick={onAddProfile} disabled={disabled} testId="commercial-add-calibration-profile">
          + Add profile
        </CtGhostBtn>
      </div>

      {profiles.length === 0 ? (
        <div className="mt-3">
          <CtEmptyState message="No calibration profiles yet. The default risk posture is saved and generic thresholds remain in use." />
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {profiles.map((profile, index) => (
            <div key={`${profile.channel}-${profile.objectiveFamily}-${profile.bidRegime}-${profile.archetype}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr 36px" }}>
                <CtField label="Channel" tooltip="The decision surface this calibration applies to. Creative profiles affect creative decision hints; Meta profiles affect Meta decision hints.">
                  <CtSelect
                    value={profile.channel}
                    onChange={(v) => onUpdateProfile(index, "channel", v)}
                    options={BUSINESS_DECISION_CALIBRATION_CHANNELS.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
                    disabled={disabled}
                    testId={`commercial-calibration-channel-${index}`}
                  />
                </CtField>
                <CtField label="Objective" tooltip="Match the campaign/ad set objective family so sales, lead, traffic, and awareness logic can be tuned separately.">
                  <CtSelect
                    value={profile.objectiveFamily}
                    onChange={(v) => onUpdateProfile(index, "objectiveFamily", v)}
                    options={BUSINESS_DECISION_OBJECTIVE_FAMILIES.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
                    disabled={disabled}
                    testId={`commercial-calibration-objective-${index}`}
                  />
                </CtField>
                <CtField label="Bid regime" tooltip="Match the bidding mode. ROAS-floor, cost-cap, bid-cap, and open bidding can need different threshold multipliers.">
                  <CtSelect
                    value={profile.bidRegime}
                    onChange={(v) => onUpdateProfile(index, "bidRegime", v)}
                    options={BUSINESS_DECISION_BID_REGIMES.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
                    disabled={disabled}
                    testId={`commercial-calibration-bid-regime-${index}`}
                  />
                </CtField>
                <CtField label="Archetype" tooltip="The policy archetype or primary driver this profile matches, for example winner_scale or fatigue_refresh.">
                  <CtTextInput
                    value={profile.archetype}
                    onChange={(v) => onUpdateProfile(index, "archetype", v)}
                    disabled={disabled}
                    testId={`commercial-calibration-archetype-${index}`}
                  />
                </CtField>
                <div className="pt-7">
                  <CtIconCircleBtn onClick={() => onRemoveProfile(index)} disabled={disabled} testId={`commercial-remove-calibration-profile-${index}`}>
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                      <path d="M2 2L9 9M9 2L2 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </CtIconCircleBtn>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-5 gap-3">
                <CtField label="Target ROAS ×" tooltip="Multiplier applied to the target ROAS threshold for this matched profile. Values above 1 are stricter; below 1 are looser.">
                  <CtNumberInput value={profile.targetRoasMultiplier} onChange={(v) => onUpdateProfile(index, "targetRoasMultiplier", v)} disabled={disabled} testId={`commercial-calibration-target-roas-multiplier-${index}`} />
                </CtField>
                <CtField label="Break-even ROAS ×" tooltip="Multiplier applied to break-even ROAS for this profile. Use cautiously because it changes loss-protection sensitivity.">
                  <CtNumberInput value={profile.breakEvenRoasMultiplier} onChange={(v) => onUpdateProfile(index, "breakEvenRoasMultiplier", v)} disabled={disabled} testId={`commercial-calibration-break-even-roas-multiplier-${index}`} />
                </CtField>
                <CtField label="Target CPA ×" tooltip="Multiplier applied to target CPA. Values below 1 are stricter; above 1 are more permissive.">
                  <CtNumberInput value={profile.targetCpaMultiplier} onChange={(v) => onUpdateProfile(index, "targetCpaMultiplier", v)} disabled={disabled} testId={`commercial-calibration-target-cpa-multiplier-${index}`} />
                </CtField>
                <CtField label="Break-even CPA ×" tooltip="Multiplier applied to break-even CPA for loss-protection checks.">
                  <CtNumberInput value={profile.breakEvenCpaMultiplier} onChange={(v) => onUpdateProfile(index, "breakEvenCpaMultiplier", v)} disabled={disabled} testId={`commercial-calibration-break-even-cpa-multiplier-${index}`} />
                </CtField>
                <CtField label="Confidence cap" tooltip="Optional cap from 0 to 1. Example: 0.75 means matched decisions cannot exceed 75% confidence.">
                  <CtNumberInput value={profile.confidenceCap} onChange={(v) => onUpdateProfile(index, "confidenceCap", v)} disabled={disabled} testId={`commercial-calibration-confidence-cap-${index}`} />
                </CtField>
              </div>

              <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: "220px 1fr" }}>
                <CtField label="Action ceiling" tooltip="Optional safe-action ceiling for matched decisions. Use it when a channel/profile should stay review-only even if metrics look strong.">
                  <CtSelect
                    value={profile.actionCeiling ?? ""}
                    onChange={(v) => onUpdateProfile(index, "actionCeiling", v || null)}
                    options={ACTION_CEILING_OPTIONS}
                    disabled={disabled}
                    testId={`commercial-calibration-action-ceiling-${index}`}
                  />
                </CtField>
                <CtField label="Notes" tooltip="Short operator note explaining why this calibration exists and when it should be revisited.">
                  <CtTextInput
                    value={profile.notes ?? ""}
                    onChange={(v) => onUpdateProfile(index, "notes", v || null)}
                    disabled={disabled}
                    testId={`commercial-calibration-notes-${index}`}
                  />
                </CtField>
              </div>
            </div>
          ))}
        </div>
      )}
    </CtSection>
  );
}

// ---------------------------------------------------------------------------
// Sticky save bar
// ---------------------------------------------------------------------------

function StickySaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  disabled,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="sticky bottom-0 z-10 mt-7 flex items-center justify-between gap-4 border-t border-slate-200 bg-white/92 px-6 py-3.5 backdrop-blur-sm">
      <div className="flex items-center gap-2.5">
        <span className={`h-2 w-2 rounded-full ${dirty ? "bg-amber-400" : "bg-emerald-500"}`} />
        <span className="text-[12.5px] text-slate-500">
          {dirty ? "Unsaved changes" : "All changes saved"}
        </span>
      </div>
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={onDiscard}
          disabled={!dirty || disabled}
          className="h-9 rounded-[10px] border border-slate-200 bg-white px-3.5 text-[13px] font-medium text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={disabled || saving}
          data-testid="commercial-settings-save"
          className="h-9 rounded-[10px] border border-slate-900 bg-slate-900 px-4 text-[13px] font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving..." : "Save Commercial Truth"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CommercialTruthSettingsSection({ businessId }: { businessId: string }) {
  const [snapshot, setSnapshot] = useState<BusinessCommercialTruthSnapshot>(
    createEmptyBusinessCommercialTruthSnapshot(businessId),
  );
  const [permissions, setPermissions] = useState<CommercialTruthSettingsResponse["permissions"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const [costs, setCostsState] = useState<CostInputs>({ ...EMPTY_COST_INPUTS });
  const setCost = (k: keyof CostInputs, v: number | null) => {
    setCostsState((s) => ({ ...s, [k]: v }));
    setDirty(true);
  };

  const costStructureActive = hasAnyCostInput(costs);
  const totalCost =
    (costs.cogs ?? 0) +
    (costs.shipping ?? 0) +
    (costs.fulfillment ?? 0) +
    (costs.processing ?? 0);
  const totalCostPct = totalCost / 100;
  const computedBreakEven =
    costStructureActive && totalCostPct < 1 ? 1 / (1 - totalCostPct) : Infinity;

  const canEdit = permissions?.canEdit ?? false;
  const effectiveDisabled = !canEdit || loading;

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/business-commercial-settings?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as CommercialTruthSettingsResponse | null;
      if (!response.ok || !payload?.snapshot || !payload.permissions) {
        throw new Error("Could not load commercial truth settings.");
      }
      setSnapshot(payload.snapshot);
      setCostsState(costInputsFromSnapshot(payload.snapshot));
      setPermissions(payload.permissions);
      setDirty(false);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : "Could not load commercial truth settings.");
      const emptySnapshot = createEmptyBusinessCommercialTruthSnapshot(businessId);
      setSnapshot(emptySnapshot);
      setCostsState(costInputsFromSnapshot(emptySnapshot));
      setPermissions(null);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    const emptySnapshot = createEmptyBusinessCommercialTruthSnapshot(businessId);
    setSnapshot(emptySnapshot);
    setCostsState(costInputsFromSnapshot(emptySnapshot));
    setPermissions(null);
    void loadSnapshot();
  }, [businessId, loadSnapshot]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setNotice(null);
    const costStructure = costStructureActive
      ? {
          cogsPercent: fromPctToRatio(costs.cogs),
          shippingPercent: fromPctToRatio(costs.shipping),
          fulfillmentPercent: fromPctToRatio(costs.fulfillment),
          paymentProcessingPercent: fromPctToRatio(costs.processing),
        }
      : null;
    const breakEvenRoas =
      costStructureActive && isFinite(computedBreakEven)
        ? roundRatio(computedBreakEven)
        : (snapshot.targetPack?.breakEvenRoas ?? null);
    const snapshotToSave: BusinessCommercialTruthSnapshot = {
      ...snapshot,
      targetPack: {
        ...(snapshot.targetPack ?? createEmptyTargetPack()),
        breakEvenRoas,
        costStructure,
      },
    };
    try {
      const response = await fetch("/api/business-commercial-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, snapshot: snapshotToSave }),
      });
      const payload = (await response.json().catch(() => null)) as CommercialTruthSettingsResponse | null;
      if (!response.ok || !payload?.snapshot || !payload.permissions) {
        throw new Error((payload as { message?: string } | null)?.message ?? "Could not save commercial truth settings.");
      }
      setSnapshot(payload.snapshot);
      setCostsState(costInputsFromSnapshot(payload.snapshot));
      setPermissions(payload.permissions);
      setNotice("Commercial truth settings updated.");
      setDirty(false);
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : "Could not save commercial truth settings.");
    } finally {
      setSaving(false);
    }
  }

  const updateTargetPack = useCallback(
    (field: keyof NonNullable<BusinessCommercialTruthSnapshot["targetPack"]>, value: unknown) => {
      setSnapshot((current) => ({
        ...current,
        targetPack: { ...(current.targetPack ?? createEmptyTargetPack()), [field]: value },
      }));
      setDirty(true);
    },
    [],
  );

  const updateCountry = useCallback(
    (index: number, field: string, value: unknown) => {
      setSnapshot((current) => ({
        ...current,
        countryEconomics: current.countryEconomics.map((row, i) =>
          i === index ? { ...row, [field]: value } : row,
        ),
      }));
      setDirty(true);
    },
    [],
  );

  const updatePromo = useCallback(
    (index: number, field: string, value: unknown) => {
      setSnapshot((current) => ({
        ...current,
        promoCalendar: current.promoCalendar.map((row, i) =>
          i === index ? { ...row, [field]: value } : row,
        ),
      }));
      setDirty(true);
    },
    [],
  );

  const updateConstraints = useCallback(
    (field: string, value: unknown) => {
      setSnapshot((current) => ({
        ...current,
        operatingConstraints: {
          ...(current.operatingConstraints ?? createEmptyOperatingConstraints()),
          [field]: value,
        },
      }));
      setDirty(true);
    },
    [],
  );

  const addCalibrationProfile = useCallback(() => {
    setSnapshot((current) => ({
      ...current,
      calibrationProfiles: [
        ...(current.calibrationProfiles ?? []),
        createEmptyDecisionCalibrationProfile(),
      ],
    }));
    setDirty(true);
  }, []);

  const updateCalibrationProfile = useCallback(
    (
      index: number,
      field: keyof BusinessDecisionCalibrationProfile,
      value: unknown,
    ) => {
      setSnapshot((current) => ({
        ...current,
        calibrationProfiles: (current.calibrationProfiles ?? []).map((profile, i) =>
          i === index ? { ...profile, [field]: value } : profile,
        ),
      }));
      setDirty(true);
    },
    [],
  );

  const removeCalibrationProfile = useCallback((index: number) => {
    setSnapshot((current) => ({
      ...current,
      calibrationProfiles: (current.calibrationProfiles ?? []).filter((_, i) => i !== index),
    }));
    setDirty(true);
  }, []);

  const targetPack = snapshot.targetPack ?? createEmptyTargetPack();
  const operatingConstraints = snapshot.operatingConstraints ?? createEmptyOperatingConstraints();

  const countryRows = useMemo(() => snapshot.countryEconomics, [snapshot.countryEconomics]);
  const promoRows = useMemo(() => snapshot.promoCalendar, [snapshot.promoCalendar]);

  const displayBreakEven = costStructureActive && isFinite(computedBreakEven)
    ? roundRatio(computedBreakEven)
    : (targetPack.breakEvenRoas ?? 0);

  return (
    <div className="flex flex-col gap-4" data-testid="commercial-truth-settings">
      {/* Status banners */}
      {!loading && permissions?.reason ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {permissions.reason}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      {loading ? (
        <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-6">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
          <p className="text-[13px] text-slate-500">Loading commercial truth settings…</p>
        </div>
      ) : null}

      <DecisionCoverageSection snapshot={snapshot} />

      <CostStructureSection
        costs={costs}
        onChange={setCost}
        totalCost={totalCost}
        breakEven={computedBreakEven}
        disabled={effectiveDisabled}
      />

      <RoasScenarioSection
        targetRoas={targetPack.targetRoas ?? 3.5}
        costPct={totalCostPct}
        breakEven={displayBreakEven}
      />

      <TargetRoasSection
        targetRoas={targetPack.targetRoas}
        onChange={(v) => updateTargetPack("targetRoas", v)}
        breakEven={displayBreakEven}
        manualBreakEven={targetPack.breakEvenRoas}
        onManualBreakEvenChange={(v) => updateTargetPack("breakEvenRoas", v)}
        costStructureActive={costStructureActive}
        disabled={effectiveDisabled}
      />

      <CountryEconomicsSection
        rows={countryRows}
        onAdd={() => {
          setSnapshot((current) => ({
            ...current,
            countryEconomics: [...current.countryEconomics, createEmptyCountryEconomicsRow()],
          }));
          setDirty(true);
        }}
        onUpdate={updateCountry}
        onRemove={(i) => {
          setSnapshot((current) => ({
            ...current,
            countryEconomics: current.countryEconomics.filter((_, idx) => idx !== i),
          }));
          setDirty(true);
        }}
        disabled={effectiveDisabled}
      />

      <PromoCalendarSection
        rows={promoRows}
        onAdd={() => {
          setSnapshot((current) => ({
            ...current,
            promoCalendar: [...current.promoCalendar, createEmptyPromoCalendarEvent()],
          }));
          setDirty(true);
        }}
        onUpdate={updatePromo}
        onRemove={(i) => {
          setSnapshot((current) => ({
            ...current,
            promoCalendar: current.promoCalendar.filter((_, idx) => idx !== i),
          }));
          setDirty(true);
        }}
        disabled={effectiveDisabled}
      />

      <SiteHealthSection
        constraints={operatingConstraints}
        onUpdate={updateConstraints}
        disabled={effectiveDisabled}
      />

      <CalibrationSection
        riskPosture={targetPack.defaultRiskPosture}
        onRiskPostureChange={(v) => updateTargetPack("defaultRiskPosture", v)}
        profiles={snapshot.calibrationProfiles ?? []}
        onAddProfile={addCalibrationProfile}
        onUpdateProfile={updateCalibrationProfile}
        onRemoveProfile={removeCalibrationProfile}
        disabled={effectiveDisabled}
      />

      <StickySaveBar
        dirty={dirty}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={() => {
          void loadSnapshot();
        }}
        disabled={effectiveDisabled || saving}
      />
    </div>
  );
}
