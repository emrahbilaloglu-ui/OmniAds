"use client";

import { InsightsAnalyticsScreen } from "@/components/analytics/InsightsAnalyticsScreen";

/**
 * `/insights/analytics` — the Insights → Analytics tab.
 *
 * The Insights layout owns the design's single page head, its three head chips
 * and the outer pill row, so this route body is the tab itself and nothing
 * else: no second header, no wrapping card, no per-tab section titles.
 */
export default function AnalyticsPage() {
  return <InsightsAnalyticsScreen />;
}
