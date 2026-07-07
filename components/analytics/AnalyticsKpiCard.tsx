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
      <div className="rounded-xl border border-neutral-200 bg-white p-4">
        <div className="h-3 w-24 rounded bg-muted animate-pulse mb-3" />
        <div className="h-7 w-20 rounded bg-muted animate-pulse" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      {sub && (
        <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
      )}
    </div>
  );
}
