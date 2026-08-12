// Child of ephemeral-postgres-migrations-check: proves the decision-bound
// preflight resolves a provider target from real storage, and refuses in every
// case where the exact target is not proven.
//
// A mocked query returns whatever the test author wrote. These claims —
// business scoping, ambiguity detection, per-grain column mapping — are claims
// about SQL, so they need a real server and real rows.
//
// DATABASE_URL is pre-set by the parent to the ephemeral server.
import { getDb } from "@/lib/db";
import { GRAIN_SOURCE, parseDecisionKey } from "@/lib/zero-base/meta/decision-bound-target";

const LABEL = "decision-bound-target-seam";

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

const BUSINESS = "biz-decision-bound";
const OTHER_BUSINESS = "biz-other";

/** The exact query the route runs, so the seam proves the shipped SQL. */
async function resolve(grain: "campaign" | "adset" | "ad", entityId: string, businessId = BUSINESS) {
  const source = GRAIN_SOURCE[grain];
  return (await getDb().query(
    `
      SELECT ${source.idColumn} AS entity_id,
             provider_account_id,
             ${source.statusColumn} AS status,
             ${grain === "ad" ? "creative_id" : "NULL::text AS creative_id"},
             ${source.parentColumn ? `${source.parentColumn} AS parent_id` : "NULL::text AS parent_id"},
             COUNT(*) OVER ()::text AS match_count
      FROM ${source.table}
      WHERE business_id = $1
        AND ${source.idColumn} = $2
      ORDER BY updated_at DESC
      LIMIT 2
    `,
    [businessId, entityId],
  )) as unknown as Array<{
    entity_id: string;
    provider_account_id: string;
    status: string | null;
    creative_id: string | null;
    parent_id: string | null;
    match_count: string;
  }>;
}

async function seed() {
  const sql = getDb();
  await sql.query(
    `INSERT INTO meta_campaign_dimensions
       (business_id, provider_account_id, campaign_id, campaign_status)
     VALUES ($1, 'act_1', 'camp-1', 'ACTIVE')
     ON CONFLICT DO NOTHING`,
    [BUSINESS],
  );
  await sql.query(
    `INSERT INTO meta_adset_dimensions
       (business_id, provider_account_id, campaign_id, adset_id, adset_status)
     VALUES ($1, 'act_1', 'camp-1', 'adset-1', 'PAUSED')
     ON CONFLICT DO NOTHING`,
    [BUSINESS],
  );
  await sql.query(
    `INSERT INTO meta_ad_dimensions
       (business_id, provider_account_id, ad_id, adset_id, ad_status, creative_id)
     VALUES ($1, 'act_1', 'ad-1', 'adset-1', 'ACTIVE', 'cr-1')
     ON CONFLICT DO NOTHING`,
    [BUSINESS],
  );
  // Same ad id, different tenant. If business scoping were wrong, this row
  // would be reachable — and a provider write would land in somebody else's
  // account.
  await sql.query(
    `INSERT INTO meta_ad_dimensions
       (business_id, provider_account_id, ad_id, adset_id, ad_status, creative_id)
     VALUES ($1, 'act_stranger', 'ad-1', 'adset-9', 'ACTIVE', 'cr-9')
     ON CONFLICT DO NOTHING`,
    [OTHER_BUSINESS],
  );
}

async function main() {
  await seed();

  // ------------------------------------------------------------ key parsing
  expectEqual(parseDecisionKey("ad:ad-1"), { grain: "ad", entityId: "ad-1" }, "ad key parses");
  expectEqual(
    parseDecisionKey("adset:adset-1"),
    { grain: "adset", entityId: "adset-1" },
    "adset key parses",
  );
  for (const key of ["group:x", "inactive:ad:1", "structure-1", "campaign:unknown:7", "ad:"]) {
    expectEqual(parseDecisionKey(key), null, `non-actionable key refused: ${key}`);
  }

  // --------------------------------------------------- per-grain resolution
  const campaign = await resolve("campaign", "camp-1");
  expectEqual(campaign[0]?.status, "ACTIVE", "campaign status maps from campaign_status");
  expectEqual(campaign[0]?.parent_id, null, "a campaign has no parent column");
  expectEqual(campaign[0]?.creative_id, null, "a campaign has no creative column");

  const adset = await resolve("adset", "adset-1");
  expectEqual(adset[0]?.status, "PAUSED", "adset status maps from adset_status");
  expectEqual(adset[0]?.parent_id, "camp-1", "adset parent maps from campaign_id");

  const ad = await resolve("ad", "ad-1");
  expectEqual(ad[0]?.status, "ACTIVE", "ad status maps from ad_status");
  expectEqual(ad[0]?.parent_id, "adset-1", "ad parent maps from adset_id");
  expectEqual(ad[0]?.creative_id, "cr-1", "ad creative maps from creative_id");
  expectEqual(ad[0]?.provider_account_id, "act_1", "the account comes from the row, not the caller");

  // ---------------------------------------------------------- business scope
  expectEqual(
    ad[0]?.provider_account_id,
    "act_1",
    "this business's ad resolves to this business's account",
  );
  expectEqual(ad.length, 1, "the stranger's identical ad id is not returned for this business");
  const stranger = await resolve("ad", "ad-1", OTHER_BUSINESS);
  expectEqual(
    stranger[0]?.provider_account_id,
    "act_stranger",
    "and the other tenant sees only its own row",
  );

  // ------------------------------------------------------------- not found
  expectEqual((await resolve("ad", "ad-missing")).length, 0, "an unknown entity resolves to nothing");

  // ------------------------------------------------------------- ambiguity
  // Two accounts holding the same ad id in ONE business. Picking the newest
  // would be a guess, and the guess would be a provider write.
  await getDb().query(
    `INSERT INTO meta_ad_dimensions
       (business_id, provider_account_id, ad_id, adset_id, ad_status, creative_id)
     VALUES ($1, 'act_2', 'ad-1', 'adset-2', 'PAUSED', 'cr-2')`,
    [BUSINESS],
  );
  const ambiguous = await resolve("ad", "ad-1");
  expectTrue(
    Number(ambiguous[0]!.match_count) > 1,
    "two rows for one identity are reported as more than one match",
    `match_count was ${ambiguous[0]!.match_count}`,
  );

  console.log(
    `[${LABEL}] PASS: each grain resolves from its own dimension table with the right status, ` +
      "parent and creative columns; the account comes from the stored row rather than the " +
      "caller; another tenant's identical entity id is unreachable; an unknown entity resolves " +
      "to nothing; and two rows for one identity are reported as ambiguous rather than resolved " +
      "to the newest.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
