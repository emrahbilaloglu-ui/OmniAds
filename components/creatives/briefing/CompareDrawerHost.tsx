"use client";

import { ArrowRight, Rocket, TrendingUp, X } from "lucide-react";
import { CompareDrawer } from "@/components/common/briefing/CompareDrawer";
import {
  buildCompareDrawerItems,
  strongestByRoas,
  weakestByRoas,
} from "@/components/creatives/briefing/bulk-actions";
import type { LaunchpadBridgeMode } from "@/components/creatives/briefing/launchpad-bridge";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

interface CompareDrawerHostProps {
  open: boolean;
  cards: BriefingCreativeCard[];
  onClose: () => void;
  onCutCards: (cards: BriefingCreativeCard[]) => void;
  onLaunchpad: (cards: BriefingCreativeCard[], mode: LaunchpadBridgeMode) => void;
}

export function CompareDrawerHost({
  open,
  cards,
  onClose,
  onCutCards,
  onLaunchpad,
}: CompareDrawerHostProps) {
  const drawerCards = cards.slice(0, 5);
  const weakest = weakestByRoas(drawerCards);
  const strongest = strongestByRoas(drawerCards);

  return (
    <CompareDrawer
      open={open}
      items={buildCompareDrawerItems(drawerCards)}
      onClose={onClose}
      actionBar={
        <>
          <button
            type="button"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-rose-600 text-white border border-rose-600 hover:bg-rose-700 text-[12.5px] font-medium"
            data-compare-action="cut-weakest"
            onClick={() => {
              if (weakest) onCutCards([weakest]);
            }}
          >
            <X className="inline-block shrink-0" size={13} aria-hidden="true" /> Cut weakest
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-emerald-600 text-white border border-emerald-600 hover:bg-emerald-700 text-[12.5px] font-medium"
            data-compare-action="scale-strongest"
            onClick={() => {
              if (strongest) onLaunchpad([strongest], "promote");
            }}
          >
            <TrendingUp className="inline-block shrink-0" size={13} aria-hidden="true" /> Scale strongest
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-blue-200 bg-white text-blue-700 hover:bg-blue-50 text-[12.5px] font-medium"
            data-compare-action="launch-test"
            onClick={() => onLaunchpad(drawerCards, "fresh_test")}
          >
            <Rocket className="inline-block shrink-0" size={13} aria-hidden="true" /> Launch test with these <ArrowRight className="inline-block shrink-0" size={13} aria-hidden="true" />
          </button>
          <span className="ml-auto text-[11.5px] text-slate-500">Tip: compare 2–5 selected action cards</span>
        </>
      }
    />
  );
}
