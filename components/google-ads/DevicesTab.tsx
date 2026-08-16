"use client";

import { cn } from "@/lib/utils";
import { fmtCurrency, fmtNumber, fmtRoas, TabSkeleton, TabEmpty, SimpleTable, ColDef } from "./shared";

interface DeviceRow {
  device: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  revenue: number;
  roas: number;
  cpa: number;
  ctr: number;
  convRate?: number;
  conversionRate?: number;
}

const DEVICE_ICON: Record<string, string> = {
  Mobile: "📱", Desktop: "🖥", Tablet: "📲", "Connected TV": "📺",
};

const cols: ColDef<DeviceRow>[] = [
  {
    key: "device", header: "Device", accessor: (r) => r.device,
    render: (r) => (
      <span className="flex items-center gap-1.5 text-xs font-medium">
        {DEVICE_ICON[r.device] ?? ""}
        {r.device}
      </span>
    ),
  },
  { key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right", render: (r) => fmtCurrency(r.spend) },
  { key: "conversions", header: "Conv.", accessor: (r) => r.conversions, align: "right", render: (r) => fmtNumber(r.conversions) },
  {
    key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right",
    render: (r) => (
      <span className={cn(r.roas >= 3 ? "text-[var(--adc-pos-fg)] dark:text-[var(--adc-pos-fg)] font-semibold" : r.roas < 1 ? "text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)]" : "")}>
        {r.roas === 0 ? "—" : fmtRoas(r.roas)}
      </span>
    ),
  },
  { key: "cpa", header: "CPA", accessor: (r) => r.cpa === 0 ? 99999 : r.cpa, align: "right", render: (r) => r.conversions === 0 ? "—" : fmtCurrency(r.cpa) },
  { key: "ctr", header: "CTR", accessor: (r) => r.ctr, align: "right", render: (r) => `${r.ctr.toFixed(1)}%` },
  {
    key: "convRate",
    header: "Conv. Rate",
    accessor: (r) => r.conversionRate ?? r.convRate ?? 0,
    align: "right",
    render: (r) => `${(r.conversionRate ?? r.convRate ?? 0).toFixed(1)}%`,
  },
  { key: "impressions", header: "Impr.", accessor: (r) => r.impressions, align: "right", render: (r) => fmtNumber(r.impressions) },
  { key: "clicks", header: "Clicks", accessor: (r) => r.clicks, align: "right", render: (r) => fmtNumber(r.clicks) },
];

interface DevicesTabProps {
  devices?: DeviceRow[];
  insights?: string[];
  isLoading: boolean;
}

export function DevicesTab({ devices, insights, isLoading }: DevicesTabProps) {
  if (isLoading) return <TabSkeleton rows={4} />;
  if (!devices || devices.length === 0) {
    return <TabEmpty message="No device performance data found." />;
  }

  return (
    <div className="space-y-4">
      {insights && insights.length > 0 && (
        <div className="space-y-2">
          {insights.map((ins, i) => (
            <div key={i} className="rounded-xl border border-[var(--adc-caution-bd)] dark:border-[var(--adc-caution-bd)]/50 bg-[var(--adc-caution-bg)] dark:bg-[var(--adc-caution-fg)]/30 px-4 py-3">
              <p className="text-xs text-foreground">△ {ins}</p>
            </div>
          ))}
        </div>
      )}
      <SimpleTable cols={cols} rows={devices} defaultSort="spend" />
    </div>
  );
}
