// Child of ephemeral-postgres-migrations-check: exercises the launchpad
// meta-store SQL seam against the freshly-migrated ephemeral database.
// DATABASE_URL is pre-set by the parent to the ephemeral server (never the
// prod tunnel).
//
// The launchpad route contract tests mock lib/launchpad/meta-store, so until
// this seam existed the store's actual SQL (business isolation, source and
// status filters, upsert scoping, payload normalization round-trips, the
// recent-templates lateral join) had no coverage anywhere.
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  createManualMetaLaunchTemplate,
  deleteManualMetaLaunchTemplate,
  deleteMetaLaunchDraft,
  listManualMetaLaunchTemplates,
  listMetaLaunchDrafts,
  listRecentMetaLaunchTemplates,
  upsertMetaLaunchDraft,
} from "@/lib/launchpad/meta-store";
import {
  normalizeMetaAddToExistingPayload,
  normalizeMetaLaunchPayload,
} from "@/lib/launchpad/meta";

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`meta-store seam FAILED [${label}]: expected ${e}, got ${a}`);
  }
}

function expectTrue(value: unknown, label: string) {
  if (!value) throw new Error(`meta-store seam FAILED [${label}]`);
}

async function insertBusinessFixture(suffix: string): Promise<string> {
  // meta_launch_* tables FK to businesses(id), and businesses.owner_id FKs
  // to users(id) - unlike the engine seam, bare UUIDs are not enough.
  const db = getDb();
  const users = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash)
     VALUES ('Seam User', $1, 'x') RETURNING id`,
    [`seam-user-${suffix}@example.test`],
  );
  const businesses = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, owner_id)
     VALUES ($1, $2) RETURNING id`,
    [`Seam Business ${suffix}`, users[0]!.id],
  );
  return businesses[0]!.id;
}

async function checkTemplates(bizA: string, bizB: string) {
  const db = getDb();
  const rawPayload = {
    currencyCode: "try",
    campaign: { name: "Seam Campaign", objective: "OUTCOME_TRAFFIC" },
    budget: { mode: "CBO", amountMinor: 5000 },
    creativeIds: ["cr_1"],
    adSets: [{ name: "AdSet 1" }],
  };

  const created = await createManualMetaLaunchTemplate({
    businessId: bizA,
    name: "Seam Template",
    description: "seam",
    payload: rawPayload,
  });
  // Write normalizes: stored payload must equal the normalizer's output
  // (objective forced to OUTCOME_SALES, currency uppercased, defaults filled),
  // not the raw input.
  expectEqual(
    created.payload,
    normalizeMetaLaunchPayload(rawPayload),
    "template payload normalization round-trip",
  );

  const listedA = await listManualMetaLaunchTemplates({ businessId: bizA });
  expectEqual(listedA.map((t) => t.id), [created.id], "template list for owner business");
  const listedB = await listManualMetaLaunchTemplates({ businessId: bizB });
  expectEqual(listedB.length, 0, "template business isolation on list");

  // source='manual' filter: an auto_recent row must never surface in the
  // manual list nor be deletable through the manual delete.
  const autoRows = await db.query<{ id: string }>(
    `INSERT INTO meta_launch_templates (business_id, name, payload_json, source)
     VALUES ($1, 'Auto Recent', '{}'::jsonb, 'auto_recent') RETURNING id`,
    [bizA],
  );
  const listedAfterAuto = await listManualMetaLaunchTemplates({ businessId: bizA });
  expectEqual(
    listedAfterAuto.map((t) => t.id),
    [created.id],
    "manual list excludes source=auto_recent",
  );
  expectEqual(
    await deleteManualMetaLaunchTemplate({ businessId: bizA, id: autoRows[0]!.id }),
    false,
    "manual delete refuses auto_recent rows",
  );

  expectEqual(
    await deleteManualMetaLaunchTemplate({ businessId: bizB, id: created.id }),
    false,
    "template business isolation on delete",
  );
  expectEqual(
    await deleteManualMetaLaunchTemplate({ businessId: bizA, id: created.id }),
    true,
    "template delete within business",
  );
  expectEqual(
    await deleteManualMetaLaunchTemplate({ businessId: bizA, id: created.id }),
    false,
    "template double delete",
  );
  console.log("[meta-store-seam] PASS: template CRUD, source filter, business isolation.");
}

async function checkDrafts(bizA: string, bizB: string) {
  const db = getDb();

  const first = await upsertMetaLaunchDraft({
    businessId: bizA,
    name: "Draft One",
    payload: { campaign: { name: "One" } },
  });
  expectEqual(first.status, "draft", "insert creates status=draft");

  // add_to_existing payloads dispatch through the other normalizer.
  const addToExistingRaw = {
    mode: "add_to_existing",
    targetCampaignId: "cmp_1",
    targetAdsetId: "adset_1",
    copyMode: "reuse_creative",
    creativeIds: ["cr_9"],
  };
  const second = await upsertMetaLaunchDraft({
    businessId: bizA,
    name: "Draft Two",
    payload: addToExistingRaw,
  });
  expectEqual(
    second.payload,
    normalizeMetaAddToExistingPayload(addToExistingRaw),
    "add_to_existing payload normalization round-trip",
  );

  // Update path: rename + payload swap resets status to draft and bumps
  // updated_at, so the updated draft must lead the DESC ordering.
  await db.query(`UPDATE meta_launch_drafts SET status = 'failed' WHERE id = $1`, [first.id]);
  const updated = await upsertMetaLaunchDraft({
    businessId: bizA,
    id: first.id,
    name: "Draft One v2",
    payload: { campaign: { name: "One v2" } },
  });
  expectEqual(updated.id, first.id, "upsert-with-id updates in place");
  expectEqual(updated.name, "Draft One v2", "upsert-with-id renames");
  expectEqual(updated.status, "draft", "upsert-with-id resets failed back to draft");

  const listed = await listMetaLaunchDrafts({ businessId: bizA });
  expectEqual(
    listed.map((d) => d.id),
    [first.id, second.id],
    "draft list ordered by updated_at DESC",
  );

  // status IN ('draft','failed') filter.
  await db.query(`UPDATE meta_launch_drafts SET status = 'launched' WHERE id = $1`, [second.id]);
  expectEqual(
    (await listMetaLaunchDrafts({ businessId: bizA })).map((d) => d.id),
    [first.id],
    "launched drafts excluded from list",
  );
  await db.query(`UPDATE meta_launch_drafts SET status = 'failed' WHERE id = $1`, [second.id]);
  expectEqual(
    (await listMetaLaunchDrafts({ businessId: bizA })).map((d) => d.id).sort(),
    [first.id, second.id].sort(),
    "failed drafts included in list",
  );

  // Cross-business upsert with a foreign id must throw, not insert.
  let crossThrew = false;
  try {
    await upsertMetaLaunchDraft({
      businessId: bizB,
      id: first.id,
      name: "Hijack",
      payload: {},
    });
  } catch {
    crossThrew = true;
  }
  expectTrue(crossThrew, "cross-business upsert-with-id throws");

  expectEqual(
    await deleteMetaLaunchDraft({ businessId: bizB, id: first.id }),
    false,
    "draft business isolation on delete",
  );
  expectEqual(
    await deleteMetaLaunchDraft({ businessId: bizA, id: first.id }),
    true,
    "draft delete within business",
  );
  console.log(
    "[meta-store-seam] PASS: draft upsert scoping, status filter, ordering, business isolation.",
  );
}

async function checkRecentTemplates(bizA: string) {
  const db = getDb();
  const account = "act_seam";
  const seedCampaign = async (input: {
    campaignId: string;
    updatedAt: string;
    configs: Array<{ objective: string; capturedAt: string; dailyBudget?: number | null }>;
  }) => {
    await db.query(
      `INSERT INTO meta_campaign_dimensions
         (business_id, provider_account_id, campaign_id, campaign_name_current, updated_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)`,
      [bizA, account, input.campaignId, `Name ${input.campaignId}`, input.updatedAt],
    );
    for (const config of input.configs) {
      await db.query(
        `INSERT INTO meta_campaign_config_history
           (business_id, provider_account_id, campaign_id, config_fingerprint,
            objective, daily_budget, captured_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
        [
          bizA,
          account,
          input.campaignId,
          `fp-${input.campaignId}-${config.capturedAt}`,
          config.objective,
          config.dailyBudget ?? 50,
          config.capturedAt,
        ],
      );
    }
  };

  // Six sales campaigns (top-5 cut by dim.updated_at), one traffic-only
  // campaign, and one whose LATEST config flipped away from sales.
  for (let index = 1; index <= 6; index += 1) {
    await seedCampaign({
      campaignId: `cmp_sales_${index}`,
      updatedAt: `2026-07-0${index} 00:00:00+00`,
      configs: [{ objective: "OUTCOME_SALES", capturedAt: "2026-07-01 00:00:00+00" }],
    });
  }
  await seedCampaign({
    campaignId: "cmp_traffic",
    updatedAt: "2026-07-07 00:00:00+00",
    configs: [{ objective: "OUTCOME_TRAFFIC", capturedAt: "2026-07-01 00:00:00+00" }],
  });
  await seedCampaign({
    campaignId: "cmp_flipped",
    updatedAt: "2026-07-07 00:00:00+00",
    configs: [
      { objective: "OUTCOME_SALES", capturedAt: "2026-07-01 00:00:00+00" },
      { objective: "OUTCOME_TRAFFIC", capturedAt: "2026-07-02 00:00:00+00" },
    ],
  });
  // Ad-set counts for the newest sales campaign.
  for (let index = 1; index <= 3; index += 1) {
    await db.query(
      `INSERT INTO meta_adset_dimensions (business_id, provider_account_id, campaign_id, adset_id)
       VALUES ($1, $2, 'cmp_sales_6', $3)`,
      [bizA, account, `adset_${index}`],
    );
  }

  const recents = await listRecentMetaLaunchTemplates({ businessId: bizA });
  expectEqual(
    recents.map((t) => t.id),
    ["cmp_sales_6", "cmp_sales_5", "cmp_sales_4", "cmp_sales_3", "cmp_sales_2"],
    "recent templates: top-5 sales campaigns by updated_at, latest-config objective filter",
  );
  expectEqual(recents[0]!.payload.adSets.length, 3, "recent templates: adset count from dimensions");
  expectEqual(recents[1]!.payload.adSets.length, 1, "recent templates: default single adset");
  expectEqual(recents[0]!.payload.budget.mode, "CBO", "recent templates: CBO from daily budget");
  expectEqual(recents[0]!.source, "auto_recent", "recent templates: source label");
  console.log("[meta-store-seam] PASS: recent-templates lateral join, top-5, objective filter.");
}

async function main() {
  if (process.env.DATABASE_URL?.includes("15432")) {
    throw new Error("meta-store seam refused: DATABASE_URL points at the prod tunnel");
  }
  const bizA = await insertBusinessFixture("a");
  const bizB = await insertBusinessFixture("b");
  await checkTemplates(bizA, bizB);
  await checkDrafts(bizA, bizB);
  await checkRecentTemplates(bizA);
  await resetDbClientCache();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
