/**
 * Server-side keyset pagination for the Agency directory.
 *
 * This replaces an earlier implementation that read every authorized business
 * and sliced it in the browser. That was client pagination behind an unbounded
 * server read: it shipped the whole client list to the page, and it grew
 * linearly with the number of clients no matter what the UI drew.
 *
 * The order is a genuine total order — `lower(btrim(name))` then `id` — and
 * both the ORDER BY and the cursor comparison are pinned to the `C` collation
 * so the sequence is byte-deterministic and identical on every database,
 * locale and platform. Without a fixed collation the same rows can order
 * differently between the query that produced a cursor and the query that
 * consumes it, which is exactly how keyset pagination silently skips or
 * repeats rows.
 *
 * Scope is re-derived from the caller's own memberships on every page, inside
 * the SQL. That is what makes a tampered cursor harmless: it can only move the
 * position within the actor's own authorized set, never widen it.
 *
 * No `server-only` guard: nothing else in this repo uses one, and it cannot be
 * resolved by the plain-tsx seam scripts that prove this module against real
 * PostgreSQL. `getDb` keeps it server-side in practice.
 */
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { isReviewerEmail } from "@/lib/reviewer-access";
import { DEMO_BUSINESS_ID } from "@/lib/demo-business";
import { readAgencyTodayTotals } from "@/lib/agency-today-store";
import type { AgencyClientRow } from "@/lib/zero-base/agency-projection";

export const AGENCY_SERVER_PAGE_SIZE = 25;
export const AGENCY_MAX_PAGE_SIZE = 100;

export interface AgencyDirectoryCursor {
  /** The `lower(btrim(name))` value SQL produced for the last served row. */
  sortKey: string;
  businessId: string;
}

export interface AgencyDirectoryServerPage {
  items: AgencyClientRow[];
  servedCount: number;
  /** Only computed on the first page; carried by the client thereafter. */
  totalCount: number | null;
  nextCursor: string | null;
  truncated: boolean;
  disclosure: string | null;
}

/**
 * Opaque to the client and validated on the way back in.
 *
 * It is not signed, and does not need to be: every page re-derives scope from
 * the session, so the worst a forged cursor can do is start the caller's own
 * list at a different place. What it must not do is crash the handler or smuggle
 * a value into SQL, so the shape is checked and the parts are bound as
 * parameters.
 */
export function encodeAgencyCursor(cursor: AgencyDirectoryCursor): string {
  return Buffer.from(JSON.stringify({ k: cursor.sortKey, i: cursor.businessId }), "utf8")
    .toString("base64url");
}

export function decodeAgencyCursor(raw: string | null | undefined): AgencyDirectoryCursor | null {
  if (!raw) return null;
  // Bound the input before decoding: an oversized cursor is not a cursor.
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const { k, i } = parsed as { k?: unknown; i?: unknown };
    if (typeof k !== "string" || typeof i !== "string") return null;
    if (k.length > 256 || i.length > 128 || i.length === 0) return null;
    return { sortKey: k, businessId: i };
  } catch {
    return null;
  }
}

/** Thrown for a cursor that is present but unusable, so the route can 400. */
export class InvalidAgencyCursorError extends Error {
  constructor() {
    super("Invalid directory cursor.");
    this.name = "InvalidAgencyCursorError";
  }
}

interface DirectoryRow {
  id: string;
  name: string;
  currency: string | null;
  role: string;
  status: "active" | "invited" | "pending";
  sort_key: string;
}

interface MetaDirectoryFactRow {
  business_id: string;
  connection_status: string | null;
  selected_account_count: string;
}

function clampPageSize(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested)) return AGENCY_SERVER_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(requested), 1), AGENCY_MAX_PAGE_SIZE);
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * How many clients this actor has, without materialising them.
 *
 * The Agency gate only needs to know whether there are at least two. Reading
 * every membership to count it is the same unbounded-read mistake the
 * directory itself used to make, just smaller — it simply was not visible
 * because the result was thrown away.
 */
export async function countAgencyClients(input: {
  userId: string;
  email: string;
}): Promise<number> {
  const readiness = await getDbSchemaReadiness({
    tables: ["memberships", "businesses"],
  }).catch(() => null);
  if (!readiness?.ready) return 0;

  const reviewerOnly = isReviewerEmail(input.email);
  const rows = (await getDb().query<{ total: string }>(
    `
      SELECT count(*)::text AS total
      FROM memberships m
      JOIN businesses b ON b.id = m.business_id
      WHERE m.user_id = $1::uuid
        AND m.status = 'active'
        AND ($2::boolean IS FALSE OR b.id::text = $3::text)
    `,
    [input.userId, reviewerOnly, DEMO_BUSINESS_ID],
  )) as Array<{ total: string }>;
  return Number(rows[0]?.total ?? 0);
}

export async function readAgencyDirectoryPage(input: {
  userId: string;
  email: string;
  /** Raw cursor from the request; `null` for the first page. */
  cursor?: string | null;
  pageSize?: number;
  /** Skips the COUNT when the client already has the total. */
  withTotal?: boolean;
  now?: Date;
}): Promise<AgencyDirectoryServerPage> {
  const pageSize = clampPageSize(input.pageSize);
  const now = input.now ?? new Date();

  const cursor = input.cursor ? decodeAgencyCursor(input.cursor) : null;
  if (input.cursor && !cursor) throw new InvalidAgencyCursorError();

  const readiness = await getDbSchemaReadiness({
    tables: ["memberships", "businesses"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return {
      items: [],
      servedCount: 0,
      totalCount: 0,
      nextCursor: null,
      truncated: false,
      disclosure: null,
    };
  }

  // A reviewer sees only the demo business, enforced in SQL rather than by
  // filtering afterwards — a post-filter would page over rows the reviewer is
  // not allowed to see and return short pages as a side effect.
  const reviewerOnly = isReviewerEmail(input.email);
  const sql = getDb();

  // One row over the page size: the extra row proves there is a next page
  // without a second query, and is never returned.
  const rows = (await sql.query<DirectoryRow>(
    `
      SELECT
        b.id::text            AS id,
        b.name                AS name,
        b.currency            AS currency,
        m.role                AS role,
        m.status              AS status,
        lower(btrim(b.name))  AS sort_key
      FROM memberships m
      JOIN businesses b ON b.id = m.business_id
      WHERE m.user_id = $1::uuid
        AND m.status = 'active'
        AND ($2::boolean IS FALSE OR b.id::text = $3::text)
        AND (
          $4::text IS NULL
          OR lower(btrim(b.name)) COLLATE "C" > $4::text COLLATE "C"
          OR (
            lower(btrim(b.name)) COLLATE "C" = $4::text COLLATE "C"
            AND b.id::text COLLATE "C" > $5::text COLLATE "C"
          )
        )
      ORDER BY lower(btrim(b.name)) COLLATE "C" ASC, b.id::text COLLATE "C" ASC
      LIMIT $6::int
    `,
    [
      input.userId,
      reviewerOnly,
      DEMO_BUSINESS_ID,
      cursor?.sortKey ?? null,
      cursor?.businessId ?? null,
      pageSize + 1,
    ],
  )) as DirectoryRow[];

  const hasMore = rows.length > pageSize;
  const served = hasMore ? rows.slice(0, pageSize) : rows;

  // Activity is batched for the served ids only. The previous version passed
  // every authorized id, which grew with the tenant rather than the page.
  const totals =
    served.length > 0
      ? await readAgencyTodayTotals({
          businessIds: served.map((row) => row.id),
          startDate: isoDate(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000)),
          endDate: isoDate(now),
        }).catch(() => new Map())
      : new Map();

  // Meta readiness is also read in one bounded batch for the served page. It
  // remains separate from the membership query so a partially migrated
  // provider catalog cannot hide otherwise-authorized clients.
  const metaFacts = new Map<string, MetaDirectoryFactRow>();
  if (served.length > 0) {
    const facts = (await sql.query<MetaDirectoryFactRow>(
      `
        SELECT
          scoped.business_id::text AS business_id,
          connection.status AS connection_status,
          count(binding.id) FILTER (WHERE binding.is_selected)::text AS selected_account_count
        FROM unnest($1::uuid[]) AS scoped(business_id)
        LEFT JOIN provider_connections connection
          ON connection.business_id = scoped.business_id
         AND connection.provider = 'meta'
        LEFT JOIN business_provider_accounts binding
          ON binding.business_id = scoped.business_id
         AND binding.provider = 'meta'
        GROUP BY scoped.business_id, connection.status
      `,
      [served.map((row) => row.id)],
    ).catch(() => [])) as MetaDirectoryFactRow[];
    for (const fact of facts) metaFacts.set(fact.business_id, fact);
  }

  const items: AgencyClientRow[] = served.map((row) => ({
    businessId: row.id,
    name: row.name,
    role: row.role,
    membershipStatus: row.status,
    metaConnectionStatus:
      metaFacts.get(row.id)?.connection_status === "connected" ? "connected" : "not_connected",
    selectedMetaAccountCount: Number(metaFacts.get(row.id)?.selected_account_count ?? 0),
    configuredCurrency: row.currency ?? null,
    sourceUpdatedAt: totals.get(row.id)?.lastSourceUpdatedAt ?? null,
    href: `/c/${row.id}/home`,
  }));

  let totalCount: number | null = null;
  if (input.withTotal) {
    const countRows = (await sql.query<{ total: string }>(
      `
        SELECT count(*)::text AS total
        FROM memberships m
        JOIN businesses b ON b.id = m.business_id
        WHERE m.user_id = $1::uuid
          AND m.status = 'active'
          AND ($2::boolean IS FALSE OR b.id::text = $3::text)
      `,
      [input.userId, reviewerOnly, DEMO_BUSINESS_ID],
    )) as Array<{ total: string }>;
    totalCount = Number(countRows[0]?.total ?? 0);
  }

  const last = served[served.length - 1];
  const nextCursor =
    hasMore && last ? encodeAgencyCursor({ sortKey: last.sort_key, businessId: last.id }) : null;

  return {
    items,
    servedCount: items.length,
    totalCount,
    nextCursor,
    truncated: hasMore,
    disclosure:
      hasMore && totalCount !== null
        ? `Showing ${items.length} of ${totalCount} clients.`
        : hasMore
          ? `Showing ${items.length} clients. More are available.`
          : null,
  };
}
