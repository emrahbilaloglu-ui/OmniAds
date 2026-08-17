"use client";

import { useEffect, type MouseEvent, type ReactNode } from "react";

import styles from "./CreativeEvidenceWindowExact.module.css";

const EM_DASH = "—";

export type CreativeEvidenceWindowExactDisplayValue = string | number | null | undefined;

export type CreativeEvidenceWindowExactTone =
  | "positive"
  | "negative"
  | "warning"
  | "info"
  | "automation"
  | "neutral";

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
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : EM_DASH;
  if (typeof value !== "string") return EM_DASH;
  return value.trim() || EM_DASH;
}

function toneClass(tone: CreativeEvidenceWindowExactTone | null | undefined): string {
  return TONE_CLASS[tone ?? "neutral"];
}

function slots<T>(values: readonly T[] | null | undefined, count: number): Array<T | undefined> {
  return Array.from({ length: count }, (_, index) => values?.[index]);
}

function widthStyle(share: number | null | undefined): string {
  if (typeof share !== "number" || !Number.isFinite(share) || share <= 0) return "0%";
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

function BodyCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `${styles.card} ${className}` : styles.card}>{children}</div>;
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

  const reasons = viewModel.reasons ?? [];
  const funnel = slots(viewModel.funnel, 4);
  const placements = slots(viewModel.placements, 3);
  const adSets = slots(viewModel.adSets, 2);
  const facts = slots(viewModel.facts, 6);
  const stripeA = viewModel.stripeA?.trim() || "#EAF0FF";
  const stripeB = viewModel.stripeB?.trim() || "#F7F9FC";
  const previewUrl = viewModel.previewUrl?.trim() || null;

  return (
    <div
      className={styles.overlay}
      data-testid="creative-evidence-window"
      onClick={onClose}
      role="presentation"
    >
      <aside
        aria-label="Creative evidence"
        aria-modal="true"
        className={styles.drawer}
        onClick={stopPropagation}
        role="dialog"
      >
        <div className={styles.header}>
          <div className={styles.headerIdentity}>
            <p className={styles.headerEyebrow}>Creative evidence · Meta</p>
            <p className={styles.headerTitle}>{display(viewModel.name)}</p>
          </div>
          <span className={`${styles.headerChip} ${toneClass(viewModel.decisionTone)}`}>
            {display(viewModel.decisionLabel)}
          </span>
          <span
            aria-label="Close creative evidence"
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
          <div className={styles.previewCard}>
            <div
              className={styles.previewStage}
              style={{
                backgroundImage: `repeating-linear-gradient(135deg,${stripeA},${stripeA} 12px,${stripeB} 12px,${stripeB} 24px)`,
              }}
            >
              {previewUrl ? (
                <img
                  alt=""
                  className={styles.previewImage}
                  data-creative-evidence-preview="served"
                  src={previewUrl}
                />
              ) : (
                <span
                  className={styles.previewPlaceholder}
                  data-creative-evidence-preview="unavailable"
                >
                  {EM_DASH}
                </span>
              )}
            </div>
            <div className={styles.previewFooter}>
              <span className={styles.previewKind}>{display(viewModel.kind)}</span>
              <span className={`${styles.bandPill} ${toneClass(viewModel.bandTone)}`}>
                {display(viewModel.band)}
              </span>
            </div>
          </div>

          <BodyCard className={`${styles.contractCard} ${toneClass(viewModel.decisionTone)}`}>
            <p className={styles.cardEyebrow}>Decision contract</p>
            <p className={styles.verdictLine}>
              <b>{display(viewModel.verdict)}</b> {display(viewModel.verdictSub)}
            </p>
            <p className={styles.moneyLine}>
              {display(viewModel.money)}{" "}
              <span className={styles.moneySub}>{display(viewModel.moneySub)}</span>
            </p>
          </BodyCard>

          <BodyCard className={toneClass(viewModel.decisionTone)}>
            <p className={styles.cardEyebrowReasons}>Engine reasoning</p>
            {slots(reasons, Math.max(1, reasons.length)).map((reason, index) => (
              <p className={styles.reasonLine} key={`reason-${index}`}>
                <span aria-hidden="true" className={styles.reasonDot} />
                <span>{display(reason)}</span>
              </p>
            ))}
          </BodyCard>

          <div className={styles.pairGrid}>
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
              <p className={styles.seriesNote}>{display(viewModel.ctr?.note)}</p>
            </BodyCard>
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
              <p className={styles.seriesNote}>{display(viewModel.frequency?.note)}</p>
            </BodyCard>
          </div>

          <BodyCard>
            <p className={styles.cardEyebrowSpaced}>Click-to-purchase funnel · 28d</p>
            <div className={styles.funnelRows}>
              {funnel.map((step, index) => (
                <div className={styles.funnelRow} key={step?.id ?? `funnel-${index}`}>
                  <span className={styles.funnelLabel}>{display(step?.label)}</span>
                  <span className={styles.funnelTrack}>
                    <span
                      className={`${styles.funnelFill} ${FUNNEL_STEP_CLASS[index] ?? ""}`}
                      style={{ width: widthStyle(step?.share) }}
                    />
                  </span>
                  <span className={styles.funnelValue}>{display(step?.value)}</span>
                  <span className={styles.funnelSub}>
                    {typeof step?.sub === "string" && !step.sub.trim() ? "" : display(step?.sub)}
                  </span>
                </div>
              ))}
            </div>
          </BodyCard>

          <div className={styles.pairGrid}>
            <BodyCard>
              <p className={styles.cardEyebrowSpaced}>Placement mix</p>
              {placements.map((placement, index) => (
                <div className={styles.placementRow} key={placement?.id ?? `placement-${index}`}>
                  <div className={styles.placementHead}>
                    <span className={styles.placementLabel}>{display(placement?.label)}</span>
                    <span className={styles.placementStats}>
                      {display(placement?.share)} · ROAS {display(placement?.roas)}
                    </span>
                  </div>
                  <div className={styles.placementTrack}>
                    <div
                      className={styles.placementFill}
                      style={{ width: widthStyle(placement?.width) }}
                    />
                  </div>
                </div>
              ))}
            </BodyCard>
            <BodyCard>
              <p className={styles.cardEyebrowTight}>Where it runs</p>
              {adSets.map((adSet, index) => (
                <div className={styles.adSetRow} key={adSet?.id ?? `adset-${index}`}>
                  <span className={styles.adSetName}>{display(adSet?.label)}</span>
                  <span className={styles.adSetSpend}>{display(adSet?.spend)}</span>
                  <span className={`${styles.adSetRoas} ${toneClass(adSet?.roasTone)}`}>
                    {display(adSet?.roas)}
                  </span>
                </div>
              ))}
              <p className={styles.adSetNote}>ROAS per ad set · same 28d window</p>
            </BodyCard>
          </div>

          <div className={styles.factGrid}>
            {facts.map((fact, index) => {
              const value = display(fact?.value);
              return (
                <div className={styles.factRow} key={fact?.id ?? `fact-${index}`}>
                  <span className={styles.factLabel}>{display(fact?.label)}</span>
                  <span
                    className={`${styles.factValue} ${toneClass(fact?.tone)} ${
                      value === EM_DASH ? styles.factValueUnavailable : ""
                    }`}
                  >
                    {value}
                  </span>
                </div>
              );
            })}
          </div>

          <p className={styles.provenance}>{display(viewModel.provenance)}</p>
        </div>

        <div className={styles.footer}>
          <FooterAction
            action={viewModel.primaryAction}
            className={`${styles.primaryButton} ${toneClass(viewModel.decisionTone)}`}
          />
          <FooterAction
            action={viewModel.compareAction ?? { label: "Compare in Studio" }}
            className={styles.secondaryButton}
          />
          <FooterAction
            action={viewModel.adsManagerAction ?? { label: "Ads Manager ↗" }}
            className={styles.tertiaryButton}
          />
        </div>
      </aside>
    </div>
  );
}
