"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import type { EvidenceAccordionSection } from "@/components/common/briefing/EvidenceAccordion";

interface EvidencePopoverProps {
  open: boolean;
  title?: string;
  subtitle?: string | null;
  sections: EvidenceAccordionSection[];
  variant?: "creative" | "meta";
  presentation?: "modal" | "drawer";
  onClose: () => void;
}

export function EvidencePopover({
  open,
  title = "Evidence",
  subtitle,
  sections,
  variant = "creative",
  presentation = "modal",
  onClose,
}: EvidencePopoverProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open || sections.length === 0) return null;

  const tone =
    variant === "meta"
      ? "border-blue-100 bg-blue-50/60 text-blue-700"
      : "border-slate-200 bg-slate-50 text-slate-700";
  const drawer = presentation === "drawer";
  const rootClassName = drawer
    ? "fixed inset-0 z-50"
    : "fixed inset-0 z-50 flex items-center justify-center p-4";
  const panelClassName = drawer
    ? "absolute inset-x-0 bottom-0 z-10 max-h-[90vh] overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none md:w-[min(640px,calc(100vw-48px))] md:rounded-none md:rounded-l-2xl md:border-y-0 md:border-r-0 md:border-l"
    : "relative z-10 w-full max-w-[620px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl";
  const bodyClassName = drawer
    ? "max-h-[calc(90vh-56px)] overflow-y-auto px-4 py-3 md:max-h-none md:h-[calc(100vh-56px)]"
    : "max-h-[68vh] overflow-y-auto px-4 py-3";

  return (
    <div className={rootClassName} role="dialog" aria-modal="true">
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/25"
        aria-label="Close evidence"
        onClick={onClose}
      />
      <div className={panelClassName} data-evidence-presentation={presentation}>
        <div className="flex items-start gap-3 border-b border-slate-100 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-slate-950">{title}</div>
            {subtitle ? (
              <div className="mt-0.5 truncate text-[12px] text-slate-500">{subtitle}</div>
            ) : null}
          </div>
          <button
            type="button"
            className="grid size-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close evidence"
            onClick={onClose}
          >
            <X className="inline-block shrink-0" size={15} aria-hidden="true" />
          </button>
        </div>
        <div className={bodyClassName}>
          <div className="space-y-3">
            {sections.map((section) => (
              <section key={section.key} className="rounded-xl border border-slate-200 bg-white">
                <div className={`flex items-center gap-2 rounded-t-xl border-b px-3 py-2 ${tone}`}>
                  {section.icon ? <span className="text-slate-400">{section.icon}</span> : null}
                  <h3 className="text-[12px] font-semibold text-slate-800">{section.title}</h3>
                  {section.count != null ? (
                    <span className="ml-auto font-mono text-[10.5px] text-slate-500">{section.count}</span>
                  ) : null}
                </div>
                <div className="px-3 py-3 text-[12px] leading-snug text-slate-600">
                  {section.content}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
