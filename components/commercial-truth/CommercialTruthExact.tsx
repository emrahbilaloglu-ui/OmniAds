"use client";

/**
 * Commercial Truth — the Dashboard v2 screen, rendered exactly.
 *
 * Presentational only: it takes a view model and three callbacks, and owns no
 * knowledge of where the numbers came from. The scenario guide's spend and ROAS
 * columns are the one piece of local state, because the design makes them a
 * what-if the operator drives from the keyboard.
 */
import { useMemo, useState, type CSSProperties } from "react";

import styles from "@/components/commercial-truth/CommercialTruthExact.module.css";
import {
  TRUTH_DASH,
  type CommercialTruthExactModel,
  type CommercialTruthFieldId,
} from "@/components/commercial-truth/commercial-truth-exact-model";

export type {
  CommercialTruthExactModel,
  CommercialTruthFieldId,
} from "@/components/commercial-truth/commercial-truth-exact-model";

export interface CommercialTruthExactProps {
  model: CommercialTruthExactModel;
  /** Omitted entirely when the screen is mounted inside another page's shell. */
  showHeader?: boolean;
  onFieldChange: (field: CommercialTruthFieldId, value: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}

interface ScenarioColumn {
  spendValue: string;
  roasValue: string;
  spend: number;
  revenue: number | null;
  variable: number | null;
  contribution: number | null;
  net: number | null;
  margin: number | null;
}

interface ScenarioCell {
  value: string;
  color: string;
  weight: number;
}

interface ScenarioRow {
  key: string;
  label: string;
  sub: string | null;
  rowBackground: string;
  labelColor: string;
  subColor: string;
  lineColor: string;
  cells: ScenarioCell[];
}

/** Stable hooks for the Commercial Truth smoke; not part of the design's DOM. */
const FIELD_TEST_IDS: Record<CommercialTruthFieldId, string> = {
  targetRoas: "commercial-target-roas",
  breakevenRoas: "commercial-break-even-roas",
  grossMargin: "commercial-gross-margin",
  aovFloor: "commercial-aov-floor",
  shippingCost: "commercial-cost-shipping",
  paymentFees: "commercial-cost-processing",
  cpaCeiling: "commercial-cpa-ceiling",
  fixedCosts: "commercial-fixed-costs",
};

function parseLoose(value: string): number {
  const parsed = Number.parseFloat(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function CommercialTruthExact({
  model,
  showHeader = true,
  onFieldChange,
  onSave,
  onDiscard,
}: CommercialTruthExactProps) {
  const { scenario } = model;
  const [spends, setSpends] = useState<string[]>(scenario.defaultSpends);
  const [roasOverrides, setRoasOverrides] = useState<Array<string | null>>(() =>
    scenario.defaultSpends.map(() => null),
  );

  const money = useMemo(() => {
    try {
      const formatter = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: model.currencyCode,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });
      return (value: number) => formatter.format(value);
    } catch {
      return (value: number) => Math.round(value).toLocaleString("en-US");
    }
  }, [model.currencyCode]);

  const targetLabel = scenario.targetRoas === null ? TRUTH_DASH : scenario.targetRoas.toFixed(2);
  // The reference composes this as `'Reset ROAS to target ' + T.toFixed(2) + '×'`
  // (script line 4297). Substituting the em dash for an unserved T left a
  // dangling "target —×": a multiplication sign attached to nothing. The
  // caption drops the value and its sign instead — the control still does the
  // one thing it does, which is clear the column edits.
  const scenarioResetLabel =
    scenario.targetRoas === null
      ? "Reset ROAS to target"
      : `Reset ROAS to target ${targetLabel}×`;

  const columns: ScenarioColumn[] = spends.map((spendValue, index) => {
    const roasValue =
      roasOverrides[index] === null || roasOverrides[index] === undefined
        ? targetLabel
        : (roasOverrides[index] as string);
    const parsedRoas = Number.parseFloat(roasValue);
    const roas =
      Number.isFinite(parsedRoas) && parsedRoas >= 0 ? parsedRoas : scenario.targetRoas;
    const spend = parseLoose(spendValue);
    const revenue = roas === null ? null : spend * roas;
    const variable =
      revenue === null || scenario.variableCostRatio === null
        ? null
        : revenue * scenario.variableCostRatio;
    const contribution = revenue === null || variable === null ? null : revenue - variable;
    const net =
      contribution === null || scenario.fixedCost === null
        ? null
        : contribution - spend - scenario.fixedCost;
    const margin = net === null || revenue === null || revenue <= 0 ? null : (net / revenue) * 100;
    return { spendValue, roasValue, spend, revenue, variable, contribution, net, margin };
  });

  const cell = (value: string, color = "#0e1526", weight = 600): ScenarioCell => ({
    value,
    color,
    weight,
  });
  const negative = (value: number | null) => (value === null ? TRUTH_DASH : `−${money(value)}`);

  const rows: ScenarioRow[] = [
    {
      key: "revenue",
      label: "Ad-attributed revenue",
      sub: "spend × ROAS",
      rowBackground: "#ffffff",
      labelColor: "#0e1526",
      subColor: "#98a4ba",
      lineColor: "#edf0f6",
      cells: columns.map((column) =>
        cell(column.revenue === null ? TRUTH_DASH : money(column.revenue)),
      ),
    },
    {
      key: "variable",
      label: "Variable costs",
      sub: scenario.variableCostSubLabel,
      rowBackground: "#fbfcfe",
      labelColor: "#45526b",
      subColor: "#98a4ba",
      lineColor: "#edf0f6",
      cells: columns.map((column) => cell(negative(column.variable), "#7a869e", 500)),
    },
    {
      key: "contribution",
      label: "Contribution before ads",
      sub: scenario.contributionSubLabel,
      rowBackground: "#ffffff",
      labelColor: "#0e1526",
      subColor: "#98a4ba",
      lineColor: "#edf0f6",
      cells: columns.map((column) =>
        cell(column.contribution === null ? TRUTH_DASH : money(column.contribution)),
      ),
    },
    {
      key: "adSpend",
      label: "Ad spend",
      sub: null,
      rowBackground: "#fbfcfe",
      labelColor: "#45526b",
      subColor: "#98a4ba",
      lineColor: "#edf0f6",
      cells: columns.map((column) => cell(negative(column.spend), "#7a869e", 500)),
    },
    {
      key: "fixed",
      label: "Fixed costs",
      sub: "from the pack · applies once per month",
      rowBackground: "#ffffff",
      labelColor: "#45526b",
      subColor: "#98a4ba",
      lineColor: "#edf0f6",
      cells: columns.map(() => cell(negative(scenario.fixedCost), "#7a869e", 500)),
    },
    {
      key: "net",
      label: "Net profit / month",
      sub: null,
      rowBackground: "#0b1020",
      labelColor: "#ffffff",
      subColor: "#8b93a7",
      lineColor: "#0b1020",
      cells: columns.map((column) =>
        column.net === null
          ? cell(TRUTH_DASH, "#8b93a7", 700)
          : cell(
              `${column.net < 0 ? "−" : ""}${money(Math.abs(column.net))}`,
              column.net >= 0 ? "#34d399" : "#f87171",
              700,
            ),
      ),
    },
    {
      key: "margin",
      label: "Net margin",
      sub: "net profit ÷ revenue",
      rowBackground: "#ffffff",
      labelColor: "#0e1526",
      subColor: "#98a4ba",
      lineColor: "#edf0f6",
      cells: columns.map((column) =>
        column.margin === null
          ? cell(TRUTH_DASH, "#98a4ba")
          : cell(`${column.margin.toFixed(1)}%`, column.margin >= 0 ? "#0e9f6e" : "#e11d48"),
      ),
    },
  ];

  return (
    <section className={styles.root} data-screen-label="Commercial Truth">
      {showHeader ? (
        <div>
          <p className={styles.eyebrow}>{model.eyebrow}</p>
          <h1 className={styles.title}>{model.title}</h1>
          <p className={styles.lede}>{model.lede}</p>
        </div>
      ) : null}

      <div className={styles.band}>
        <span className={styles.bandPill}>
          <span className={styles.bandDot} />
          Single source
        </span>
        <p className={styles.bandNote}>{model.bandNote}</p>
        {model.stats.map((stat) => (
          <span key={stat.key} className={styles.bandStat}>
            <span className={styles.bandStatKey}>{stat.key}</span>
            <span className={styles.bandStatValue}>{stat.value}</span>
          </span>
        ))}
      </div>

      <div className={styles.grid}>
        <div className={styles.column}>
          <article
            className={`${styles.card} ${styles.cardPadded}`}
            data-testid="commercial-truth-settings"
          >
            <div className={`${styles.cardHead} ${styles.cardHeadSpaced}`}>
              <h2 className={styles.cardTitle}>Target pack</h2>
              <span className={styles.cardNote}>
                applies on the next snapshot, never retroactively
              </span>
            </div>
            <div className={styles.fieldGrid}>
              {model.fields.map((field) => (
                <label key={field.id} className={styles.field}>
                  <span className={styles.fieldLabel}>{field.label}</span>
                  <input
                    className={`${styles.fieldInput} ${field.accent ? styles.fieldInputAccent : ""}`}
                    value={field.value}
                    readOnly={!field.editable}
                    onChange={(event) => onFieldChange(field.id, event.target.value)}
                    aria-label={field.label}
                    data-testid={FIELD_TEST_IDS[field.id]}
                  />
                  <span className={styles.fieldHint}>{field.hint}</span>
                </label>
              ))}
            </div>
            <div className={styles.packActions}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={onSave}
                disabled={!model.pack.canEdit || model.pack.saving}
                data-testid="commercial-settings-save"
              >
                Save target pack
              </button>
              <button
                type="button"
                className={styles.ghostButton}
                onClick={onDiscard}
                disabled={!model.pack.dirty || model.pack.saving}
              >
                Discard changes
              </button>
              <span className={styles.packStamp}>{model.pack.lastUpdated}</span>
            </div>
            {model.pack.error ? <p className={styles.packError}>{model.pack.error}</p> : null}
          </article>

          <article className={`${styles.card} ${styles.cardPadded}`}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>Where $100 of revenue goes</h2>
              <span className={styles.cardNote}>derived from this pack · 28d blended pace</span>
            </div>
            <div className={styles.splitBar}>
              {model.segments.map((segment) => (
                <span
                  key={segment.key}
                  style={{ width: segment.width, background: segment.background }}
                />
              ))}
            </div>
            <div className={styles.splitLegend}>
              {model.segments.map((segment) => (
                <span key={segment.key} className={styles.splitLegendItem}>
                  <span
                    className={styles.splitSwatch}
                    style={{ background: segment.background }}
                  />
                  <span className={styles.splitKey}>{segment.key}</span>
                  <span className={styles.splitValue}>{segment.value}</span>
                </span>
              ))}
            </div>
            <p className={styles.splitNote}>{model.splitNote}</p>
          </article>
        </div>

        <div className={styles.column}>
          <article className={`${styles.card} ${styles.cardClipped}`}>
            <div className={styles.listHead}>
              <h2 className={styles.cardTitle}>Consumed by</h2>
              <span className={styles.cardNote}>{model.consumers.length} surfaces</span>
            </div>
            {model.consumers.map((consumer) => (
              <div key={consumer.name} className={styles.consumerRow}>
                <span className={styles.consumerDot} style={{ background: consumer.dot }} />
                <div className={styles.consumerBody}>
                  <div className={styles.consumerHead}>
                    <span className={styles.consumerName}>{consumer.name}</span>
                    <span className={styles.consumerLast}>{consumer.last}</span>
                  </div>
                  <p className={styles.consumerNote}>{consumer.note}</p>
                  <span className={styles.consumerReads}>reads: {consumer.reads}</span>
                </div>
              </div>
            ))}
          </article>

          <article className={`${styles.card} ${styles.cardClipped}`}>
            <div className={styles.listHead}>
              <h2 className={styles.cardTitle}>Change history</h2>
            </div>
            {model.log.map((entry) => (
              <div key={entry.id} className={styles.logRow}>
                <span className={styles.logTime}>{entry.time}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p className={styles.logChange}>{entry.change}</p>
                  <p className={styles.logWhy}>
                    {entry.why} · {entry.actor}
                  </p>
                </div>
              </div>
            ))}
            <p className={styles.listFoot}>
              every change re-stamps downstream decisions on the next snapshot
            </p>
          </article>
        </div>
      </div>

      <article className={`${styles.card} ${styles.cardClipped}`}>
        <div className={styles.scenarioHead}>
          <div className={styles.scenarioHeadBody}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>Spend × ROAS scenario guide</h2>
              <span className={styles.cardNote}>
                recalculates live from this pack’s economics
              </span>
            </div>
            <p className={styles.scenarioLede}>
              Edit monthly spend in the header and ROAS per column. Contribution margin{" "}
              {scenario.contributionSubLabel === TRUTH_DASH
                ? TRUTH_DASH
                : scenario.contributionSubLabel.replace(" of revenue", "")}{" "}
              and the{" "}
              {scenario.fixedCost === null ? TRUTH_DASH : `${money(scenario.fixedCost)}/mo`} fixed
              base come straight from the pack above.
            </p>
          </div>
          <button
            type="button"
            className={styles.scenarioReset}
            onClick={() => setRoasOverrides(spends.map(() => null))}
          >
            {scenarioResetLabel}
          </button>
        </div>
        <div className={styles.tableScroll}>
          <table className={styles.scenarioTable}>
            <tbody>
              <tr>
                <td className={styles.scenarioStubSpend}>Spend / month</td>
                {columns.map((column, index) => (
                  <td key={`spend-${index}`} className={styles.scenarioSpendCell}>
                    <span className={styles.scenarioSpendChip}>
                      <span className={styles.scenarioSpendSymbol}>{model.currencySymbol}</span>
                      <input
                        className={styles.scenarioSpendInput}
                        value={column.spendValue}
                        aria-label={`Monthly spend column ${index + 1}`}
                        onChange={(event) =>
                          setSpends((current) =>
                            current.map((value, position) =>
                              position === index ? event.target.value : value,
                            ),
                          )
                        }
                      />
                    </span>
                  </td>
                ))}
              </tr>
              <tr>
                <td className={styles.scenarioStubRoas}>
                  <span className={styles.scenarioStubRoasKey}>ROAS</span>
                  <span className={styles.scenarioStubRoasSub}>
                    edit per column · defaults to target
                  </span>
                </td>
                {columns.map((column, index) => (
                  <td key={`roas-${index}`} className={styles.scenarioRoasCell}>
                    <span className={styles.scenarioRoasChip}>
                      <input
                        className={styles.scenarioRoasInput}
                        value={column.roasValue}
                        aria-label={`ROAS column ${index + 1}`}
                        onChange={(event) =>
                          setRoasOverrides((current) =>
                            current.map((value, position) =>
                              position === index ? event.target.value : value,
                            ),
                          )
                        }
                      />
                      <span className={styles.scenarioRoasSymbol}>×</span>
                    </span>
                  </td>
                ))}
              </tr>
              {rows.map((row) => (
                <tr key={row.key} style={{ background: row.rowBackground }}>
                  <td
                    className={styles.scenarioRowStub}
                    style={{ borderTop: `1px solid ${row.lineColor}` }}
                  >
                    <span className={styles.scenarioRowKey} style={{ color: row.labelColor }}>
                      {row.label}
                    </span>
                    {row.sub ? (
                      <span className={styles.scenarioRowSub} style={{ color: row.subColor }}>
                        {row.sub}
                      </span>
                    ) : null}
                  </td>
                  {row.cells.map((scenarioCell, index) => (
                    <td
                      key={`${row.key}-${index}`}
                      className={styles.scenarioCell}
                      style={
                        {
                          borderTop: `1px solid ${row.lineColor}`,
                          color: scenarioCell.color,
                          fontWeight: scenarioCell.weight,
                        } as CSSProperties
                      }
                    >
                      {scenarioCell.value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.cardFoot}>
          Reads gross margin, shipping, fees and fixed costs from the pack — save the pack and every
          scenario re-anchors. Net profit needs ROAS × contribution margin to clear ad spend plus the
          fixed base.
        </p>
      </article>

      <article className={`${styles.card} ${styles.cardClipped}`}>
        <div className={styles.spendHead}>
          <h2 className={styles.cardTitle}>Where spend sits against these targets</h2>
          <span className={styles.cardNote}>
            live preview — edit Target or Breakeven ROAS above and every row re-labels
          </span>
        </div>
        <div className={styles.bandGrid}>
          {model.bands.map((band) => (
            <div key={band.name} className={styles.bandCard} style={{ borderLeftColor: band.tone }}>
              <div className={styles.bandCardHead}>
                <span className={styles.bandCardName}>{band.name}</span>
                <span className={styles.bandCardRange}>{band.range}</span>
              </div>
              <p className={styles.bandCardSpend}>
                {band.spend} <span className={styles.bandCardShare}>· {band.share}</span>
              </p>
              <p className={styles.bandCardVerdict}>
                {band.count} entities → <b style={{ color: band.tone }}>{band.verdict}</b>
              </p>
            </div>
          ))}
        </div>
        <div className={styles.shareStrip}>
          <div className={styles.shareBar}>
            {model.bands.map((band) => (
              <span key={band.name} style={{ width: band.share, background: band.tone }} />
            ))}
          </div>
          <p className={styles.shareNote}>
            share of labeled ad spend · 28d · {model.coverage}
          </p>
        </div>
        <div className={styles.tableScroll}>
          <table className={styles.spendTable}>
            <thead>
              <tr>
                <th className={`${styles.spendTh} ${styles.spendThLead}`}>Campaign</th>
                <th className={styles.spendTh}>Spend · 28d</th>
                <th className={`${styles.spendTh} ${styles.spendThShare}`}>Share</th>
                <th className={styles.spendTh}>Revenue</th>
                <th className={styles.spendTh}>ROAS</th>
                <th className={styles.spendTh}>vs target</th>
                <th className={`${styles.spendTh} ${styles.spendThLead}`}>Next-snapshot verdict</th>
              </tr>
            </thead>
            <tbody>
              {model.spendRows.length === 0 ? (
                <tr>
                  <td className={styles.spendEmptyCell} colSpan={7}>
                    No campaign carries spend in this window.
                  </td>
                </tr>
              ) : (
                model.spendRows.map((row) => (
                  <tr key={row.id} className={styles.spendRow}>
                    <td className={styles.spendNameCell}>
                      <div className={styles.spendNameInner}>
                        <span className={styles.spendLogoTile}>
                          <span
                            role="img"
                            aria-label={row.platform}
                            className={styles.spendLogo}
                            style={{ backgroundImage: `url(${row.logo})` }}
                          />
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <span className={styles.spendName}>{row.name}</span>
                          <span className={styles.spendMeta}>
                            {row.platform} · {row.level}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className={styles.spendValueCell}>{row.spend}</td>
                    <td className={styles.spendShareCell}>
                      <div className={styles.spendShareInner}>
                        <span className={styles.spendShareTrack}>
                          <span
                            className={styles.spendShareFill}
                            style={{ width: row.shareWidth, background: row.tone }}
                          />
                        </span>
                        <span className={styles.spendShareLabel}>{row.share}</span>
                      </div>
                    </td>
                    <td className={styles.spendRevenueCell}>{row.revenue}</td>
                    <td className={styles.spendChipCell}>
                      <span
                        className={styles.spendRoasChip}
                        style={{ background: row.roasBackground, color: row.roasForeground }}
                      >
                        {row.roas}
                      </span>
                    </td>
                    <td className={styles.spendDeltaCell} style={{ color: row.deltaForeground }}>
                      {row.delta}
                    </td>
                    <td className={styles.spendVerdictCell}>
                      <span
                        className={styles.spendVerdictChip}
                        style={{
                          background: row.verdictBackground,
                          color: row.verdictForeground,
                        }}
                      >
                        <span className={styles.spendVerdictDot} />
                        {row.verdict}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr>
                <td className={styles.spendFootLead}>Blended · all labeled spend</td>
                <td className={`${styles.spendFootCell} ${styles.spendFootStrong}`}>
                  {model.totals.spend}
                </td>
                <td className={styles.spendFootCell} />
                <td className={`${styles.spendFootCell} ${styles.spendFootValue}`}>
                  {model.totals.revenue}
                </td>
                <td className={styles.spendFootCell}>
                  <span
                    className={styles.spendRoasChip}
                    style={{
                      background: model.totals.roasBackground,
                      color: model.totals.roasForeground,
                    }}
                  >
                    {model.totals.roas}
                  </span>
                </td>
                <td
                  className={styles.spendFootCell}
                  style={{
                    fontFamily: "var(--font-ibm-plex-mono), 'IBM Plex Mono', monospace",
                    fontSize: "11.5px",
                    color: model.totals.deltaForeground,
                  }}
                >
                  {model.totals.delta}
                </td>
                <td className={styles.spendFootTarget}>vs target {model.totals.targetRoas}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className={styles.cardFoot}>
          Preview only — verdicts stamp on the next snapshot after the pack is saved. Unlabeled spend
          ({model.unlabeledSpend}) is excluded until it gets a label in Decisions.
        </p>
      </article>
    </section>
  );
}

export default CommercialTruthExact;
