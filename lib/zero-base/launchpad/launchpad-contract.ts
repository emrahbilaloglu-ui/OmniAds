/**
 * Meta Launchpad preparation (H25/H26, Flow E).
 *
 * Launchpad prepares. It does not launch. That distinction is the whole point
 * of this module, and it is enforced in three places rather than one:
 *
 * 1. The canonical client bundle contains **no call site** for the launch or
 *   add-to-existing endpoints. Not a disabled button that would call them, not
 *   a guarded fetch — no reference at all, so no flag flip and no code path can
 *   reach them from here.
 * 2. Launch and Add-to-existing render as disabled with their **exact**
 *   prerequisites listed, so an operator knows what is missing rather than
 *   assuming the feature is broken.
 * 3. The limitations panel says what works today in plain terms, including the
 *   things that do not exist. There is no Launchpad rollback and there is no
 *   Google Launchpad; claiming either would be worse than claiming nothing.
 */

/** Endpoints the canonical bundle must never reference. */
export const FORBIDDEN_LAUNCH_ENDPOINTS = [
  "/api/launchpad/meta/launch",
  "/api/launchpad/meta/add-to-existing",
] as const;

export interface Prerequisite {
  id: string;
  label: string;
  /** Whether this prerequisite is satisfied today. */
  met: boolean;
  detail: string;
}

/**
 * Why Launch is disabled, in the exact terms the execution contract uses.
 *
 * These are not placeholders. Each names a real requirement from the provider
 * write authority: a durable rollback path, a canonical decision origin, and an
 * explicit operator confirmation bound to the request.
 */
export function launchPrerequisites(): Prerequisite[] {
  return [
    {
      id: "rollback",
      label: "A durable rollback path",
      met: false,
      detail:
        "Launching creates provider objects. There is no rollback for that today — undoing it means deleting what was created, by hand, and that is not a rollback.",
    },
    {
      id: "origin",
      label: "A canonical launch decision origin",
      met: false,
      detail:
        "A provider write must declare exactly one origin. Launchpad has no canonical launch origin contract, so a launch could not state where its authority came from.",
    },
    {
      id: "confirmation",
      label: "An explicit operator confirmation bound to the request",
      met: false,
      detail:
        "The confirmation must be part of the request that performs the write, not a dialog that happened earlier and cannot be proven.",
    },
  ];
}

export interface DisabledAction {
  id: "launch" | "add_to_existing";
  label: string;
  disabled: true;
  prerequisites: Prerequisite[];
  /** The single sentence shown next to the disabled control. */
  summary: string;
}

export function disabledLaunchActions(): DisabledAction[] {
  const prerequisites = launchPrerequisites();
  const unmet = prerequisites.filter((item) => !item.met).length;
  const summary = `Unavailable: ${unmet} prerequisite${unmet === 1 ? "" : "s"} are not met.`;
  return [
    { id: "launch", label: "Launch", disabled: true, prerequisites, summary },
    { id: "add_to_existing", label: "Add to existing", disabled: true, prerequisites, summary },
  ];
}

/**
 * Plain statement of the surface's real reach.
 *
 * Acceptance review found the first version of this list claiming drafts,
 * templates and validation that were never wired — the client only listed and
 * deleted templates. Every line below now corresponds to a mounted, tested
 * call against the real endpoint, and a claim is removed the moment its action
 * is not.
 */
export const WHAT_WORKS_TODAY = [
  "Drafts are listed from your saved drafts, and a new draft can be created with a name and payload.",
  "Templates are listed, created, and deleted. They cannot be edited — change one by duplicating it, which copies the served payload into a new template, so the original stays exactly as whatever used it saw it.",
  "Validation runs your draft payload through the validator and reports what it finds.",
  "Nothing on this page creates, changes or launches anything in Meta.",
] as const;

export const WHAT_DOES_NOT_EXIST = [
  "There is no rollback for a launch. Nothing here can undo provider objects once they exist.",
  "There is no Google Launchpad. This surface is Meta only, and no part of it applies to Google.",
  "Bulk ad status is not available from this page. See the reason next to it.",
] as const;

/**
 * Why bulk is withheld even when the mutation flag is on.
 *
 * The real `/api/launchpad/meta/bulk-ad-status` handler requires a canonical
 * per-item decision-origin contract: exact ad and creative identity, an action
 * origin, and a dry-run declaration, per item. This page holds none of that.
 * Assembling it in the browser would mean inventing exact target, creative and
 * origin fields — precisely the client-supplied authority the write contracts
 * refuse — and building a second source for it would be a parallel authority.
 *
 * So the control is withheld with this reason rather than shipped as a button
 * that can only 400.
 */
export const BULK_WITHHELD_REASON =
  "Bulk ad status needs the exact per-item ad and creative identity and a canonical action origin, which this page does not hold. Building them here would mean the browser inventing the authority the write contract exists to refuse.";

/* ------------------------------------------------------------- templates */

/**
 * Templates are immutable once created.
 *
 * The server offers GET, POST and DELETE and no update at all. Rendering an
 * edit affordance would promise a write the API cannot perform — and, worse,
 * would let a template change under whatever already referenced it.
 */
export const TEMPLATE_IMMUTABILITY_NOTE =
  "Templates cannot be edited. Duplicate one to change it, so anything already built from the original still matches what its author saw.";

export type TemplateAction = "read" | "duplicate" | "delete";
export const TEMPLATE_ACTIONS: readonly TemplateAction[] = ["read", "duplicate", "delete"];

/* ------------------------------------------------------------ validation */

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationFinding {
  id: string;
  field: string | null;
  severity: ValidationSeverity;
  message: string;
}

/** The first error, so focus can move to the field that blocks progress. */
export function firstBlockingField(findings: readonly ValidationFinding[]): string | null {
  return findings.find((item) => item.severity === "error" && item.field)?.field ?? null;
}

export function hasBlockingError(findings: readonly ValidationFinding[]): boolean {
  return findings.some((item) => item.severity === "error");
}

/* ------------------------------------------------------------------ bulk */

/** The server's own cap. Stated here so the UI refuses before the request. */
export const MAX_BULK_ADS = 20;

export type BulkItemOutcome =
  | { adId: string; status: "applied"; detail: string }
  | { adId: string; status: "refused"; detail: string }
  | { adId: string; status: "unknown"; detail: string };

export type BulkGate =
  | { ok: true; adIds: string[] }
  | { ok: false; reason: string };

/**
 * Whether a bulk request may even be assembled.
 *
 * The mutation UI flag is the outer gate: with it off there is no bulk control
 * at all. The cap is checked here so 21 ads are refused in the form rather than
 * after a round trip that would refuse them anyway.
 */
export function gateBulkRequest(input: {
  mutationUiEnabled: boolean;
  adIds: readonly string[];
  /** Whether this surface can build the handler's exact per-item contract. */
  canBuildExactContract?: boolean;
}): BulkGate {
  if (!input.mutationUiEnabled) {
    return { ok: false, reason: "Bulk status changes are not enabled in this environment." };
  }
  // The flag being on is not sufficient. Without the exact per-item contract
  // the request cannot be valid, so it is refused here rather than by the
  // handler after a pointless round trip.
  if (input.canBuildExactContract !== true) {
    return { ok: false, reason: BULK_WITHHELD_REASON };
  }
  const adIds = [...new Set(input.adIds.map((id) => id.trim()).filter(Boolean))];
  if (adIds.length === 0) {
    return { ok: false, reason: "Select at least one ad." };
  }
  if (adIds.length > MAX_BULK_ADS) {
    return {
      ok: false,
      reason: `Select at most ${MAX_BULK_ADS} ads. ${adIds.length} were selected.`,
    };
  }
  return { ok: true, adIds };
}

/**
 * Per-item outcomes.
 *
 * A bulk result is not one verdict. Some items apply, some are refused, and
 * some end unknown — and an operator shown a single "done" would never learn
 * which. An item the server did not mention is `unknown`, never assumed applied.
 */
export function reconcileBulkOutcomes(input: {
  requested: readonly string[];
  served: readonly { adId: string; status?: string; detail?: string }[];
}): BulkItemOutcome[] {
  const byId = new Map(input.served.map((item) => [item.adId, item]));
  return input.requested.map((adId) => {
    const item = byId.get(adId);
    if (!item) {
      return {
        adId,
        status: "unknown" as const,
        detail: "The server did not report an outcome for this ad.",
      };
    }
    if (item.status === "applied" || item.status === "success") {
      return { adId, status: "applied" as const, detail: item.detail ?? "Applied." };
    }
    if (item.status === "refused" || item.status === "failed" || item.status === "error") {
      return { adId, status: "refused" as const, detail: item.detail ?? "Refused." };
    }
    return {
      adId,
      status: "unknown" as const,
      detail: item.detail ?? "The outcome was not classified.",
    };
  });
}
