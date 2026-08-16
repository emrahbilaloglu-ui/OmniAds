import { HelpCircle, MessageCircle, MousePointer, ShoppingCart, UserPlus, Video } from "lucide-react";
import type { MetaFunnelCohort } from "@/lib/meta/funnel-cohort";

interface MetaCohortChipProps {
  cohort: MetaFunnelCohort | null | undefined;
}

const COHORTS = {
  mid_funnel: { text: "Mid-funnel", className: "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]", icon: ShoppingCart },
  upper_funnel: { text: "Upper-funnel", className: "border-[var(--adc-info-bd)] bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)]", icon: Video },
  lead: { text: "Lead", className: "border-[var(--adc-auto-bd)] bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)]", icon: UserPlus },
  traffic: { text: "Traffic", className: "border-slate-300 bg-slate-50 text-slate-700", icon: MousePointer },
  engagement: { text: "Engagement", className: "border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]", icon: MessageCircle },
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
