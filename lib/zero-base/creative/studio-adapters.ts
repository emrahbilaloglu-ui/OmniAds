/**
 * Briefs, inbox, copies, landing pages and shares (Flow D and Flow L).
 *
 * Five surfaces that share one habit: each says exactly what its backend told
 * it, and says so plainly when the backend told it nothing. The specific
 * honesty rules, and why each exists:
 *
 * - **Landing-page caps.** The design names 250 rows and 100 per page. Those
 *   numbers are only true if the backend served them. When it does not, the
 *   surface says "Backend cap not supplied" rather than printing a number it
 *   read from a spec document — a cap the server never enforced is a fiction
 *   the operator would plan around.
 * - **No brief delete.** A brief is lineage: something downstream was created
 *   from it. Deleting it would orphan that lineage silently, so the surface has
 *   no delete control at all rather than one that fails.
 * - **Source states.** Inbox and copy rows carry where they came from, so a
 *   row with no recoverable source is visibly unsourced rather than looking the
 *   same as a sourced one.
*/
import type { ShareAudience } from "@/components/creatives/shareCreativeTypes";

/* --------------------------------------------------------- landing pages */

/** The caps the design specifies, honoured only when the backend serves them. */
export const LANDING_PAGE_ROW_CAP = 250;
export const LANDING_PAGE_PAGE_SIZE = 100;
export const BACKEND_CAP_NOT_SUPPLIED = "Backend cap not supplied";

export interface LandingPageCapContract {
  rowCap: number | null;
  pageSize: number | null;
  text: string;
}

/**
 * The cap disclosure for the landing-page collection.
 *
 * `served` is what the backend actually reported. Absent means absent: this
 * function will not fill in 250/100 from the spec, because the surface would
 * then claim a limit nobody enforces.
 */
export function landingPageCap(served: {
  rowCap?: number | null;
  pageSize?: number | null;
}): LandingPageCapContract {
  const rowCap = Number.isInteger(served.rowCap) ? (served.rowCap as number) : null;
  const pageSize = Number.isInteger(served.pageSize) ? (served.pageSize as number) : null;
  if (rowCap === null && pageSize === null) {
    return { rowCap: null, pageSize: null, text: BACKEND_CAP_NOT_SUPPLIED };
  }
  const parts: string[] = [];
  if (rowCap !== null) parts.push(`Up to ${rowCap} rows`);
  if (pageSize !== null) parts.push(`${pageSize} per page`);
  return { rowCap, pageSize, text: parts.join(", ") + "." };
}

/* ---------------------------------------------------------------- briefs */

/**
 * A brief as `/api/meta/creative-briefs` actually serves it.
 *
 * This used to declare `title`, `sourceCreativeId` and `sourceAccountId` —
 * **none of which the endpoint sends.** `MetaCreativeBrief` carries
 * `providerAccountId`, a `sourceDecision` object holding `creativeId`, and a
 * `content` object holding keep/change/next. So every row rendered an undefined
 * title, and the lineage check compared two fields that are never present,
 * which made *every* brief report "this brief does not record the creative it
 * was derived from" — about briefs whose creative id was sitting in
 * `sourceDecision`. Plan §5.1 finding 17.
 *
 * Declared to match the served contract, with the legacy flat spellings kept as
 * optional so an older payload still parses rather than throwing.
 */
export interface ServedBrief {
  id: string;
  createdAt: string;
  status?: string | null;
  providerAccountId?: string | null;
  sourceDecision?: {
    creativeId?: string | null;
    snapshotId?: string | null;
    publishedLabel?: string | null;
    rawLabel?: string | null;
    snapshotAsOf?: string | null;
  } | null;
  content?: {
    keep?: string | null;
    change?: string | null;
    next?: string | null;
  } | null;
  /** Legacy flat spellings. Read if present; never required. */
  title?: string | null;
  sourceCreativeId?: string | null;
  sourceAccountId?: string | null;
}

export interface BriefRow {
  id: string;
  title: string;
  createdAt: string;
  status: string;
  lineage: { known: true; creativeId: string; accountId: string } | { known: false; reason: string };
}

/**
 * A title from a field the server actually sends.
 *
 * `MetaCreativeBrief` has no title. The decision's own published label is what
 * names this brief to an operator — it is the verdict the brief was written
 * about — and the raw label is the fallback. When neither is served the id is
 * NOT used as a name: an id is an identifier, and printing one where a name
 * goes is how a UUID ends up looking like a title. WP11 Briefs item 3.
 */
function briefTitle(brief: ServedBrief): string {
  return (
    brief.title?.trim() ||
    brief.sourceDecision?.publishedLabel?.trim() ||
    brief.sourceDecision?.rawLabel?.trim() ||
    "Untitled brief"
  );
}

export function toBriefRow(brief: ServedBrief): BriefRow {
  // `sourceDecision.creativeId` is where the served contract keeps it; the flat
  // spelling is read only for an older payload. Preferring the nested one is
  // what turns "lineage unknown" back into the lineage the server sent.
  const creativeId =
    brief.sourceDecision?.creativeId?.trim() || brief.sourceCreativeId?.trim();
  const accountId =
    brief.providerAccountId?.trim() || brief.sourceAccountId?.trim();
  return {
    id: brief.id,
    title: briefTitle(brief),
    createdAt: brief.createdAt,
    status: brief.status?.trim() || "Not reported",
    lineage:
      creativeId && accountId
        ? { known: true, creativeId, accountId }
        : {
            known: false,
            // Named, because a brief with no traceable origin cannot be
            // reconciled against the creative it claims to describe.
            reason: "This brief does not record the creative it was derived from.",
          },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The exact body `/api/meta/creative-briefs` requires.
 *
 * Read from `parseCreateMetaCreativeBriefRequest`: business, provider account,
 * an idempotency key, an immutable `sourceDecision` carrying a UUID snapshot
 * id and its trigger, and the three content fields.
 */
export interface CreateBriefRequest {
  businessId: string;
  providerAccountId: string;
  idempotencyKey: string;
  sourceDecision: { snapshotId: string; trigger: string };
  content: { keep: string; change: string; next: string };
}

export interface BriefLineage {
  creativeId: string | null;
  accountId: string | null;
  /** The decision snapshot this brief would be derived from. */
  snapshotId: string | null;
  trigger: string | null;
}

/**
 * Whether a brief may be created — checked BEFORE any POST.
 *
 * The route's lineage is a decision snapshot, not merely a creative id. A
 * creative surface that has no snapshot cannot produce a traceable brief, and
 * posting anyway would earn a 400 the operator cannot act on. So the block
 * names the specific missing piece.
 */
export function canCreateBrief(input: BriefLineage): { ok: true } | { ok: false; reason: string } {
  if (!input.creativeId?.trim() || !input.accountId?.trim()) {
    return {
      ok: false,
      reason:
        "A brief can only be created from a creative whose identity and account are both known.",
    };
  }
  if (!input.snapshotId?.trim()) {
    return {
      ok: false,
      reason:
        "A brief is derived from a decision snapshot, and none is in scope here. Open this creative from a decision to create a brief from it.",
    };
  }
  if (!UUID.test(input.snapshotId.trim())) {
    // The route requires a UUID; a malformed one would 400 after the round trip.
    return {
      ok: false,
      reason: "The decision snapshot in scope is not a valid identifier, so no brief can be traced to it.",
    };
  }
  if (!input.trigger?.trim()) {
    return {
      ok: false,
      reason: "The decision snapshot in scope records no trigger, which the brief contract requires.",
    };
  }
  return { ok: true };
}

/** Build the exact request body. Only called after `canCreateBrief` passes. */
export function buildCreateBriefRequest(input: {
  lineage: BriefLineage;
  content: { keep: string; change: string; next: string };
  idempotencyKey: string;
}): CreateBriefRequest {
  return {
    businessId: "",
    providerAccountId: input.lineage.accountId!.trim(),
    idempotencyKey: input.idempotencyKey,
    sourceDecision: {
      snapshotId: input.lineage.snapshotId!.trim().toLowerCase(),
      trigger: input.lineage.trigger!.trim(),
    },
    content: {
      keep: input.content.keep.trim(),
      change: input.content.change.trim(),
      next: input.content.next.trim(),
    },
  };
}

/* ------------------------------------------------------- inbox and copies */

export type SourceState =
  | { kind: "sourced"; source: string }
  | { kind: "unsourced"; reason: string };

export function sourceState(source: string | null | undefined): SourceState {
  const value = source?.trim();
  return value
    ? { kind: "sourced", source: value }
    : {
        kind: "unsourced",
        reason: "No source was recorded for this row.",
      };
}

/* --------------------------------------------------------------- shares */

export type ShareStatus = "active" | "expired" | "revoked";

export interface ServedShare {
  token: string;
  title: string;
  audience: ShareAudience;
  status?: ShareStatus;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  openCount?: number;
  creativeCount?: number;
  firstCreativeName?: string | null;
  providerAccountId?: string;
}

export interface ShareRow extends ServedShare {
  status: ShareStatus;
  statusText: string;
}

/**
 * Internal share status.
 *
 * The ledger distinguishes revoked from expired because the owner needs to know
 * which happened. The PUBLIC surface must not — see `PUBLIC_SHARE_GONE`.
 */
export function shareStatus(share: ServedShare, now: Date): ShareStatus {
  if (share.status === "revoked" || share.status === "expired" || share.status === "active") {
    return share.status;
  }
  if (share.revokedAt) return "revoked";
  const expiry = new Date(share.expiresAt).getTime();
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) return "expired";
  return "active";
}

export function toShareRow(share: ServedShare, now: Date): ShareRow {
  const status = shareStatus(share, now);
  return {
    ...share,
    status,
    statusText:
      status === "revoked"
        ? "Revoked"
        : status === "expired"
          ? "Expired"
          : `Active until ${share.expiresAt}`,
  };
}

/**
 * The one thing a public visitor is told.
 *
 * Expired, revoked and never-existed are externally indistinguishable on
 * purpose: distinguishing them confirms to an outsider holding a dead link that
 * the link was once real and that this workspace issued it.
 */
export const PUBLIC_SHARE_GONE =
  "This link is not available. It may have expired, been withdrawn, or never existed.";

/** A rotated share invalidates the token it replaced. */
export function rotationInvalidates(input: {
  oldToken: string;
  newToken: string;
}): { invalidated: string; issued: string } {
  return { invalidated: input.oldToken, issued: input.newToken };
}
