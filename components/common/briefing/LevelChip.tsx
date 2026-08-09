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
  campaign: "border-neutral-300 bg-neutral-50 text-neutral-700",
  adset: "border-sky-200 bg-sky-50 text-sky-700",
  account: "border-blue-200 bg-blue-50 text-blue-700",
  creative: "border-neutral-200 bg-white text-neutral-600",
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
        "text-[12px] font-medium",
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
