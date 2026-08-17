"use client";

import { InsightsSeoScreen } from "@/components/seo/InsightsSeoScreen";

/**
 * `/insights/seo` — the Insights → SEO Intelligence tab.
 *
 * The Insights layout owns the design's single page head, its three head chips
 * and the outer pill row, so this route body is the tab itself and nothing
 * else: no second header, no wrapping card, no per-tab section titles.
 */
export default function SeoIntelligencePage() {
  return <InsightsSeoScreen />;
}
