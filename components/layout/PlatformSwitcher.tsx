"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, CircleDot, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  platformOrder,
  platformsRegistry,
  type PlatformId,
  type PlatformStatus,
} from "./nav-items";
import { usePlatformContext } from "@/lib/navigation/platform-context";

const STATUS_BADGE_CLASSES: Record<PlatformStatus, string> = {
  live: "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)] border-[var(--adc-pos-bd)]",
  beta: "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)] border-[var(--adc-caution-bd)]",
  soon: "bg-[var(--adc-s3)] text-[var(--adc-ink3)] border-[var(--adc-b1)]",
};

const STATUS_LABELS: Record<PlatformStatus, string> = {
  live: "Live",
  beta: "Beta",
  soon: "Soon",
};

function StatusBadge({ status, compact = false }: { status: PlatformStatus; compact?: boolean }) {
  const pad = compact ? "px-1 py-px" : "px-1.5 py-0.5";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border text-[12px] font-semibold uppercase tracking-wider",
        pad,
        STATUS_BADGE_CLASSES[status]
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

export function PlatformLogo({
  platformId,
  size = 16,
}: {
  platformId: PlatformId;
  size?: number;
}) {
  const platform = platformsRegistry[platformId];
  return (
    <span
      className="inline-grid place-items-center rounded-[4px] shrink-0 overflow-hidden bg-white"
      style={{ width: size, height: size }}
    >
      <Image
        src={platform.logoSrc}
        alt={`${platform.name} logo`}
        width={size}
        height={size}
        className="h-full w-full object-contain"
      />
    </span>
  );
}

export function PlatformSwitcher() {
  const { activePlatformId, activePlatform, switchPlatform } = usePlatformContext();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  function handlePick(platformId: PlatformId) {
    const platform = platformsRegistry[platformId];
    if (platform.status === "soon") return;
    switchPlatform(platformId);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative" data-testid="platform-switcher">
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-1.5 rounded-md border hover:bg-neutral-50 text-[12.5px] text-neutral-700",
          open ? "border-blue-300 bg-blue-50/50" : "border-neutral-200 bg-white"
        )}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <PlatformLogo platformId={activePlatformId} size={16} />
        <span className="font-medium text-neutral-900">{activePlatform.name}</span>
        {activePlatform.status !== "live" ? <StatusBadge status={activePlatform.status} /> : null}
        <ChevronDown className="h-[13px] w-[13px] text-neutral-400" />
      </button>

      {open ? (
        <div
          className="absolute left-0 top-full mt-1 w-72 rounded-2xl border border-neutral-200 bg-white shadow-[0_8px_32px_rgba(15,23,42,0.12)] overflow-hidden z-40"
          role="menu"
        >
          <div className="px-3 py-2 border-b border-neutral-100 flex items-center justify-between">
            <span className="text-[12px] uppercase tracking-wider text-neutral-400 font-semibold">
              Switch platform
            </span>
            {/*
              A search-shortcut hint used to sit here with no handler behind
              it, and in the wrong menu besides: the shortcut belongs to
              search. It now lives on the search control, where it works.
            */}
          </div>
          <div className="py-1">
            {platformOrder.map((platformId) => {
              const platform = platformsRegistry[platformId];
              const active = platformId === activePlatformId;
              const clickable = platform.status === "live" || platform.status === "beta";
              return (
                <button
                  key={platformId}
                  type="button"
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-left text-[12.5px]",
                    clickable ? "hover:bg-neutral-50" : "cursor-default",
                    active ? "bg-blue-50/40" : ""
                  )}
                  data-platform-pick={platformId}
                  data-soon={!clickable ? "" : undefined}
                  onClick={() => handlePick(platformId)}
                  role="menuitem"
                >
                  <span
                    className={cn(
                      "w-4 h-4 grid place-items-center",
                      active ? "text-blue-600" : "text-neutral-300"
                    )}
                  >
                    {active ? <CheckCircle2 className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
                  </span>
                  <PlatformLogo platformId={platformId} size={16} />
                  <span className={active ? "font-semibold text-neutral-900" : "text-neutral-700"}>
                    {platform.name}
                  </span>
                  <StatusBadge status={platform.status} />
                  {/*
                    A notify-when-it-ships link used to sit here and write one
                    line to the browser console. Someone who clicked it
                    believed they had registered interest and would hear when
                    the platform shipped; nothing recorded it anywhere.
                    Removed rather than backed by an invented store -- the
                    status badge beside the name already says the honest thing.
                  */}
                </button>
              );
            })}
          </div>
          <div className="px-3 py-2 border-t border-neutral-100 text-[12px] text-neutral-500 flex items-center gap-1">
            <Info className="h-[11px] w-[11px]" />
            <span>Last viewed platform per business is remembered.</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export { StatusBadge as PlatformStatusBadge };
