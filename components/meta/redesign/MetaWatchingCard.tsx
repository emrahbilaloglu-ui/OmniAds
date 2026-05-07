"use client";

import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { MetaActionCard } from "@/components/meta/redesign/MetaActionCard";

interface MetaWatchingCardProps {
  rec: MetaRecommendation;
  deferred?: boolean;
  evidenceWindow?: string;
  onOpenDrill?: (rec: MetaRecommendation) => void;
  onDefer?: (rec: MetaRecommendation) => void;
  onUndoDefer?: (rec: MetaRecommendation) => void;
}

export function MetaWatchingCard(props: MetaWatchingCardProps) {
  return (
    <MetaActionCard
      rec={props.rec}
      deferred={props.deferred}
      evidenceWindow={props.evidenceWindow}
      onPrimary={props.onOpenDrill}
      onOpenDrill={(item) => {
        if ("level" in item) props.onOpenDrill?.(item);
      }}
      onDefer={props.onDefer}
      onUndoDefer={props.onUndoDefer}
    />
  );
}
