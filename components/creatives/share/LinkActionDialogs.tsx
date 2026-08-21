"use client";

/**
 * Rotate and revoke — the two destructive-adjacent actions the Shared links
 * manager offers on an active link. Each is confirm-first, then a done state
 * carrying the outcome. Neither dialog fetches or mutates anything itself.
 */
import styles from "./LinkActionDialogs.module.css";

export type LinkDialogPhase = "confirm" | "done";

export interface RotateLinkDialogProps {
  phase: LinkDialogPhase;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
  newUrl: string;
  copyLabel: string;
  onCopy: () => void;
  onSeeOldLink: () => void;
  onDone: () => void;
}

export function RotateLinkDialog(props: RotateLinkDialogProps) {
  return (
    <div className={styles.scrim} onClick={props.phase === "confirm" ? props.onCancel : undefined}>
      <div
        aria-modal="true"
        className={styles.dialog}
        data-screen-label="Rotate link"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        {props.phase === "confirm" ? (
          <>
            <div className={styles.body}>
              <h3>Rotate this link?</h3>
              <p>
                &ldquo;{props.title}&rdquo; gets a new URL for the same frozen
                content. The current link stops working immediately — anyone
                holding it will see &ldquo;no longer available&rdquo;.
              </p>
            </div>
            <div className={styles.footer}>
              <button className={styles.secondaryButton} onClick={props.onCancel} type="button">
                Cancel
              </button>
              <button className={styles.doneButton} onClick={props.onConfirm} type="button">
                Rotate link
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.body}>
              <div className={styles.doneHead}>
                <span className={styles.doneBadge}>
                  <CheckIcon />
                </span>
                <h3>Link rotated — old URL is now invalid</h3>
              </div>
              <p className={styles.metaLabel}>New URL · same frozen content</p>
              <div className={styles.urlRow}>
                <input
                  aria-label="New share URL"
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  value={props.newUrl}
                />
                <button className={styles.primaryButton} onClick={props.onCopy} type="button">
                  {props.copyLabel}
                </button>
              </div>
              <p className={styles.trailNote}>
                Visitors with the previous URL see the neutral &ldquo;no
                longer available&rdquo; page — nothing about this snapshot is
                revealed.{" "}
                <button className={styles.linkButton} onClick={props.onSeeOldLink} type="button">
                  See what they get →
                </button>
              </p>
            </div>
            <div className={styles.footerEnd}>
              <button className={styles.doneButton} onClick={props.onDone} type="button">
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export interface RevokeLinkDialogProps {
  phase: LinkDialogPhase;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
  onSeePage: () => void;
  onDone: () => void;
}

export function RevokeLinkDialog(props: RevokeLinkDialogProps) {
  return (
    <div className={styles.scrim} onClick={props.phase === "confirm" ? props.onCancel : undefined}>
      <div
        aria-modal="true"
        className={styles.dialog}
        data-screen-label="Revoke link"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        {props.phase === "confirm" ? (
          <>
            <div className={styles.body}>
              <div className={styles.doneHead}>
                <span className={styles.warnBadge}>
                  <WarningIcon />
                </span>
                <h3>Revoke &ldquo;{props.title}&rdquo;?</h3>
              </div>
              <p>
                Viewers lose access immediately and this URL can&rsquo;t be
                re-enabled. The frozen content itself is kept — create a new
                share from the same creatives if needed later.
              </p>
            </div>
            <div className={styles.footer}>
              <button className={styles.secondaryButton} onClick={props.onCancel} type="button">
                Cancel
              </button>
              <button className={styles.dangerButton} onClick={props.onConfirm} type="button">
                Revoke link
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.body}>
              <div className={styles.doneHead}>
                <span className={styles.revokedBadge}>
                  <XIcon />
                </span>
                <h3>Link revoked</h3>
              </div>
              <p>
                Anyone opening it now sees the neutral &ldquo;no longer
                available&rdquo; page.{" "}
                <button className={styles.linkButton} onClick={props.onSeePage} type="button">
                  View that page →
                </button>
              </p>
            </div>
            <div className={styles.footerEnd}>
              <button className={styles.doneButton} onClick={props.onDone} type="button">
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg fill="none" height="11" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" viewBox="0 0 24 24" width="11">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg fill="none" height="14" stroke="#e11d48" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="14">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg fill="none" height="10" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" viewBox="0 0 24 24" width="10">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
