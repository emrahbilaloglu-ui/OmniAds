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

export interface ServedBrief {
  id: string;
  title: string;
  createdAt: string;
  /** What this brief was derived from. Missing lineage is disclosed, not hidden. */
  sourceCreativeId?: string | null;
  sourceAccountId?: string | null;
  status?: string | null;
}

export interface BriefRow {
  id: string;
  title: string;
  createdAt: string;
  status: string;
  lineage: { known: true; creativeId: string; accountId: string } | { known: false; reason: string };
}

export function toBriefRow(brief: ServedBrief): BriefRow {
  const creativeId = brief.sourceCreativeId?.trim();
  const accountId = brief.sourceAccountId?.trim();
  return {
    id: brief.id,
    title: brief.title,
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

/**
 * Whether a brief may be created from this source.
 *
 * Lineage-safe: a brief is only created when the creative and account it comes
 * from are both known. Creating one without them produces a document nobody can
 * trace back, which is worse than not creating it.
 */
export function canCreateBrief(input: {
  creativeId: string | null;
  accountId: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.creativeId?.trim() || !input.accountId?.trim()) {
    return {
      ok: false,
      reason:
        "A brief can only be created from a creative whose identity and account are both known.",
    };
  }
  return { ok: true };
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
  audience: "buyer" | "creator";
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
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
