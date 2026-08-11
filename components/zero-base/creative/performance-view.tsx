"use client";

/**
 * Creative performance (H21).
 *
 * A collection of served creatives with their media, their metrics and — only
 * when the engine is genuinely serving — a decision affordance. At 390 and 320
 * the rows stay complete: every metric that exists at 1440 exists there too,
 * stacked rather than dropped, because a metric silently missing on mobile is a
 * different surface pretending to be the same one.
 */
import Link from "next/link";

import { DataTable } from "@/components/zero-base/collections/data-table";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import { postureView, type EnginePosture } from "@/lib/zero-base/creative/engine-posture";
import {
  creativeDetailHref,
  decisionsHrefForCreative,
  type MetricValue,
  type PerformanceViewModel,
} from "@/lib/zero-base/creative/performance-adapter";
import { CreativeMedia } from "@/components/zero-base/creative/creative-media";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

function Metric({ value, name }: { value: MetricValue; name: string }) {
  const t = useCopy();
  if (!value.available) {
    // Never 0: an absent measurement and a measured zero are different facts.
    return (
      <span data-metric-unavailable={name} style={{ color: "var(--ledger-ink-tertiary)" }}>
        {t.notServed}
        <span style={{ display: "block", fontSize: 12 }}>{value.reason}</span>
      </span>
    );
  }
  return (
    <span data-metric={name} data-metric-raw={String(value.raw)}>
      {value.display}
    </span>
  );
}

export function CreativePerformanceView({
  model,
  businessId,
  unavailableReason,
}: {
  model: PerformanceViewModel;
  businessId: string;
  unavailableReason?: string | null;
}) {
  const t = useCopy();
  const copy = useCopy();
  const posture = postureView(model.posture);

  if (unavailableReason) {
    return (
      <div data-creative-performance="">
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>
          {copy.creativePerformance}
        </h1>
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      </div>
    );
  }

  return (
    <div data-creative-performance="">
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>
        {copy.creativePerformance}
      </h1>

      {/* The posture is stated on the surface, not implied by what is absent. */}
      <p
        data-engine-posture={posture.posture}
        data-el="engine-posture"
        style={{ margin: "8px 0 0", fontSize: 12.5, lineHeight: "18px", color: "var(--ledger-ink-secondary)" }}
      >
        <strong style={{ fontWeight: 600 }}>{posture.label}.</strong> {posture.explanation}
      </p>

      <p
        data-performance-disclosure=""
        style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}
      >
        {model.disclosure.text}
      </p>

      <div style={{ marginTop: 16 }}>
        <DataTable
          collection="creatives"
          caption={copy.creativePerformance}
          rows={model.rows}
          rowKey={(row) => row.id}
          columns={[
            {
              id: "creative",
              header: "Creative",
              render: (row) => (
                <span data-creative-cell={row.creativeId} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <CreativeMedia state={row.media} label={row.name} />
                  <span>
                    <Link
                      href={creativeDetailHref({
                        businessId,
                        creativeId: row.creativeId,
                        accountId: row.accountId,
                      })}
                      data-creative-detail-link={row.creativeId}
                      data-ctl="live:CREATIVE-02 open"
                      style={{ color: "var(--ledger-accent-action)", fontWeight: 600 }}
                    >
                      {row.name}
                    </Link>
                    <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                      {row.campaignName ?? "Campaign not served"}
                      {row.adsetName ? ` · ${row.adsetName}` : ""}
                    </span>
                  </span>
                </span>
              ),
            },
            { id: "spend", header: "Spend", numeric: true, render: (row) => <Metric value={row.spend} name="spend" /> },
            { id: "roas", header: "ROAS", numeric: true, render: (row) => <Metric value={row.roas} name="roas" /> },
            { id: "cpa", header: "CPA", numeric: true, render: (row) => <Metric value={row.cpa} name="cpa" /> },
            {
              id: "purchases",
              header: "Purchases",
              numeric: true,
              render: (row) => <Metric value={row.purchases} name="purchases" />,
            },
            {
              id: "decision",
              header: "Decision",
              render: (row) =>
                // Zero affordances unless the engine is genuinely serving.
                model.posture === "serving" ? (
                  <Link
                    href={decisionsHrefForCreative({ businessId, row })}
                    data-decision-link={row.creativeId}
                    style={{ color: "var(--ledger-accent-action)" }}
                  >
                    {t.openInDecisions}
                  </Link>
                ) : (
                  <span data-decision-withheld={row.creativeId} style={{ color: "var(--ledger-ink-tertiary)" }}>
                    {posture.label}
                  </span>
                ),
            },
          ]}
        />
      </div>
    </div>
  );
}
