/**
 * Maps the existing Meta history authority onto the canonical History surface.
 *
 * Two provenance facts survive this mapping intact, because losing either is
 * how a later reader mistakes a reconstruction for a record:
 *
 * - **replay.** A replayed entry was recomputed after the fact and did not
 *   drive the decision taken at the time. The flag comes straight from the read
 *   model's `replay` object, and any replayed row raises a banner that cannot
 *   be dismissed.
 * - **actor.** The read model distinguishes an actor that is *available*, one
 *   that is *unavailable*, and one that is *not applicable* because no human
 *   acted. Those are three different sentences, and none of them is "System".
 */
import type { MetaHistoryEntry, MetaHistoryResponse } from "@/lib/meta/history-contract";

export interface HistoryRow {
  id: string;
  occurredAt: string;
  action: string;
  outcome: string;
  actor: string | null;
  replayed: boolean;
}

export interface HistoryPage {
  rows: HistoryRow[];
  /** Stated whenever the page is capped, so "no more" is never implied. */
  disclosure: string | null;
  limitations: string[];
  accountLabel: string | null;
}

/**
 * Actor text for one entry.
 *
 * `null` is returned for both "unavailable" and an empty name, which the view
 * renders as "Actor not recorded". Attributing an unnamed change to the system
 * would be a claim about who acted.
 */
export function actorFor(entry: MetaHistoryEntry): string | null {
  if (entry.actor.availability === "not_applicable") return "No human actor (engine)";
  if (entry.actor.availability === "unavailable") return null;
  const name = (entry.actor.name ?? "").trim();
  return name.length > 0 ? name : null;
}

export function toHistoryRow(entry: MetaHistoryEntry): HistoryRow {
  return {
    id: entry.id,
    occurredAt: entry.occurredAt,
    action: entry.title,
    // The served status word, not a re-derived one.
    outcome: entry.status,
    actor: actorFor(entry),
    replayed: entry.replay !== null,
  };
}

export function toHistoryPage(payload: MetaHistoryResponse): HistoryPage {
  const rows = payload.entries.map(toHistoryRow);
  // `total` is deliberately null on the cursor path, so the honest disclosure
  // names the cap and the fact that more may exist — never a total.
  const disclosure =
    payload.page.nextCursor !== null
      ? `Showing the ${payload.page.returned} most recent entries. More exist beyond this page.`
      : payload.page.returned >= payload.page.limit
        ? `Showing ${payload.page.returned} entries, the maximum for one page.`
        : null;

  return {
    rows,
    disclosure,
    limitations: payload.limitations.map((item) => item.message),
    accountLabel: payload.scope.providerAccountName ?? payload.scope.providerAccountId,
  };
}
