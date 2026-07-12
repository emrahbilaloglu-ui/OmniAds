// Child of ephemeral-postgres-migrations-check: exercises the Creative Brief
// store against the freshly migrated throwaway database. DATABASE_URL is
// force-set by the parent and never points at the production tunnel.
import { getDb, resetDbClientCache } from "@/lib/db";
import { parseCreateMetaCreativeBriefRequest } from "@/lib/meta/creative-brief-contract";
import {
  MetaCreativeBriefIdempotencyConflictError,
  MetaCreativeBriefSourceNotFoundError,
  MetaCreativeBriefVersionConflictError,
  createMetaCreativeBrief,
  listMetaCreativeBriefs,
  patchMetaCreativeBrief,
  readMetaCreativeBrief,
} from "@/lib/meta/creative-brief-store";

function expectEqual(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `creative-brief seam FAILED [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function expectRejects(
  action: () => Promise<unknown>,
  errorType: new (...args: never[]) => Error,
  label: string,
) {
  try {
    await action();
  } catch (error) {
    if (error instanceof errorType) return;
    throw new Error(
      `creative-brief seam FAILED [${label}]: unexpected ${error instanceof Error ? error.name : String(error)}`,
    );
  }
  throw new Error(`creative-brief seam FAILED [${label}]: expected rejection`);
}

async function seedFixture() {
  const db = getDb();
  const users = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash)
     VALUES ('Creative Brief Seam', 'creative-brief-seam@example.test', 'x')
     RETURNING id::text AS id`,
  );
  const businesses = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, owner_id)
     VALUES ('Creative Brief Seam Business', $1::uuid)
     RETURNING id::text AS id`,
    [users[0]!.id],
  );
  const businessId = businesses[0]!.id;
  const userId = users[0]!.id;
  const providerAccountId = "act_creative_brief_seam";

  await db.query(
    `INSERT INTO meta_creative_dimensions (
       business_id, provider_account_id, creative_id, creative_name
     ) VALUES ($1, $2, 'creative_brief_seam_1', 'Brief source creative')`,
    [businessId, providerAccountId],
  );
  const snapshots = await db.query<{ id: string }>(
    `INSERT INTO engine_v3_decision_snapshots_daily (
       business_ref_id,
       business_id,
       creative_id,
       as_of_date,
       engine_version,
       scope_type,
       scope_id,
       label,
       raw_label,
       confidence,
       truth_source,
       effective_target_roas,
       ratio_to_target,
       badges,
       reason
     ) VALUES (
       $1::uuid,
       $1,
       'creative_brief_seam_1',
       '2026-07-10'::date,
       'v3-creative-brief-seam',
       'account',
       '*',
       'refresh',
       'refresh',
       76,
       'commercial_truth',
       2.5,
       0.91,
       '[{"type":"fatigue_composite","label":"Fatigue","severity":"warning"}]'::jsonb,
       'Composite fatigue evidence'
     ) RETURNING id::text AS id`,
    [businessId],
  );
  return {
    businessId,
    userId,
    providerAccountId,
    snapshotId: snapshots[0]!.id,
  };
}

async function main() {
  if (process.env.DATABASE_URL?.includes("15432")) {
    throw new Error("creative-brief seam refused: DATABASE_URL points at the prod tunnel");
  }
  const fixture = await seedFixture();
  const request = parseCreateMetaCreativeBriefRequest({
    businessId: fixture.businessId,
    providerAccountId: fixture.providerAccountId,
    idempotencyKey: "creative-brief-seam-create-1",
    sourceDecision: {
      snapshotId: fixture.snapshotId,
      trigger: "Fatigued former winner",
    },
    content: {
      keep: "Keep the product proof",
      change: "Change the opening hook",
      next: "Produce three vertical variants",
    },
  });

  const created = await createMetaCreativeBrief({
    request,
    createdBy: fixture.userId,
  });
  expectEqual(created.created, true, "first create");
  expectEqual(created.brief.sourceDecision.rawLabel, "refresh", "raw label frozen");
  expectEqual(
    created.brief.sourceDecision.badges.map((badge) => badge.type),
    ["fatigue_composite"],
    "source badges frozen",
  );

  const replay = await createMetaCreativeBrief({
    request,
    createdBy: fixture.userId,
  });
  expectEqual(replay.created, false, "idempotent replay");
  expectEqual(replay.brief.id, created.brief.id, "idempotent singleton");

  await expectRejects(
    () =>
      createMetaCreativeBrief({
        request: {
          ...request,
          content: { ...request.content, next: "Different payload" },
        },
        createdBy: fixture.userId,
      }),
    MetaCreativeBriefIdempotencyConflictError,
    "idempotency mismatch",
  );
  await expectRejects(
    () =>
      createMetaCreativeBrief({
        request: { ...request, providerAccountId: "act_other" },
        createdBy: fixture.userId,
      }),
    MetaCreativeBriefSourceNotFoundError,
    "cross-account source rejection",
  );

  const reviewed = await patchMetaCreativeBrief({
    businessId: fixture.businessId,
    providerAccountId: fixture.providerAccountId,
    id: created.brief.id,
    patch: { expectedVersion: 1, content: {}, status: "reviewed" },
    updatedBy: fixture.userId,
  });
  expectEqual(reviewed.status, "reviewed", "reviewed status");
  expectEqual(Boolean(reviewed.reviewedAt), true, "review timestamp");

  const edited = await patchMetaCreativeBrief({
    businessId: fixture.businessId,
    providerAccountId: fixture.providerAccountId,
    id: created.brief.id,
    patch: {
      expectedVersion: 2,
      content: { change: "Use a stronger first-frame contrast" },
    },
    updatedBy: fixture.userId,
  });
  expectEqual(edited.status, "draft", "review invalidated by content edit");
  expectEqual(edited.reviewedAt, null, "review timestamp cleared on edit");
  expectEqual(edited.version, 3, "optimistic version increment");

  await expectRejects(
    () =>
      patchMetaCreativeBrief({
        businessId: fixture.businessId,
        providerAccountId: fixture.providerAccountId,
        id: created.brief.id,
        patch: { expectedVersion: 2, content: {}, status: "reviewed" },
        updatedBy: fixture.userId,
      }),
    MetaCreativeBriefVersionConflictError,
    "stale optimistic version",
  );

  expectEqual(
    (await listMetaCreativeBriefs({
      businessId: fixture.businessId,
      providerAccountId: fixture.providerAccountId,
    })).map((brief) => brief.id),
    [created.brief.id],
    "account-scoped list",
  );
  expectEqual(
    await readMetaCreativeBrief({
      businessId: fixture.businessId,
      providerAccountId: "act_other",
      id: created.brief.id,
    }),
    null,
    "account-scoped detail",
  );

  console.log(
    "[creative-brief-seam] PASS: source verification, frozen lineage, idempotency, account isolation, review lifecycle, optimistic concurrency.",
  );
  await resetDbClientCache();
}

main().catch(async (error) => {
  console.error(error);
  try {
    resetDbClientCache();
  } catch {
    // Best-effort cleanup after the original seam failure.
  }
  process.exitCode = 1;
});
