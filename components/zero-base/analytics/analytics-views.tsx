"use client";

/**
 * The four analytics leaves (H34–H36 plus the landing-page leaf).
 *
 * Every surface states its sources, and a source that did not answer is named
 * rather than folded into an empty table. At 320 the tables become stacked
 * cards so no column is dropped — a metric missing on mobile is a different
 * surface pretending to be the same one.
 */
import { DataTable } from "@/components/zero-base/collections/data-table";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import {
  GEO_PROXY_DISCLOSURE,
  GEO_TOP_THREE_DISCLOSURE,
  dualSourceState,
  type AdaptedGeo,
  type AdaptedInsight,
  type AnalyticsValue,
  type SeoRoleState,
  type SourcePanel,
} from "@/lib/zero-base/analytics/analytics-contract";

export function SourcePanels({ panels }: { panels: readonly SourcePanel[] }) {
  const state = dualSourceState(panels);
  return (
    <section aria-label="Sources" style={{ marginTop: 8 }}>
      <ul data-source-panels={state.kind} style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
        {panels.map((panel) => (
          <li key={panel.kind} data-source-panel={panel.kind} style={{ fontSize: 12.5 }}>
            <strong style={{ fontWeight: 600 }}>{panel.label}:</strong>{" "}
            {panel.connected ? (
              <span data-source-connected={panel.kind}>Connected</span>
            ) : (
              <span data-source-down={panel.kind} style={{ color: "var(--ledger-semantic-warn)" }}>
                {panel.error}
              </span>
            )}
          </li>
        ))}
      </ul>
      {state.reason ? (
        <p data-source-degraded="" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
          {state.reason}
        </p>
      ) : null}
    </section>
  );
}

export function Value({ value, name }: { value: AnalyticsValue; name: string }) {
  if (!value.available) {
    return (
      <span data-value-unavailable={name} style={{ color: "var(--ledger-ink-tertiary)" }}>
        Not served
        <span style={{ display: "block", fontSize: 11 }}>{value.reason}</span>
      </span>
    );
  }
  return (
    <span data-value={name} data-measured-zero={value.measuredZero ? "true" : "false"}>
      {value.display}
    </span>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div data-analytics-surface={title.toLowerCase().replace(/\s+/g, "-")}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{title}</h1>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------ GA4/Shopify */

export function SourceOverviewView({
  panels,
  rows,
  capText,
  insight,
  unavailableReason,
}: {
  panels: readonly SourcePanel[];
  rows: readonly { id: string; label: string; sessions: AnalyticsValue; revenue: AnalyticsValue }[];
  capText: string;
  insight: AdaptedInsight;
  unavailableReason?: string | null;
}) {
  return (
    <Shell title="GA4 and Shopify">
      <SourcePanels panels={panels} />
      {unavailableReason ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      ) : (
        <>
          <p data-cap-text="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            {capText}
          </p>
          <div style={{ marginTop: 12 }}>
            <DataTable
              caption="Sessions and revenue"
              rows={[...rows]}
              rowKey={(row) => row.id}
              columns={[
                { id: "label", header: "Source", render: (row) => row.label },
                { id: "sessions", header: "Sessions", numeric: true, render: (row) => <Value value={row.sessions} name="sessions" /> },
                { id: "revenue", header: "Revenue", numeric: true, render: (row) => <Value value={row.revenue} name="revenue" /> },
              ]}
            />
          </div>
        </>
      )}

      <section aria-label="Latest AI insight" style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Latest AI insight</h2>
        {insight.absentReason ? (
          <p data-insight="absent" style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ledger-ink-tertiary)" }}>
            {insight.absentReason}
          </p>
        ) : (
          <p data-insight="present" style={{ margin: "4px 0 0", fontSize: 13 }}>
            {insight.text}
            {insight.generatedAt ? (
              <span style={{ display: "block", fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
                Generated {insight.generatedAt}
              </span>
            ) : null}
          </p>
        )}
        {/* Read only. There is no generate control here, and no code path to one. */}
        <p data-insight-read-only="" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
          This surface reads the latest insight. It does not generate one.
        </p>
      </section>
    </Shell>
  );
}

/* --------------------------------------------------- landing pages/products */

export function AnalyticsTableView({
  title,
  panels,
  rows,
  columns,
  capText,
  unavailableReason,
}: {
  title: string;
  panels: readonly SourcePanel[];
  rows: readonly { id: string; cells: Record<string, AnalyticsValue | string> }[];
  columns: readonly { id: string; header: string; numeric?: boolean }[];
  capText: string;
  unavailableReason?: string | null;
}) {
  return (
    <Shell title={title}>
      <SourcePanels panels={panels} />
      {unavailableReason ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      ) : (
        <>
          <p data-cap-text="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            {capText}
          </p>
          <div style={{ marginTop: 12 }}>
            <DataTable
              caption={title}
              rows={[...rows]}
              rowKey={(row) => row.id}
              columns={columns.map((column) => ({
                id: column.id,
                header: column.header,
                numeric: column.numeric,
                render: (row: { cells: Record<string, AnalyticsValue | string> }) => {
                  const cell = row.cells[column.id];
                  if (typeof cell === "string") return cell;
                  return cell ? <Value value={cell} name={column.id} /> : "—";
                },
              }))}
            />
          </div>
        </>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------- SEO */

export function SeoView({
  panels,
  role,
  findings,
  unavailableReason,
}: {
  panels: readonly SourcePanel[];
  role: SeoRoleState;
  findings: readonly { id: string; title: string; detail: string | null }[];
  unavailableReason?: string | null;
}) {
  return (
    <Shell title="SEO">
      <SourcePanels panels={panels} />
      {role.allowed ? null : (
        <p data-seo-role-blocked="" style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
          {role.reason}
        </p>
      )}
      {unavailableReason ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      ) : findings.length === 0 ? (
        <p data-seo-findings="empty" style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--ledger-ink-tertiary)" }}>
          No SEO findings were served for this window.
        </p>
      ) : (
        <ul data-seo-findings="ready" style={{ margin: "12px 0 0", paddingLeft: 18 }}>
          {findings.map((finding) => (
            <li key={finding.id} data-seo-finding={finding.id} style={{ fontSize: 12.5 }}>
              {finding.title}
              {finding.detail ? (
                <span style={{ display: "block", color: "var(--ledger-ink-tertiary)" }}>{finding.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------- GEO */

export function GeoView({ geo, unavailableReason }: { geo: AdaptedGeo | null; unavailableReason?: string | null }) {
  if (!geo || unavailableReason) {
    return (
      <Shell title="GEO">
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason ?? "GEO could not be composed."} />
        </div>
      </Shell>
    );
  }
  return (
    <Shell title="GEO">
      <SourcePanels panels={geo.sources} />

      <section aria-label="AI page reach" style={{ marginTop: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>AI-visited pages</h2>
        <p style={{ margin: "4px 0 0", fontSize: 13 }}>
          <Value value={geo.aiPageCount} name="aiPageCount" />
        </p>
        {/* Always shown: the number is a capped proxy whether or not it is at
            the ceiling, and printing it bare reports a ceiling as a count. */}
        <p data-geo-proxy-disclosure="" style={{ margin: "4px 0 0", fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
          {GEO_PROXY_DISCLOSURE}
        </p>
        {geo.atProxyCap ? (
          <p data-geo-at-cap="" style={{ margin: "4px 0 0", fontSize: 11, color: "var(--ledger-semantic-warn)" }}>
            This value is at the cap.
          </p>
        ) : null}
      </section>

      <section aria-label="Priorities" style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Top priorities</h2>
        <ol data-geo-priorities="" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {geo.priorities.map((item) => (
            <li key={item.title} data-geo-priority={item.priority} style={{ fontSize: 12.5 }}>
              {item.title}
              {item.detail ? (
                <span style={{ display: "block", color: "var(--ledger-ink-tertiary)" }}>{item.detail}</span>
              ) : null}
            </li>
          ))}
        </ol>
        <p data-geo-top-three-disclosure="" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
          {GEO_TOP_THREE_DISCLOSURE}
        </p>
      </section>
    </Shell>
  );
}
