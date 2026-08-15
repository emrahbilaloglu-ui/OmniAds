"use client";

import { GadsOpportunityCard, TabSkeleton, TabEmpty } from "./shared";

interface Opportunity {
  id: string;
  type: string;
  title: string;
  whyItMatters: string;
  evidence: string;
  expectedImpact: string;
  effort: "low" | "medium" | "high";
  priority: "high" | "medium" | "low";
}

interface OpportunitiesTabProps {
  opportunities?: Opportunity[];
  isLoading: boolean;
}

export function OpportunitiesTab({ opportunities, isLoading }: OpportunitiesTabProps) {
  if (isLoading) return <TabSkeleton rows={4} />;

  if (!opportunities || opportunities.length === 0) {
    return (
      <div className="rounded-xl border border-dashed py-12 text-center">
        <p className="text-sm font-medium">No opportunities detected</p>
        <p className="mt-1 text-xs text-muted-foreground max-w-sm mx-auto">
          Opportunities are generated when there is sufficient performance data — try a wider date range.
        </p>
      </div>
    );
  }

  const highPriority = opportunities.filter((o) => o.priority === "high");
  const medLow = opportunities.filter((o) => o.priority !== "high");

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Prioritised optimisation opportunities ranked by potential impact. Each card shows the evidence,
        expected outcome, and effort required.
      </p>

      {highPriority.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)]">
            High Priority
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {highPriority.map((opp) => (
              <GadsOpportunityCard key={opp.id} {...opp} />
            ))}
          </div>
        </div>
      )}

      {medLow.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Medium / Low Priority
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {medLow.map((opp) => (
              <GadsOpportunityCard key={opp.id} {...opp} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
