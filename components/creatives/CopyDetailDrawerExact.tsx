"use client";

import { useEffect, useRef, type MouseEvent } from "react";

import styles from "./CopyDetailDrawerExact.module.css";

const EM_DASH = "—";

export type CopyDetailDrawerExactDisplayValue = string | number | null | undefined;

export type CopyDetailDrawerExactTone =
  | "positive"
  | "negative"
  | "warning"
  | "info"
  | "automation"
  | "neutral";

export interface CopyDetailDrawerExactStat {
  id: string;
  label?: CopyDetailDrawerExactDisplayValue;
  value?: CopyDetailDrawerExactDisplayValue;
  sub?: CopyDetailDrawerExactDisplayValue;
  tone?: CopyDetailDrawerExactTone;
}

export interface CopyDetailDrawerExactAlternate {
  id: string;
  angle?: CopyDetailDrawerExactDisplayValue;
  angleTone?: CopyDetailDrawerExactTone;
  text?: CopyDetailDrawerExactDisplayValue;
  why?: CopyDetailDrawerExactDisplayValue;
  draftHref?: string | null;
}

export interface CopyDetailDrawerExactViewModel {
  kind?: CopyDetailDrawerExactDisplayValue;
  text?: CopyDetailDrawerExactDisplayValue;
  angle?: CopyDetailDrawerExactDisplayValue;
  angleTone?: CopyDetailDrawerExactTone;
  edgeTone?: CopyDetailDrawerExactTone;
  read?: CopyDetailDrawerExactDisplayValue;
  stats?: readonly CopyDetailDrawerExactStat[];
  alternatesNote?: CopyDetailDrawerExactDisplayValue;
  alternates?: readonly CopyDetailDrawerExactAlternate[];
  footnote?: CopyDetailDrawerExactDisplayValue;
  draftAllLabel?: CopyDetailDrawerExactDisplayValue;
  draftAllHref?: string | null;
}

export interface CopyDetailDrawerExactProps {
  viewModel: CopyDetailDrawerExactViewModel;
  onClose: () => void;
}

const TONE_CLASS: Record<CopyDetailDrawerExactTone, string> = {
  positive: styles.tonePositive,
  negative: styles.toneNegative,
  warning: styles.toneWarning,
  info: styles.toneInfo,
  automation: styles.toneAutomation,
  neutral: styles.toneNeutral,
};

function display(value: CopyDetailDrawerExactDisplayValue): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : EM_DASH;
  if (typeof value !== "string") return EM_DASH;
  return value.trim() || EM_DASH;
}

function toneClass(tone: CopyDetailDrawerExactTone | null | undefined): string {
  return TONE_CLASS[tone ?? "neutral"];
}

function slots<T>(values: readonly T[] | null | undefined, count: number): Array<T | undefined> {
  return Array.from({ length: count }, (_, index) => values?.[index]);
}

function stopPropagation(event: MouseEvent) {
  event.stopPropagation();
}

export function CopyDetailDrawerExact({ viewModel, onClose }: CopyDetailDrawerExactProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  const stats = slots(viewModel.stats, 4);
  const alternates = viewModel.alternates ?? [];
  const text = display(viewModel.text);

  return (
    <div
      className={styles.overlay}
      data-testid="copy-detail-drawer"
      onClick={onClose}
      role="presentation"
    >
      <aside
        aria-labelledby="copy-detail-title"
        aria-modal="true"
        className={styles.drawer}
        onClick={stopPropagation}
        role="dialog"
      >
        <div className={styles.header}>
          <div className={styles.headerIdentity}>
            <p className={styles.headerEyebrow}>Copy detail · {display(viewModel.kind)}</p>
            <p className={styles.headerTitle} id="copy-detail-title">
              “{text}”
            </p>
          </div>
          <button
            aria-label="Close copy detail"
            className={styles.headerClose}
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.lineCard}>
            <div className={styles.lineHead}>
              <p className={styles.lineText}>“{text}”</p>
              <span className={`${styles.anglePill} ${toneClass(viewModel.angleTone)}`}>
                {display(viewModel.angle)}
              </span>
            </div>
            <div className={styles.statGrid}>
              {stats.map((stat, index) => (
                <div className={styles.statTile} key={stat?.id ?? `stat-${index}`}>
                  <p className={styles.statLabel}>{display(stat?.label)}</p>
                  <p className={`${styles.statValue} ${toneClass(stat?.tone)}`}>
                    {display(stat?.value)}
                  </p>
                  <p className={styles.statSub}>{display(stat?.sub)}</p>
                </div>
              ))}
            </div>
          </div>

          <div className={`${styles.readCard} ${toneClass(viewModel.edgeTone)}`}>
            <p className={styles.cardEyebrow}>Read</p>
            <p className={styles.readText}>{display(viewModel.read)}</p>
          </div>

          <div className={styles.alternatesCard}>
            <div className={styles.alternatesHead}>
              <h3>Alternative lines</h3>
              <span>{display(viewModel.alternatesNote)}</span>
            </div>
            <div className={styles.alternatesList}>
              {alternates.length === 0 ? (
                <div className={styles.alternateRow} data-copy-alternate="none">
                  <div className={styles.alternateHead}>
                    <span className={`${styles.alternateAngle} ${styles.toneNeutral}`}>
                      {EM_DASH}
                    </span>
                  </div>
                  <p className={styles.alternateText}>“{EM_DASH}”</p>
                  <p className={styles.alternateWhy}>{EM_DASH}</p>
                </div>
              ) : (
                alternates.map((alternate) => (
                  <div
                    className={styles.alternateRow}
                    data-copy-alternate={alternate.id}
                    key={alternate.id}
                  >
                    <div className={styles.alternateHead}>
                      <span
                        className={`${styles.alternateAngle} ${toneClass(alternate.angleTone)}`}
                      >
                        {display(alternate.angle)}
                      </span>
                      {alternate.draftHref ? (
                        <a className={styles.draftButton} href={alternate.draftHref}>
                          Draft →
                        </a>
                      ) : (
                        <button className={styles.draftButton} disabled type="button">
                          Draft →
                        </button>
                      )}
                    </div>
                    <p className={styles.alternateText}>“{display(alternate.text)}”</p>
                    <p className={styles.alternateWhy}>{display(alternate.why)}</p>
                  </div>
                ))
              )}
            </div>
          </div>

          <p className={styles.footnote}>{display(viewModel.footnote)}</p>
        </div>

        <div className={styles.footer}>
          {viewModel.draftAllHref ? (
            <a className={styles.primaryButton} href={viewModel.draftAllHref}>
              {display(viewModel.draftAllLabel)}
            </a>
          ) : (
            <button className={styles.primaryButton} disabled type="button">
              {display(viewModel.draftAllLabel)}
            </button>
          )}
          <button className={styles.closeButton} onClick={onClose} type="button">
            Close
          </button>
        </div>
      </aside>
    </div>
  );
}
