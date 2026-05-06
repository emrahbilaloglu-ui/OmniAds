import { Badge } from "@/components/ui/badge";
import type { CommandCenterHistoricalIntelligence } from "@/lib/command-center";

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatLabel(value: string) {
  return value.replaceAll("_", " ");
}

export function CommandCenterHistoricalIntelligencePanel({
  intelligence,
}: {
  intelligence: CommandCenterHistoricalIntelligence;
}) {
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
      data-testid="command-center-historical-intelligence"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Historical Intelligence
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">
            Selected-period analysis and self-tuning
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Selected period {intelligence.selectedWindow.startDate} to{" "}
            {intelligence.selectedWindow.endDate}. {intelligence.selectedWindow.note}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            Action core {formatPercent(intelligence.decisionQuality.suppressionRates.actionCore)}
          </Badge>
          <Badge variant="outline">
            Watchlist {formatPercent(intelligence.decisionQuality.suppressionRates.watchlist)}
          </Badge>
          <Badge variant="outline">
            Archive {formatPercent(intelligence.decisionQuality.suppressionRates.archive)}
          </Badge>
          <Badge variant="outline">
            Degraded {formatPercent(intelligence.decisionQuality.suppressionRates.degraded)}
          </Badge>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div
          className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"
          data-testid="command-center-campaign-family-summary"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-950">
              Selected-period Meta campaign families
            </h3>
            <span className="text-[11px] text-slate-500">descriptive only</span>
          </div>
          <div className="mt-3 space-y-2">
            {intelligence.campaignFamilies.map((family) => (
              <div
                key={family.family}
                className="rounded-xl border border-slate-200 bg-white p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-950">
                      {family.familyLabel}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">{family.summary}</p>
                  </div>
                  <div className="text-right text-xs text-slate-600">
                    <p>{family.campaignCount} campaigns</p>
                    <p>{family.activeCampaignCount} active</p>
                  </div>
                </div>
              </div>
            ))}
            {intelligence.campaignFamilies.length === 0 ? (
              <p className="text-sm text-slate-500">
                No selected-period Meta campaign-family summary is available.
              </p>
            ) : null}
          </div>
        </div>

        <div
          className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"
          data-testid="command-center-decision-quality"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-950">Decision quality</h3>
            <span className="text-[11px] text-slate-500">queue observability</span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {[
              ["Actionable", intelligence.decisionQuality.actionableCount],
              ["Selected", intelligence.decisionQuality.selectedCount],
              ["Overflow", intelligence.decisionQuality.overflowCount],
              ["Queue gaps", intelligence.decisionQuality.queueGapCount],
              ["False positives", intelligence.decisionQuality.falsePositiveCount],
              ["False negatives", intelligence.decisionQuality.falseNegativeCount],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2"
              >
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  {label}
                </p>
                <p className="mt-1 text-xl font-semibold text-slate-950">{value}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 space-y-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                False-positive hotspots
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {intelligence.decisionQuality.falsePositiveHotspots.map((hotspot) => (
                  <Badge
                    key={hotspot.key}
                    variant="outline"
                    className="border-amber-200 bg-amber-50 text-amber-700"
                  >
                    {hotspot.label}: {hotspot.count}
                  </Badge>
                ))}
                {intelligence.decisionQuality.falsePositiveHotspots.length === 0 ? (
                  <span className="text-sm text-slate-500">
                    No repeated false-positive hotspot is visible.
                  </span>
                ) : null}
              </div>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                False-negative hotspots
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {intelligence.decisionQuality.falseNegativeHotspots.map((hotspot) => (
                  <Badge
                    key={hotspot.key}
                    variant="outline"
                    className="border-sky-200 bg-sky-50 text-sky-700"
                  >
                    {hotspot.label}: {hotspot.count}
                  </Badge>
                ))}
                {intelligence.decisionQuality.falseNegativeHotspots.length === 0 ? (
                  <span className="text-sm text-slate-500">
                    No repeated queue-gap hotspot is visible.
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <div
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4"
          data-testid="command-center-degraded-guidance"
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-800">
            Degraded guidance
          </p>
          <p className="mt-2 text-sm font-semibold text-amber-950">
            {intelligence.degradedGuidance.summary}
          </p>
          {intelligence.degradedGuidance.missingInputs.length > 0 ? (
            <p className="mt-2 text-xs text-amber-900">
              Missing inputs: {intelligence.degradedGuidance.missingInputs.join(", ")}.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {intelligence.degradedGuidance.reasons.map((reason) => (
              <Badge
                key={reason}
                variant="outline"
                className="border-amber-300 bg-white text-amber-800"
              >
                {reason}
              </Badge>
            ))}
            {intelligence.degradedGuidance.reasons.length === 0 ? (
              <span className="text-sm text-amber-900">
                No dominant degraded reason is currently repeating.
              </span>
            ) : null}
          </div>
        </div>

        <div
          className="rounded-2xl border border-slate-200 bg-white p-4"
          data-testid="command-center-calibration-suggestions"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-950">
              Deterministic calibration suggestions
            </h3>
            <span className="text-[11px] text-slate-500">tune next</span>
          </div>
          <div className="mt-3 space-y-2">
            {intelligence.calibrationSuggestions.map((suggestion) => (
              <div
                key={suggestion.key}
                className="rounded-xl border border-slate-200 bg-slate-50/70 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-950">
                      {suggestion.title}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      {suggestion.detail}
                    </p>
                  </div>
                  <Badge variant="outline">{formatLabel(suggestion.priority)}</Badge>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  {suggestion.evidence}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
