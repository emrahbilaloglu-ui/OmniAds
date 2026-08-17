"use client";

import { useState, type MouseEvent } from "react";

import styles from "./MetaDecisionCenterExact.module.css";

const EM_DASH = "—";

export type MetaDecisionCenterExactDisplayValue = string | number | null | undefined;
export type MetaDecisionCenterExactScope = "structure" | "creatives";
export type MetaDecisionCenterExactLane =
  | "action"
  | "watching"
  | "healthy"
  | "nonsales"
  | "archive";
export type MetaDecisionCenterExactWindow = "7d" | "14d" | "28d" | "90d";
export type MetaDecisionCenterExactTone =
  | "positive"
  | "negative"
  | "warning"
  | "info"
  | "automation"
  | "neutral";

export interface MetaDecisionCenterExactIdentityViewModel {
  accountLabel?: MetaDecisionCenterExactDisplayValue;
  currency?: MetaDecisionCenterExactDisplayValue;
  syncedLabel?: MetaDecisionCenterExactDisplayValue;
  snapshotLabel?: MetaDecisionCenterExactDisplayValue;
  engineLabel?: MetaDecisionCenterExactDisplayValue;
  timeLabel?: MetaDecisionCenterExactDisplayValue;
}

export interface MetaDecisionCenterExactChipViewModel {
  label?: MetaDecisionCenterExactDisplayValue;
  tone?: MetaDecisionCenterExactTone;
}

export interface MetaDecisionCenterExactKpisViewModel {
  spend?: {
    value?: MetaDecisionCenterExactDisplayValue;
    delta?: MetaDecisionCenterExactDisplayValue;
    detail?: MetaDecisionCenterExactDisplayValue;
  };
  roas?: {
    label?: MetaDecisionCenterExactDisplayValue;
    value?: MetaDecisionCenterExactDisplayValue;
    target?: MetaDecisionCenterExactDisplayValue;
    sparkPath?: string | null;
  };
  snapshot?: {
    freshness?: MetaDecisionCenterExactDisplayValue;
    detail?: MetaDecisionCenterExactDisplayValue;
  };
  labels?: {
    coverage?: MetaDecisionCenterExactDisplayValue;
    percentage?: MetaDecisionCenterExactDisplayValue;
  };
  mode?: {
    value?: MetaDecisionCenterExactDisplayValue;
    chips?: readonly MetaDecisionCenterExactChipViewModel[];
  };
}

export interface MetaDecisionCenterExactCountsViewModel {
  structure?: MetaDecisionCenterExactDisplayValue;
  creatives?: MetaDecisionCenterExactDisplayValue;
  action?: MetaDecisionCenterExactDisplayValue;
  watching?: MetaDecisionCenterExactDisplayValue;
  healthy?: MetaDecisionCenterExactDisplayValue;
  nonsales?: MetaDecisionCenterExactDisplayValue;
  archive?: MetaDecisionCenterExactDisplayValue;
  deferred?: MetaDecisionCenterExactDisplayValue;
}

export interface MetaDecisionCenterExactActionRowViewModel {
  id: string;
  name?: MetaDecisionCenterExactDisplayValue;
  level?: MetaDecisionCenterExactDisplayValue;
  chips?: readonly MetaDecisionCenterExactDisplayValue[];
  decisionLabel?: MetaDecisionCenterExactDisplayValue;
  decisionTone?: MetaDecisionCenterExactTone;
  edgeTone?: MetaDecisionCenterExactTone;
  money?: MetaDecisionCenterExactDisplayValue;
  moneySub?: MetaDecisionCenterExactDisplayValue;
  confidence?: MetaDecisionCenterExactDisplayValue;
  confidenceTone?: MetaDecisionCenterExactTone;
  actionLabel?: MetaDecisionCenterExactDisplayValue;
  actionTone?: MetaDecisionCenterExactTone;
  onPrimary?: () => void;
  onMenu?: () => void;
}

export interface MetaDecisionCenterExactWatchSegmentViewModel {
  id: string;
  label?: MetaDecisionCenterExactDisplayValue;
  count?: MetaDecisionCenterExactDisplayValue;
}

export interface MetaDecisionCenterExactWatchingRowViewModel {
  id: string;
  segment?: MetaDecisionCenterExactDisplayValue;
  segmentTone?: MetaDecisionCenterExactTone;
  name?: MetaDecisionCenterExactDisplayValue;
  level?: MetaDecisionCenterExactDisplayValue;
  note?: MetaDecisionCenterExactDisplayValue;
  money?: MetaDecisionCenterExactDisplayValue;
  onReview?: () => void;
}

export interface MetaDecisionCenterExactHealthyGroupViewModel {
  id: string;
  name?: MetaDecisionCenterExactDisplayValue;
  strategy?: MetaDecisionCenterExactDisplayValue;
  rollup?: MetaDecisionCenterExactDisplayValue;
  adsets?: readonly {
    id: string;
    name?: MetaDecisionCenterExactDisplayValue;
    stats?: MetaDecisionCenterExactDisplayValue;
  }[];
}

export interface MetaDecisionCenterExactNonSalesViewModel {
  name?: MetaDecisionCenterExactDisplayValue;
  level?: MetaDecisionCenterExactDisplayValue;
  contextLabel?: MetaDecisionCenterExactDisplayValue;
  metrics?: readonly {
    id: string;
    label?: MetaDecisionCenterExactDisplayValue;
    value?: MetaDecisionCenterExactDisplayValue;
  }[];
  note?: MetaDecisionCenterExactDisplayValue;
}

export interface MetaDecisionCenterExactArchiveRowViewModel {
  id: string;
  name?: MetaDecisionCenterExactDisplayValue;
  status?: MetaDecisionCenterExactDisplayValue;
  statusTone?: MetaDecisionCenterExactTone;
  spend?: MetaDecisionCenterExactDisplayValue;
  note?: MetaDecisionCenterExactDisplayValue;
  /** Controls only the canonical visual affordance; authority stays outside this component. */
  showResume?: boolean;
  onResume?: () => void;
}

export interface MetaDecisionCenterExactCreativePostureViewModel {
  id: string;
  label?: MetaDecisionCenterExactDisplayValue;
  value?: MetaDecisionCenterExactDisplayValue;
  detail?: MetaDecisionCenterExactDisplayValue;
  tone?: MetaDecisionCenterExactTone;
}

export interface MetaDecisionCenterExactCreativeDecisionViewModel {
  id: string;
  name?: MetaDecisionCenterExactDisplayValue;
  kindShort?: MetaDecisionCenterExactDisplayValue;
  stripeA?: string | null;
  stripeB?: string | null;
  edgeTone?: MetaDecisionCenterExactTone;
  decisionLabel?: MetaDecisionCenterExactDisplayValue;
  decisionTone?: MetaDecisionCenterExactTone;
  chips?: readonly MetaDecisionCenterExactDisplayValue[];
  sparkPath?: string | null;
  money?: MetaDecisionCenterExactDisplayValue;
  moneySub?: MetaDecisionCenterExactDisplayValue;
  actionLabel?: MetaDecisionCenterExactDisplayValue;
  actionTone?: MetaDecisionCenterExactTone;
  onPrimary?: () => void;
  onOpen?: () => void;
}

export interface MetaDecisionCenterExactInspectorViewModel {
  entityName?: MetaDecisionCenterExactDisplayValue;
  entityMeta?: MetaDecisionCenterExactDisplayValue;
  decisionLabel?: MetaDecisionCenterExactDisplayValue;
  tone?: MetaDecisionCenterExactTone;
  serverVerdict?: MetaDecisionCenterExactDisplayValue;
  contractDetail?: MetaDecisionCenterExactDisplayValue;
  reasons?: readonly MetaDecisionCenterExactDisplayValue[];
  moneyValue?: MetaDecisionCenterExactDisplayValue;
  targetComparison?: MetaDecisionCenterExactDisplayValue;
  moneySparkPath?: string | null;
  moneyDetail?: MetaDecisionCenterExactDisplayValue;
  confidence?: MetaDecisionCenterExactDisplayValue;
  readiness?: MetaDecisionCenterExactDisplayValue;
  blockers?: MetaDecisionCenterExactDisplayValue;
  blockerTone?: MetaDecisionCenterExactTone;
  evidence?: readonly {
    id: string;
    label?: MetaDecisionCenterExactDisplayValue;
    value?: MetaDecisionCenterExactDisplayValue;
  }[];
  actionLabel?: MetaDecisionCenterExactDisplayValue;
  actionTone?: MetaDecisionCenterExactTone;
  provenance?: MetaDecisionCenterExactDisplayValue;
  onPrimary?: () => void;
}

export interface MetaDecisionCenterExactViewModel {
  identity?: MetaDecisionCenterExactIdentityViewModel;
  activeWindow?: MetaDecisionCenterExactWindow | null;
  counts?: MetaDecisionCenterExactCountsViewModel;
  kpis?: MetaDecisionCenterExactKpisViewModel;
  actionRows?: readonly MetaDecisionCenterExactActionRowViewModel[];
  watchSegments?: readonly MetaDecisionCenterExactWatchSegmentViewModel[];
  watchingRows?: readonly MetaDecisionCenterExactWatchingRowViewModel[];
  healthyGroups?: readonly MetaDecisionCenterExactHealthyGroupViewModel[];
  nonSales?: MetaDecisionCenterExactNonSalesViewModel | null;
  archiveRows?: readonly MetaDecisionCenterExactArchiveRowViewModel[];
  creativePosture?: readonly MetaDecisionCenterExactCreativePostureViewModel[];
  creativeDecisions?: readonly MetaDecisionCenterExactCreativeDecisionViewModel[];
  inspector?: MetaDecisionCenterExactInspectorViewModel | null;
}

export interface MetaDecisionCenterExactProps {
  viewModel: MetaDecisionCenterExactViewModel;
  scope?: MetaDecisionCenterExactScope;
  defaultScope?: MetaDecisionCenterExactScope;
  lane?: MetaDecisionCenterExactLane;
  defaultLane?: MetaDecisionCenterExactLane;
  inspectorOpen?: boolean;
  onScopeChange?: (scope: MetaDecisionCenterExactScope) => void;
  onLaneChange?: (lane: MetaDecisionCenterExactLane) => void;
  onWindowChange?: (window: MetaDecisionCenterExactWindow) => void;
  onRunSnapshot?: () => void;
  onNewCampaign?: () => void;
  onManageLabels?: () => void;
  onSortChange?: (sort: MetaDecisionCenterExactSort) => void;
  onSearchChange?: (query: string) => void;
  onOpenCreativeStudio?: () => void;
}

export type MetaDecisionCenterExactSort = "money" | "priority" | "age";

const WINDOWS: readonly MetaDecisionCenterExactWindow[] = ["7d", "14d", "28d", "90d"];
const LANES: readonly { id: MetaDecisionCenterExactLane; label: string }[] = [
  { id: "action", label: "Action Now" },
  { id: "watching", label: "Watching" },
  { id: "healthy", label: "Healthy" },
  { id: "nonsales", label: "Non-sales" },
  { id: "archive", label: "Archive" },
];

const TONE_CLASS: Record<MetaDecisionCenterExactTone, string> = {
  positive: styles.tonePositive,
  negative: styles.toneNegative,
  warning: styles.toneWarning,
  info: styles.toneInfo,
  automation: styles.toneAutomation,
  neutral: styles.toneNeutral,
};

function display(value: MetaDecisionCenterExactDisplayValue): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : EM_DASH;
  if (typeof value !== "string") return EM_DASH;
  return value.trim() || EM_DASH;
}

function toneClass(tone: MetaDecisionCenterExactTone | null | undefined): string {
  return TONE_CLASS[tone ?? "neutral"];
}

/**
 * A name for an action button whose whole label is the em dash.
 *
 * Keeping the design's geometry when nothing is served is right — the button
 * stays, dimmed and inert — but its rendered label is then a single dash, so
 * assistive tech announces an unnamed dimmed button and nothing explains why.
 * This says why, without changing a pixel. `undefined` for a real label, so a
 * served action keeps its own text as its accessible name.
 */
function unservedActionName(label: string, subject: string): string | undefined {
  return label === EM_DASH ? `No action available: ${subject}` : undefined;
}

function slots<T>(values: readonly T[] | null | undefined, count: number): Array<T | undefined> {
  return Array.from({ length: count }, (_, index) => values?.[index]);
}

function callWithPropagationStopped(event: MouseEvent, callback?: () => void) {
  event.stopPropagation();
  callback?.();
}

function ExactKpiBand({
  kpis,
  onManageLabels,
}: {
  kpis?: MetaDecisionCenterExactKpisViewModel;
  onManageLabels?: () => void;
}) {
  const modeChips = slots(kpis?.mode?.chips, 2);
  return (
    <div className={styles.kpiGrid} data-meta-exact-section="kpis">
      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>Spend · today</p>
        <p className={styles.kpiValue}>
          {display(kpis?.spend?.value)}{" "}
          <span className={styles.spendDelta}>{display(kpis?.spend?.delta)}</span>
        </p>
        <p className={styles.kpiDetail}>{display(kpis?.spend?.detail)}</p>
      </article>

      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>
          {display(kpis?.roas?.label ?? "ROAS · 28d")}
        </p>
        <p className={styles.kpiValue}>
          {display(kpis?.roas?.value)}{" "}
          <span className={styles.roasTarget}>target {display(kpis?.roas?.target)}</span>
        </p>
        <svg
          aria-hidden="true"
          className={styles.roasSpark}
          viewBox="0 0 100 20"
          preserveAspectRatio="none"
        >
          <path
            d="M0 12 L100 12"
            stroke="#C9D2E0"
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={kpis?.roas?.sparkPath ?? ""}
            fill="none"
            stroke="#2F6BFF"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </article>

      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>Snapshot</p>
        <span className={styles.freshnessPill}>{display(kpis?.snapshot?.freshness)}</span>
        <p className={styles.snapshotDetail}>{display(kpis?.snapshot?.detail)}</p>
      </article>

      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>Labels</p>
        <p className={styles.kpiValue}>
          {display(kpis?.labels?.coverage)}{" "}
          <span className={styles.labelPercentage}>{display(kpis?.labels?.percentage)}</span>
        </p>
        <p className={styles.manageLabels} onClick={onManageLabels}>
          Manage labels →
        </p>
      </article>

      <article className={styles.kpiCard}>
        <p className={styles.kpiLabel}>Mode</p>
        <p className={styles.modeValue}>{display(kpis?.mode?.value)}</p>
        <div className={styles.modeChips}>
          {modeChips.map((chip, index) => (
            <span
              className={`${styles.modeChip} ${toneClass(chip?.tone)}`}
              key={`mode-chip-${index}`}
            >
              {display(chip?.label)}
            </span>
          ))}
        </div>
      </article>
    </div>
  );
}

function ActionLane({ rows }: { rows: readonly MetaDecisionCenterExactActionRowViewModel[] }) {
  return (
    <>
      {rows.map((row) => (
        <article
          className={`${styles.actionCard} ${toneClass(row.edgeTone)}`}
          data-meta-exact-action-row={row.id}
          key={row.id}
        >
          <div className={styles.actionIdentity}>
            <div className={styles.entityHeading}>
              <span className={styles.entityName}>{display(row.name)}</span>
              <span className={styles.entityLevel}>{display(row.level)}</span>
            </div>
            <div className={styles.rowChips}>
              {(row.chips ?? []).map((chip, index) => (
                <span className={styles.rowChip} key={`${row.id}-chip-${index}`}>
                  {display(chip)}
                </span>
              ))}
            </div>
          </div>
          <span className={`${styles.decisionLabel} ${toneClass(row.decisionTone)}`}>
            {display(row.decisionLabel)}
          </span>
          <div className={styles.moneyBlock}>
            <p className={styles.moneyValue}>{display(row.money)}</p>
            <p className={styles.moneySub}>{display(row.moneySub)}</p>
          </div>
          <span className={`${styles.confidencePill} ${toneClass(row.confidenceTone)}`}>
            {display(row.confidence)} confidence
          </span>
          <button
            aria-label={unservedActionName(
              display(row.actionLabel),
              "this decision was served without one",
            )}
            className={`${styles.primaryAction} ${toneClass(row.actionTone)}`}
            disabled={!row.onPrimary}
            onClick={row.onPrimary}
            type="button"
          >
            {display(row.actionLabel)}
          </button>
          <span className={styles.moreAction} onClick={row.onMenu}>
            ⋯
          </span>
        </article>
      ))}
    </>
  );
}

function WatchingLane({
  segments,
  rows,
}: {
  segments: readonly MetaDecisionCenterExactWatchSegmentViewModel[];
  rows: readonly MetaDecisionCenterExactWatchingRowViewModel[];
}) {
  return (
    <>
      <div className={styles.watchSegments}>
        {slots(segments, 5).map((segment, index) => (
          <span className={styles.watchSegment} key={segment?.id ?? `watch-segment-${index}`}>
            {segment ? `${display(segment.label)} ${display(segment.count)}` : EM_DASH}
          </span>
        ))}
      </div>
      {rows.map((row) => (
        <article className={styles.watchingCard} data-meta-exact-watching-row={row.id} key={row.id}>
          <span className={`${styles.watchBadge} ${toneClass(row.segmentTone)}`}>
            {display(row.segment)}
          </span>
          <div className={styles.watchingIdentity}>
            <span className={styles.watchingName}>{display(row.name)}</span>
            <span className={styles.watchLevel}>{display(row.level)}</span>
            <p className={styles.watchingNote}>{display(row.note)}</p>
          </div>
          <span className={styles.watchingMoney}>{display(row.money)}</span>
          <button
            className={styles.reviewButton}
            disabled={!row.onReview}
            onClick={row.onReview}
            type="button"
          >
            Review
          </button>
        </article>
      ))}
    </>
  );
}

function HealthyLane({ groups }: { groups: readonly MetaDecisionCenterExactHealthyGroupViewModel[] }) {
  return (
    <>
      {groups.map((group) => (
        <article className={styles.healthyCard} data-meta-exact-healthy-group={group.id} key={group.id}>
          <div className={styles.healthyHeader}>
            <span className={styles.healthyDot} />
            <span className={styles.healthyName}>{display(group.name)}</span>
            <span className={styles.healthyStrategy}>{display(group.strategy)}</span>
            <span className={styles.healthyRollup}>{display(group.rollup)}</span>
          </div>
          {(group.adsets ?? []).map((adset) => (
            <div className={styles.healthyAdset} key={adset.id}>
              <span className={styles.healthyAdsetName}>{display(adset.name)}</span>
              <span className={styles.healthyStats}>{display(adset.stats)}</span>
            </div>
          ))}
        </article>
      ))}
    </>
  );
}

function NonSalesLane({ card }: { card?: MetaDecisionCenterExactNonSalesViewModel | null }) {
  const metrics = slots(card?.metrics, 4);
  return (
    <article className={styles.nonSalesCard} data-meta-exact-nonsales>
      <div className={styles.nonSalesHeading}>
        <span className={styles.nonSalesName}>{display(card?.name)}</span>
        <span className={styles.nonSalesLevel}>{display(card?.level)}</span>
        <span className={styles.nonSalesContext}>{display(card?.contextLabel)}</span>
      </div>
      <div className={styles.nonSalesMetrics}>
        {metrics.map((metric, index) => (
          <div className={styles.nonSalesMetric} key={metric?.id ?? `non-sales-metric-${index}`}>
            <p className={styles.nonSalesMetricLabel}>{display(metric?.label)}</p>
            <p className={styles.nonSalesMetricValue}>{display(metric?.value)}</p>
          </div>
        ))}
      </div>
      <p className={styles.nonSalesNote}>{display(card?.note)}</p>
    </article>
  );
}

function ArchiveLane({ rows }: { rows: readonly MetaDecisionCenterExactArchiveRowViewModel[] }) {
  return (
    <article className={styles.archiveCard} data-meta-exact-archive>
      <table className={styles.archiveTable}>
        <thead>
          <tr>
            <th>Entity</th>
            <th>Status</th>
            <th>Spend · 28d</th>
            <th>Note</th>
            <th aria-label="Action" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{display(row.name)}</td>
              <td>
                <span className={`${styles.archiveStatus} ${toneClass(row.statusTone)}`}>
                  {display(row.status)}
                </span>
              </td>
              <td>{display(row.spend)}</td>
              <td>{display(row.note)}</td>
              <td>
                {row.showResume === true ? (
                  <button
                    className={styles.resumeButton}
                    disabled={!row.onResume}
                    onClick={row.onResume}
                    type="button"
                  >
                    Resume
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

function CreativesScope({
  posture,
  decisions,
  onOpenCreativeStudio,
}: {
  posture: readonly MetaDecisionCenterExactCreativePostureViewModel[];
  decisions: readonly MetaDecisionCenterExactCreativeDecisionViewModel[];
  onOpenCreativeStudio?: () => void;
}) {
  return (
    <>
      <div className={styles.postureGrid} data-meta-exact-creative-posture>
        {slots(posture, 4).map((item, index) => (
          <div
            className={`${styles.postureCard} ${toneClass(item?.tone)}`}
            key={item?.id ?? `posture-${index}`}
          >
            <p className={styles.postureLabel}>{display(item?.label)}</p>
            <p className={styles.postureValue}>{display(item?.value)}</p>
            <p className={styles.postureDetail}>{display(item?.detail)}</p>
          </div>
        ))}
      </div>
      {decisions.map((row) => {
        const stripeA = row.stripeA?.trim() || "#F1F4F9";
        const stripeB = row.stripeB?.trim() || "#F7F9FC";
        return (
          <article
            className={`${styles.creativeCard} ${toneClass(row.edgeTone)}`}
            data-meta-exact-creative-row={row.id}
            key={row.id}
            onClick={row.onOpen}
          >
            <span
              className={styles.creativeThumb}
              style={{
                backgroundImage: `repeating-linear-gradient(135deg,${stripeA},${stripeA} 8px,${stripeB} 8px,${stripeB} 16px)`,
              }}
            >
              <span className={styles.creativeKind}>{display(row.kindShort)}</span>
            </span>
            <div className={styles.creativeIdentity}>
              <div className={styles.creativeHeading}>
                <span className={styles.creativeName}>{display(row.name)}</span>
                <span className={`${styles.creativeDecisionLabel} ${toneClass(row.decisionTone)}`}>
                  {display(row.decisionLabel)}
                </span>
              </div>
              <div className={styles.rowChips}>
                {(row.chips ?? []).map((chip, index) => (
                  <span className={styles.rowChip} key={`${row.id}-chip-${index}`}>
                    {display(chip)}
                  </span>
                ))}
              </div>
            </div>
            <div className={styles.creativeSparkBlock}>
              <p className={styles.creativeSparkLabel}>CTR · 28d</p>
              <svg aria-hidden="true" viewBox="0 0 100 22" preserveAspectRatio="none">
                <path
                  d={row.sparkPath ?? ""}
                  fill="none"
                  stroke="var(--tone-solid)"
                  strokeWidth="1.6"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>
            <div className={styles.creativeMoneyBlock}>
              <p className={styles.moneyValue}>{display(row.money)}</p>
              <p className={styles.moneySub}>{display(row.moneySub)}</p>
            </div>
            <button
              aria-label={unservedActionName(
                display(row.actionLabel),
                "this creative was served without one",
              )}
              className={`${styles.primaryAction} ${toneClass(row.actionTone)}`}
              disabled={!row.onPrimary}
              onClick={(event) => callWithPropagationStopped(event, row.onPrimary)}
              type="button"
            >
              {display(row.actionLabel)}
            </button>
            <span className={styles.evidenceLink}>Evidence →</span>
          </article>
        );
      })}
      <div className={styles.creativeFootnote}>
        <p>
          The engine makes only three ad-level calls — refresh, retire, scale winner. Click a row
          for the evidence window; metric deep-dives and side-by-side comparison live in Creative
          Studio.
        </p>
        <span onClick={onOpenCreativeStudio}>Open Creative Studio →</span>
      </div>
    </>
  );
}

function EvidenceInspector({ model }: { model?: MetaDecisionCenterExactInspectorViewModel | null }) {
  const reasons = slots(model?.reasons, 3);
  const evidence = slots(model?.evidence, 4);
  const inspectorTone = toneClass(model?.tone);
  return (
    <aside className={`${styles.inspector} ${inspectorTone}`} data-meta-exact-inspector>
      <div className={styles.inspectorHeader}>
        <span className={styles.inspectorEyebrow}>Evidence inspector</span>
        <span className={`${styles.inspectorDecision} ${inspectorTone}`}>
          {display(model?.decisionLabel)}
        </span>
      </div>
      <div className={styles.inspectorBody}>
        <div>
          <p className={styles.inspectorEntity}>{display(model?.entityName)}</p>
          <p className={styles.inspectorMeta}>{display(model?.entityMeta)}</p>
        </div>
        <div className={styles.contractCard}>
          <p className={styles.inspectorSectionLabel}>Decision contract</p>
          <p className={styles.contractCopy}>
            Server verdict: <b>{display(model?.serverVerdict)}</b>. {display(model?.contractDetail)}
          </p>
        </div>
        <div>
          <p className={styles.reasonHeading}>Engine reasoning</p>
          {reasons.map((reason, index) => (
            <p className={styles.reasonRow} key={`reason-${index}`}>
              <span />
              <span>{display(reason)}</span>
            </p>
          ))}
        </div>
        <div className={styles.moneyImpact}>
          <p className={styles.inspectorSectionLabel}>Money impact · ROAS vs target</p>
          <p className={styles.inspectorMoneyValue}>
            {display(model?.moneyValue)}{" "}
            <span>{display(model?.targetComparison)}</span>
          </p>
          <svg aria-hidden="true" viewBox="0 0 100 24" preserveAspectRatio="none">
            <path
              d="M0 14 L100 14"
              stroke="#C9D2E0"
              strokeWidth="1"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={model?.moneySparkPath ?? ""}
              fill="none"
              stroke="var(--tone-solid)"
              strokeWidth="1.6"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <p className={styles.inspectorMoneyDetail}>{display(model?.moneyDetail)}</p>
        </div>
        <div className={styles.inspectorMiniTiles}>
          <span className={`${styles.inspectorMiniTile} ${styles.confidenceTile}`}>
            <span className={styles.inspectorMiniLabel}>Confidence</span>
            <span className={styles.inspectorMiniValue}>{display(model?.confidence)}</span>
          </span>
          <span className={`${styles.inspectorMiniTile} ${styles.readinessTile}`}>
            <span className={styles.inspectorMiniLabel}>Readiness</span>
            <span className={styles.inspectorMiniValue}>{display(model?.readiness)}</span>
          </span>
        </div>
        <div>
          <p className={styles.blockersHeading}>Blockers</p>
          <p className={`${styles.blockersCopy} ${toneClass(model?.blockerTone)}`}>
            {display(model?.blockers)}
          </p>
        </div>
        {evidence.map((item, index) => (
          <div className={styles.evidenceRow} key={item?.id ?? `evidence-${index}`}>
            <span>{display(item?.label)}</span>
            <span>{display(item?.value)}</span>
          </div>
        ))}
        <button
          aria-label={unservedActionName(
            display(model?.actionLabel),
            "the inspector has no selection to act on",
          )}
          className={`${styles.inspectorPrimary} ${toneClass(model?.actionTone)}`}
          disabled={!model?.onPrimary}
          onClick={model?.onPrimary}
          type="button"
        >
          {display(model?.actionLabel)}
        </button>
        <p className={styles.provenance}>{display(model?.provenance)}</p>
      </div>
    </aside>
  );
}

export function MetaDecisionCenterExact({
  viewModel,
  scope,
  defaultScope = "structure",
  lane,
  defaultLane = "action",
  inspectorOpen = true,
  onScopeChange,
  onLaneChange,
  onWindowChange,
  onRunSnapshot,
  onNewCampaign,
  onManageLabels,
  onSortChange,
  onSearchChange,
  onOpenCreativeStudio,
}: MetaDecisionCenterExactProps) {
  const [internalScope, setInternalScope] = useState<MetaDecisionCenterExactScope>(defaultScope);
  const [internalLane, setInternalLane] = useState<MetaDecisionCenterExactLane>(defaultLane);
  const [sort, setSort] = useState<MetaDecisionCenterExactSort>("money");
  const [query, setQuery] = useState("");

  const activeScope = scope ?? internalScope;
  const activeLane = lane ?? internalLane;
  const activeWindow =
    viewModel.activeWindow === undefined ? "28d" : viewModel.activeWindow;
  const counts = viewModel.counts;
  const identity = viewModel.identity;
  const showInspector = inspectorOpen && activeScope === "structure" && activeLane === "action";

  function selectScope(nextScope: MetaDecisionCenterExactScope) {
    if (scope === undefined) setInternalScope(nextScope);
    onScopeChange?.(nextScope);
  }

  function selectLane(nextLane: MetaDecisionCenterExactLane) {
    if (lane === undefined) setInternalLane(nextLane);
    onLaneChange?.(nextLane);
  }

  return (
    <section className={styles.root} data-screen-label="Meta Decision Center">
      <div className={styles.pageHeader}>
        <div>
          <p className={styles.pageEyebrow}>
            Meta · {display(identity?.accountLabel)} · {display(identity?.currency)}
          </p>
          <h1>Decision Center</h1>
          <p className={styles.asOfLine} data-meta-exact-source-identity>
            {display(identity?.syncedLabel)} · {display(identity?.snapshotLabel)} ·{" "}
            {display(identity?.engineLabel)} · {display(identity?.timeLabel)}
          </p>
        </div>
        <div className={styles.headerTools}>
          <span className={styles.windowControl}>
            {WINDOWS.map((window) => (
              <span
                className={`${styles.windowOption} ${
                  activeWindow === window ? styles.windowOptionActive : ""
                }`}
                data-meta-exact-window={window}
                key={window}
                onClick={() => onWindowChange?.(window)}
              >
                {window}
              </span>
            ))}
          </span>
          <button
            className={styles.snapshotButton}
            disabled={!onRunSnapshot}
            onClick={onRunSnapshot}
            type="button"
          >
            Run snapshot
          </button>
          <button
            className={styles.newCampaignButton}
            disabled={!onNewCampaign}
            onClick={onNewCampaign}
            type="button"
          >
            + New campaign
          </button>
        </div>
      </div>

      <ExactKpiBand kpis={viewModel.kpis} onManageLabels={onManageLabels} />

      <div className={styles.scopeRow}>
        <span className={styles.scopeControl}>
          <span
            className={`${styles.scopeOption} ${
              activeScope === "structure" ? styles.scopeOptionActive : ""
            }`}
            data-meta-exact-scope="structure"
            onClick={() => selectScope("structure")}
          >
            Campaigns &amp; Ad sets
            <span>{display(counts?.structure)}</span>
          </span>
          <span
            className={`${styles.scopeOption} ${
              activeScope === "creatives" ? styles.scopeOptionActive : ""
            }`}
            data-meta-exact-scope="creatives"
            onClick={() => selectScope("creatives")}
          >
            Creatives
            <span>{display(counts?.creatives)}</span>
          </span>
        </span>
        <p data-meta-exact-queue-snapshot>
          queue reflects {display(identity?.snapshotLabel)} — the date range scopes metrics, not
          decisions
        </p>
      </div>

      {activeScope === "structure" ? (
        <div className={styles.laneToolbar} data-meta-exact-lane-toolbar>
          {LANES.map((item) => (
            <span
              className={`${styles.laneOption} ${
                activeLane === item.id ? styles.laneOptionActive : ""
              }`}
              data-meta-exact-lane={item.id}
              key={item.id}
              onClick={() => selectLane(item.id)}
            >
              {item.label}
              <span>{display(counts?.[item.id])}</span>
            </span>
          ))}
          <span className={styles.deferredPill}>Deferred {display(counts?.deferred)}</span>
          <span className={styles.toolbarSpacer} />
          <select
            aria-label="Sort decisions"
            onChange={(event) => {
              const next = event.target.value as MetaDecisionCenterExactSort;
              setSort(next);
              onSortChange?.(next);
            }}
            value={sort}
          >
            <option value="money">Sort: Money at stake</option>
            <option value="priority">Sort: Priority</option>
            <option value="age">Sort: Age</option>
          </select>
          <input
            aria-label="Search entities"
            onChange={(event) => {
              setQuery(event.target.value);
              onSearchChange?.(event.target.value);
            }}
            placeholder="Search entities…"
            value={query}
          />
        </div>
      ) : null}

      <div
        className={`${styles.workspace} ${showInspector ? styles.workspaceWithInspector : ""}`}
        data-meta-exact-workspace
      >
        <div className={styles.queue}>
          {activeScope === "structure" && activeLane === "action" ? (
            <ActionLane rows={viewModel.actionRows ?? []} />
          ) : null}
          {activeScope === "structure" && activeLane === "watching" ? (
            <WatchingLane
              rows={viewModel.watchingRows ?? []}
              segments={viewModel.watchSegments ?? []}
            />
          ) : null}
          {activeScope === "structure" && activeLane === "healthy" ? (
            <HealthyLane groups={viewModel.healthyGroups ?? []} />
          ) : null}
          {activeScope === "structure" && activeLane === "nonsales" ? (
            <NonSalesLane card={viewModel.nonSales} />
          ) : null}
          {activeScope === "structure" && activeLane === "archive" ? (
            <ArchiveLane rows={viewModel.archiveRows ?? []} />
          ) : null}
          {activeScope === "creatives" ? (
            <CreativesScope
              decisions={viewModel.creativeDecisions ?? []}
              onOpenCreativeStudio={onOpenCreativeStudio}
              posture={viewModel.creativePosture ?? []}
            />
          ) : null}
        </div>
        {showInspector ? <EvidenceInspector model={viewModel.inspector} /> : null}
      </div>
    </section>
  );
}
