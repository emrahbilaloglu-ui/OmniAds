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
import { ZeroBaseTabs } from "@/components/zero-base/primitives/tabs";
import { Button } from "@/components/zero-base/primitives/button";
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
  preset = "all",
  onPresetChange,
  sort = "spend",
  onSortChange,
  actionState = "any",
  onActionStateChange,
  onLoadMore,
}: {
  model: PerformanceViewModel;
  businessId: string;
  unavailableReason?: string | null;
  preset?: string;
  onPresetChange?: (value: string) => void;
  sort?: string;
  onSortChange?: (value: string) => void;
  /** Includes the legacy null state, which is a real value and not "any". */
  actionState?: string;
  onActionStateChange?: (value: string) => void;
  onLoadMore?: () => void;
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


      <p
        data-performance-disclosure=""
        style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}
      >
        {model.disclosure.text}
      </p>

      <ZeroBaseTabs
        label={copy.creativePerformance}
        value="served"
        onValueChange={() => {}}
        tabs={[
          { id: "served", label: copy.served, content: null },
          { id: "all", label: copy.all, content: null },
        ]}
      />

      {onPresetChange || onSortChange || onActionStateChange ? (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
          {onPresetChange ? (
            <label style={{ fontSize: 12, display: "grid", gap: 4 }}>
              {copy.preset}
              <select
                data-ctl="live:CREATIVE-12 preset"
                value={preset}
                onChange={(event) => onPresetChange(event.target.value)}
                style={{ minHeight: 44, padding: "6px 8px" }}
              >
                {["all", "scaling", "watch", "cut"].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {onSortChange ? (
            <label style={{ fontSize: 12, display: "grid", gap: 4 }}>
              {copy.sort}
              <select
                data-ctl="live:CREATIVE-12 sort"
                value={sort}
                onChange={(event) => onSortChange(event.target.value)}
                style={{ minHeight: 44, padding: "6px 8px" }}
              >
                {["spend", "roas", "cpa", "purchases"].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {onActionStateChange ? (
            <label style={{ fontSize: 12, display: "grid", gap: 4 }}>
              {copy.actionState}
              <select
                data-ctl="live:CREATIVE-13 filter"
                value={actionState}
                onChange={(event) => onActionStateChange(event.target.value)}
                style={{ minHeight: 44, padding: "6px 8px" }}
              >
                {/* "unset" is the legacy null state and a real value: rows
                    recorded before the engine assigned one are not "any". */}
                {["any", "acted", "deferred", "unset"].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}


      <div style={{ marginTop: 16 }} data-collection="creatives">
        <DataTable
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
        {onLoadMore ? (
          <Button
            variant="secondary"
            data-ctl="live:META-DEC-05 load-more"
            onClick={onLoadMore}
            style={{ marginTop: 8 }}
          >
            {copy.loadMore}
          </Button>
        ) : null}
      </div>
      {/* The posture is stated on the surface, not implied by what is absent —
          after the creatives it describes, where the reference places it. */}
      <p
        data-engine-posture={posture.posture}
        data-el="engine-posture"
        style={{ margin: "8px 0 0", fontSize: 12, lineHeight: "18px", color: "var(--ledger-ink-secondary)" }}
      >
        <strong style={{ fontWeight: 600 }}>{posture.label}.</strong> {posture.explanation}
      </p>
    </div>
  );
}
