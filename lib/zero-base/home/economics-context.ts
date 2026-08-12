/**
 * The economics context Home shows, and where it comes from.
 *
 * H03 states a fact that is easy to get wrong: break-even and target ROAS come
 * from the **Commercial Truth target pack**, and only Meta decisions consume
 * them. Overview and Google read a *separate* cost model. Rendering one number
 * without naming its source and its consumers is what produces the "why is
 * Google using a different break-even?" question this panel exists to answer.
 *
 * So the model carries both sources and their consumers explicitly, and the
 * divergence link (ECON-04) leads to the Business Settings panel that shows
 * them side by side.
 */
import { navHref } from "@/lib/zero-base/navigation";

/** A named economics source and the surfaces that read it. */
export interface EconomicsSource {
  key: "target-pack" | "cost-model";
  label: string;
  /** Surfaces that consume this source. Never empty. */
  consumers: readonly string[];
}

export interface EconomicsContextModel {
  /** Null when it has genuinely not been derived — never coerced to 0. */
  breakEvenRoas: number | null;
  targetRoas: number | null;
  sources: readonly EconomicsSource[];
  /** True when the two sources disagree enough to be worth reconciling. */
  diverges: boolean;
}

/** The Business Settings economics panel (H45), which shows both sources. */
export function economicsPanelHref(businessId: string | null): string {
  return `${navHref("/c/[businessId]/manage/business", businessId)}#economics`;
}

/**
 * Format a ROAS for display.
 *
 * Two decimals, because the difference between 2.12 and 2.1 is a real amount of
 * money at scale. An absent value renders as a word, never as a dash that could
 * be read as zero.
 */
export function formatRoas(value: number | null): string {
  return value === null ? "not derived" : value.toFixed(2);
}
