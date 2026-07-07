"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface EvidenceAccordionSection {
  key: string;
  title: string;
  icon?: ReactNode;
  content: ReactNode;
  count?: ReactNode;
  defaultOpen?: boolean;
}

type EvidenceAccordionVariant = "creative" | "meta" | "legacy";

interface EvidenceAccordionProps {
  sections: EvidenceAccordionSection[];
  variant?: EvidenceAccordionVariant;
  className?: string;
  "data-testid"?: string;
}

export function EvidenceAccordion({
  sections,
  variant = "creative",
  className,
  "data-testid": testId,
}: EvidenceAccordionProps) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(
    () => new Set(sections.filter((section) => section.defaultOpen).map((section) => section.key)),
  );

  if (sections.length === 0) return null;

  const classes = getEvidenceAccordionClasses(variant);

  return (
    <div className={[classes.container, className].filter(Boolean).join(" ")} data-testid={testId}>
      {sections.map((section) => {
        const isOpen = openKeys.has(section.key);
        const Chevron = variant === "meta" ? ChevronRight : ChevronDown;

        return (
          <details key={section.key} className={classes.details} open={isOpen}>
            <summary
              className={classes.summary}
              aria-expanded={isOpen}
              onClick={(event) => {
                event.preventDefault();
                setOpenKeys((current) => {
                  const next = new Set(current);
                  if (next.has(section.key)) {
                    next.delete(section.key);
                  } else {
                    next.add(section.key);
                  }
                  return next;
                });
              }}
            >
              {variant === "legacy" ? (
                section.title
              ) : (
                <>
                  {section.icon ? <span className="text-neutral-400">{section.icon}</span> : null}
                  <span className={classes.title}>{section.title}</span>
                </>
              )}
              {section.count != null ? (
                <span className="ml-auto text-[10.5px] text-neutral-400 font-mono">{section.count}</span>
              ) : null}
              {variant !== "legacy" ? (
                <span
                  className={[
                    section.count != null ? "" : "ml-auto",
                    variant === "creative" ? "text-neutral-400 transition-transform" : "text-neutral-400",
                    variant === "creative" && isOpen ? "rotate-180" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <Chevron className="inline-block shrink-0" size={13} aria-hidden="true" />
                </span>
              ) : null}
            </summary>
            <div className={classes.body}>{section.content}</div>
          </details>
        );
      })}
    </div>
  );
}

function getEvidenceAccordionClasses(variant: EvidenceAccordionVariant) {
  if (variant === "meta") {
    return {
      container: "mt-3 rounded-xl border border-neutral-200 bg-neutral-50/40 overflow-hidden",
      details: "border-t border-neutral-100",
      summary: "flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-neutral-50 text-[12px]",
      title: "font-medium text-neutral-700",
      body: "px-3 pb-3 pt-0 text-[12px] text-neutral-600 leading-snug",
    };
  }

  if (variant === "legacy") {
    return {
      container: "space-y-2",
      details: "rounded-xl border border-neutral-200 bg-white",
      summary:
        "cursor-pointer select-none px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500",
      title: "",
      body: "border-t border-neutral-100 px-3 py-3",
    };
  }

  return {
    container: "mt-3 ml-[44px] mr-1 rounded-xl border border-neutral-200 bg-neutral-50/40 overflow-hidden",
    details: "border-b border-neutral-200 last:border-b-0 group",
    summary:
      "flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-neutral-100/60 list-none [&::-webkit-details-marker]:hidden",
    title: "text-[12px] font-semibold text-neutral-700",
    body: "px-3 pb-3 pt-1 bg-white border-t border-neutral-100",
  };
}
