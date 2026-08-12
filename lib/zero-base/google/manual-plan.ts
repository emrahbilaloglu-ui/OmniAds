/**
 * Google manual plan and reference write posture (H32/H33, Flow F).
 *
 * The manual path is the product. Google writes are not performed by this
 * programme at all, so the plan is something an operator carries into the
 * Google UI themselves: an ordered list, exact copy, an exact CSV, and deep
 * links that land on the precise entity rather than a search page.
 *
 * Two wording rules that look small and are not:
 *
 * - **"Reconciliation" is a Meta word.** It names a specific durable process
 *   that settles an ambiguous Meta write. Google has no such process here, so a
 *   Google pending state that borrowed the word would promise an settlement
 *   nobody will perform.
 * - **No `pause_ad` control.** Not disabled — absent. Google pausing is not a
 *   thing this surface does, and a greyed control implies it is coming.
 */
import type { GoogleExecutionStatus } from "@/lib/google-ads/growth-advisor-types";
import type { AdaptedRecommendation } from "@/lib/zero-base/google/payload-adapters";

/* ------------------------------------------------------------ plan model */

/**
 * A plan input, built ONLY by `fromAdaptedRecommendation` from the real
 * `GoogleRecommendation` fields. It carries no `accountId`, because the served
 * recommendation has none — assuming one is what made `googleDeepLink` call
 * `.replace()` on `undefined`.
 */
export interface ServedRecommendation {
  id: string;
  /** From the server's own `rankScore`. Never re-derived from a metric. */
  rank?: number | null;
  title: string;
  rationale: string | null;
  entityId: string | null;
  entityName: string | null;
  executionTargetType: string | null;
  executionTargetId: string | null;
  /** The link Google served. Absent means the exact link is withheld. */
  deepLinkUrl: string | null;
  executionStatus?: GoogleExecutionStatus | null;
  dependencyReadiness?: string | null;
  stabilizationNote?: string | null;
}

/** Map the real adapted recommendation onto a plan input. No invention. */
export function fromAdaptedRecommendation(item: AdaptedRecommendation): ServedRecommendation {
  return {
    id: item.id,
    // rankScore is the served ordering semantic.
    rank: item.rankScore,
    title: item.title,
    rationale: item.summary ?? item.why,
    entityId: item.entityId,
    entityName: item.entityName,
    executionTargetType: item.executionTargetType,
    executionTargetId: item.executionTargetId,
    deepLinkUrl: item.deepLinkUrl,
    dependencyReadiness: null,
    stabilizationNote: item.rollbackGuidance,
  };
}

export interface PlanStep extends ServedRecommendation {
  position: number;
  /** Weaknesses stated on the step itself, not buried in a footnote. */
  weaknesses: string[];
}

/**
 * Order the plan by the rank the server assigned.
 *
 * Items with no rank keep their served order after the ranked ones — inventing
 * an order from a metric would be this surface deciding priority, which is the
 * advisor's job.
 */
export function buildPlan(items: readonly ServedRecommendation[]): PlanStep[] {
  const ranked = items.filter((item) => typeof item.rank === "number");
  const unranked = items.filter((item) => typeof item.rank !== "number");
  ranked.sort((a, b) => (a.rank as number) - (b.rank as number));
  return [...ranked, ...unranked].map((item, index) => ({
    ...item,
    position: index + 1,
    weaknesses: [
      item.dependencyReadiness && item.dependencyReadiness !== "ready"
        ? `Dependency not ready: ${item.dependencyReadiness}.`
        : null,
      item.stabilizationNote ? `Stabilization: ${item.stabilizationNote}` : null,
    ].filter((value): value is string => Boolean(value)),
  }));
}

/* --------------------------------------------------------------- wording */

/** Words a Google pending state must never borrow from Meta. */
export const FORBIDDEN_PENDING_WORDS = ["reconciliation", "reconcile", "reconciled"] as const;

export const GOOGLE_PENDING_COPY =
  "Submitted in Google and not yet confirmed here. Check the change history in Google Ads to see whether it took effect.";

export function pendingCopyIsClean(text: string): boolean {
  const lowered = text.toLowerCase();
  return !FORBIDDEN_PENDING_WORDS.some((word) => lowered.includes(word));
}

/* ------------------------------------------------------------ deep links */

/**
 * The exact link, or nothing.
 *
 * Google serves `deepLinkUrl` when it can address the entity. When it does not,
 * this returns null and the surface says the exact link is not available —
 * because a link assembled from an account id we were never given is either a
 * crash (the previous `.replace()` on `undefined`) or a link to the wrong
 * account, and both are worse than no link.
 */
export function googleDeepLink(
  step: Pick<ServedRecommendation, "deepLinkUrl" | "executionTargetId" | "executionTargetType">,
): string | null {
  const url = step.deepLinkUrl?.trim();
  if (!url) return null;
  // Only absolute Google URLs are followed; anything else is not a destination
  // this surface can vouch for.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith("google.com")) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export const LINK_WITHHELD =
  "Google did not serve a direct link for this item. Open the entity from the Google Ads UI.";

/* ------------------------------------------------------------- copy / CSV */

export function planToText(steps: readonly PlanStep[]): string {
  return steps
    .map((step) => {
      const lines = [`${step.position}. ${step.title}`];
      if (step.entityName) lines.push(`   Entity: ${step.entityName} (${step.entityId ?? "id not served"})`);
      const link = googleDeepLink(step);
      if (!link) lines.push("   Link: not served by Google");
      if (step.rationale) lines.push(`   Why: ${step.rationale}`);
      for (const weakness of step.weaknesses) lines.push(`   Caveat: ${weakness}`);
      return lines.join("\n");
    })
    .join("\n");
}

export const CSV_COLUMNS = [
  "position",
  "title",
  "execution_target_type",
  "execution_target_id",
  "entity_name",
  "rationale",
  "caveats",
  "google_link",
] as const;

/**
 * RFC 4180 escaping.
 *
 * A rationale containing a comma, a quote or a newline is ordinary — and each
 * of the three silently corrupts a naive CSV, shifting every later column into
 * the wrong field.
 */
export function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function planToCsv(steps: readonly PlanStep[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = steps.map((step) =>
    [
      step.position,
      step.title,
      step.executionTargetType ?? "",
      step.executionTargetId ?? step.entityId ?? "",
      step.entityName ?? "",
      step.rationale ?? "",
      step.weaknesses.join(" "),
      googleDeepLink(step) ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  // CRLF per RFC 4180, so a spreadsheet on any platform reads the same file.
  return [header, ...rows].join("\r\n");
}

/* ------------------------------------------------------------ batch gate */

export const MAX_BATCH_ITEMS = 250;

export type BatchGate = { ok: true; ids: string[] } | { ok: false; reason: string };

/**
 * Validate a reference batch before it could be assembled.
 *
 * Type and group must be uniform: a batch mixing campaigns and keywords, or
 * spanning two accounts, is not one operation and cannot be reasoned about as
 * one. Nothing is executed either way — this is the shape a batch would need if
 * it ever were.
 */
export function gateBatch(input: {
  steps: readonly PlanStep[];
  selectedIds: readonly string[];
}): BatchGate {
  const ids = [...new Set(input.selectedIds.filter(Boolean))];
  if (ids.length === 0) return { ok: false, reason: "Select at least one item." };
  if (ids.length > MAX_BATCH_ITEMS) {
    return {
      ok: false,
      reason: `A batch is limited to ${MAX_BATCH_ITEMS} items. ${ids.length} were selected.`,
    };
  }
  const chosen = input.steps.filter((step) => ids.includes(step.id));
  const types = new Set(chosen.map((step) => step.executionTargetType ?? "unknown"));
  if (types.size > 1) {
    return {
      ok: false,
      reason: `A batch must be one execution target type. This selection spans ${[...types].join(", ")}.`,
    };
  }
  return { ok: true, ids };
}

/* -------------------------------------------------- reference write states */

export interface ReferenceWriteState {
  mode: "single" | "batch";
  enabled: false;
  reason: string;
}

export const REFERENCE_WRITE_STATES: ReferenceWriteState[] = [
  {
    mode: "single",
    enabled: false,
    reason:
      "This product performs no Google writes. The step above is what you would do in Google Ads yourself.",
  },
  {
    mode: "batch",
    enabled: false,
    reason:
      "Batch application is a reference shape only. No Google mutation layer exists in this programme.",
  },
];

/** The `partially_applied` status is real in the served contract, so it renders. */
export function supportsPartiallyApplied(statuses: readonly string[]): boolean {
  return statuses.includes("partially_applied");
}
