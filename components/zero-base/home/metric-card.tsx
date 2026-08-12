"use client";

/**
 * A KPI card.
 *
 * The card renders what the contract decided; it computes no truth of its own.
 * Three things it must never do, each of which the legacy card did:
 *
 * - render a missing comparison as `0.0%`;
 * - colour a delta from its arrow, which made a rising CPA look like rising
 *   revenue;
 * - print a currency symbol for a currency nobody has observed.
 */
import {
  comparisonSentiment,
  comparisonUnavailableCopy,
  type HomeMetric,
} from "@/lib/zero-base/home/metric-contract";
import { Sparkline } from "@/components/zero-base/home/sparkline";

const SENTIMENT_COLOUR: Record<"positive" | "negative" | "neutral", string> = {
  positive: "var(--ledger-semantic-ok)",
  negative: "var(--ledger-semantic-danger)",
  neutral: "var(--ledger-ink-secondary)",
};

const ARROW_GLYPH: Record<"up" | "down" | "flat", string> = {
  up: "▲",
  down: "▼",
  flat: "→",
};

function formatValue(metric: HomeMetric): string {
  if (metric.value === null) return "—";
  switch (metric.unit) {
    case "currency": {
      const amount = new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(metric.value);
      // No symbol unless the currency is known: an unknown currency rendered
      // as "$" is a claim about which money this is.
      return metric.money?.currency ? `${metric.money.currency} ${amount}` : amount;
    }
    case "percent":
      return `${metric.value.toFixed(1)}%`;
    case "ratio":
      return metric.value.toFixed(2);
    default:
      return new Intl.NumberFormat("en-US").format(metric.value);
  }
}

export function MetricCard({ metric }: { metric: HomeMetric }) {
  const sentiment = comparisonSentiment(metric);
  const unavailable = metric.availability === "unavailable";

  return (
    <article
      data-metric-card={metric.key}
      data-availability={metric.availability}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 16,
        minWidth: 0,
        borderRadius: "var(--ledger-radius-card)",
        border: unavailable
          ? "1px dashed var(--ledger-border-control)"
          : "1px solid var(--ledger-border-subtle)",
        background: unavailable ? "transparent" : "var(--ledger-bg-surface)",
      }}
    >
      <h3 style={{ margin: 0, fontSize: 12, fontWeight: 500, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}>
        {metric.title}
      </h3>

      <p
        data-metric-value=""
        style={{
          margin: 0,
          fontFamily: "var(--font-adc-mono), ui-monospace, monospace",
          fontSize: 20,
          fontWeight: 700,
          lineHeight: "26px",
          color: unavailable ? "var(--ledger-ink-tertiary)" : "var(--ledger-ink-primary)",
        }}
      >
        {formatValue(metric)}
      </p>

      {/* Money says whether its currency was observed or merely configured. */}
      {metric.money && metric.value !== null ? (
        <p data-money-proof={metric.money.proof} style={{ margin: 0, fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}>
          {metric.money.currency
            ? metric.money.proven
              ? "Account currency, observed"
              : "Account currency, configured — not observed"
            : "Currency unknown"}
        </p>
      ) : null}

      {metric.comparison.available ? (
        <p
          data-comparison="available"
          data-sentiment={sentiment}
          style={{ margin: 0, fontSize: 12, lineHeight: "16px", color: SENTIMENT_COLOUR[sentiment] }}
        >
          {/* The arrow is arithmetic; the colour is meaning. They are read from
              two different fields precisely because they disagree. */}
          <span aria-hidden="true">{ARROW_GLYPH[metric.comparison.arrow]} </span>
          {metric.comparison.changePercent === null
            ? "changed"
            : `${Math.abs(metric.comparison.changePercent).toFixed(1)}%`}{" "}
          <span style={{ color: "var(--ledger-ink-tertiary)" }}>{metric.comparison.basisLabel}</span>
        </p>
      ) : (
        <p
          data-comparison="unavailable"
          data-comparison-reason={metric.comparison.reason}
          style={{ margin: 0, fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}
        >
          {comparisonUnavailableCopy(metric.comparison)}
        </p>
      )}

      {metric.reason ? (
        <p data-metric-reason="" style={{ margin: 0, fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}>
          {metric.reason}
        </p>
      ) : null}

      {metric.sparkline.length > 0 ? (
        <Sparkline title={metric.title} points={metric.sparkline} unit={metric.unit} />
      ) : null}

      <p style={{ margin: 0, fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}>
        {metric.source.label}
      </p>
    </article>
  );
}
