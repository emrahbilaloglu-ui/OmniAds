export type LandingPageFunnelStepKey =
  | "sessions"
  | "scroll"
  | "view_item"
  | "add_to_cart"
  | "begin_checkout"
  | "add_shipping_info"
  | "add_payment_info"
  | "purchase";

export interface LandingPagePerformanceRow {
  path: string;
  title: string;
  sessions: number;
  engagementRate: number;
  scrollRate: number;
  viewItem: number;
  addToCarts: number;
  checkouts: number;
  addShippingInfo: number;
  addPaymentInfo: number;
  purchases: number;
  totalRevenue: number;
  averagePurchaseRevenue: number;
  sessionToViewItemRate: number;
  viewItemToCartRate: number;
  cartToCheckoutRate: number;
  checkoutToShippingRate: number;
  shippingToPaymentRate: number;
  paymentToPurchaseRate: number;
  sessionToPurchaseRate: number;
  largestDropOffStep: LandingPageFunnelStepKey | null;
  largestDropOffRate: number;
  dataCompleteness: "complete" | "partial";
}

export interface LandingPagePerformanceSummary {
  totalLandingPages: number;
  totalSessions: number;
  avgEngagementRate: number;
  avgScrollRate: number;
  totalViewItem: number;
  totalAddToCarts: number;
  totalCheckouts: number;
  totalAddShippingInfo: number;
  totalAddPaymentInfo: number;
  totalPurchases: number;
  totalRevenue: number;
  averagePurchaseRevenue: number;
  sessionToPurchaseRate: number;
  topLandingPagePath: string | null;
  weakestLandingPagePath: string | null;
}

export interface LandingPagePerformanceMeta {
  /**
   * When this payload was actually retrieved from GA4.
   *
   * Stamped once at the live fetch and carried by the cache, so a response
   * served from cache reports when the data was retrieved rather than when it
   * was handed over. Re-stamping on a cache hit would make every response look
   * seconds old however long it had been sitting there.
   */
  retrievedAt?: string | null;
  empty: boolean;
  hasEcommerceData: boolean;
  unavailableMetrics: Array<{
    metric: string;
    reason: string;
  }>;
  propertyName?: string;
}

export interface LandingPagePerformanceResponse {
  rows: LandingPagePerformanceRow[];
  summary: LandingPagePerformanceSummary;
  meta: LandingPagePerformanceMeta;
}

export interface LandingPageAiReport {
  url: string;
  path: string;
  title: string;
  sessions: number;
  purchases: number;
  totalRevenue: number;
  engagementRate: number;
  scrollRate: number;
  conversionRate: number;
  biggestLeak: {
    from: LandingPageFunnelStepKey;
    to: LandingPageFunnelStepKey;
    dropRate: number;
  } | null;
  strongestStep: {
    from: LandingPageFunnelStepKey;
    to: LandingPageFunnelStepKey;
    conversionRate: number;
  } | null;
  strengths: string[];
  concerns: string[];
}

export interface LandingPageAiCommentary {
  summary: string;
  insights: string[];
  recommendations: string[];
  risks: string[];
}

export interface LandingPageAiCommentaryResponse {
  source: "ai" | "fallback";
  warning?: string | null;
  commentary: LandingPageAiCommentary;
}

export type LandingPageArchetype =
  | "homepage"
  | "listing"
  | "product"
  | "campaign"
  | "content"
  | "other";

export type LandingPageRuleAction =
  | "scale"
  | "watch"
  | "fix_above_fold"
  | "fix_product_discovery"
  | "fix_product_story"
  | "fix_checkout_intent"
  | "fix_late_checkout"
  | "tracking_audit";

export type LandingPageCauseTag =
  | "weak_above_fold"
  | "poor_product_discovery"
  | "weak_product_story"
  | "low_checkout_intent"
  | "late_checkout_friction"
  | "tracking_gap"
  | "healthy_engagement"
  | "healthy_purchase_intent"
  | "strong_late_checkout";

export interface LandingPageRuleScoreBreakdown {
  trafficQuality: number;
  discovery: number;
  intent: number;
  checkout: number;
  revenueEfficiency: number;
}

export interface LandingPageRuleReport {
  path: string;
  title: string;
  archetype: LandingPageArchetype;
  action: LandingPageRuleAction;
  score: number;
  confidence: number;
  primaryLeak: LandingPageFunnelStepKey | null;
  causeTags: LandingPageCauseTag[];
  strengths: string[];
  issues: string[];
  actions: string[];
  risks: string[];
  summary: string;
  scoreBreakdown: LandingPageRuleScoreBreakdown;
}
