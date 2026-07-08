"use client";

import { LaunchpadOverlay } from "@/components/common/briefing";
import type { MetaLaunchMode } from "@/components/meta/redesign/types";

interface MetaLaunchpadOverlayProps {
  open: boolean;
  mode: MetaLaunchMode;
  item: {
    id: string;
    name?: string;
    campaign?: string;
    currentBidCap?: number;
    proposedBidCap?: number;
    currencyCode?: string;
  };
  onClose: () => void;
  onConfirm: () => void;
}

export function MetaLaunchpadOverlay({
  open,
  mode,
  item,
  onClose,
  onConfirm,
}: MetaLaunchpadOverlayProps) {
  return (
    <LaunchpadOverlay
      open={open}
      mode={mode}
      item={{
        ...item,
        brand: "Meta",
        label: mode === "apply_bid" ? "tune" : mode === "duplicate" ? "swap" : "rebuild",
      }}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}
