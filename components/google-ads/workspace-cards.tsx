"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function WorkspaceTaskCard({
  title,
  impact,
  evidence,
  action,
  tone = "neutral",
}: {
  title: string;
  impact: string;
  evidence: string[];
  action: string;
  tone?: "good" | "warning" | "risk" | "neutral";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-4 shadow-sm",
        tone === "good" && "border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)]/70",
        tone === "warning" && "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)]/70",
        tone === "risk" && "border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)]/70",
        tone === "neutral" && "border-border/70 bg-card",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            AI task
          </p>
          <h4 className="mt-2 text-sm font-semibold tracking-tight">{title}</h4>
        </div>
        <Badge
          className={cn(
            "border",
            tone === "good" && "border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]",
            tone === "warning" && "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]",
            tone === "risk" && "border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]",
            tone === "neutral" && "border-border bg-background text-muted-foreground",
          )}
        >
          {impact}
        </Badge>
      </div>
      <div className="mt-4 rounded-xl bg-background/70 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Evidence
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {evidence.map((item) => (
            <span
              key={item}
              className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
            >
              {item}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-4 border-t border-border/60 pt-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Recommended action
        </p>
        <p className="mt-1 text-xs font-medium">{action}</p>
      </div>
    </div>
  );
}
