import { Globe, Megaphone, Target } from "lucide-react";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

interface MetaScopeChipProps {
  level: MetaRecommendation["level"] | "anomaly";
  label?: string | null;
}

const LEVELS = {
  account: { text: "Account", className: "border-[var(--adc-info-bd)] bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)]", icon: Globe },
  campaign: { text: "Campaign", className: "border-slate-300 bg-slate-50 text-slate-700", icon: Megaphone },
  adset: { text: "Adset", className: "border-[var(--adc-auto-bd)] bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)]", icon: Target },
  anomaly: { text: "Anomaly", className: "border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]", icon: Target },
} as const;

export function MetaScopeChip({ level, label }: MetaScopeChipProps) {
  const config = LEVELS[level];
  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border ${config.className} text-[10.5px] font-medium`}
      data-scope-chip={level}
    >
      <Icon className="inline-block shrink-0" size={11} aria-hidden="true" />
      {label ?? config.text}
    </span>
  );
}
