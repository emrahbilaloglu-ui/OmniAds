"use client";

import styles from "@/components/google-ads/GoogleAssetsPlanExact.module.css";
import { assetsSyncToneClass } from "@/components/google-ads/GoogleAssetsExact";
import type { GoogleSearchExactSyncTone } from "@/components/google-ads/GoogleSearchExact";
import type {
  GooglePlanExactStepViewModel,
  GooglePlanExactViewModel,
} from "@/components/google-ads/google-plan-exact-adapter";

export interface GooglePlanExactProps {
  model: GooglePlanExactViewModel;
  syncTone?: GoogleSearchExactSyncTone;
  /**
   * The guarded write. The surface never mutates on its own: it hands the step
   * back and the caller drives `/api/google-ads/advisor-memory`, which still
   * enforces role, demo state, the write-back capability gate and account
   * authority on the server.
   */
  onApplyStep?: (step: GooglePlanExactStepViewModel) => void;
  onApplyAll?: () => void;
  onDismissStep?: (step: GooglePlanExactStepViewModel) => void;
  onCopyStep?: (step: GooglePlanExactStepViewModel) => void;
  onDownloadCsv?: () => void;
}

/**
 * The canonical `Google Ads · Plan & activity` screen.
 *
 * Presentation only, and exactly what the reference fragment draws: the
 * execution queue, the dashed batch-contract card, the activity feed and one
 * closing mono line. No budget workspace, no result banner.
 */
export function GooglePlanExact({
  model,
  syncTone = "neutral",
  onApplyStep,
  onApplyAll,
  onDismissStep,
  onCopyStep,
  onDownloadCsv,
}: GooglePlanExactProps) {
  return (
    <section className={styles.screen} data-screen-label="Google Ads · Plan">
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{model.eyebrow}</p>
          <h1 className={styles.title}>Plan &amp; activity</h1>
        </div>
        <div className={styles.headerStatus}>
          <span className={styles.guardCopy}>
            writes guarded · receipt on every change
          </span>
          <span
            className={`${styles.syncPill} ${assetsSyncToneClass(syncTone)}`}
            data-testid="google-plan-sync"
          >
            <span className={styles.syncDot} aria-hidden="true" />
            {model.syncLabel}
          </span>
        </div>
      </div>

      <div className={styles.planGrid}>
        <div className={styles.planColumn}>
          <article className={styles.card} data-google-execution-queue="true">
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Execution queue</h2>
              <span className={styles.queueCount}>
                {model.queuedLabel} queued · {model.appliedLabel} applied
              </span>
              <div className={styles.queueActions}>
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={!model.applyAllEnabled}
                  onClick={onApplyAll}
                >
                  Apply all approved
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={onDownloadCsv}
                >
                  Download CSV
                </button>
              </div>
            </div>

            <p className={styles.queueIntro}>
              Approved changes execute here through the guarded write boundary —
              nothing bypasses approval, guardrails or quiet hours, and every
              write returns a Google receipt.
            </p>

            {model.steps.map((step) => (
              <div
                className={styles.step}
                key={step.key}
                data-google-plan-step={step.key}
              >
                <div className={styles.stepHead}>
                  <span className={styles.stepNumber}>{step.number}</span>
                  <div className={styles.stepBody}>
                    <p className={styles.stepTitle}>{step.title}</p>
                    <p className={styles.stepSource}>{step.source}</p>
                    {step.note ? (
                      <p className={styles.stepNote}>{step.note}</p>
                    ) : null}
                  </div>
                  {step.openHref ? (
                    <a
                      className={styles.stepOpen}
                      href={step.openHref}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open ↗
                    </a>
                  ) : null}
                </div>
                <div className={styles.stepControls}>
                  <button
                    type="button"
                    className={styles.stepToggle}
                    aria-pressed={step.applied}
                    disabled={!step.applyEnabled}
                    onClick={() => onApplyStep?.(step)}
                  >
                    <span
                      className={`${styles.tick} ${step.applied ? styles.tickOn : ""}`}
                    >
                      {step.applied ? (
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#ffffff"
                          strokeWidth={3.5}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={styles.tickMark}
                          aria-hidden="true"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : null}
                    </span>
                    <span
                      className={`${styles.stepStatus} ${
                        step.applied ? styles.stepStatusApplied : ""
                      }`}
                    >
                      {step.statusLabel}
                    </span>
                  </button>
                  <div className={styles.stepButtons}>
                    <button
                      type="button"
                      data-google-plan-apply={step.key}
                      className={`${styles.applyButton} ${
                        step.applied ? styles.applyButtonRollback : ""
                      }`}
                      disabled={!step.applyEnabled}
                      onClick={() => onApplyStep?.(step)}
                    >
                      {step.applyLabel}
                    </button>
                    <button
                      type="button"
                      className={styles.stepButton}
                      onClick={() => onCopyStep?.(step)}
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      data-google-plan-dismiss={step.key}
                      className={`${styles.stepButton} ${styles.stepButtonMuted}`}
                      disabled={!step.dismissEnabled}
                      onClick={() => onDismissStep?.(step)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </article>

          <article className={styles.batchCard}>
            <p className={styles.batchTitle}>Batch apply — guarded</p>
            <p className={styles.batchBody}>
              One execution target type per run, up to 250 items, one receipt
              chain. Batches run inside the same guardrails — the kill switch
              and quiet hours apply.
            </p>
          </article>
        </div>

        <article className={styles.card} data-google-activity="true">
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Activity</h2>
            <span className={styles.cardSubtitle}>manual confirmations</span>
          </div>
          <p className={styles.activityIntro}>
            Every guarded write lands here with its receipt and is confirmed
            against the Google Ads change history on the next sync.
          </p>
          <p className={styles.retentionLine}>{model.retentionLine}</p>
          <table className={styles.activityTable}>
            <thead>
              <tr>
                <th className={`${styles.headEdge} ${styles.left}`}>When</th>
                <th className={`${styles.headInner} ${styles.left}`}>Who</th>
                <th className={`${styles.headInner} ${styles.left}`}>What</th>
                <th className={`${styles.headEdge} ${styles.left}`}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {model.activityRows.map((row) => (
                <tr
                  className={styles.row}
                  data-google-activity-row={row.key}
                  key={row.key}
                >
                  <td className={styles.activityWhen}>{row.when}</td>
                  <td className={styles.activityWho}>{row.who}</td>
                  <td className={styles.activityWhat}>{row.what}</td>
                  <td className={styles.activityDetail}>{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </div>

      <p className={styles.footnote}>
        Writes execute only through the guarded boundary — approval, guardrails,
        quiet hours. Anything blocked stays queued with its blocker named rather
        than dropped.
      </p>
    </section>
  );
}
