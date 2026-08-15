"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import type { EvidenceAccordionSection } from "@/components/common/briefing/EvidenceAccordion";

interface EvidencePopoverProps {
  open: boolean;
  title?: string;
  subtitle?: string | null;
  sections: EvidenceAccordionSection[];
  variant?: "creative" | "meta";
  presentation?: "modal" | "drawer";
  media?: ReactNode;
  onClose: () => void;
}

export function EvidencePopover({
  open,
  title = "Evidence",
  subtitle,
  sections,
  variant = "creative",
  presentation = "modal",
  media,
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

  if (!open) return null;

  const tone =
    variant === "meta"
      ? "border-[var(--adc-info-bd)] bg-[var(--adc-info-bg)]/60 text-[var(--adc-info-fg)]"
      : "border-neutral-200 bg-neutral-50 text-neutral-700";
  const drawer = presentation === "drawer";
  const hasPreview = drawer && Boolean(media);
  const rootClassName = drawer
    ? "fixed inset-0 z-50"
    : "fixed inset-0 z-50 flex items-center justify-center p-4";
  const drawerWidth = hasPreview
    ? "md:w-[min(960px,calc(100vw-48px))]"
    : "md:w-[min(640px,calc(100vw-48px))]";
  const panelClassName = drawer
    ? `absolute inset-x-0 bottom-0 z-10 max-h-[90vh] overflow-hidden rounded-t-2xl border border-neutral-200 bg-white shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none ${drawerWidth} md:rounded-none md:rounded-l-2xl md:border-y-0 md:border-r-0 md:border-l`
    : "relative z-10 w-full max-w-[620px] overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl";
  const bodyClassName = drawer
    ? "max-h-[calc(90vh-56px)] overflow-y-auto px-4 py-3 md:max-h-none md:h-[calc(100vh-56px)]"
    : "max-h-[68vh] overflow-y-auto px-4 py-3";

  return (
    <div className={rootClassName} role="dialog" aria-modal="true">
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/25"
        aria-label="Close evidence"
        onClick={onClose}
      />
      <div className={panelClassName} data-evidence-presentation={presentation}>
        <div className="flex items-start gap-3 border-b border-neutral-100 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-neutral-950">{title}</div>
            {subtitle ? (
              <div className="mt-0.5 truncate text-[12px] text-neutral-500">{subtitle}</div>
            ) : null}
          </div>
          <button
            type="button"
            className="grid size-7 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
            aria-label="Close evidence"
            onClick={onClose}
          >
            <X className="inline-block shrink-0" size={15} aria-hidden="true" />
          </button>
        </div>
        <div className={bodyClassName}>
          {media ? <div className="mb-3">{media}</div> : null}
          <div className="space-y-3">
            {sections.length === 0 ? (
              <section className="rounded-xl border border-neutral-200 bg-white">
                <div className={`flex items-center gap-2 rounded-t-xl border-b px-3 py-2 ${tone}`}>
                  <h3 className="text-[12px] font-semibold text-neutral-800">Evidence unavailable</h3>
                </div>
                <div className="px-3 py-3 text-[12px] leading-snug text-neutral-600">
                  No server evidence was returned for this item. The drawer opens intentionally so missing evidence is visible instead of silently failing.
                </div>
              </section>
            ) : sections.map((section) => (
              <section key={section.key} className="rounded-xl border border-neutral-200 bg-white">
                <div className={`flex items-center gap-2 rounded-t-xl border-b px-3 py-2 ${tone}`}>
                  {section.icon ? <span className="text-neutral-400">{section.icon}</span> : null}
                  <h3 className="text-[12px] font-semibold text-neutral-800">{section.title}</h3>
                  {section.count != null ? (
                    <span className="ml-auto font-mono text-[10.5px] text-neutral-500">{section.count}</span>
                  ) : null}
                </div>
                <div className="px-3 py-3 text-[12px] leading-snug text-neutral-600">
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
