"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight, X } from "lucide-react";

export interface InsightWidget {
  key: string;
  title: string;
  trailingLabel?: string;
  content: ReactNode;
  needsAttention?: boolean;
}

interface InsightsPanelProps {
  widgets: InsightWidget[];
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  handleLabel?: string;
  panelLabel?: string;
  topOffset?: number;
  className?: string;
  testId?: string;
}

export function InsightsPanel({
  widgets,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  handleLabel = "Insights",
  panelLabel = "Insights",
  topOffset = 96,
  className,
  testId = "insights-panel",
}: InsightsPanelProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? Boolean(openProp) : internalOpen;
  const headingId = useId();
  const handleRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const attentionCount = useMemo(
    () => widgets.reduce((sum, widget) => sum + (widget.needsAttention ? 1 : 0), 0),
    [widgets],
  );

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange],
  );

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        handleRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => closeRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  if (widgets.length === 0) return null;

  const topStyle = { top: `${topOffset}px` } as const;

  return (
    <>
      <button
        ref={handleRef}
        type="button"
        aria-controls={headingId}
        aria-expanded={open}
        aria-label={`${handleLabel}${attentionCount > 0 ? ` — ${attentionCount} needs attention` : ""}`}
        data-testid={`${testId}-handle`}
        onClick={() => setOpen(!open)}
        style={topStyle}
        className={
          "fixed right-0 z-30 hidden xl:flex flex-col items-center gap-2 " +
          "rounded-l-lg border border-r-0 border-slate-300 bg-white px-2 py-4 " +
          "text-[12px] font-semibold text-slate-800 shadow-md " +
          "hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 " +
          "transition-colors"
        }
      >
        {attentionCount > 0 ? (
          <span className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-indigo-600 px-1.5 py-[1px] font-mono text-[10px] font-bold text-white">
            {attentionCount}
          </span>
        ) : null}
        <span
          aria-hidden="true"
          className="text-slate-800"
          style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
        >
          {handleLabel}
        </span>
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={
            "text-slate-500 transition-transform " + (open ? "rotate-180" : "")
          }
        />
      </button>

      {open ? (
        <aside
          id={headingId}
          role="region"
          aria-label={panelLabel}
          data-testid={testId}
          style={{ top: `${topOffset}px`, bottom: "24px" }}
          className={
            "fixed right-4 z-40 hidden xl:flex w-[340px] flex-col gap-4 " +
            "overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-2xl " +
            (className ?? "")
          }
        >
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <h2 className="m-0 text-[15px] font-bold text-slate-900 tracking-tight">
              {panelLabel}
            </h2>
            <button
              ref={closeRef}
              type="button"
              aria-label="Close insights"
              data-testid={`${testId}-close`}
              onClick={() => setOpen(false)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-500 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          {widgets.map((widget) => (
            <InsightsWidget key={widget.key} widget={widget} />
          ))}
        </aside>
      ) : null}
    </>
  );
}

function InsightsWidget({ widget }: { widget: InsightWidget }) {
  return (
    <section
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
      data-testid={`insights-widget-${widget.key}`}
    >
      <h3 className="m-0 mb-3 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.05em] text-slate-500">
        <span>{widget.title}</span>
        {widget.trailingLabel ? (
          <span className="font-bold text-slate-900">{widget.trailingLabel}</span>
        ) : null}
      </h3>
      {widget.content}
    </section>
  );
}
