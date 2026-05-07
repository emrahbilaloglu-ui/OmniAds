"use client";

import { useId, type ReactNode } from "react";

interface DeferTooltipProps {
  children: ReactNode;
}

export const DEFER_TOOLTIP_TITLE = "What does Defer 24h do?";
export const DEFER_TOOLTIP_BODY =
  "Temporarily removes this card from Action Now for 24 hours. It does not delete the recommendation, change engine v3 logic, or apply any ad account action. It only saves a triage reappear time; the card can return when the window expires. Use Undo to bring it back immediately.";

export function DeferTooltip({ children }: DeferTooltipProps) {
  const tooltipId = useId();

  return (
    <span className="group relative inline-flex" aria-describedby={tooltipId}>
      {children}
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-[310px] -translate-x-1/2 rounded-xl border border-slate-200 bg-slate-950 px-3 py-2 text-left text-white opacity-0 shadow-xl transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <span className="block text-[12px] font-semibold leading-snug">{DEFER_TOOLTIP_TITLE}</span>
        <span className="mt-1 block text-[11.5px] leading-snug text-slate-200">{DEFER_TOOLTIP_BODY}</span>
        <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-slate-200 bg-slate-950" />
      </span>
    </span>
  );
}
