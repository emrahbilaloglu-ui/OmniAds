interface UnavailableMetricCardProps {
  label: string;
  requires: string;
}

export function UnavailableMetricCard({ label, requires }: UnavailableMetricCardProps) {
  return (
    <article className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          Requires {requires}
        </span>
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-muted-foreground">—</p>
      <div className="mt-4 h-8" />
    </article>
  );
}
