import { HelpCircle, MessageCircle, MousePointer, ShoppingCart, UserPlus, Video } from "lucide-react";
import type { MetaFunnelCohort } from "@/lib/meta/funnel-cohort";

interface MetaCohortChipProps {
  cohort: MetaFunnelCohort | null | undefined;
}

const COHORTS = {
  mid_funnel: { text: "Mid-funnel", className: "border-amber-200 bg-amber-50 text-amber-700", icon: ShoppingCart },
  upper_funnel: { text: "Upper-funnel", className: "border-blue-200 bg-blue-50 text-blue-700", icon: Video },
  lead: { text: "Lead", className: "border-indigo-200 bg-indigo-50 text-indigo-700", icon: UserPlus },
  traffic: { text: "Traffic", className: "border-slate-300 bg-slate-50 text-slate-700", icon: MousePointer },
  engagement: { text: "Engagement", className: "border-rose-200 bg-rose-50 text-rose-700", icon: MessageCircle },
  unknown: { text: "Unknown goal", className: "border-zinc-200 bg-zinc-50 text-zinc-700", icon: HelpCircle },
} as const satisfies Record<Exclude<MetaFunnelCohort, "purchase">, {
  text: string;
  className: string;
  icon: typeof HelpCircle;
}>;

export function MetaCohortChip({ cohort }: MetaCohortChipProps) {
  if (!cohort || cohort === "purchase") return null;

  const config = COHORTS[cohort];
  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10.5px] font-medium ${config.className}`}
      data-cohort-chip={cohort}
    >
      <Icon className="inline-block shrink-0" size={11} aria-hidden="true" />
      {config.text}
    </span>
  );
}
