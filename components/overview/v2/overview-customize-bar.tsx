"use client";

import { useEffect, useRef } from "react";
import styles from "./overview-layout.module.css";

/**
 * The one place a customize session ends. Cancel always leaves and discards
 * the KPI and section drafts; Save changes is the only way anything is
 * written, and it stays unavailable until something has changed.
 *
 * Escape leaves only when nothing has changed, so a stray key press never
 * throws away edits; with changes it moves focus to Cancel so the choice is
 * explicit.
 */
export function OverviewCustomizeBar({
  dirty,
  onCancel,
  onSave,
}: {
  dirty: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    barRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Popovers and menus close on Escape first and mark the event handled.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (dirty) {
        cancelRef.current?.focus();
        return;
      }
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dirty, onCancel]);

  return (
    <div
      ref={barRef}
      className={styles.customizeBar}
      role="region"
      aria-label="Customize Overview"
      tabIndex={-1}
      data-overview-customize-bar=""
    >
      <div className={styles.customizeCopy}>
        <strong>Customizing Overview</strong>
        <span>{dirty ? "Unsaved changes to KPIs or sections." : "Nothing changed yet."}</span>
      </div>
      <div className={styles.customizeActions}>
        <button ref={cancelRef} type="button" className="adv-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="adv-btn adv-btn--primary"
          disabled={!dirty}
          onClick={onSave}
        >
          Save changes
        </button>
      </div>
    </div>
  );
}
