"use client";

/**
 * "Shared links" — every frozen snapshot this account has created, active,
 * expired or revoked, with rotate and revoke for the ones still active.
 *
 * Purely presentational: the caller owns the fetch, the rotate/revoke
 * mutations, and copy-to-clipboard state. This component only renders the
 * list it is given and calls back on action.
 */
import type { CreativeShareLedgerEntry } from "@/components/creatives/shareCreativeTypes";
import styles from "./SharedLinksManager.module.css";

export interface SharedLinksManagerRowViewModel {
  entry: CreativeShareLedgerEntry;
  url: string;
  audienceLabel: string;
  statusLabel: string;
  metaLine: string;
  copyLabel: string;
}

export interface SharedLinksManagerProps {
  rows: readonly SharedLinksManagerRowViewModel[];
  loading: boolean;
  errorMessage: string | null;
  onCopy: (token: string, url: string) => void;
  onOpen: (token: string) => void;
  onRotate: (token: string) => void;
  onRevoke: (token: string) => void;
  onDelete: (token: string) => void;
  onGoSelectCreatives: () => void;
  onClose: () => void;
}

export function SharedLinksManager({
  rows,
  loading,
  errorMessage,
  onCopy,
  onOpen,
  onRotate,
  onRevoke,
  onDelete,
  onGoSelectCreatives,
  onClose,
}: SharedLinksManagerProps) {
  return (
    <div className={styles.scrim} data-testid="shared-links-manager-scrim" onClick={onClose}>
      <aside
        className={styles.panel}
        data-screen-label="Shared links manager"
        data-testid="shared-links-manager"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <div className={styles.headerText}>
            <p className={styles.eyebrow}>Creative Studio · Shared links</p>
            <p className={styles.title}>Frozen snapshot links</p>
          </div>
          <span className={styles.countChip}>{rows.length} links</span>
          <button aria-label="Close" className={styles.closeButton} onClick={onClose} type="button">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <p className={styles.intro}>
            Every link is a frozen, read-only snapshot. Rotate replaces the
            URL for the same content; revoke kills access immediately. A
            revoked or expired link can be deleted to remove it from this
            list.
          </p>

          {loading ? <p className={styles.loading}>Loading shared links…</p> : null}
          {errorMessage ? (
            <p className={styles.error} role="alert">
              {errorMessage}
            </p>
          ) : null}

          {!loading && !errorMessage && rows.length === 0 ? (
            <p className={styles.empty}>No links have been created yet.</p>
          ) : null}

          {rows.map((row) => (
            <article className={styles.linkCard} data-share-link-row={row.entry.token} key={row.entry.token}>
              <div className={styles.linkHead}>
                <p className={styles.linkTitle}>{row.entry.title}</p>
                <span className={styles.audienceChip} data-tone={row.entry.audience}>
                  {row.audienceLabel}
                </span>
                <span className={styles.statusChip} data-status={row.entry.status}>
                  {row.statusLabel}
                </span>
                {row.entry.status === "active" && row.entry.creativeCount === 0 ? (
                  <span className={styles.emptyWarnChip}>empty snapshot</span>
                ) : null}
              </div>
              <p className={styles.linkMeta}>{row.metaLine}</p>
              <div className={styles.linkActions}>
                <span className={styles.linkUrl}>{row.url}</span>
                <button
                  className={styles.actionButton}
                  onClick={() => onCopy(row.entry.token, row.url)}
                  type="button"
                >
                  {row.copyLabel}
                </button>
                <button
                  className={styles.actionButtonAccent}
                  onClick={() => onOpen(row.entry.token)}
                  type="button"
                >
                  Open
                </button>
                {row.entry.status === "active" ? (
                  <>
                    <button
                      className={styles.actionButton}
                      onClick={() => onRotate(row.entry.token)}
                      type="button"
                    >
                      Rotate
                    </button>
                    <button
                      className={styles.actionButtonDanger}
                      onClick={() => onRevoke(row.entry.token)}
                      type="button"
                    >
                      Revoke
                    </button>
                  </>
                ) : (
                  <button
                    className={styles.actionButtonDanger}
                    onClick={() => onDelete(row.entry.token)}
                    type="button"
                  >
                    Delete
                  </button>
                )}
              </div>
            </article>
          ))}

          <div className={styles.footerCard}>
            <p>
              New shares always start from creatives you select in the Assets
              table — there is no blank share from here.
            </p>
            <button className={styles.footerLink} onClick={onGoSelectCreatives} type="button">
              Select creatives →
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

export default SharedLinksManager;
