/**
 * The reference's own inner geometry for the v2 report block kinds, shared by
 * the builder canvas (`ReportsExact`) and by the export, print and share
 * surfaces (`report-canvas`).
 *
 * One copy, so the page an operator arranges in the builder is the page the
 * client receives. Two rules hold throughout:
 *
 * - No figure is invented. A block the renderer did not measure keeps the
 *   design's structure and shows an em dash where the figure would be, rather
 *   than a zero, a seed value, or a blank box.
 * - Where the design encodes a value as colour rather than as text — the heat
 *   grid's cells, the funnel's bar widths — an unmeasured value is drawn in the
 *   neutral fill, because tinting it would assert a reading nobody took.
 *
 * Geometry is transcribed from `Adsecute Dashboard v2.dc.html`: kpirow l.2452,
 * donut l.2480, funnel l.2470-2477, heat l.2492-2498, ai l.2483-2489 and the
 * creative brief l.2500-2551.
 */
import styles from "@/components/reports/ReportsExact.module.css";

export const BLOCK_DASH = "—";

/** Reference l.2452-2457 — the four-up KPI strip. */
export function KpiRowGeometry({
  minis,
}: {
  minis: Array<{ k: string; v: string }>;
}) {
  const entries = minis.length > 0 ? minis : [{ k: BLOCK_DASH, v: BLOCK_DASH }];
  return (
    <div className={styles.kpiRow} data-report-block="kpirow">
      {entries.map((mini, index) => (
        <span className={styles.kpiMini} key={`${mini.k}-${index}`}>
          <span className={styles.kpiMiniKey}>{mini.k}</span>
          <span className={styles.kpiMiniValue}>{mini.v}</span>
        </span>
      ))}
    </div>
  );
}

/** Reference l.2479-2481 — the share donut and its legend. */
export function DonutGeometry({
  gradient,
  legend,
}: {
  gradient: string | null;
  legend: Array<{ color: string; text: string }>;
}) {
  const entries =
    legend.length > 0 ? legend : [{ color: "#EDF0F6", text: BLOCK_DASH }];
  return (
    <div className={styles.donutWrap} data-report-block="donut">
      <span
        className={styles.donut}
        style={{ background: gradient ?? "conic-gradient(#EDF0F6 0 100%)" }}
      />
      <div className={styles.donutLegend}>
        {entries.map((entry, index) => (
          <span className={styles.donutLegendItem} key={`${entry.text}-${index}`}>
            <span className={styles.donutSwatch} style={{ background: entry.color }} />
            {entry.text}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Reference l.2470-2477 — the funnel's stacked tracks.
 *
 * Nothing measures a funnel yet, so the unmeasured state draws one track in
 * the neutral fill with an em dash beside it. It deliberately does not draw the
 * reference's four steps: the step count is itself a measurement.
 */
export function FunnelGeometry({
  steps,
}: {
  steps: Array<{ widthCss: string; color: string; label: string }>;
}) {
  if (steps.length === 0) {
    return (
      <div className={styles.funnelBody} data-report-block="funnel">
        <div className={styles.funnelStep} data-funnel-step="">
          <span
            className={`${styles.funnelBar} ${styles.funnelBarUnmeasured}`}
            style={{ width: "100%" }}
          />
          <span className={styles.funnelLabel}>{BLOCK_DASH}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.funnelBody} data-report-block="funnel">
      {steps.map((step, index) => (
        <div className={styles.funnelStep} data-funnel-step="" key={`${step.label}-${index}`}>
          <span
            className={styles.funnelBar}
            style={{ width: step.widthCss, background: step.color }}
          />
          <span className={styles.funnelLabel}>{step.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Reference l.2492-2498 — the six-column creative heat grid.
 *
 * A heat cell carries no text: its tint is the whole of its meaning. So the
 * unmeasured grid is drawn at full geometry in the neutral fill, which is this
 * design's own way of writing "no reading", and the block's dash is carried by
 * the caption line beneath the grid.
 */
export function HeatGeometry({ cells }: { cells: string[] }) {
  const tints = cells.length > 0 ? cells : Array.from({ length: 12 }, () => null);
  return (
    <div className={styles.heatGrid} data-report-block="heat">
      {tints.map((tint, index) => (
        <span
          className={styles.heatCell}
          data-heat-cell=""
          key={index}
          style={tint ? { background: tint } : undefined}
        />
      ))}
    </div>
  );
}

/** Reference l.2483-2489 — the AI brief panel. */
export function AiGeometry({ body }: { body?: string }) {
  return (
    <div className={styles.aiPanel} data-report-block="ai">
      <span className={styles.aiTag}>AI BRIEF</span>
      <p className={styles.aiBody}>{body?.trim() ? body : BLOCK_DASH}</p>
    </div>
  );
}

export interface BriefFields {
  tag: string;
  concept: string;
  gate: string;
  status: string;
  fromName: string;
  fromMeta: string;
  make: string;
  makeSub: string;
  why: string;
  shootLabel: string;
  shoot: string[];
  rules: Array<{ sign: string; text: string }>;
  specs: string[];
  foot: string;
}

/** Every field an unmeasured brief carries: the structure, and no claims. */
export const UNMEASURED_BRIEF: BriefFields = {
  tag: BLOCK_DASH,
  concept: BLOCK_DASH,
  gate: BLOCK_DASH,
  status: BLOCK_DASH,
  fromName: BLOCK_DASH,
  fromMeta: BLOCK_DASH,
  make: BLOCK_DASH,
  makeSub: BLOCK_DASH,
  why: BLOCK_DASH,
  shootLabel: BLOCK_DASH,
  shoot: [BLOCK_DASH],
  rules: [{ sign: BLOCK_DASH, text: BLOCK_DASH }],
  specs: [BLOCK_DASH],
  foot: BLOCK_DASH,
};

/** Reference l.2500-2551 — the forwardable creative brief. */
export function BriefGeometry({ fields = UNMEASURED_BRIEF }: { fields?: BriefFields }) {
  return (
    <div className={styles.brief} data-report-block="brief">
      <div className={styles.briefHead}>
        <span className={styles.briefTag}>{fields.tag}</span>
        <span className={styles.briefConcept}>{fields.concept}</span>
        <span className={styles.briefGate}>{fields.gate}</span>
        <span className={styles.briefStatus}>{fields.status}</span>
      </div>
      <div className={styles.briefBody}>
        <div className={styles.briefGrid}>
          <div className={styles.briefFromCard}>
            <span className={styles.briefStripe} />
            <span className={styles.briefFromText}>
              <span className={styles.briefLabel}>THE CREATIVE</span>
              <span className={styles.briefFromName}>{fields.fromName}</span>
              <span className={styles.briefFromMeta}>{fields.fromMeta}</span>
            </span>
          </div>
          <div className={styles.briefNeedCard}>
            <span className={styles.briefNeedLabel}>→ WHAT WE NEED</span>
            <span className={styles.briefMake}>{fields.make}</span>
            <span className={styles.briefMakeSub}>{fields.makeSub}</span>
          </div>
        </div>
        <p className={styles.briefWhy}>
          <span className={styles.briefWhyLabel}>WHY</span>
          {fields.why}
        </p>
        <div className={styles.briefChipRow}>
          <span className={styles.briefRowLabel}>{fields.shootLabel}</span>
          {fields.shoot.map((entry, index) => (
            <span className={styles.briefChip} key={`${entry}-${index}`}>
              {entry}
            </span>
          ))}
        </div>
        <div className={styles.briefRuleRow}>
          <span className={styles.briefRowLabel}>RULES</span>
          {fields.rules.map((rule, index) => (
            <span className={styles.briefRule} key={`${rule.text}-${index}`}>
              <span className={styles.briefRuleSign}>{rule.sign}</span>
              {rule.text}
            </span>
          ))}
        </div>
        <div className={styles.briefSpecRow}>
          {fields.specs.map((spec, index) => (
            <span className={styles.briefSpec} key={`${spec}-${index}`}>
              {spec}
            </span>
          ))}
          <span className={styles.briefFoot}>{fields.foot}</span>
        </div>
      </div>
    </div>
  );
}
