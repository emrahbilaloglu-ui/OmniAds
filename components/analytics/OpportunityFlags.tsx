"use client";

import { TrendingUp, AlertTriangle, Zap, Target } from "lucide-react";

interface Opportunity {
  type: "opportunity" | "warning" | "strong";
  title: string;
  description: string;
}

function deriveOpportunities(data: {
  products?: Array<{ name: string; views: number; addToCarts: number; checkouts: number; purchases: number; atcRate: number; checkoutRate: number; purchaseRate: number }>;
  pages?: Array<{ path: string; sessions: number; engagementRate: number; purchaseCvr: number }>;
  channels?: Array<{ sourceMedium: string; sessions: number; engagementRate: number; purchaseCvr: number }>;
  newVsReturning?: { new: { sessions: number; purchaseCvr: number }; returning: { sessions: number; purchaseCvr: number } };
}): Opportunity[] {
  const ops: Opportunity[] = [];

  // New vs returning gap
  if (data.newVsReturning) {
    const { new: newSeg, returning: retSeg } = data.newVsReturning;
    if (newSeg.purchaseCvr > 0 && retSeg.purchaseCvr > 0) {
      const multiplier = retSeg.purchaseCvr / newSeg.purchaseCvr;
      if (multiplier >= 2) {
        ops.push({
          type: "opportunity",
          title: "Returning visitors are under-targeted",
          description: `Returning users convert ${multiplier.toFixed(1)}× better. Consider retargeting campaigns to re-engage past visitors.`,
        });
      }
    }
  }

  // High traffic page with weak engagement
  if (data.pages) {
    const highTrafficWeak = data.pages
      .filter((p) => p.sessions > 200 && p.engagementRate < 0.3)
      .sort((a, b) => b.sessions - a.sessions)[0];
    if (highTrafficWeak) {
      ops.push({
        type: "warning",
        title: `High traffic, weak engagement: ${highTrafficWeak.path}`,
        description: `${Math.round(highTrafficWeak.sessions).toLocaleString()} sessions but only ${(highTrafficWeak.engagementRate * 100).toFixed(0)}% engagement rate. Review ad targeting and landing page relevance.`,
      });
    }

    // Strong page that could get more budget
    const strongPage = [...data.pages]
      .filter((p) => p.sessions > 30 && p.purchaseCvr > 0.03)
      .sort((a, b) => b.purchaseCvr - a.purchaseCvr)[0];
    if (strongPage) {
      ops.push({
        type: "strong",
        title: `Top converter deserves more budget: ${strongPage.path}`,
        description: `${(strongPage.purchaseCvr * 100).toFixed(1)}% purchase CVR — consider allocating more paid traffic to this page.`,
      });
    }
  }

  // Product funnel gaps
  if (data.products) {
    // High views, low ATC
    const highViewsLowAtc = data.products
      .filter((p) => p.views > 100 && p.atcRate < 0.03)
      .sort((a, b) => b.views - a.views)[0];
    if (highViewsLowAtc) {
      ops.push({
        type: "warning",
        title: `Funnel drop-off at add-to-cart: "${highViewsLowAtc.name}"`,
        description: `High view volume (${Math.round(highViewsLowAtc.views).toLocaleString()}) but only ${(highViewsLowAtc.atcRate * 100).toFixed(1)}% add-to-cart rate. Consider improving product page CTA and pricing clarity.`,
      });
    }

    // Strong ATC but weak checkout
    const atcDropOff = data.products
      .filter((p) => p.addToCarts > 20 && p.checkoutRate < 0.15)
      .sort((a, b) => b.addToCarts - a.addToCarts)[0];
    if (atcDropOff) {
      ops.push({
        type: "warning",
        title: `Cart-to-checkout drop-off: "${atcDropOff.name}"`,
        description: `Strong add-to-cart but weak checkout rate (${(atcDropOff.checkoutRate * 100).toFixed(1)}%). Cart abandonment may be driven by unexpected shipping costs or checkout friction.`,
      });
    }
  }

  // Low quality traffic source
  if (data.channels) {
    const highTrafficLowQuality = data.channels
      .filter((c) => c.sessions > 100 && c.engagementRate < 0.25 && c.purchaseCvr === 0)
      .sort((a, b) => b.sessions - a.sessions)[0];
    if (highTrafficLowQuality) {
      ops.push({
        type: "warning",
        title: `Low-intent traffic source: ${highTrafficLowQuality.sourceMedium}`,
        description: `High session volume with ${(highTrafficLowQuality.engagementRate * 100).toFixed(0)}% engagement and zero purchases. Consider pausing or adjusting this traffic source.`,
      });
    }
  }

  return ops.slice(0, 6);
}

interface OpportunityFlagsProps {
  products?: Array<{ name: string; views: number; addToCarts: number; checkouts: number; purchases: number; atcRate: number; checkoutRate: number; purchaseRate: number }>;
  pages?: Array<{ path: string; sessions: number; engagementRate: number; purchaseCvr: number }>;
  channels?: Array<{ sourceMedium: string; sessions: number; engagementRate: number; purchaseCvr: number }>;
  newVsReturning?: { new: { sessions: number; purchaseCvr: number }; returning: { sessions: number; purchaseCvr: number } };
  isLoading?: boolean;
}

export function OpportunityFlags({
  products,
  pages,
  channels,
  newVsReturning,
  isLoading,
}: OpportunityFlagsProps) {
  const opportunities = deriveOpportunities({ products, pages, channels, newVsReturning });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (opportunities.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        Not enough data to surface opportunities yet. Come back once more sessions are recorded.
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      {opportunities.map((op, i) => (
        <OpportunityCard key={i} op={op} />
      ))}
      {/* The design states where the flags come from, so a quiet screen reads
          as "nothing crossed a threshold" rather than "nothing was checked". */}
      <p className="m-0 pt-1 font-[family-name:var(--adv-font-mono)] text-[10.5px] leading-[1.6] text-[var(--adv-ink-4)]">
        Derived from this window&apos;s funnel, landing-page, audience and
        channel reads — thresholds, not opinions. Not enough data → no flag.
      </p>
    </div>
  );
}

function OpportunityCard({ op }: { op: Opportunity }) {
  const config = {
    opportunity: {
      icon: <Zap className="h-4 w-4 text-[var(--adc-info-fg)]" />,
      border: "border-[var(--adc-info-bd)]",
      bg: "bg-[var(--adc-info-bg)]",
      titleColor: "text-[var(--adc-info-fg)]",
      textColor: "text-[var(--adc-info-fg)]",
    },
    warning: {
      icon: <AlertTriangle className="h-4 w-4 text-[var(--adc-caution-fg)] " />,
      border: "border-[var(--adc-caution-bd)] ",
      bg: "bg-[var(--adc-caution-bg)] ",
      titleColor: "text-[var(--adc-caution-fg)] ",
      textColor: "text-[var(--adc-caution-fg)] ",
    },
    strong: {
      icon: <TrendingUp className="h-4 w-4 text-[var(--adc-pos-fg)] " />,
      border: "border-[var(--adc-pos-bd)] ",
      bg: "bg-[var(--adc-pos-bg)] ",
      titleColor: "text-[var(--adc-pos-fg)] ",
      textColor: "text-[var(--adc-pos-fg)] ",
    },
  }[op.type];

  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${config.border} ${config.bg}`}
    >
      <div className="mt-0.5 shrink-0">{config.icon}</div>
      <div>
        <p className={`text-sm font-semibold ${config.titleColor}`}>{op.title}</p>
        <p className={`mt-0.5 text-xs ${config.textColor}`}>{op.description}</p>
      </div>
    </div>
  );
}

// Standalone icon export for empty state
export function OpportunityIcon() {
  return <Target className="h-6 w-6 text-muted-foreground" />;
}
