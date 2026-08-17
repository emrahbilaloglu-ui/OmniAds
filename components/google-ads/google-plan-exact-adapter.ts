import type { GoogleAdsActivityEntry } from "@/lib/google-ads/advisor-memory";
import type { GoogleRecommendation } from "@/lib/google-ads/growth-advisor-types";

/**
 * Pure view model for the canonical `Google Ads · Plan & activity` screen
 * (reference markup lines 1625-1693, model lines 3876-3894).
 *
 * The screen is the execution queue, the batch contract card and the activity
 * feed — nothing else. Every step reads the advisor's own served execution
 * state; every activity row reads the guarded-write execution log.
 */

const DASH = "—";

/**
 * The reference's fixed provenance line under each step title (model line
 * 3877). It is identical on every step because it states where the queue comes
 * from, not what the individual step touches.
 */
export const GOOGLE_PLAN_STEP_SOURCE =
  "served by the advisor from the last complete day";

export interface GooglePlanExactIdentity {
  accountId?: string | null;
  currencyCode?: string | null;
  windowLabel?: string | null;
  syncLabel?: string | null;
}

export interface GooglePlanExactStepViewModel {
  /** The recommendation id, so the surface can act on the right step. */
  key: string;
  number: string;
  title: string;
  source: string;
  /** Amber blocker line, or null when the advisor names no blocker. */
  note: string | null;
  /** Google Ads deep link, or null when the advisor served none. */
  openHref: string | null;
  applied: boolean;
  statusLabel: string;
  applyLabel: string;
  /**
   * False when this step carries no mutate (or rollback) payload, or when the
   * viewer may not write. The guarded boundary still refuses on the server;
   * this only stops the surface offering a control it cannot honour.
   */
  applyEnabled: boolean;
  /** The clipboard payload for the reference's Copy control. */
  copyText: string;
  dismissEnabled: boolean;
}

export interface GooglePlanExactActivityRowViewModel {
  key: string;
  when: string;
  who: string;
  what: string;
  detail: string;
}

export interface GooglePlanExactViewModel {
  eyebrow: string;
  syncLabel: string;
  queuedLabel: string;
  appliedLabel: string;
  steps: GooglePlanExactStepViewModel[];
  applyAllEnabled: boolean;
  /** "Entries before <date> are past retention and cannot be shown." */
  retentionLine: string;
  activityRows: GooglePlanExactActivityRowViewModel[];
}

export interface GooglePlanExactInput {
  identity?: GooglePlanExactIdentity;
  /** Null means the advisor has not been read, not that it is empty. */
  recommendations: GoogleRecommendation[] | null;
  /** Null means the execution log has not been read. */
  activity: GoogleAdsActivityEntry[] | null;
  /** Retention window of the execution log, in days. */
  activityRetentionDays: number | null;
  /** Reference instant for the retention boundary; the adapter stays pure. */
  asOf: Date;
  /**
   * Whether this viewer may drive the guarded write boundary at all. Mirrors
   * the advisor screen's own authority: a reviewer, a demo session or an
   * unresolved account never gets an armed control.
   */
  writeAuthority: "allowed" | "denied" | "unknown";
}

function clean(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : DASH;
}

function eyebrowText(identity: GooglePlanExactIdentity) {
  return `Google Ads · ${clean(identity.accountId)} · ${clean(
    identity.currencyCode,
  )} · ${clean(identity.windowLabel)} window`;
}

function humanise(value: string | null | undefined): string {
  const normalized = (value ?? "").replace(/_/g, " ").trim();
  if (!normalized) return DASH;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

/**
 * The design's Activity `Who`: the seat that authored the guarded write.
 *
 * The execution log stores the authorizing session's user id, and the read
 * joins it to that member's name. Two absences look the same in one cell and
 * both print the em dash rather than a guess: a row with no actor at all (every
 * row written before the actor column existed, and any write with no session
 * behind it), and an actor whose user row is gone so no name can be served. The
 * account the write executed against is never printed here — it names the
 * write's target, not its author.
 */
export function googlePlanActivityActorLabel(
  actor: { id: string; name: string | null } | null | undefined,
): string {
  const name = actor?.name?.trim();
  return name ? name : DASH;
}

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return clean(value);
  return `${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })} · ${date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
}

/** A step has actually executed only when the server says `applied`. */
export function isGooglePlanStepApplied(step: GoogleRecommendation): boolean {
  return step.executionStatus === "applied";
}

export function googlePlanStepIsApplyReady(step: GoogleRecommendation): boolean {
  return Boolean(step.mutateActionType && step.mutatePayloadPreview);
}

export function googlePlanStepIsRollbackReady(
  step: GoogleRecommendation,
): boolean {
  return Boolean(step.rollbackActionType && step.rollbackPayloadPreview);
}

/**
 * The retention boundary the reference states above the activity table. It is
 * the execution log's own retention window counted back from now, not a guess:
 * with no window served the line keeps its slot and prints the em dash.
 */
export function googlePlanRetentionLine(
  retentionDays: number | null,
  asOf: Date,
): string {
  if (
    retentionDays === null ||
    !Number.isFinite(retentionDays) ||
    retentionDays <= 0 ||
    Number.isNaN(asOf.getTime())
  ) {
    return DASH;
  }
  const cutoff = new Date(asOf.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const label = cutoff.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `Entries before ${label} are past retention and cannot be shown.`;
}

export function buildGooglePlanExactViewModel(
  input: GooglePlanExactInput,
): GooglePlanExactViewModel {
  const identity = input.identity ?? {};
  const allowed = input.writeAuthority === "allowed";
  // The reference's `sc-for` over `gPlanSteps` (markup line 1638) is uncapped
  // and its counter is `gPlanRaw.length` (model line 4443): the queue renders
  // every served recommendation, and the head states the true length. A cap
  // here would drop steps and print a number no server produced.
  const ranked = [...(input.recommendations ?? [])].sort(
    (left, right) => (right.rankScore ?? 0) - (left.rankScore ?? 0),
  );

  const steps: GooglePlanExactStepViewModel[] = ranked.map(
    (recommendation, index) => {
      const applied = isGooglePlanStepApplied(recommendation);
      const receipt = recommendation.transactionId?.trim() || null;
      const blockers = (recommendation.blockers ?? []).filter(
        (blocker) => typeof blocker === "string" && blocker.trim() !== "",
      );
      const deepLink = recommendation.deepLinkUrl?.trim() || null;
      const ready = applied
        ? googlePlanStepIsRollbackReady(recommendation) &&
          recommendation.rollbackAvailable !== false
        : googlePlanStepIsApplyReady(recommendation);
      return {
        key: recommendation.id,
        number: String(index + 1),
        title: clean(recommendation.title),
        source: GOOGLE_PLAN_STEP_SOURCE,
        note: blockers.length > 0 ? blockers.join(" · ") : null,
        openHref: deepLink,
        applied,
        statusLabel: applied
          ? `applied · receipt ${receipt ?? DASH}`
          : "queued — awaiting apply",
        applyLabel: applied ? "Roll back" : "Apply now",
        applyEnabled: allowed && ready,
        copyText: [
          clean(recommendation.title),
          clean(recommendation.recommendedAction),
          clean(recommendation.whyNow),
        ].join("\n"),
        dismissEnabled:
          allowed && Boolean(recommendation.recommendationFingerprint),
      };
    },
  );

  const appliedCount = steps.filter((step) => step.applied).length;
  const activity = input.activity ?? [];

  return {
    eyebrow: eyebrowText(identity),
    syncLabel: clean(identity.syncLabel),
    queuedLabel: String(steps.length),
    appliedLabel: String(appliedCount),
    steps,
    applyAllEnabled: steps.some((step) => !step.applied && step.applyEnabled),
    retentionLine: googlePlanRetentionLine(
      input.activityRetentionDays,
      input.asOf,
    ),
    activityRows: activity.map((row) => ({
      key: row.id,
      when: formatWhen(row.createdAt),
      who: googlePlanActivityActorLabel(row.actor),
      what: humanise(row.status),
      detail:
        [
          humanise(row.mutateActionType),
          row.receiptId ? `receipt ${row.receiptId}` : null,
          row.detail,
        ]
          .filter((part): part is string => Boolean(part) && part !== DASH)
          .join(" · ") || DASH,
    })),
  };
}
