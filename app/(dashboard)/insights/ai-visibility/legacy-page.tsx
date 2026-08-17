"use client";

import { InsightsGeoScreen } from "@/components/geo/InsightsGeoScreen";

/**
 * `/insights/ai-visibility` — the Insights → AI Visibility tab.
 *
 * The Insights layout owns the design's single page head, its three head chips
 * and the outer pill row, so this route body is the tab itself and nothing
 * else: no second header, no second pair of connection chips, no wrapping card.
 */
export default function AiVisibilityPage() {
  return <InsightsGeoScreen />;
}
