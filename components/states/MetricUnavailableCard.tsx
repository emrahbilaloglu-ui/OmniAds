"use client";

interface MetricUnavailableCardProps {
  label: string;
  description: string;
}

export function MetricUnavailableCard({
  label,
  description,
}: MetricUnavailableCardProps) {
  return (
    <article className="rounded-xl border border-neutral-200 bg-white p-5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-muted-foreground">
        Unavailable
      </p>
      <p className="mt-3 text-xs text-muted-foreground">{description}</p>
    </article>
  );
}
