"use client";

import { PlanGate } from "@/components/pricing/PlanGate";
import { InsightsChrome } from "@/components/insights/InsightsChrome";

/**
 * The preserved `/insights/**` family shares one screen in the design: one page
 * head (eyebrow + h1 + three chips) and one outer pill row, then the active
 * section's body. Both live in `InsightsChrome`, which the canonical
 * `/c/{businessId}/analytics/**` twins mount as well.
 */
export default function InsightsLayout({ children }: { children: React.ReactNode }) {
  return (
    <PlanGate requiredPlan="pro">
      <InsightsChrome>{children}</InsightsChrome>
    </PlanGate>
  );
}
