import { canonicalJson } from "@/lib/commerce-cost/revision";
import type { CommerceCostComponent } from "@/src/types/commerce-cost";

/**
 * Reconciling a submitted structure against the one already stored.
 *
 * A component's `version` is monotonic per id and its `recordedAt` is
 * transaction time — "what did we believe, and when did we come to believe it".
 * Both are read by the runtime: the resolver and the ledger take the newest
 * version per id and break ties on `recordedAt`, and evidence recency is judged
 * from it.
 *
 * So neither may be taken from the caller. If a save re-stamped every component
 * with the current clock, editing one shipping rate would move the transaction
 * time of every untouched cost with it — the tie-break between two equally
 * ranked components could flip, and a per-component version history that
 * advances on every unrelated save records nothing.
 *
 * THE CURRENT STRUCTURE HOLDS EXACTLY ONE RECORD PER COMPONENT ID: the latest.
 * A superseded version REPLACES its predecessor rather than being appended
 * beside it. Two reasons, and the first is a correctness bug, not a preference:
 *
 *  1. `activeComponents` in the resolver (lib/commerce-cost/resolver.ts) and
 *     `buildPeriodLedger` both drop `status !== "active"` BEFORE choosing the
 *     latest version per id. Append a retired v2 next to an active v1 and the
 *     retired record is filtered out first, leaving v1 as the newest survivor —
 *     so retiring a cost would leave it costing. Keeping one record per id
 *     makes that state unrepresentable instead of relying on every consumer to
 *     order its filters correctly.
 *  2. A snapshot that accumulated every past version would grow without bound
 *     against the 500-component payload ceiling, for no gain: replay is the
 *     immutable structure-history table's job, and each row there is a whole
 *     past structure.
 *
 * The rule:
 *  - A component whose content is byte-identical to the stored one keeps that
 *    stored record whole: version, `recordedAt`, audit. Saving a structure you
 *    did not change must change nothing.
 *  - A component whose content differs supersedes the stored record for its id
 *    at version + 1, stamped now and attributed to the actor. Retiring is this
 *    same path with `status: "retired"`.
 *  - An id not stored before starts at version 1.
 *  - An id the caller did not send is not resurrected. The submitted structure
 *    is what stands; earlier ones remain readable as earlier structure versions.
 *
 * Content identity deliberately excludes `version`, `recordedAt`, `supersededAt`
 * and `audit` — those are the server's answer, not part of the question.
 */

/** Fields the server owns, so they cannot make two identical components differ. */
function contentFingerprint(component: CommerceCostComponent): string {
  const {
    version: _version,
    recordedAt: _recordedAt,
    supersededAt: _supersededAt,
    audit: _audit,
    ...content
  } = component;
  return canonicalJson(content);
}

/** A submitted structure that could not be reconciled without losing meaning. */
export class DuplicateCostComponentIdError extends Error {
  readonly code = "duplicate_component_id";

  constructor(readonly componentId: string) {
    super(
      `The submitted structure carries more than one record for component "${componentId}".`,
    );
    this.name = "DuplicateCostComponentIdError";
  }
}

export interface ReconcileCostComponentsInput {
  /** Components of the structure currently stored, or null for a first save. */
  previous: readonly CommerceCostComponent[] | null;
  /** Components as submitted, already sanitised at the HTTP boundary. */
  next: readonly CommerceCostComponent[];
  /** Transaction time for anything this save actually changes. */
  recordedAt: string;
  actorUserId: string | null;
}

export interface ReconcileCostComponentsResult {
  /** In submitted order: component order is significant to the revision. */
  components: CommerceCostComponent[];
  /** Ids whose stored record was kept untouched. */
  unchanged: string[];
  /** Ids that superseded a stored record, with the version they now carry. */
  changed: Array<{ id: string; fromVersion: number; toVersion: number }>;
  /** Ids stored for the first time. */
  added: string[];
  /** Ids that were stored and are not in the submitted structure. */
  removed: string[];
  /** Ids the submission retired, a subset of `changed`. */
  retired: string[];
}

/** The stored record that speaks for an id: highest version, newest wins ties. */
function latestById(
  components: readonly CommerceCostComponent[],
): Map<string, CommerceCostComponent> {
  const latest = new Map<string, CommerceCostComponent>();
  for (const component of components) {
    const existing = latest.get(component.id);
    if (
      !existing ||
      component.version > existing.version ||
      (component.version === existing.version && component.recordedAt > existing.recordedAt)
    ) {
      latest.set(component.id, component);
    }
  }
  return latest;
}

export function reconcileCostComponents(
  input: ReconcileCostComponentsInput,
): ReconcileCostComponentsResult {
  // Defensive: `previous` is written by this module and is one-per-id, but a
  // structure imported from elsewhere need not be.
  const stored = latestById(input.previous ?? []);

  const components: CommerceCostComponent[] = [];
  const unchanged: string[] = [];
  const changed: ReconcileCostComponentsResult["changed"] = [];
  const added: string[] = [];
  const retired: string[] = [];
  const seenIds = new Set<string>();

  for (const submitted of input.next) {
    // Refused rather than collapsed. Two records for one id are two different
    // intentions, and picking one of them silently would enact a cost the
    // operator may not have meant to keep.
    if (seenIds.has(submitted.id)) {
      throw new DuplicateCostComponentIdError(submitted.id);
    }
    seenIds.add(submitted.id);

    const previous = stored.get(submitted.id);
    if (previous && contentFingerprint(previous) === contentFingerprint(submitted)) {
      // Identical content: this is the same fact, already recorded. Keeping the
      // stored record whole is what makes a no-op save a no-op.
      components.push(previous);
      unchanged.push(submitted.id);
      continue;
    }

    const version = (previous?.version ?? 0) + 1;
    const {
      version: _claimedVersion,
      recordedAt: _claimedRecordedAt,
      supersededAt: _claimedSupersededAt,
      audit: claimedAudit,
      ...submittedContent
    } = submitted;
    components.push({
      ...submittedContent,
      // Server-owned, every one of them. Whatever the payload claimed is gone.
      version,
      recordedAt: input.recordedAt,
      ...(submitted.status === "retired" ? { supersededAt: input.recordedAt } : {}),
      audit: {
        ...(claimedAudit?.note ? { note: claimedAudit.note } : {}),
        createdBy: input.actorUserId,
        createdAt: input.recordedAt,
      },
    });

    if (previous) {
      changed.push({ id: submitted.id, fromVersion: previous.version, toVersion: version });
      if (submitted.status === "retired" && previous.status !== "retired") {
        retired.push(submitted.id);
      }
    } else {
      added.push(submitted.id);
    }
  }

  const removed = [...stored.keys()].filter((id) => !seenIds.has(id));

  return { components, unchanged, changed, added, removed, retired };
}
