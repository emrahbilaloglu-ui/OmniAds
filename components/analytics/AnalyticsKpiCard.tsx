"use client";

interface AnalyticsKpiCardProps {
  label: string;
  value: string;
  sub?: string;
  trend?: "up" | "down" | "neutral";
  isLoading?: boolean;
}

export function AnalyticsKpiCard({
  label,
  value,
  sub,
  isLoading,
}: AnalyticsKpiCardProps) {
  if (isLoading) {
    return (
      <div className="rounded-[var(--r-lg,11px)] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] p-4">
        <div className="h-3 w-24 rounded bg-muted animate-pulse mb-3" />
        <div className="h-7 w-20 rounded bg-muted animate-pulse" />
      </div>
    );
  }

  return (
    <div className="rounded-[var(--r-lg,11px)] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight" style={{ fontFeatureSettings: "'tnum'" }}>{value}</p>
      {sub && (
        <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
      )}
    </div>
  );
}
