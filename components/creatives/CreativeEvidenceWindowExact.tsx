"use client";

import { useEffect, type MouseEvent, type ReactNode } from "react";

import styles from "./CreativeEvidenceWindowExact.module.css";

const EM_DASH = "—";

export type CreativeEvidenceWindowExactDisplayValue =
  string | number | null | undefined;

export type CreativeEvidenceWindowExactTone =
  "positive" | "negative" | "warning" | "info" | "automation" | "neutral";

export interface CreativeEvidenceWindowExactFunnelStep {
  id: string;
  label?: CreativeEvidenceWindowExactDisplayValue;
  value?: CreativeEvidenceWindowExactDisplayValue;
  sub?: CreativeEvidenceWindowExactDisplayValue;
  /** 0..1 of the funnel top. Null renders the track with no fill. */
  share?: number | null;
}

export interface CreativeEvidenceWindowExactPlacement {
  id: string;
  label?: CreativeEvidenceWindowExactDisplayValue;
  share?: CreativeEvidenceWindowExactDisplayValue;
  roas?: CreativeEvidenceWindowExactDisplayValue;
  /** 0..1 of the placement total. Null renders the track with no fill. */
  width?: number | null;
}

export interface CreativeEvidenceWindowExactAdSet {
  id: string;
  label?: CreativeEvidenceWindowExactDisplayValue;
  spend?: CreativeEvidenceWindowExactDisplayValue;
  roas?: CreativeEvidenceWindowExactDisplayValue;
  roasTone?: CreativeEvidenceWindowExactTone;
}

export interface CreativeEvidenceWindowExactFact {
  id: string;
  label?: CreativeEvidenceWindowExactDisplayValue;
  value?: CreativeEvidenceWindowExactDisplayValue;
  tone?: CreativeEvidenceWindowExactTone;
}

export interface CreativeEvidenceWindowExactSeries {
  path?: string | null;
  note?: CreativeEvidenceWindowExactDisplayValue;
}

export interface CreativeEvidenceWindowExactAction {
  label?: CreativeEvidenceWindowExactDisplayValue;
  href?: string | null;
  onClick?: () => void;
  disabled?: boolean;
  /** Anchors that leave the app carry the provider target. */
  external?: boolean;
}

/**
 * One audit field. Used for both the authority block (evidence that qualifies
 * the numbers) and the diagnostics disclosure (receipts that prove them).
 */
export interface CreativeEvidenceWindowExactAuditRow {
  id: string;
  label?: CreativeEvidenceWindowExactDisplayValue;
  value?: CreativeEvidenceWindowExactDisplayValue;
  tone?: CreativeEvidenceWindowExactTone;
}

/**
 * The state of the drawer's ad-grain helper reads, in words.
 *
 * Without this every unresolved cell printed the same em-dash a genuinely
 * unserved cell prints, so a broken read looked exactly like an empty account.
 */
export interface CreativeEvidenceWindowExactReadNotice {
  tone: CreativeEvidenceWindowExactTone;
  text: string;
}

/**
 * Which half of this row's evidence the window is actually holding.
 *
 * A Meta ad decision arrives in two envelopes and they are not interchangeable.
 * The SERVED presentation decision carries the engine's reading — why now, the
 * assessment, blockers, resolution, lane, availability and the ad's own metrics.
 * The CANONICAL decision snapshot carries the audit half — hashes, provider
 * lineage, identity resolution, action eligibility, operator responses,
 * provider-write outcome, risk tier and confirmation ceremony.
 *
 * A row can be served with only the first. When that happens the window must
 * not stay silent about it: an operator reading a screen full of dashes cannot
 * tell "the engine measured nothing" from "this row has no audit envelope at
 * all", and the second is the only one that also means the row carries no
 * authority. So the window says which half it has, in words, above the
 * evidence — and nothing below it is inferred to fill the other half in.
 */
export interface CreativeEvidenceWindowExactCoverage {
  /** `served-only` is the row with no canonical envelope. */
  state: "served-and-canonical" | "served-only" | "canonical-only";
  tone: CreativeEvidenceWindowExactTone;
  headline: string;
  servedLabel: string;
  served: readonly string[];
  unavailableLabel: string;
  unavailable: readonly string[];
  /** The authority sentence. Empty string when there is nothing to withhold. */
  note: string;
}

export interface CreativeEvidenceWindowExactViewModel {
  name?: CreativeEvidenceWindowExactDisplayValue;
  decisionLabel?: CreativeEvidenceWindowExactDisplayValue;
  decisionTone?: CreativeEvidenceWindowExactTone;
  previewUrl?: string | null;
  stripeA?: string | null;
  stripeB?: string | null;
  kind?: CreativeEvidenceWindowExactDisplayValue;
  band?: CreativeEvidenceWindowExactDisplayValue;
  bandTone?: CreativeEvidenceWindowExactTone;
  verdict?: CreativeEvidenceWindowExactDisplayValue;
  verdictSub?: CreativeEvidenceWindowExactDisplayValue;
  money?: CreativeEvidenceWindowExactDisplayValue;
  moneySub?: CreativeEvidenceWindowExactDisplayValue;
  reasons?: readonly CreativeEvidenceWindowExactDisplayValue[];
  ctr?: CreativeEvidenceWindowExactSeries;
  frequency?: CreativeEvidenceWindowExactSeries;
  funnel?: readonly CreativeEvidenceWindowExactFunnelStep[];
  placements?: readonly CreativeEvidenceWindowExactPlacement[];
  adSets?: readonly CreativeEvidenceWindowExactAdSet[];
  facts?: readonly CreativeEvidenceWindowExactFact[];
  /** Loading / failed state of the ad-grain helper reads. Null when resolved. */
  readNotice?: CreativeEvidenceWindowExactReadNotice | null;
  /** Concise buyer-facing reason an otherwise visible action is unavailable. */
  actionNotice?: CreativeEvidenceWindowExactReadNotice | null;
  /** Which half of the evidence is served and which is canonical-only. */
  coverage?: CreativeEvidenceWindowExactCoverage | null;
  /** Source authority, eligibility, identity, risk, responses, write outcome. */
  authority?: readonly CreativeEvidenceWindowExactAuditRow[];
  /** Hashes, lineage ids and receipts. Closed by default. */
  diagnostics?: readonly CreativeEvidenceWindowExactAuditRow[];
  provenance?: CreativeEvidenceWindowExactDisplayValue;
  primaryAction?: CreativeEvidenceWindowExactAction;
  compareAction?: CreativeEvidenceWindowExactAction;
  adsManagerAction?: CreativeEvidenceWindowExactAction;
}

export interface CreativeEvidenceWindowExactProps {
  viewModel: CreativeEvidenceWindowExactViewModel;
  onClose: () => void;
}

const TONE_CLASS: Record<CreativeEvidenceWindowExactTone, string> = {
  positive: styles.tonePositive,
  negative: styles.toneNegative,
  warning: styles.toneWarning,
  info: styles.toneInfo,
  automation: styles.toneAutomation,
  neutral: styles.toneNeutral,
};

/** The design's funnel bars step through four blues into the purchase green. */
const FUNNEL_STEP_CLASS = [
  styles.funnelFillA,
  styles.funnelFillB,
  styles.funnelFillC,
  styles.funnelFillD,
];

function display(value: CreativeEvidenceWindowExactDisplayValue): string {
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : EM_DASH;
  if (typeof value !== "string") return EM_DASH;
  return value.trim() || EM_DASH;
}

function toneClass(
  tone: CreativeEvidenceWindowExactTone | null | undefined,
): string {
  return TONE_CLASS[tone ?? "neutral"];
}

function meaningful(value: CreativeEvidenceWindowExactDisplayValue): boolean {
  const rendered = display(value);
  return rendered !== EM_DASH && rendered !== "…" && rendered !== "unreadable";
}

function widthStyle(share: number | null | undefined): string {
  if (typeof share !== "number" || !Number.isFinite(share) || share <= 0)
    return "0%";
  return `${Math.min(100, share * 100).toFixed(1)}%`;
}

function stopPropagation(event: MouseEvent) {
  event.stopPropagation();
}

function FooterAction({
  action,
  className,
}: {
  action: CreativeEvidenceWindowExactAction | undefined;
  className: string;
}) {
  const label = display(action?.label);
  const href = action?.href?.trim();
  if (href && !action?.disabled) {
    return (
      <a
        className={className}
        href={href}
        {...(action?.external ? { rel: "noreferrer", target: "_blank" } : {})}
      >
        {label}
      </a>
    );
  }
  return (
    <button
      className={className}
      disabled={action?.disabled || !action?.onClick}
      onClick={action?.onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function BodyCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `${styles.card} ${className}` : styles.card}>
      {children}
    </div>
  );
}

export function CreativeEvidenceWindowExact({
  viewModel,
  onClose,
}: CreativeEvidenceWindowExactProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const reasons = (viewModel.reasons ?? []).filter(meaningful);
  const funnel = (viewModel.funnel ?? []).filter(
    (step) =>
      meaningful(step.label) &&
      (meaningful(step.value) ||
        (typeof step.share === "number" && Number.isFinite(step.share))),
  );
  const placements = (viewModel.placements ?? []).filter(
    (placement) =>
      meaningful(placement.label) &&
      (meaningful(placement.share) || meaningful(placement.roas)),
  );
  const adSets = (viewModel.adSets ?? []).filter(
    (adSet) =>
      meaningful(adSet.label) &&
      (meaningful(adSet.spend) || meaningful(adSet.roas)),
  );
  const facts = (viewModel.facts ?? []).filter(
    (fact) => meaningful(fact.label) && meaningful(fact.value),
  );
  const showCtr =
    Boolean(viewModel.ctr?.path) || meaningful(viewModel.ctr?.note);
  const showFrequency =
    Boolean(viewModel.frequency?.path) || meaningful(viewModel.frequency?.note);
  const primaryAction = meaningful(viewModel.primaryAction?.label)
    ? viewModel.primaryAction
    : undefined;
  const compareAction =
    viewModel.compareAction?.href || viewModel.compareAction?.onClick
      ? viewModel.compareAction
      : undefined;
  const adsManagerAction =
    viewModel.adsManagerAction?.href || viewModel.adsManagerAction?.onClick
      ? viewModel.adsManagerAction
      : undefined;
  const showFooter = Boolean(
    primaryAction || compareAction || adsManagerAction,
  );
  const stripeA = viewModel.stripeA?.trim() || "#EAF0FF";
  const stripeB = viewModel.stripeB?.trim() || "#F7F9FC";
  const previewUrl = viewModel.previewUrl?.trim() || null;
  const showDecisionCard =
    meaningful(viewModel.verdict) ||
    meaningful(viewModel.verdictSub) ||
    meaningful(viewModel.money) ||
    meaningful(viewModel.moneySub);

  return (
    <div
      className={styles.overlay}
      data-testid="creative-evidence-window"
      onClick={onClose}
      role="presentation"
    >
      <aside
        aria-label="Creative decision"
        aria-modal="true"
        className={styles.drawer}
        onClick={stopPropagation}
        role="dialog"
      >
        <div className={styles.header}>
          <div className={styles.headerIdentity}>
            <p className={styles.headerEyebrow}>Creative decision</p>
            <p className={styles.headerTitle}>{display(viewModel.name)}</p>
          </div>
          {meaningful(viewModel.decisionLabel) ? (
            <span
              className={`${styles.headerChip} ${toneClass(viewModel.decisionTone)}`}
            >
              {display(viewModel.decisionLabel)}
            </span>
          ) : null}
          {meaningful(viewModel.band) ? (
            <span
              className={`${styles.bandPill} ${toneClass(viewModel.bandTone)}`}
            >
              {display(viewModel.band)}
            </span>
          ) : null}
          <span
            aria-label="Close creative decision"
            className={styles.headerClose}
            onClick={onClose}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClose();
              }
            }}
            role="button"
            tabIndex={0}
          >
            ✕
          </span>
        </div>

        <div className={styles.body}>
          {viewModel.readNotice ? (
            <p
              className={`${styles.readNotice} ${toneClass(viewModel.readNotice.tone)}`}
              data-creative-evidence-read-state={
                viewModel.readNotice.tone === "negative" ? "error" : "loading"
              }
              role="status"
            >
              {viewModel.readNotice.text}
            </p>
          ) : null}
          {viewModel.actionNotice ? (
            <p
              className={`${styles.readNotice} ${toneClass(viewModel.actionNotice.tone)}`}
              data-creative-evidence-action-state="unavailable"
              role="status"
            >
              {viewModel.actionNotice.text}
            </p>
          ) : null}
          {previewUrl ? (
            <div className={styles.previewCard}>
              <div
                className={styles.previewStage}
                style={{
                  backgroundImage: `repeating-linear-gradient(135deg,${stripeA},${stripeA} 12px,${stripeB} 12px,${stripeB} 24px)`,
                }}
              >
                <img
                  alt=""
                  className={styles.previewImage}
                  data-creative-evidence-preview="served"
                  src={previewUrl}
                />
              </div>
              <div className={styles.previewFooter}>
                <span className={styles.previewKind}>
                  {display(viewModel.kind)}
                </span>
                <span
                  className={`${styles.bandPill} ${toneClass(viewModel.bandTone)}`}
                >
                  {display(viewModel.band)}
                </span>
              </div>
            </div>
          ) : null}

          {showDecisionCard ? (
            <BodyCard
              className={`${styles.contractCard} ${toneClass(viewModel.decisionTone)}`}
            >
              <p className={styles.cardEyebrow}>Decision</p>
              <p className={styles.verdictLine}>
                <b>{display(viewModel.verdict)}</b>{" "}
                {display(viewModel.verdictSub)}
              </p>
              <p className={styles.moneyLine}>
                {display(viewModel.money)}{" "}
                <span className={styles.moneySub}>
                  {display(viewModel.moneySub)}
                </span>
              </p>
            </BodyCard>
          ) : null}

          {!showDecisionCard &&
          !viewModel.readNotice &&
          !viewModel.actionNotice &&
          !previewUrl &&
          reasons.length === 0 &&
          funnel.length === 0 &&
          placements.length === 0 &&
          adSets.length === 0 &&
          facts.length === 0 ? (
            <p className={styles.readNotice} role="status">
              Decision details are unavailable.
            </p>
          ) : null}

          {reasons.length > 0 ? (
            <BodyCard className={toneClass(viewModel.decisionTone)}>
              <p className={styles.cardEyebrowReasons}>Why</p>
              {reasons.map((reason, index) => (
                <p className={styles.reasonLine} key={`reason-${index}`}>
                  <span aria-hidden="true" className={styles.reasonDot} />
                  <span>{display(reason)}</span>
                </p>
              ))}
            </BodyCard>
          ) : null}

          {showCtr || showFrequency ? (
            <div className={styles.pairGrid}>
              {showCtr ? (
                <BodyCard className={toneClass(viewModel.decisionTone)}>
                  <p className={styles.cardEyebrow}>CTR · 28d</p>
                  <svg
                    aria-hidden="true"
                    className={styles.sparkline}
                    preserveAspectRatio="none"
                    viewBox="0 0 100 22"
                  >
                    <path
                      d={viewModel.ctr?.path ?? ""}
                      fill="none"
                      stroke="var(--tone-solid)"
                      strokeWidth="1.6"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  <p className={styles.seriesNote}>
                    {display(viewModel.ctr?.note)}
                  </p>
                </BodyCard>
              ) : null}
              {showFrequency ? (
                <BodyCard>
                  <p className={styles.cardEyebrow}>Frequency · 28d</p>
                  <svg
                    aria-hidden="true"
                    className={styles.sparkline}
                    preserveAspectRatio="none"
                    viewBox="0 0 100 22"
                  >
                    <path
                      d={viewModel.frequency?.path ?? ""}
                      fill="none"
                      stroke="#e11d48"
                      strokeWidth="1.6"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  <p className={styles.seriesNote}>
                    {display(viewModel.frequency?.note)}
                  </p>
                </BodyCard>
              ) : null}
            </div>
          ) : null}

          {funnel.length > 0 ? (
            <BodyCard>
              <p className={styles.cardEyebrowSpaced}>
                Click-to-purchase funnel · 28d
              </p>
              <div className={styles.funnelRows}>
                {funnel.map((step, index) => (
                  <div className={styles.funnelRow} key={step.id}>
                    <span className={styles.funnelLabel}>
                      {display(step.label)}
                    </span>
                    <span className={styles.funnelTrack}>
                      <span
                        className={`${styles.funnelFill} ${FUNNEL_STEP_CLASS[index] ?? ""}`}
                        style={{ width: widthStyle(step.share) }}
                      />
                    </span>
                    <span className={styles.funnelValue}>
                      {display(step.value)}
                    </span>
                    <span className={styles.funnelSub}>
                      {typeof step.sub === "string" && !step.sub.trim()
                        ? ""
                        : display(step.sub)}
                    </span>
                  </div>
                ))}
              </div>
            </BodyCard>
          ) : null}

          {placements.length > 0 || adSets.length > 0 ? (
            <div className={styles.pairGrid}>
              {placements.length > 0 ? (
                <BodyCard>
                  <p className={styles.cardEyebrowSpaced}>Placement mix</p>
                  {placements.map((placement) => (
                    <div className={styles.placementRow} key={placement.id}>
                      <div className={styles.placementHead}>
                        <span className={styles.placementLabel}>
                          {display(placement.label)}
                        </span>
                        <span className={styles.placementStats}>
                          {display(placement.share)} · ROAS{" "}
                          {display(placement.roas)}
                        </span>
                      </div>
                      <div className={styles.placementTrack}>
                        <div
                          className={styles.placementFill}
                          style={{ width: widthStyle(placement.width) }}
                        />
                      </div>
                    </div>
                  ))}
                </BodyCard>
              ) : null}
              {adSets.length > 0 ? (
                <BodyCard>
                  <p className={styles.cardEyebrowTight}>Where it runs</p>
                  {adSets.map((adSet) => (
                    <div className={styles.adSetRow} key={adSet.id}>
                      <span className={styles.adSetName}>
                        {display(adSet.label)}
                      </span>
                      <span className={styles.adSetSpend}>
                        {display(adSet.spend)}
                      </span>
                      <span
                        className={`${styles.adSetRoas} ${toneClass(adSet.roasTone)}`}
                      >
                        {display(adSet.roas)}
                      </span>
                    </div>
                  ))}
                  <p className={styles.adSetNote}>
                    ROAS per ad set · same 28d window
                  </p>
                </BodyCard>
              ) : null}
            </div>
          ) : null}

          {facts.length > 0 ? (
            <div className={styles.factGrid}>
              {facts.map((fact) => {
                const value = display(fact.value);
                return (
                  <div className={styles.factRow} key={fact.id}>
                    <span className={styles.factLabel}>
                      {display(fact.label)}
                    </span>
                    <span
                      className={`${styles.factValue} ${toneClass(fact.tone)} ${
                        value === EM_DASH ? styles.factValueUnavailable : ""
                      }`}
                    >
                      {value}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {showFooter ? (
          <div className={styles.footer}>
            {primaryAction ? (
              <FooterAction
                action={primaryAction}
                className={`${styles.primaryButton} ${toneClass(viewModel.decisionTone)}`}
              />
            ) : null}
            {compareAction ? (
              <FooterAction
                action={compareAction}
                className={styles.secondaryButton}
              />
            ) : null}
            {adsManagerAction ? (
              <FooterAction
                action={adsManagerAction}
                className={styles.tertiaryButton}
              />
            ) : null}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
