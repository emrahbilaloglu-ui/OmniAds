"use client";

import { ArrowRight, Rocket, TrendingUp, X } from "lucide-react";
import { CompareDrawer } from "@/components/common/briefing/CompareDrawer";
import {
  buildCompareDrawerItems,
  strongestByRoas,
  weakestByRoas,
} from "@/components/creatives/briefing/bulk-actions";
import {
  canOpenBriefingCardInLaunchpad,
  canOpenBriefingCardsInLaunchpad,
  type LaunchpadBridgeMode,
} from "@/components/creatives/briefing/launchpad-bridge";
import {
  hasBriefingCanonicalNativeActionAuthority,
} from "@/components/creatives/briefing/action-authority";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

interface CompareDrawerHostProps {
  open: boolean;
  cards: BriefingCreativeCard[];
  onClose: () => void;
  onCutCard: (card: BriefingCreativeCard) => void;
  onLaunchpad: (cards: BriefingCreativeCard[], mode: LaunchpadBridgeMode) => void;
}

export function CompareDrawerHost({
  open,
  cards,
  onClose,
  onCutCard,
  onLaunchpad,
}: CompareDrawerHostProps) {
  const drawerCards = cards.slice(0, 4);
  const weakest = weakestByRoas(
    drawerCards.filter((card) =>
      hasBriefingCanonicalNativeActionAuthority(card, "cut"),
    ),
  );
  const strongest = strongestByRoas(
    drawerCards.filter((card) =>
      canOpenBriefingCardInLaunchpad(card, "promote"),
    ),
  );
  const canLaunchSelectedFreshTest = canOpenBriefingCardsInLaunchpad(
    drawerCards,
    "fresh_test",
  );

  return (
    <CompareDrawer
      open={open}
      items={buildCompareDrawerItems(drawerCards)}
      onClose={onClose}
      actionBar={
        <>
          {weakest ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-rose-600 text-white border border-rose-600 hover:bg-rose-700 text-[12.5px] font-medium"
              data-compare-action="cut-weakest"
              onClick={() => onCutCard(weakest)}
            >
              <X className="inline-block shrink-0" size={13} aria-hidden="true" /> Cut weakest
            </button>
          ) : null}
          {strongest ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-emerald-600 text-white border border-emerald-600 hover:bg-emerald-700 text-[12.5px] font-medium"
              data-compare-action="scale-strongest"
              onClick={() => onLaunchpad([strongest], "promote")}
            >
              <TrendingUp className="inline-block shrink-0" size={13} aria-hidden="true" /> Scale strongest
            </button>
          ) : null}
          {canLaunchSelectedFreshTest ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-blue-200 bg-white text-blue-700 hover:bg-blue-50 text-[12.5px] font-medium"
              data-compare-action="launch-test"
              onClick={() => onLaunchpad(drawerCards, "fresh_test")}
            >
              <Rocket className="inline-block shrink-0" size={13} aria-hidden="true" /> Send selected to Launchpad <ArrowRight className="inline-block shrink-0" size={13} aria-hidden="true" />
            </button>
          ) : null}
        </>
      }
    />
  );
}
