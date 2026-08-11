"use client";

/**
 * Source health and the banner stack.
 *
 * Hard and partial banners are shown together. Collapsing to "the worst one"
 * hides that two different things are wrong and, worse, makes a partial source
 * look resolved the moment a hard one appears.
 *
 * Freshness is never claimed without a timestamp to claim it from: an absent
 * one renders "unknown", not "fresh".
 */
import type { HomeBanner, HomeSourceState } from "@/lib/zero-base/home/metric-contract";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

const FRESHNESS_WORD = {
  fresh: "fresh",
  stale: "stale",
  unknown: "unknown",
} as const;

export function BannerStack({ banners }: { banners: readonly HomeBanner[] }) {
  if (banners.length === 0) return null;
  return (
    <div data-banner-stack="" style={{ display: "grid", gap: 8, marginBottom: 16 }}>
      {banners.map((banner) => (
        <p
          key={`${banner.severity}:${banner.key}`}
          role="status"
          data-banner={banner.severity}
          data-banner-key={banner.key}
          style={{
            margin: 0,
            padding: "10px 14px",
            borderRadius: "var(--ledger-radius-card)",
            fontSize: 13,
            lineHeight: "19px",
            border: `1px solid ${
              banner.severity === "hard"
                ? "var(--ledger-semantic-danger)"
                : "var(--ledger-semantic-warn)"
            }`,
            color:
              banner.severity === "hard"
                ? "var(--ledger-semantic-danger)"
                : "var(--ledger-semantic-warn)",
          }}
        >
          {/* The severity word travels with the colour so meaning survives
              without it. */}
          <strong>{banner.severity === "hard" ? "Unavailable: " : "Incomplete: "}</strong>
          {banner.message}
        </p>
      ))}
    </div>
  );
}

/**
 * The way out of this row's state, named for what it actually does.
 *
 * A stale-but-connected source needs somewhere to see *why* it is stale; a
 * source with no property or site selected needs a picker, not a connect flow
 * it has already been through. The row said "Connect this source" to all three.
 */
function SourceRemedy({
  source,
  connectHref,
}: {
  source: HomeSourceState;
  connectHref: string | null;
}) {
  const copy = useCopy();
  const remedy = source.remedy ?? (source.state === "ok" ? "details" : "connect");
  const style = {
    display: "inline-flex",
    alignItems: "center",
    minHeight: 24,
    fontSize: 12,
    color: "var(--ledger-accent-action)",
  } as const;

  if (remedy === "connect") {
    return connectHref ? (
      <a href={connectHref} data-ctl="live:INTEGRATION-03" style={style}>
        {copy.connect}
      </a>
    ) : (
      <span style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>&mdash;</span>
    );
  }
  if (remedy === "select") {
    return connectHref ? (
      <a href={connectHref} data-ctl="live:SCOPE-06" style={style}>
        {copy.chooseSite}
      </a>
    ) : (
      <span style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>&mdash;</span>
    );
  }
  return (
    <a href="/admin/sync-health" data-ctl="live:HEALTH-01" style={style}>
      {copy.details}
    </a>
  );
}

export function SourceHealthPanel({
  sources,
  connectHref,
}: {
  sources: readonly HomeSourceState[];
  /** Where an unconfigured source is connected. Absent when none needs it. */
  connectHref?: string | null;
}) {
  const copy = useCopy();
  return (
    <section
      data-source-health=""
      aria-label={copy.sourceHealth}
      style={{
        borderRadius: "var(--ledger-radius-card)",
        border: "1px solid var(--ledger-border-subtle)",
        background: "var(--ledger-bg-surface)",
        padding: 16,
      }}
    >
      <h2 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 600, lineHeight: "22px" }}>
        {copy.whereNumbersFrom}
      </h2>
      <table
        data-collection="sources"
        style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
      >
        <caption style={{ textAlign: "left", fontSize: 12, color: "var(--ledger-ink-tertiary)", paddingBottom: 6 }}>
          {copy.eachSourceState}
        </caption>
        <thead>
          <tr>
            <th scope="col" style={{ textAlign: "left", padding: "6px 8px", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
              {copy.source}
            </th>
            <th scope="col" style={{ textAlign: "left", padding: "6px 8px", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
              {copy.state}
            </th>
            <th scope="col" style={{ textAlign: "left", padding: "6px 8px", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
              {copy.lastUpdated}
            </th>
            <th scope="col" style={{ textAlign: "left", padding: "6px 8px", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
              {copy.action}
            </th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.key} data-source={source.key} data-source-state={source.state}>
              <th scope="row" style={{ textAlign: "left", fontWeight: 500, padding: "6px 8px" }}>
                {source.label}
              </th>
              <td style={{ padding: "6px 8px" }}>
                {/* Word first, colour second. */}
                {source.state === "ok" ? "Serving" : source.state === "partial" ? "Incomplete" : "Unavailable"}
                {source.state !== "ok" && connectHref && (source.remedy ?? "connect") === "connect" ? (
                  <a
                    href={connectHref}
                    data-ctl="live:INTEGRATION-03 connect"
                    style={{ display: "block", fontSize: 12, color: "var(--ledger-accent-action)" }}
                  >
                    {copy.connectThisSource}
                  </a>
                ) : null}
                {source.reason ? (
                  <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                    {source.reason}
                  </span>
                ) : null}
              </td>
              <td style={{ padding: "6px 8px", fontFamily: "var(--font-adc-mono), ui-monospace, monospace", fontSize: 12 }}>
                {source.lastUpdatedAt ?? "Not recorded"}
                <span style={{ display: "block", color: "var(--ledger-ink-tertiary)" }}>
                  {FRESHNESS_WORD[source.freshness]}
                </span>
              </td>
              <td style={{ padding: "6px 8px" }}>
                <SourceRemedy source={source} connectHref={connectHref ?? null} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
