// Child of ephemeral-postgres-migrations-check: proves that a Decision Center
// structure card's "Apply" carries a key the preflight can actually resolve.
//
// The defect this exists for: the ceremony sent `rec.id` as the decision key.
// A served recommendation id is a display identity — `structure-7`, `bid-c1`,
// `optimization-as-1` — and `parseDecisionKey` refuses every one of them, so
// EVERY card-level Apply returned 422 `decision_not_actionable` regardless of
// data. That looked like a data gap and was not one.
//
// Every claim in the chain below is a claim about SQL or about a stored JSON
// blob: `proposedAction` survives the read path only through the `evidence`
// column, and the preflight's single-target resolution is a property of the
// dimension rows. A mocked reader proves neither, so this runs the shipped
// readers against a genuinely migrated throwaway database.
//
// DATABASE_URL is pre-set by the parent to the ephemeral server.
import { getDb } from "@/lib/db";
import { readLatestMetaDecisionSnapshot } from "@/lib/meta/snapshot";
import { annotateMetaRecPresentation } from "@/lib/meta/rec-presentation";
import { toDecisionRow } from "@/lib/zero-base/meta/decisions-presentation";
import { GRAIN_SOURCE, parseDecisionKey } from "@/lib/zero-base/meta/decision-bound-target";
import { readMetaDecisionsWorkspaceReadModel } from "@/lib/meta/decisions-workspace-read-model";

const LABEL = "decision-card-apply-seam";

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

/*
 * A real UUID, not a readable slug.
 *
 * `business_id` is TEXT in the warehouse dimension tables, so a slug reads
 * fine there — but the native decision-generation read casts it to `uuid`, and
 * a slug makes that query fail on its own syntax. The read model then comes
 * back `snapshot_unavailable` for the wrong reason, and the assertion below
 * would be proving a malformed id rather than an absent creative decision
 * source.
 */
const BUSINESS = "3f6b1c2e-7d40-4a1b-9f55-0c8e2a7b41d9";
const ACCOUNT = "act_card_apply";
const CAMPAIGN = "camp-card-1";
const ADSET = "adset-card-1";
const SNAPSHOT_DATE = "2026-09-01";
const WINDOW = { startDate: "2026-08-25", endDate: "2026-09-01" };

/**
 * The exact query the preflight route runs, so this seam grades the shipped
 * SQL rather than a paraphrase of it.
 */
async function resolveTarget(grain: "campaign" | "adset" | "ad", entityId: string) {
  const source = GRAIN_SOURCE[grain];
  return (await getDb().query(
    `
      SELECT ${source.idColumn} AS entity_id,
             provider_account_id,
             ${source.statusColumn} AS status,
             COUNT(*) OVER ()::text AS match_count
      FROM ${source.table}
      WHERE business_id = $1
        AND ${source.idColumn} = $2
      ORDER BY updated_at DESC
      LIMIT 2
    `,
    [BUSINESS, entityId],
  )) as unknown as Array<{
    entity_id: string;
    provider_account_id: string;
    status: string | null;
    match_count: string;
  }>;
}

/**
 * The stored blob a real snapshot write leaves behind.
 *
 * `hydrateRecommendation` re-hydrates `{recommendation: …}` out of `evidence`
 * and the non-stored branch sets no `proposedAction` at all, so a fixture that
 * fills the columns but omits this blob produces a card with no Apply — which
 * reads on the surface as a UI defect rather than as a missing write.
 */
function storedEvidenceBlob() {
  return {
    recommendation: {
      id: `structure-${ADSET}`,
      level: "adset",
      campaignId: CAMPAIGN,
      adsetId: ADSET,
      campaignName: "Prospecting — Broad",
      adsetName: "Broad 25-54",
      type: "pause_underperformer",
      lens: "performance",
      priority: "high",
      confidence: "high",
      decisionState: "act",
      decision: "Pause — 7-day ROAS 0.6 against a 2.0 target",
      title: "Broad 25-54",
      why: "Seven-day ROAS is well below target with sufficient spend.",
      summary: "Seven-day ROAS is well below target with sufficient spend.",
      recommendedAction: "Pause this ad set.",
      expectedImpact: "Stops spend that is not returning.",
      evidence: [],
      proposedAction: { kind: "pause" },
      timeframeContext: {
        coreVerdict: "Pause",
        selectedRangeOverlay: "",
        historicalSupport: "",
        seasonalityFlag: "none",
        note: null,
      },
    },
  };
}

/*
 * Seeded loudly: no `ON CONFLICT DO NOTHING`.
 *
 * `meta_decision_snapshots_daily`'s primary key does not include
 * `business_id`, so a swallowed conflict here would leave ANOTHER tenant's row
 * in place and every assertion below would then be grading it. A seam that
 * silently seeds nothing is a seam that proves nothing.
 */
async function seed() {
  const sql = getDb();
  await sql.query(
    `INSERT INTO meta_campaign_dimensions
       (business_id, provider_account_id, campaign_id, campaign_status)
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [BUSINESS, ACCOUNT, CAMPAIGN],
  );
  await sql.query(
    `INSERT INTO meta_adset_dimensions
       (business_id, provider_account_id, campaign_id, adset_id, adset_status)
     VALUES ($1, $2, $3, $4, 'ACTIVE')`,
    [BUSINESS, ACCOUNT, CAMPAIGN, ADSET],
  );
  await sql.query(
    `INSERT INTO meta_decision_snapshots_daily
       (scope_type, scope_id, business_id, provider_account_id, snapshot_date,
        rec_id, rec_type, level, kind, decision_state, confidence_score,
        evidence, recommended_action, expected_impact, reasoning, engine_version)
     VALUES ('adset', $1, $2, $3, $4::date,
             $5, 'pause_underperformer', 'adset', 'recommendation', 'act', 0.82,
             $6::jsonb, 'Pause this ad set.', 'Stops spend that is not returning.',
             'Seven-day ROAS is well below target with sufficient spend.', 'seam-v1')`,
    [ADSET, BUSINESS, ACCOUNT, SNAPSHOT_DATE, `structure-${ADSET}`, JSON.stringify(storedEvidenceBlob())],
  );
}

async function main() {
  await seed();

  // ----------------------------------------- the shape the surface used to send
  // Pinned here as well as in the route's own test, because this is the shape
  // the Decision Center actually produces for a structure card.
  for (const displayId of [
    `structure-${ADSET}`,
    "bid-c1",
    "optimization-as-1",
    "volume-c1",
    "profit-c1",
  ]) {
    expectEqual(parseDecisionKey(displayId), null, `a display id is not a decision key: ${displayId}`);
  }

  // --------------------------------------------------------- the read path
  const snapshot = await readLatestMetaDecisionSnapshot({
    businessId: BUSINESS,
    startDate: WINDOW.startDate,
    endDate: WINDOW.endDate,
  });
  expectTrue(snapshot !== null, "the seeded snapshot is returned by the shipped reader");
  expectEqual(snapshot!.recommendations.length, 1, "exactly the seeded recommendation is served");

  const served = snapshot!.recommendations[0]!;
  expectEqual(served.id, `structure-${ADSET}`, "the served id is the row's rec_id");
  expectEqual(served.adsetId, ADSET, "the ad-set identity survived hydration");
  // The single most load-bearing hydration claim: without the stored blob the
  // non-stored branch sets no proposedAction, and the card would carry no Apply.
  expectEqual(served.proposedAction, { kind: "pause" }, "proposedAction is restored from evidence");

  // ------------------------------------------------- the server's own verb
  const annotated = annotateMetaRecPresentation([served])[0]!;
  expectEqual(
    annotated.operatorApply,
    { action: "pause", grain: "adset", entityId: ADSET },
    "serverOperatorApplyForRec stamps the verb, grain and proven entity id",
  );

  // ------------------------------------------------------- the derived key
  const row = toDecisionRow(annotated);
  expectEqual(row.id, `structure-${ADSET}`, "the display id is still the display id");
  expectEqual(row.decisionKey, `adset:${ADSET}`, "the decision key comes from the grain identity");
  expectEqual(
    parseDecisionKey(row.decisionKey!),
    { grain: "adset", entityId: ADSET },
    "and the route can parse what the panel now sends",
  );

  // -------------------------------------------- the preflight's own lookup
  const resolved = await resolveTarget("adset", ADSET);
  expectEqual(resolved.length, 1, "the derived key resolves to exactly one warehouse row");
  expectEqual(resolved[0]!.match_count, "1", "and reports itself unambiguous");
  expectEqual(
    resolved[0]!.provider_account_id,
    ACCOUNT,
    "the account comes from the stored row, never from the caller",
  );
  expectEqual(resolved[0]!.status, "ACTIVE", "the expected state is read, never sent");

  // ---------------------------------------- the read model is not a precondition
  // No engine_v3_* rows are seeded at all. The creative decision source being
  // unavailable must NOT withdraw the structure card's Apply: they are
  // different sources, and conflating them is what made this look like a
  // fixture problem instead of a key-derivation defect.
  const readModel = await readMetaDecisionsWorkspaceReadModel({
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    asOfDate: SNAPSHOT_DATE,
  });
  expectEqual(readModel.status, "unavailable", "with no engine_v3 rows the read model is unavailable");
  expectEqual(readModel.unavailable?.code, "snapshot_unavailable", "and says so by its own code");
  expectEqual(
    annotated.operatorApply,
    { action: "pause", grain: "adset", entityId: ADSET },
    "while the structure card still carries its Apply",
  );

  // ------------------------------------------------------------- ambiguity
  // A second account holding the same ad-set id in ONE business. Resolving to
  // the newest would be a guess, and the guess would be a provider write.
  await getDb().query(
    `INSERT INTO meta_adset_dimensions
       (business_id, provider_account_id, campaign_id, adset_id, adset_status)
     VALUES ($1, 'act_second', $2, $3, 'PAUSED')`,
    [BUSINESS, CAMPAIGN, ADSET],
  );
  const ambiguous = await resolveTarget("adset", ADSET);
  expectTrue(
    Number(ambiguous[0]!.match_count) > 1,
    "two rows for one identity are reported as more than one match",
    `match_count was ${ambiguous[0]!.match_count}`,
  );

  console.log(
    `[${LABEL}] PASS: a structure recommendation's proposedAction survives the read path only ` +
      "through the stored evidence blob; the server stamps operatorApply from it; the decision " +
      "key is derived from the ad-set identity rather than from the display id (which the route " +
      "refuses); that key resolves to exactly one warehouse row with the account and status read " +
      "from storage; a second row for the same identity is reported ambiguous; and the card keeps " +
      "its Apply while the native read model is snapshot_unavailable.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
