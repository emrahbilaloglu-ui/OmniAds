/**
 * Creative detail, evidence and history (H22/H23).
 *
 * The rule this module exists to enforce: **a deep-linked detail belongs to the
 * business and account in the URL.** A creative id is not globally unique in
 * any useful sense — the same id can appear under a different account, and a
 * stale tab or a shared link can name one this business does not own. Resolving
 * it anyway would render another workspace's creative inside this one.
 *
 * The decision band is read from the served posture and the served decision. It
 * is never derived from metrics here: the UI must not compute `buyerAction`,
 * and a band computed from a ROAS threshold is exactly that computation wearing
 * a different name.
 */
import type { EnginePosture } from "@/lib/zero-base/creative/engine-posture";
import type { MediaState, ServedCreativeRow } from "@/lib/zero-base/creative/performance-adapter";
import { mediaStateFor } from "@/lib/zero-base/creative/performance-adapter";

export type DetailResolution =
  | { kind: "ready"; row: ServedCreativeRow }
  | { kind: "not_in_scope"; reason: string }
  | { kind: "not_found"; reason: string };

/**
 * Resolve a deep-linked creative within the URL's own scope.
 *
 * `accountId` is the account named by the URL. A row that exists but belongs to
 * a different account is `not_in_scope` — deliberately distinct from
 * `not_found`, because the remedies differ: one is a wrong link, the other is a
 * creative that is gone.
 */
export function resolveDetail(input: {
  creativeId: string;
  accountId: string | null;
  rows: readonly ServedCreativeRow[];
}): DetailResolution {
  const id = input.creativeId.trim();
  const matches = input.rows.filter((row) => row.creative_id === id);
  if (matches.length === 0) {
    return {
      kind: "not_found",
      reason: "No creative with this identity was served for this business.",
    };
  }
  if (!input.accountId) {
    // Without an account in the URL there is nothing to check the row against.
    return { kind: "ready", row: matches[0] };
  }
  const inScope = matches.find((row) => row.account_id === input.accountId);
  if (!inScope) {
    return {
      kind: "not_in_scope",
      reason:
        "This creative exists but belongs to a different ad account than the one in this link.",
    };
  }
  return { kind: "ready", row: inScope };
}

export interface EvidenceItem {
  label: string;
  value: string;
  /** Where the value came from. Unsourced evidence is not evidence. */
  source: string;
}

/**
 * Evidence rows for the detail surface.
 *
 * Only served fields, each labelled with its origin. A field the server did not
 * send is omitted rather than rendered empty, so the list never implies a
 * measurement that was never taken.
 */
export function buildEvidence(row: ServedCreativeRow): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const push = (label: string, value: string | null | undefined, source: string) => {
    const text = value?.toString().trim();
    if (text) items.push({ label, value: text, source });
  };
  push("Creative id", row.creative_id, "served identity");
  push("Ad id", row.real_ad_id, "served identity");
  push("Ad account", row.account_name ?? row.account_id, "served identity");
  push("Campaign", row.campaign_name, "served hierarchy");
  push("Ad set", row.adset_name, "served hierarchy");
  push("First seen", row.launch_date, "served warehouse");
  push("Preview origin", row.preview_origin, "served media");
  return items;
}

export type DecisionBand =
  | { kind: "none"; reason: string }
  | { kind: "band"; label: string; detail: string | null };

/**
 * The decision band for one creative.
 *
 * Derived from the served posture and the served decision label — never from a
 * metric. When the posture is anything but `serving`, there is no band at all,
 * and the posture's own explanation is the reason.
 */
export function decisionBand(input: {
  posture: EnginePosture;
  postureExplanation: string;
  /** The server's decision label for this creative, when it served one. */
  servedLabel: string | null;
  servedDetail: string | null;
}): DecisionBand {
  if (input.posture !== "serving") {
    return { kind: "none", reason: input.postureExplanation };
  }
  const label = input.servedLabel?.trim();
  if (!label) {
    return { kind: "none", reason: "The engine served no decision for this creative." };
  }
  return { kind: "band", label, detail: input.servedDetail?.trim() || null };
}

export interface DetailView {
  creativeId: string;
  name: string;
  media: MediaState;
  evidence: EvidenceItem[];
  band: DecisionBand;
  decisionsHref: string;
}

/* ------------------------------------------------------------------ history */

export interface ServedHistoryEntry {
  id: string;
  occurredAt: string;
  label: string;
  detail: string | null;
  /** Present when the entry was recomputed after the fact. */
  replayedAt?: string | null;
  engineVersion?: string | null;
  actor?: string | null;
}

export interface HistoryEntryView {
  id: string;
  occurredAt: string;
  label: string;
  detail: string | null;
  replayed: boolean;
  actor: string;
  engineVersion: string | null;
}

export const CREATIVE_REPLAY_BANNER =
  "Part of this history was replayed after the fact. Replayed entries describe what the engine would decide now, not what it decided then.";

/**
 * History rows, with replay and actor provenance intact.
 *
 * A replayed entry is marked permanently, and an entry with no recorded actor
 * says so rather than being attributed to the system.
 */
export function buildHistory(entries: readonly ServedHistoryEntry[]): {
  rows: HistoryEntryView[];
  anyReplayed: boolean;
} {
  const rows = entries.map((entry) => ({
    id: entry.id,
    occurredAt: entry.occurredAt,
    label: entry.label,
    detail: entry.detail?.trim() || null,
    replayed: Boolean(entry.replayedAt),
    actor: entry.actor?.trim() || "Actor not recorded",
    engineVersion: entry.engineVersion?.trim() || null,
  }));
  return { rows, anyReplayed: rows.some((row) => row.replayed) };
}

export { mediaStateFor };
