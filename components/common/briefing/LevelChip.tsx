import { Globe, Layers, Megaphone, Target } from "lucide-react";
import type { DecisionLevel } from "@/components/common/briefing/types";

interface LevelChipProps {
  level: DecisionLevel;
  className?: string;
}

const LABELS: Record<DecisionLevel, string> = {
  account: "Account",
  campaign: "Campaign",
  adset: "Adset",
  creative: "Creative",
};

const TONES: Record<DecisionLevel, string> = {
  campaign: "border-slate-300 bg-slate-50 text-slate-700",
  adset: "border-violet-200 bg-violet-50 text-violet-700",
  account: "border-blue-200 bg-blue-50 text-blue-700",
  creative: "border-slate-200 bg-white text-slate-600",
};

const ICONS: Record<DecisionLevel, typeof Globe> = {
  account: Globe,
  campaign: Megaphone,
  adset: Target,
  creative: Layers,
};

export function LevelChip({ level, className }: LevelChipProps) {
  const Icon = ICONS[level];

  return (
    <span
      className={[
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border",
        TONES[level],
        "text-[10.5px] font-medium",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Icon className="inline-block shrink-0" size={11} aria-hidden="true" />
      {LABELS[level]}
    </span>
  );
}
