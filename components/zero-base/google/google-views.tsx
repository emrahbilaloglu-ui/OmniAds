"use client";

/**
 * The five Google read leaves (H29–H31).
 *
 * They share a header that always states the account scope, because a figure
 * from one account and a figure across a portfolio are different facts and the
 * difference is invisible without saying it.
 */
import { DataTable } from "@/components/zero-base/collections/data-table";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import {
  ADVISOR_HORIZON_LABEL,
  groupAdvisor,
  referenceCardComplete,
  type AdvisorHorizon,
  type GoogleScope,
  type GoogleSourceState,
  type GoogleValue,
  type ReferenceCard,
  type ServedAdvisorItem,
} from "@/lib/zero-base/google/google-contract";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export function GoogleScopeHeader({ title, scope }: { title: string; scope: GoogleScope }) {
  return (
    <header>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{title}</h1>
      {scope.kind === "none" ? (
        <p data-google-scope="none" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
          {scope.reason}
        </p>
      ) : (
        <p data-google-scope={scope.kind} style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {scope.kind === "single" ? "Single account: " : "Portfolio: "}
          {scope.label}
          {scope.kind === "portfolio" && scope.unsummableReason ? (
            <span data-google-unsummable="" style={{ display: "block", color: "var(--ledger-semantic-warn)" }}>
              {scope.unsummableReason}
            </span>
          ) : null}
        </p>
      )}
    </header>
  );
}

export function GoogleSourceBadge({ state }: { state: GoogleSourceState }) {
  if (state.kind === "serving") {
    return (
      <p data-google-source="serving" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
        Serving{state.observedAt ? ` · observed ${state.observedAt}` : ""}
      </p>
    );
  }
  const tone =
    state.kind === "unavailable" ? "var(--ledger-semantic-danger)" : "var(--ledger-semantic-warn)";
  return (
    <p data-google-source={state.kind} style={{ margin: "6px 0 0", fontSize: 12, color: tone }}>
      {state.kind === "rate_limited"
        ? `Rate limited by Google. ${state.reason}${
            state.retryAfterSeconds ? ` Retry in ${state.retryAfterSeconds}s.` : ""
          }`
        : state.reason}
    </p>
  );
}

export function GoogleMetric({ value, name }: { value: GoogleValue; name: string }) {
  const t = useCopy();
  if (!value.available) {
    // Unavailable is not zero. A zero here would be a measurement nobody took.
    return (
      <span data-google-unavailable={name} style={{ color: "var(--ledger-ink-tertiary)" }}>
        {t.notServed}
        <span style={{ display: "block", fontSize: 12 }}>{value.reason}</span>
      </span>
    );
  }
  return (
    <span data-google-metric={name} data-google-raw={String(value.raw)}>
      {value.display}
    </span>
  );
}

/* --------------------------------------------------------------- overview */

export function GoogleOverviewView({
  scope,
  source,
  rows,
  portfolioMode = false,
  onPortfolioChange,
  unavailableReason,
}: {
  scope: GoogleScope;
  source: GoogleSourceState;
  /** One row per account. Merged Overview/Pulse without collapsing scope. */
  rows: readonly { id: string; account: string; spend: GoogleValue; conversions: GoogleValue; pulse: string }[];
  /** Portfolio mode is labelled; a mixed-currency portfolio withholds totals. */
  portfolioMode?: boolean;
  onPortfolioChange?: (on: boolean) => void;
  unavailableReason?: string | null;
}) {
  const copy = useCopy();
  return (
    <div data-google-surface="overview">
      <GoogleScopeHeader title={copy.googleOverview} scope={scope} />
      <GoogleSourceBadge state={source} />
      {unavailableReason ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          {onPortfolioChange ? (
            <label
              data-el="google-vocab"
              style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, margin: "0 0 8px" }}
            >
              <input
                type="checkbox"
                data-ctl="live:GOOGLE-32 portfolio"
                checked={portfolioMode}
                onChange={(event) => onPortfolioChange(event.target.checked)}
              />
              {/* Google's own vocabulary, not Meta's: these are campaigns and
                  accounts, and a portfolio of mixed currencies withholds
                  totals rather than summing across them. */}
              <span>{copy.portfolioMode}</span>
            </label>
          ) : null}
          <DataTable
            collection="gcamps"
            caption={copy.googleOverviewByAccount}
            rows={[...rows]}
            rowKey={(row) => row.id}
            columns={[
              { id: "account", header: "Account", render: (row) => row.account },
              { id: "spend", header: "Spend", numeric: true, render: (row) => <GoogleMetric value={row.spend} name="spend" /> },
              {
                id: "conversions",
                header: "Conversions",
                numeric: true,
                render: (row) => <GoogleMetric value={row.conversions} name="conversions" />,
              },
              { id: "pulse", header: "Pulse", render: (row) => row.pulse },
            ]}
          />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- advisor */

export function GoogleAdvisorView({
  scope,
  source,
  items,
  referenceCards,
  bucket = null,
  onBucketChange,
  onOpenCard,
}: {
  scope: GoogleScope;
  source: GoogleSourceState;
  items: readonly ServedAdvisorItem[];
  referenceCards: readonly ReferenceCard[];
  /** Null shows every horizon. */
  bucket?: string | null;
  onBucketChange?: (horizon: string | null) => void;
  onOpenCard?: (id: string) => void;
}) {
  const t = useCopy();
  const copy = useCopy();
  const groups = groupAdvisor(items);
  return (
    <div data-google-surface="advisor">
      <GoogleScopeHeader title={copy.googleAdvisor} scope={scope} />
      <GoogleSourceBadge state={source} />

      {/*
        Bucket filters. The horizons come from the server's own urgency, so the
        filter narrows what is shown and never re-ranks: deciding priority is
        the advisor's job, not this surface's.
      */}
      <div
        data-el="advisor-buckets"
        role="group"
        aria-label={copy.horizon}
        style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}
      >
        {groups.map((group) => (
          <button
            key={group.horizon}
            type="button"
            data-ctl="live:GOOGLE-13 bucket"
            aria-pressed={bucket === group.horizon}
            onClick={() => onBucketChange?.(bucket === group.horizon ? null : group.horizon)}
            style={{
              minHeight: 32,
              padding: "4px 10px",
              fontSize: 12,
              borderRadius: "var(--ledger-radius-control)",
              border: "1px solid var(--ledger-border-control)",
              background:
                bucket === group.horizon ? "var(--ledger-accent-tint)" : "var(--ledger-bg-surface)",
              color: "var(--ledger-ink-primary)",
              cursor: "pointer",
            }}
          >
            {ADVISOR_HORIZON_LABEL[group.horizon as AdvisorHorizon]} ({group.items.length})
          </button>
        ))}
      </div>

      {groups
        .filter((group) => bucket === null || group.horizon === bucket)
        .map((group) => (
        <section key={group.horizon} aria-label={group.label} style={{ marginTop: 16 }}>
          <h2 data-advisor-horizon={group.horizon} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {ADVISOR_HORIZON_LABEL[group.horizon as AdvisorHorizon]}
          </h2>
          {group.items.length === 0 ? (
            <p data-advisor-empty={group.horizon} style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
              {copy.nothingInHorizon}
            </p>
          ) : (
            <ul data-collection="advisor" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {group.items.map((item) => (
                <li key={item.id} data-advisor-item={group.horizon} style={{ fontSize: 12 }}>
                  {onOpenCard ? (
                    <button
                      type="button"
                      data-ctl="live:GOOGLE-16 open-card"
                      onClick={() => onOpenCard(item.id)}
                      style={{
                        background: "none",
                        border: 0,
                        padding: 0,
                        color: "var(--ledger-accent-action)",
                        cursor: "pointer",
                        fontSize: 12,
                        textAlign: "left",
                      }}
                    >
                      {item.title}
                    </button>
                  ) : (
                    item.title
                  )}
                  {item.rationale ? (
                    <span style={{ display: "block", color: "var(--ledger-ink-tertiary)" }}>{item.rationale}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <section aria-label={copy.reference} style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{t.referenceNotEnabled}</h2>
        <p style={{ margin: "4px 0 8px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          These are proposals this product will not perform. They are shown so the reasoning is
          inspectable, not because a switch is pending.
        </p>
        {referenceCards.filter(referenceCardComplete).map((card) => (
          <div
            key={card.id}
            data-reference-card={card.id}
            data-el="default-off-card"
            style={{
              display: "grid",
              gap: 4,
              padding: "10px 14px",
              marginTop: 8,
              borderRadius: "var(--ledger-radius-card)",
              border: "1px dashed var(--ledger-border-control)",
              fontSize: 12,
            }}
          >
            <strong style={{ fontWeight: 600 }}>{card.title}</strong>
            <span data-card-reason="">Why it is off: {card.reason}</span>
            {/* The fingerprint is what makes two runs comparable, and the
                stabilization window is what makes a signal trustworthy. Both
                are shown so "off by default" is a stated posture rather than
                an unexplained absence. */}
            <span data-card-fingerprint="">
              Fingerprint: {card.fingerprint}
            </span>
            <span data-card-dependency="">Depends on: {card.dependency}</span>
            <span data-card-stabilization="">Stabilization: {card.stabilization}</span>
            <span data-card-unverified="">Not verified: {card.unverified}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

/* --------------------------------------------- search / products / assets */

export function GoogleCollectionView({
  title,
  scope,
  source,
  rows,
  columns,
  capText,
  unavailableReason,
}: {
  title: string;
  scope: GoogleScope;
  source: GoogleSourceState;
  rows: readonly { id: string; cells: Record<string, GoogleValue | string> }[];
  columns: readonly { id: string; header: string; numeric?: boolean }[];
  capText: string | null;
  unavailableReason?: string | null;
}) {
  return (
    <div data-google-surface={title.toLowerCase().replace(/\s+/g, "-")}>
      <GoogleScopeHeader title={title} scope={scope} />
      <GoogleSourceBadge state={source} />
      {capText ? (
        <p data-google-cap="" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {capText}
        </p>
      ) : null}
      {unavailableReason ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          <DataTable
            caption={title}
            rows={[...rows]}
            rowKey={(row) => row.id}
            columns={columns.map((column) => ({
              id: column.id,
              header: column.header,
              numeric: column.numeric,
              render: (row: { id: string; cells: Record<string, GoogleValue | string> }) => {
                const cell = row.cells[column.id];
                if (typeof cell === "string") return cell;
                return cell ? <GoogleMetric value={cell} name={column.id} /> : "—";
              },
            }))}
          />
        </div>
      )}
    </div>
  );
}
