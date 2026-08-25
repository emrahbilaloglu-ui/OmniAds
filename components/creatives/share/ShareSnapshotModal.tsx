"use client";

/**
 * "Share a frozen snapshot" — the Creative Studio share modal.
 *
 * Four phases, matching what the server actually does: `config` (the operator
 * is still choosing), `creating` (the POST is in flight and every control
 * locks — a frozen snapshot half-created is not a state anyone should be able
 * to walk away from silently), `failed` (the POST errored; nothing was
 * created and nothing was shared), `ready` (a real link exists).
 *
 * This component owns no data of its own. Every list here — what's included,
 * what's removed, the snapshot rules — is a prop computed by the caller from
 * the same policy function (`resolveCreativeStudioSharePolicy`) that decides
 * what the server actually sends, so this dialog cannot promise something the
 * link does not deliver.
 */
import { useEffect, useRef } from "react";
import type { ShareAudience } from "@/components/creatives/shareCreativeTypes";
import styles from "./ShareSnapshotModal.module.css";

export type ShareSnapshotPhase = "config" | "creating" | "failed" | "ready";

export interface ShareAudiencePresetViewModel {
  value: ShareAudience;
  name: string;
  tag: string;
  who: string;
  badge: string | null;
  points: readonly string[];
}

export interface ShareThumbnailViewModel {
  id: string;
  name: string;
  imageUrl: string | null;
}

export interface ShareReadyMetaRow {
  label: string;
  value: string;
}

export interface ShareSnapshotModalProps {
  phase: ShareSnapshotPhase;
  presets: readonly ShareAudiencePresetViewModel[];
  audience: ShareAudience;
  onAudienceChange: (value: ShareAudience) => void;

  selectedCount: number;
  thumbnails: readonly ShareThumbnailViewModel[];
  dateRangeLabel: string;
  frozenAsOfLabel: string;

  included: readonly string[];
  removed: readonly string[];

  buyerAckRequired: boolean;
  buyerAckOn: boolean;
  onBuyerAckToggle: () => void;
  buyerAckErrorShown: boolean;

  csvShown: boolean;
  csvOn: boolean;
  onCsvToggle: () => void;

  expiryDays: 7 | 14 | 30;
  onExpiryChange: (days: 7 | 14 | 30) => void;
  expiresOnLabel: string;

  note: string;
  onNoteChange: (value: string) => void;

  errorMessage: string | null;

  onCancel: () => void;
  onPreview: () => void;
  onCreate: () => void;

  keepChips: readonly string[];
  onBackToConfig: () => void;
  onRetry: () => void;

  readyUrl: string | null;
  readyCreatedLabel: string;
  readyMeta: readonly ShareReadyMetaRow[];
  copyLabel: string;
  copyFailedShown: boolean;
  onCopy: () => void;
  onOpenReady: () => void;
  onManageLinks: () => void;
  onNewShare: () => void;

  onClose: () => void;
}

const SNAPSHOT_RULES = [
  "Read-only",
  "Frozen at creation time",
  "Selected creatives only",
  "Campaign names excluded",
  "No workspace access",
  "Revoke or rotate later",
] as const;

export function ShareSnapshotModal(props: ShareSnapshotModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const locked = props.phase === "creating";

  useEffect(() => {
    if (locked) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [locked, props]);

  const dialogLabel =
    props.phase === "creating"
      ? "Share modal — creating"
      : props.phase === "failed"
        ? "Share modal — creation failed"
        : props.phase === "ready"
          ? "Share modal — link ready"
          : `Share modal — ${props.presets.find((preset) => preset.value === props.audience)?.name ?? "config"}`;

  return (
    <div
      className={styles.scrim}
      data-screen-label={dialogLabel}
      data-testid="studio-share-modal-scrim"
      onClick={locked ? undefined : props.onClose}
    >
      <div
        aria-label="Share a frozen snapshot"
        aria-modal="true"
        className={styles.dialog}
        data-testid="studio-share-modal"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
      >
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2>Share a frozen snapshot</h2>
            <p>
              A read-only link containing the selected creatives and only the
              fields the chosen audience allows.
            </p>
          </div>
          <button
            aria-label="Close"
            className={styles.closeButton}
            disabled={locked}
            onClick={props.onClose}
            title={locked ? "Locked while the snapshot is being created" : "Close"}
            type="button"
          >
            ✕
          </button>
        </div>

        <div className={styles.body}>
          {props.phase === "config" ? (
            <ConfigPhase {...props} />
          ) : props.phase === "creating" ? (
            <CreatingPhase />
          ) : props.phase === "failed" ? (
            <FailedPhase {...props} />
          ) : (
            <ReadyPhase {...props} />
          )}
        </div>

        <div className={styles.footer}>
          {props.phase === "config" ? (
            <div className={styles.footerRow}>
              {props.errorMessage ? (
                <span className={styles.footerError} role="alert">
                  {props.errorMessage}
                </span>
              ) : null}
              <span className={styles.footerSpacer} />
              <button
                className={styles.ghostButton}
                onClick={props.onCancel}
                type="button"
              >
                Cancel
              </button>
              <button
                className={styles.secondaryButton}
                disabled={props.selectedCount === 0}
                onClick={props.onPreview}
                type="button"
              >
                Preview page
              </button>
              <button
                className={styles.primaryButton}
                disabled={props.selectedCount === 0}
                onClick={props.onCreate}
                type="button"
              >
                Create link
              </button>
            </div>
          ) : null}
          {props.phase === "creating" ? (
            <div className={styles.footerCentered}>
              <span className={styles.spinner} />
              <span className={styles.footerCreatingLabel}>
                Creating frozen snapshot — controls locked
              </span>
            </div>
          ) : null}
          {props.phase === "failed" ? (
            <div className={styles.footerRowEnd}>
              <button
                className={styles.secondaryButton}
                onClick={props.onBackToConfig}
                type="button"
              >
                Back to settings
              </button>
              <button className={styles.primaryButton} onClick={props.onRetry} type="button">
                Retry — create link
              </button>
            </div>
          ) : null}
          {props.phase === "ready" ? (
            <div className={styles.footerRowEnd}>
              <button
                className={styles.secondaryButton}
                onClick={props.onManageLinks}
                type="button"
              >
                Manage shared links
              </button>
              <button className={styles.doneButton} onClick={props.onClose} type="button">
                Done
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConfigPhase(props: ShareSnapshotModalProps) {
  const overflowCount = Math.max(0, props.selectedCount - 4);
  return (
    <>
      <div className={styles.selectionCard}>
        <div className={styles.selectionRow}>
          <div className={styles.thumbStack}>
            {props.thumbnails.slice(0, 4).map((thumbnail) => (
              <span className={styles.thumb} key={thumbnail.id}>
                {thumbnail.imageUrl ? (
                  <img alt="" src={thumbnail.imageUrl} />
                ) : (
                  <span className={styles.thumbPlaceholder} aria-hidden="true" />
                )}
              </span>
            ))}
            {overflowCount > 0 ? (
              <span className={styles.thumbMore}>+{overflowCount}</span>
            ) : null}
          </div>
          <div className={styles.selectionText}>
            <p className={styles.selectionCount}>
              {props.selectedCount} creative{props.selectedCount === 1 ? "" : "s"} selected
            </p>
            <p className={styles.selectionRange}>{props.dateRangeLabel}</p>
          </div>
          <span className={styles.frozenBadge}>
            <FrozenIcon />
            Frozen snapshot
          </span>
        </div>
        <p className={styles.selectionNote}>
          The link contains these creatives exactly as they exist right now —
          data through {props.frozenAsOfLabel}. It never updates and it is not
          a live dashboard. Campaign names and account identifiers are never
          included.
        </p>
      </div>

      <div>
        <p className={styles.sectionLabel}>Who is this link for?</p>
        <div className={styles.presetGroup} role="radiogroup" aria-label="Audience preset">
          {props.presets.map((preset) => {
            const selected = preset.value === props.audience;
            return (
              <div
                aria-checked={selected}
                className={selected ? styles.presetCardSelected : styles.presetCard}
                data-share-audience-option={preset.value}
                key={preset.value}
                onClick={() => props.onAudienceChange(preset.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onAudienceChange(preset.value);
                  }
                }}
                role="radio"
                tabIndex={0}
              >
                <div className={styles.presetHead}>
                  <span className={selected ? styles.presetDotSelected : styles.presetDot}>
                    <span className={styles.presetDotInner} />
                  </span>
                  <span className={styles.presetName}>{preset.name}</span>
                  {preset.badge ? (
                    <span
                      className={
                        preset.badge === "Strictest"
                          ? styles.presetBadgeStrict
                          : styles.presetBadgeSafe
                      }
                    >
                      {preset.badge}
                    </span>
                  ) : null}
                  <span className={styles.presetTag}>{preset.tag}</span>
                </div>
                <p className={styles.presetWho}>{preset.who}</p>
                <div className={styles.presetPoints}>
                  {preset.points.map((point) => (
                    <span className={styles.presetPoint} key={point}>
                      {point}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.previewCard} data-screen-label="Included / excluded preview">
        <div className={styles.previewHead}>
          <p>What the page will contain</p>
          <span>updates with the preset</span>
        </div>
        <div className={styles.previewGrid}>
          <div className={styles.previewIncluded}>
            <p>Included</p>
            {props.included.map((item) => (
              <span className={styles.previewIncludedRow} key={item}>
                <CheckIcon /> {item}
              </span>
            ))}
          </div>
          <div className={styles.previewRemoved}>
            <p>Removed entirely</p>
            {props.removed.map((item) => (
              <span className={styles.previewRemovedRow} key={item}>
                – {item}
              </span>
            ))}
            <p className={styles.previewRemovedNote}>
              Removed sections disappear from the page — they are never shown
              as empty cells or dashes.
            </p>
          </div>
        </div>
      </div>

      {props.buyerAckRequired ? (
        <div
          className={props.buyerAckErrorShown ? styles.ackCardError : styles.ackCard}
          data-screen-label="Buyer financial-data acknowledgement"
        >
          <div className={styles.ackRow}>
            <WarningIcon />
            <div className={styles.ackText}>
              <p className={styles.ackTitle}>Financial metrics are directional</p>
              <p className={styles.ackBody}>
                Spend, revenue, ROAS and CPA are platform-attributed by Meta.
                Store or finance reporting may differ — the shared page says
                this to viewers too.
              </p>
              <div
                aria-checked={props.buyerAckOn}
                className={styles.ackCheckboxRow}
                onClick={props.onBuyerAckToggle}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onBuyerAckToggle();
                  }
                }}
                role="checkbox"
                tabIndex={0}
              >
                <span className={props.buyerAckOn ? styles.ackTickOn : styles.ackTickOff}>
                  {props.buyerAckOn ? <CheckIcon /> : null}
                </span>
                <span className={styles.ackLabel}>
                  I understand — share these financial metrics anyway
                </span>
              </div>
              {props.buyerAckErrorShown ? (
                <p className={styles.ackError}>
                  Confirm the notice above to preview or create this link.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className={styles.expiryCard}>
        <div className={styles.expiryRow}>
          <p>Link expires</p>
          <div className={styles.expiryOptions} role="radiogroup" aria-label="Expiration">
            {([7, 14, 30] as const).map((days) => (
              <button
                className={days === props.expiryDays ? styles.expiryChipSelected : styles.expiryChip}
                key={days}
                onClick={() => props.onExpiryChange(days)}
                type="button"
              >
                {days} days
              </button>
            ))}
          </div>
        </div>
        <p className={styles.expiryNote}>Expires {props.expiresOnLabel}.</p>
      </div>

      {props.csvShown ? (
        <div className={styles.csvCard}>
          <div className={styles.csvText}>
            <p>Allow CSV download</p>
            <span>
              Client stakeholder only — the export contains exactly the table
              on the page.
            </span>
          </div>
          <span
            aria-checked={props.csvOn}
            /*
             * A switch with no name. Everything that says what this control
             * does is in the sibling `<p>`, which the switch does not point
             * at — so a screen reader reached a switch, announced "switch, on"
             * and nothing else, and the operator had to guess which of the
             * dialog's settings they had just changed. Found while driving
             * WP11's lifecycle from the keyboard: the runtime spec could not
             * address it by name either.
             */
            aria-label="Allow CSV download"
            className={props.csvOn ? styles.toggleOn : styles.toggleOff}
            onClick={props.onCsvToggle}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onCsvToggle();
              }
            }}
            role="switch"
            tabIndex={0}
          >
            <span className={styles.toggleKnob} />
          </span>
        </div>
      ) : null}

      <div className={styles.noteCard}>
        <p>
          Note to viewers <span className={styles.noteOptional}>optional</span>
        </p>
        <textarea
          onChange={(event) => props.onNoteChange(event.target.value)}
          placeholder="e.g. Focus on the first 3 seconds — the weak hooks need a rebrief."
          value={props.note}
        />
        <p className={styles.noteHint}>
          Shown at the top of the shared page and starts the discussion
          thread.
        </p>
      </div>

      <div className={styles.rulesCard}>
        <p>Snapshot contract</p>
        <div className={styles.rulesGrid}>
          {SNAPSHOT_RULES.map((rule) => (
            <span className={styles.rule} key={rule}>
              <span className={styles.ruleDot} />
              {rule}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

function CreatingPhase() {
  return (
    <div className={styles.creatingWrap}>
      <div className={styles.creatingInner}>
        <span className={styles.creatingSpinner} />
        <p className={styles.creatingTitle}>Creating frozen snapshot…</p>
        <p className={styles.creatingBody}>
          Copying the selected creatives and their metrics as of right now.
          The modal stays open until this finishes.
        </p>
        <div className={styles.creatingBar}>
          <span className={styles.creatingBarFill} />
        </div>
        <p className={styles.creatingCaption}>
          controls are locked · Esc won't close this step
        </p>
      </div>
    </div>
  );
}

function FailedPhase(props: ShareSnapshotModalProps) {
  return (
    <>
      <div className={styles.failedCard}>
        <FailedIcon />
        <div>
          <p className={styles.failedTitle}>The snapshot couldn't be created</p>
          <p className={styles.failedBody}>
            A server error interrupted the freeze. No link was created and
            nothing was shared. Your selection and settings are kept exactly
            as they were — retry when ready.
          </p>
        </div>
      </div>
      <div className={styles.keepCard}>
        <p>Kept settings</p>
        <div className={styles.keepGrid}>
          {props.keepChips.map((chip) => (
            <span className={styles.keepChip} key={chip}>
              {chip}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

function ReadyPhase(props: ShareSnapshotModalProps) {
  return (
    <>
      <div className={styles.readyBanner}>
        <span className={styles.readyBadge}>
          <CheckIcon />
        </span>
        <div>
          <p className={styles.readyTitle}>Link ready — frozen and read-only</p>
          <p className={styles.readyCreated}>created {props.readyCreatedLabel}</p>
        </div>
      </div>
      <div className={styles.readyUrlCard}>
        <p>Public URL</p>
        <div className={styles.readyUrlRow}>
          <input
            aria-label="Public share URL"
            data-studio-share-link=""
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            value={props.readyUrl ?? ""}
          />
          <button className={styles.primaryButton} onClick={props.onCopy} type="button">
            {props.copyLabel}
          </button>
          <button className={styles.secondaryButton} onClick={props.onOpenReady} type="button">
            Open page
          </button>
        </div>
        {props.copyFailedShown ? (
          <p className={styles.copyFailedNote}>
            Clipboard was blocked — click the URL above and copy it manually;
            it stays visible and selectable.
          </p>
        ) : null}
        <div className={styles.readyMetaGrid}>
          {props.readyMeta.map((row) => (
            <div className={styles.readyMetaRow} key={row.label}>
              <span>{row.label}</span>
              <span>{row.value}</span>
            </div>
          ))}
        </div>
      </div>
      <div className={styles.readyChangeCard}>
        <p>
          Changing the audience, expiry or selection creates a{" "}
          <b>new frozen snapshot</b> with its own link — this one keeps
          exactly what it holds now.
        </p>
        <button className={styles.secondaryButton} onClick={props.onNewShare} type="button">
          New share with different settings
        </button>
      </div>
    </>
  );
}

function CheckIcon() {
  return (
    <svg fill="none" height="10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" viewBox="0 0 24 24" width="10">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function FrozenIcon() {
  return (
    <svg fill="none" height="12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="12">
      <path d="M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg fill="none" height="16" stroke="#B45309" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="16">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function FailedIcon() {
  return (
    <svg fill="none" height="16" stroke="#B0123F" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="16">
      <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}

export default ShareSnapshotModal;
