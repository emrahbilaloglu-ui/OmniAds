// Child of ephemeral-postgres-migrations-check: proves the Agency directory's
// server pagination against real storage.
//
// This is the seam an in-memory test cannot cover. Keyset pagination is only
// correct if the ORDER BY that produced a cursor and the comparison that
// consumes it agree exactly — including collation, tie-breaking and the
// treatment of duplicate and accented names. A mocked database would prove the
// mock. Only real PostgreSQL proves that 121 clients page through without a
// gap, a repeat or a reorder.
//
// DATABASE_URL is pre-set by the parent to the ephemeral server.
import { getDb } from "@/lib/db";
import {
  AGENCY_MAX_PAGE_SIZE,
  countAgencyClients,
  decodeAgencyCursor,
  encodeAgencyCursor,
  InvalidAgencyCursorError,
  readAgencyDirectoryPage,
} from "@/lib/zero-base/agency-directory-store";
import { findForbiddenAgencyKeys, AGENCY_ROW_KEYS } from "@/lib/zero-base/agency-projection";
import { SHOPIFY_REVIEWER_EMAIL } from "@/lib/reviewer-access";
import { DEMO_BUSINESS_ID } from "@/lib/demo-business";

const LABEL = "agency-directory-seam";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

function expectTrue(value: boolean, label: string, detail?: string) {
  if (!value) fail(label, detail);
}

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "a0000000-0000-4000-8000-000000000002";
const REVIEWER_USER_ID = "a0000000-0000-4000-8000-000000000003";
const EMAIL = "agency@example.com";

function businessUuid(index: number): string {
  return `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** 121 clients: more than one page at any sane page size, per the requirement. */
const CLIENT_COUNT = 121;

async function seed() {
  const sql = getDb();

  for (const [id, email] of [
    [USER_ID, EMAIL],
    [OTHER_USER_ID, "other@example.com"],
    [REVIEWER_USER_ID, SHOPIFY_REVIEWER_EMAIL],
  ] as const) {
    await sql.query(
      `INSERT INTO users (id, email, name, password_hash)
       VALUES ($1::uuid, $2, 'Seed', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [id, email],
    );
  }

  // Names chosen to stress the order: duplicates that can only be separated by
  // the id tie-break, accented forms, and mixed case with padding.
  const names: string[] = [];
  for (let index = 0; index < CLIENT_COUNT - 6; index += 1) {
    names.push(`Client ${String(index).padStart(3, "0")}`);
  }
  names.push("Duplicate Name", "Duplicate Name", "Duplicate Name");
  names.push("Ácme", "acme", "  Zebra  ");

  for (const [index, name] of names.entries()) {
    const id = businessUuid(index);
    await sql.query(
      `INSERT INTO businesses (id, name, owner_id, currency, timezone)
       VALUES ($1::uuid, $2, $3::uuid, 'USD', 'UTC')
       ON CONFLICT (id) DO NOTHING`,
      [id, name, USER_ID],
    );
    await sql.query(
      `INSERT INTO memberships (user_id, business_id, role, status)
       VALUES ($1::uuid, $2::uuid, 'admin', 'active')
       ON CONFLICT (user_id, business_id) DO NOTHING`,
      [USER_ID, id],
    );
  }

  // Memberships that must never be served: not active, and another tenant's.
  for (const [offset, status] of [
    [0, "invited"],
    [1, "pending"],
  ] as const) {
    const id = businessUuid(900 + offset);
    await sql.query(
      `INSERT INTO businesses (id, name, owner_id, currency, timezone)
       VALUES ($1::uuid, $2, $3::uuid, 'USD', 'UTC') ON CONFLICT (id) DO NOTHING`,
      [id, `Unaccepted ${status}`, USER_ID],
    );
    await sql.query(
      `INSERT INTO memberships (user_id, business_id, role, status)
       VALUES ($1::uuid, $2::uuid, 'admin', $3)
       ON CONFLICT (user_id, business_id) DO NOTHING`,
      [USER_ID, id, status],
    );
  }

  const foreign = businessUuid(950);
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, currency, timezone)
     VALUES ($1::uuid, 'AAA Another Tenant', $2::uuid, 'USD', 'UTC') ON CONFLICT (id) DO NOTHING`,
    [foreign, OTHER_USER_ID],
  );
  await sql.query(
    `INSERT INTO memberships (user_id, business_id, role, status)
     VALUES ($1::uuid, $2::uuid, 'admin', 'active')
     ON CONFLICT (user_id, business_id) DO NOTHING`,
    [OTHER_USER_ID, foreign],
  );

  // Reviewer: a member of both the demo business and a real one.
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, currency, timezone)
     VALUES ($1::uuid, 'Demo Business', $2::uuid, 'USD', 'UTC') ON CONFLICT (id) DO NOTHING`,
    [DEMO_BUSINESS_ID, REVIEWER_USER_ID],
  );
  for (const id of [DEMO_BUSINESS_ID, businessUuid(0)]) {
    await sql.query(
      `INSERT INTO memberships (user_id, business_id, role, status)
       VALUES ($1::uuid, $2::uuid, 'admin', 'active')
       ON CONFLICT (user_id, business_id) DO NOTHING`,
      [REVIEWER_USER_ID, id],
    );
  }
}

/** Walks every page, returning the ids in served order. */
async function scanAll(pageSize: number): Promise<{ ids: string[]; requests: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let requests = 0;

  for (let guard = 0; guard <= CLIENT_COUNT + 5; guard += 1) {
    const page = await readAgencyDirectoryPage({
      userId: USER_ID,
      email: EMAIL,
      cursor,
      pageSize,
      withTotal: cursor === null,
    });
    requests += 1;

    expectTrue(
      page.items.length <= pageSize,
      "page is bounded",
      `served ${page.items.length} with pageSize ${pageSize}`,
    );
    ids.push(...page.items.map((row) => row.businessId));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return { ids, requests };
}

async function main() {
  await seed();

  // ---------------------------------------------------- one bounded page
  const first = await readAgencyDirectoryPage({
    userId: USER_ID,
    email: EMAIL,
    pageSize: 25,
    withTotal: true,
  });
  expectEqual(first.items.length, 25, "first response is one bounded page");
  expectEqual(first.totalCount, CLIENT_COUNT, "total counts only active memberships");
  expectTrue(first.nextCursor !== null, "first page offers a cursor");
  expectTrue(first.truncated, "first page reports truncation");

  // ------------------------------------------------- stable, gap-free scan
  const scan = await scanAll(25);
  expectEqual(scan.ids.length, CLIENT_COUNT, "scan serves every client exactly once");
  expectEqual(new Set(scan.ids).size, CLIENT_COUNT, "scan contains no duplicate");
  expectTrue(scan.requests >= 5, "scan needed multiple server requests", `${scan.requests}`);

  // The same scan at a different page size must produce the identical order,
  // which is what "stable" means: paging cannot change the sequence.
  const scanSmall = await scanAll(7);
  expectEqual(scanSmall.ids, scan.ids, "order is identical across page sizes");

  const scanLarge = await scanAll(AGENCY_MAX_PAGE_SIZE);
  expectEqual(scanLarge.ids, scan.ids, "order is identical at the maximum page size");

  // ------------------------------------------- ordering, duplicates, accents
  const names = new Map<string, string>();
  for (const id of scan.ids) names.set(id, "");
  const nameRows = (await getDb().query(
    `SELECT id::text AS id, name FROM businesses WHERE id::text = ANY($1::text[])`,
    [scan.ids],
  )) as unknown as Array<{ id: string; name: string }>;
  for (const row of nameRows) names.set(row.id, row.name);

  const sortKeys = scan.ids.map((id) => (names.get(id) ?? "").trim().toLowerCase());
  for (let index = 1; index < sortKeys.length; index += 1) {
    const previous = sortKeys[index - 1];
    const current = sortKeys[index];
    if (previous > current) {
      fail("alphabetical order holds", `"${previous}" preceded "${current}" at index ${index}`);
    }
  }

  // Three identically-named rows must all appear, separated by the id
  // tie-break — an id-only or name-only cursor loses one of them.
  const duplicates = scan.ids.filter((id) => names.get(id) === "Duplicate Name");
  expectEqual(duplicates.length, 3, "all duplicate-named clients are served");
  const sortedDuplicates = [...duplicates].sort();
  expectEqual(duplicates, sortedDuplicates, "duplicate names are ordered by id");

  // Accent placement is a consequence of the fixed C collation and is pinned
  // rather than left implicit: "ácme" sorts after every ASCII name, and "Ácme"
  // and "acme" are therefore NOT adjacent. Deterministic and identical on
  // every database, which is what the cursor needs; a locale-aware collation
  // would fold them together but could reorder between two queries.
  const acmeIndex = scan.ids.findIndex((id) => names.get(id) === "acme");
  const accentedIndex = scan.ids.findIndex((id) => names.get(id) === "Ácme");
  const zebraIndex = scan.ids.findIndex((id) => names.get(id) === "  Zebra  ");
  expectTrue(acmeIndex >= 0 && accentedIndex >= 0 && zebraIndex >= 0, "accent fixtures are served");
  expectTrue(
    accentedIndex > zebraIndex && zebraIndex > acmeIndex,
    "C collation places accented names after every ASCII name",
    `acme=${acmeIndex} zebra=${zebraIndex} accented=${accentedIndex}`,
  );
  // Padding is normalised away by btrim, so "  Zebra  " sorts as "zebra".
  expectTrue(
    (names.get(scan.ids[zebraIndex]) ?? "").trim() === "Zebra",
    "surrounding whitespace does not affect placement",
  );

  // ------------------------------------------------------ scope enforcement
  expectTrue(
    !scan.ids.includes(businessUuid(900)) && !scan.ids.includes(businessUuid(901)),
    "invited and pending memberships are excluded",
  );
  expectTrue(!scan.ids.includes(businessUuid(950)), "another tenant's client is excluded");

  // A cursor from this actor cannot pull another tenant's rows in: scope is
  // re-derived per page inside the query.
  const foreignCursor = encodeAgencyCursor({ sortKey: "aaa another tenant", businessId: businessUuid(950) });
  const afterForeign = await readAgencyDirectoryPage({
    userId: USER_ID,
    email: EMAIL,
    cursor: foreignCursor,
    pageSize: CLIENT_COUNT,
  });
  expectTrue(
    !afterForeign.items.some((row) => row.businessId === businessUuid(950)),
    "a cursor naming another tenant cannot surface it",
  );

  // ------------------------------------------------------ reviewer scoping
  const reviewerPage = await readAgencyDirectoryPage({
    userId: REVIEWER_USER_ID,
    email: SHOPIFY_REVIEWER_EMAIL,
    pageSize: 50,
    withTotal: true,
  });
  expectEqual(
    reviewerPage.items.map((row) => row.businessId),
    [DEMO_BUSINESS_ID],
    "a reviewer sees only the demo business",
  );
  expectEqual(reviewerPage.totalCount, 1, "reviewer total is scoped too");

  // ------------------------------------------------------ bounded gate count
  // The Agency gate counts rather than materialising the list, so it must agree
  // with the paged scan exactly and apply the same scope filters.
  expectEqual(
    await countAgencyClients({ userId: USER_ID, email: EMAIL }),
    CLIENT_COUNT,
    "gate count matches the scanned total",
  );
  expectEqual(
    await countAgencyClients({ userId: REVIEWER_USER_ID, email: SHOPIFY_REVIEWER_EMAIL }),
    1,
    "gate count honours reviewer scoping",
  );
  expectEqual(
    await countAgencyClients({ userId: OTHER_USER_ID, email: "other@example.com" }),
    1,
    "gate count is per-actor, not global",
  );

  // ------------------------------------------------------- cursor validation
  for (const bad of ["not-base64!", "x".repeat(600), Buffer.from("{}").toString("base64url")]) {
    expectEqual(decodeAgencyCursor(bad), null, "malformed cursor is rejected");
  }
  let threw = false;
  try {
    await readAgencyDirectoryPage({ userId: USER_ID, email: EMAIL, cursor: "not-a-cursor" });
  } catch (error: unknown) {
    threw = error instanceof InvalidAgencyCursorError;
  }
  expectTrue(threw, "a malformed cursor fails closed rather than serving page one");

  // A well-formed cursor pointing past the end serves an empty final page
  // rather than wrapping around to the start.
  //
  // The key is U+FFFF rather than "zzzz": under the C collation a non-ASCII
  // first byte sorts ABOVE 'z', so "ácme" comes after "zzzzzzzz". A cursor
  // built on that assumption would not be past the end at all.
  const past = await readAgencyDirectoryPage({
    userId: USER_ID,
    email: EMAIL,
    cursor: encodeAgencyCursor({ sortKey: "\uffff", businessId: businessUuid(999) }),
    pageSize: 25,
  });
  expectEqual(past.items.length, 0, "a cursor past the end returns no rows");
  expectEqual(past.nextCursor, null, "a cursor past the end offers no next page");

  // -------------------------------------------------------- response shape
  expectEqual(
    Object.keys(first.items[0]!).sort(),
    [...AGENCY_ROW_KEYS].sort(),
    "row carries exactly the allowlisted keys",
  );
  expectEqual(findForbiddenAgencyKeys(first), [], "no forbidden key anywhere in the page");
  expectTrue(
    first.items.every(
      (row) =>
        row.href ===
        `/switch-business/${encodeURIComponent(row.businessId)}?next=${encodeURIComponent("/app/home")}`,
    ),
    "every row links to its own client",
  );

  console.log(
    `[${LABEL}] PASS: ${CLIENT_COUNT} clients page through in a stable total order at three page ` +
      "sizes with no gap, duplicate or reorder; duplicate and accented names are separated by the " +
      "id tie-break; invited/pending/other-tenant rows are excluded and a cursor cannot widen " +
      "scope; reviewer scoping holds; malformed cursors fail closed; and the served rows carry " +
      "only allowlisted keys; and the bounded gate count agrees with the scan.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
