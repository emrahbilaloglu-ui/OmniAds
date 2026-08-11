/**
 * The Google manual-plan activity journal.
 *
 * Google's write path is manual: Adsecute states what to change, the operator
 * changes it in Google, and then says so. The journal is the record of that
 * second step — actor and timestamp, written by us.
 *
 * One rule governs everything here: **Adsecute never claims Google-side
 * verification.** A journal entry records that a human said they applied a
 * change. It does not record that Google applied it, because nothing here read
 * Google back. So the row reads "applied (manual)", never "applied", and a
 * failed journal write must revert the claim rather than leave a confirmation
 * on screen that no record backs.
 */

export type JournalAction = "marked-applied" | "copied" | "copied-all" | "csv" | "csv-all";

export interface JournalEntry {
  id: string;
  /** ISO timestamp the entry was recorded at. Server-assigned. */
  at: string;
  actor: string;
  action: JournalAction;
  /** Plan step this concerns; null for whole-plan actions like copy-all. */
  stepId: string | null;
  detail: string;
}

export const JOURNAL_ACTION_LABEL: Record<JournalAction, string> = {
  "marked-applied": "Marked applied (manual)",
  copied: "Copied change text",
  "copied-all": "Copied all queued changes",
  csv: "Exported change to CSV",
  "csv-all": "Exported all queued changes to CSV",
};

export interface JournalPage {
  entries: readonly JournalEntry[];
  /**
   * True when entries are known to be missing — retention expired, or the
   * journal could not be read for part of the range.
   */
  hasGap: boolean;
  /** Required whenever `hasGap`. Absence of a gap is never implied. */
  gapReason: string | null;
}

/**
 * Whether a mark can still be undone.
 *
 * Per GOOGLE-28 a manual confirmation is reversible "until CSV export of the
 * batch" — once the batch has been exported the record has left the system and
 * un-marking it here would make our journal disagree with the file the operator
 * is working from.
 */
export function markIsReversible(page: JournalPage, stepId: string): boolean {
  const exported = page.entries.some(
    (entry) =>
      (entry.action === "csv-all" && entry.stepId === null) ||
      (entry.action === "csv" && entry.stepId === stepId),
  );
  if (!exported) return true;
  const marked = page.entries.find(
    (entry) => entry.action === "marked-applied" && entry.stepId === stepId,
  );
  if (!marked) return true;
  // Reversible only if the mark came after the export that would have frozen it.
  const lastExport = page.entries
    .filter(
      (entry) =>
        (entry.action === "csv-all" && entry.stepId === null) ||
        (entry.action === "csv" && entry.stepId === stepId),
    )
    .map((entry) => entry.at)
    .sort()
    .at(-1)!;
  return marked.at > lastExport;
}

/** Steps the journal records as manually applied. */
export function appliedStepIds(page: JournalPage): Set<string> {
  const applied = new Set<string>();
  for (const entry of page.entries) {
    if (entry.action === "marked-applied" && entry.stepId) applied.add(entry.stepId);
  }
  return applied;
}

/**
 * What the row says once marked.
 *
 * Deliberately not "Applied". The qualifier is the whole point: it is the
 * difference between a fact we observed and a claim someone made.
 */
export const APPLIED_MANUAL_LABEL = "applied (manual)";
