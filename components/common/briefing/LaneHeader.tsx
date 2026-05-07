import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Eye, Target } from "lucide-react";
import type { LaneKey } from "@/components/common/briefing/types";

type LaneHeaderVariant = "creative" | "meta";

interface LaneHeaderProps {
  laneKey: LaneKey;
  title: string;
  count: number;
  subtitle?: string;
  collapsed?: boolean;
  variant?: LaneHeaderVariant;
  onToggle?: (laneKey: LaneKey) => void;
}

const CREATIVE_TONE_CLASS: Record<LaneKey, string> = {
  action: "bg-rose-500",
  watching: "bg-sky-500",
  healthy: "bg-emerald-500",
  audience: "bg-violet-400",
};

const CREATIVE_ICON = {
  action: AlertTriangle,
  watching: Eye,
  healthy: CheckCircle2,
  audience: Target,
};

const CREATIVE_ICON_CLASS: Record<LaneKey, string> = {
  action: "text-rose-600",
  watching: "text-sky-600",
  healthy: "text-emerald-600",
  audience: "text-violet-600",
};

export function LaneHeader({
  laneKey,
  title,
  count,
  subtitle,
  collapsed = false,
  variant = "creative",
  onToggle,
}: LaneHeaderProps) {
  const Icon = CREATIVE_ICON[laneKey];
  const ToggleIcon = collapsed ? ChevronDown : ChevronUp;

  if (variant === "meta") {
    return (
      <div className="flex items-center gap-2 px-1 mb-2" data-lane-header={title}>
        <span className={`w-1 h-4 rounded-full ${CREATIVE_TONE_CLASS[laneKey]}`} />
        <h3 className="text-[13px] font-semibold text-slate-900 uppercase tracking-wider">
          {title}
        </h3>
        <span className="font-mono tabular-nums text-[11px] text-slate-500 px-1.5 py-0.5 bg-slate-50 border border-slate-200 rounded-md">
          {count}
        </span>
        {subtitle ? <span className="text-[11.5px] text-slate-500">{subtitle}</span> : null}
        <button
          type="button"
          className="ml-auto text-[11px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
          data-toggle-lane={title}
          onClick={() => onToggle?.(laneKey)}
        >
          <ToggleIcon className="inline-block shrink-0" size={13} aria-hidden="true" />
          <span>{collapsed ? "Expand" : "Collapse"}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 mb-2.5 px-1" data-lane-header={laneKey}>
      <div className={`w-1 h-6 rounded-full ${CREATIVE_TONE_CLASS[laneKey]}`} />
      <div className="flex items-center gap-2">
        <Icon
          className={`inline-block shrink-0 ${CREATIVE_ICON_CLASS[laneKey]}`}
          size={13}
          aria-hidden="true"
        />
        <h3 className="text-[14px] font-semibold text-slate-900 tracking-tight">
          {title}
        </h3>
        <span className="font-mono tabular-nums text-[12px] text-slate-500 px-1.5 py-0.5 rounded-md bg-slate-100">
          {count}
        </span>
      </div>
      {subtitle ? <span className="text-[12px] text-slate-500">{subtitle}</span> : null}
      <button
        type="button"
        data-toggle-lane={laneKey}
        className="ml-auto inline-flex items-center gap-1 text-[12px] text-slate-500 hover:text-slate-900 px-2 py-1 rounded-md hover:bg-slate-100"
        onClick={() => onToggle?.(laneKey)}
      >
        {collapsed ? "Expand" : "Collapse"}
        <ToggleIcon className="inline-block shrink-0" size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
