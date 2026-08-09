import { Globe, Megaphone, Target } from "lucide-react";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

interface MetaScopeChipProps {
  level: MetaRecommendation["level"] | "anomaly";
  label?: string | null;
}

const LEVELS = {
  account: { text: "Account", className: "border-blue-200 bg-blue-50 text-blue-700", icon: Globe },
  campaign: { text: "Campaign", className: "border-slate-300 bg-slate-50 text-slate-700", icon: Megaphone },
  adset: { text: "Adset", className: "border-violet-200 bg-violet-50 text-violet-700", icon: Target },
  anomaly: { text: "Anomaly", className: "border-rose-200 bg-rose-50 text-rose-700", icon: Target },
} as const;

export function MetaScopeChip({ level, label }: MetaScopeChipProps) {
  const config = LEVELS[level];
  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border ${config.className} text-[12px] font-medium`}
      data-scope-chip={level}
    >
      <Icon className="inline-block shrink-0" size={11} aria-hidden="true" />
      {label ?? config.text}
    </span>
  );
}
