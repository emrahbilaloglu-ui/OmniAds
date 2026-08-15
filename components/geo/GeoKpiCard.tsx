"use client";

interface GeoKpiCardProps {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  isLoading?: boolean;
}

export function GeoKpiCard({
  label,
  value,
  sub,
  highlight,
  isLoading,
}: GeoKpiCardProps) {
  if (isLoading) {
    return (
      <div className="rounded-xl border border-[var(--adv-border)] bg-white p-4">
        <div className="h-3 w-24 rounded bg-muted animate-pulse mb-3" />
        <div className="h-7 w-20 rounded bg-muted animate-pulse" />
      </div>
    );
  }
  return (
    <div
      className={`rounded-xl border border-[var(--adv-border)] bg-white p-4 ${
        highlight ? "border-[var(--adc-auto-bd)] " : ""
      }`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={`mt-2 text-2xl font-semibold tracking-tight ${
          highlight ? "text-[var(--adc-auto-fg)] " : ""
        }`}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
      )}
    </div>
  );
}
