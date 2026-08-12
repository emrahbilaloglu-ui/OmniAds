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

function Metric({ value, name, compact = false }: { value: MetricValue; name: string; compact?: boolean }) {
  const t = useCopy();
  if (!value.available) {
    // Never 0: an absent measurement and a measured zero are different facts.
    return (
      <span data-metric-unavailable={name} title={value.reason} style={{ color: "var(--ledger-ink-tertiary)" }}>
        {t.notServed}
        {compact ? null : <span style={{ display: "block", fontSize: 12 }}>{value.reason}</span>}
      </span>
    );
  }
  return (
    <span data-metric={name} data-metric-raw={String(value.raw)}>
      {value.display}
    </span>
  );
}

function decisionTone(action: string | null): {
  color: string;
  background: string;
  border: string;
} {
  if (action === "cut" || action === "refresh") {
    return {
      color: "var(--ledger-semantic-danger)",
      background: "var(--ledger-bg-inset)",
      border: "var(--ledger-semantic-danger)",
    };
  }
  if (action === "scale" || action === "keep") {
    return {
      color: "var(--ledger-semantic-ok)",
      background: "var(--ledger-bg-inset)",
      border: "var(--ledger-semantic-ok)",
    };
  }
  return {
    color: "var(--ledger-ink-secondary)",
    background: "var(--ledger-bg-inset)",
    border: "var(--ledger-border-subtle)",
  };
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
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>
          {copy.creativeIntelligence}
        </h1>
        <span
          style={{
            padding: "2px 8px",
            border: "1px solid var(--ledger-accent-action)",
            borderRadius: 999,
            background: "var(--ledger-accent-tint)",
            color: "var(--ledger-accent-action)",
            fontFamily: "var(--font-adc-mono), monospace",
            fontSize: 12,
            lineHeight: "18px",
            textTransform: "uppercase",
          }}
        >
          {copy.metaScoped}
        </span>
      </div>

      {onPresetChange || onSortChange || onActionStateChange ? (
        <div
          data-creative-toolbar=""
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}
        >
          {onPresetChange ? (
            <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span>{copy.preset}</span>
              <select
                data-ctl="live:CREATIVE-12 preset"
                value={preset}
                onChange={(event) => onPresetChange(event.target.value)}
                style={{ minHeight: 34, padding: "4px 26px 4px 8px", borderRadius: 6 }}
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
            <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span>{copy.sort}</span>
              <select
                data-ctl="live:CREATIVE-12 sort"
                value={sort}
                onChange={(event) => onSortChange(event.target.value)}
                style={{ minHeight: 34, padding: "4px 26px 4px 8px", borderRadius: 6 }}
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
            <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span>{copy.actionState}</span>
              <select
                data-ctl="live:CREATIVE-13 filter"
                value={actionState}
                onChange={(event) => onActionStateChange(event.target.value)}
                style={{ minHeight: 34, padding: "4px 26px 4px 8px", borderRadius: 6 }}
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
          <span data-collection="creatives" style={{ display: "inline-flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
            <span
              data-performance-disclosure=""
              style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}
            >
              {model.disclosure.text}
            </span>
            {onLoadMore ? (
              <Button variant="quiet" data-ctl="live:META-DEC-05 load-more" onClick={onLoadMore}>
                {copy.loadMore}
              </Button>
            ) : null}
          </span>
        </div>
      ) : (
        <p
          data-performance-disclosure=""
          style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}
        >
          {model.disclosure.text}
        </p>
      )}


      <div style={{ marginTop: 16 }} data-collection="creatives">
        <div
          role="table"
          aria-label={copy.creativePerformance}
          style={{ border: "1px solid var(--ledger-border-subtle)", borderRadius: 12, overflow: "hidden", background: "var(--ledger-bg-surface)" }}
        >
          {model.rows.map((row) => {
            const tone = decisionTone(row.decision?.buyerAction ?? null);
            return (
              <div
                key={row.id}
                role="row"
                data-creative-row={row.creativeId}
                style={{
                  display: "grid",
                  gridTemplateColumns: "56px minmax(180px,1.7fr) minmax(110px,1fr) minmax(110px,1fr) minmax(150px,1.2fr) minmax(130px,1fr)",
                  gap: 12,
                  padding: "10px 16px",
                  alignItems: "center",
                  borderBottom: "1px solid var(--ledger-bg-inset)",
                }}
              >
                <span role="cell"><CreativeMedia state={row.media} label={row.name} /></span>
                <span role="cell" data-creative-cell={row.creativeId} style={{ minWidth: 0 }}>
                  <Link
                    href={creativeDetailHref({ businessId, creativeId: row.creativeId, accountId: row.accountId })}
                    data-creative-detail-link={row.creativeId}
                    data-ctl="live:CREATIVE-02 open"
                    style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ledger-ink-primary)", fontSize: 13, fontWeight: 600, textDecoration: "none" }}
                  >
                    {row.name}
                  </Link>
                  <span style={{ display: "block", fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                    {row.campaignName ?? copy.campaignNotServed}{row.adsetName ? ` · ${row.adsetName}` : ""}
                  </span>
                </span>
                <span role="cell" style={{ textAlign: "right", fontFamily: "var(--font-adc-mono), monospace", fontSize: 13 }}>
                  <Metric value={row.spend} name="spend" compact />
                  <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.spend}</span>
                </span>
                <span role="cell" style={{ textAlign: "right", fontFamily: "var(--font-adc-mono), monospace", fontSize: 13 }}>
                  <Metric value={row.roas} name="roas" compact />
                  <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                    ROAS / {row.decision?.effectiveTargetRoas !== null && row.decision?.effectiveTargetRoas !== undefined
                      ? `tgt ${row.decision.effectiveTargetRoas.toFixed(1)}`
                      : copy.targetNotServed}
                  </span>
                </span>
                <span role="cell">
                  <span style={{ display: "inline-flex", padding: "3px 9px", borderRadius: 6, border: `1px solid ${tone.border}`, background: tone.background, color: tone.color, fontSize: 12, fontWeight: 600 }}>
                    {row.decision?.buyerLabel ?? copy.noEngineVerdict}
                  </span>
                  <span style={{ display: "block", marginTop: 4, fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                    CPA <Metric value={row.cpa} name="cpa" compact /> · {copy.purchases} <Metric value={row.purchases} name="purchases" compact />
                  </span>
                </span>
                <span role="cell" style={{ fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
                  {row.decision?.decisionState ?? posture.label}
                  {model.posture === "serving" ? (
                    <Link
                      href={decisionsHrefForCreative({ businessId, row })}
                      data-decision-link={row.creativeId}
                      style={{ display: "block", marginTop: 3, color: "var(--ledger-accent-action)", fontWeight: 600 }}
                    >
                      {t.openInDecisions}
                    </Link>
                  ) : (
                    <span data-decision-withheld={row.creativeId} style={{ display: "block", marginTop: 3, color: "var(--ledger-ink-tertiary)" }}>
                      {posture.label}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
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
      <style>{`@media(max-width:900px){[data-creative-row]{grid-template-columns:44px minmax(150px,1fr) minmax(96px,.7fr) minmax(96px,.7fr) minmax(150px,1fr) minmax(120px,.8fr)!important;min-width:760px}[data-creative-toolbar]>[data-performance-disclosure]{margin-left:0!important;flex-basis:100%}}`}</style>
    </div>
  );
}
