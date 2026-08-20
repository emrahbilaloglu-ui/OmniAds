import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";

/**
 * Mint / consume / single-use / account scoping against a REAL PostgreSQL.
 *
 * These are claims about SQL, not about shapes. The single-use guarantee is one
 * conditional UPDATE; the account scoping is a WHERE clause; "a handoff row
 * appears in the account's own draft list" is a join between what this module
 * writes and what `lib/launchpad/meta-store.ts` reads. A mocked `sql` would
 * return whatever it was told and prove none of it.
 *
 * HOW IT RUNS. `scripts/ephemeral-postgres-launchpad-handoff-seam.ts` boots a
 * throwaway cluster on a random free port (never 5432, never 15432), migrates
 * it from zero with the repo's real deploy entry point, points `DATABASE_URL`
 * at it and sets `ADSECUTE_EPHEMERAL_DB_SEAM=1`. That script is wired into
 * `scripts/verify-database-seams.sh`, which CI invokes, so this file runs in
 * normal acceptance instead of skipping.
 *
 * Outside that harness every test below SKIPS rather than silently running
 * against whatever `DATABASE_URL` happens to be — which, in this working copy,
 * is production over an SSH tunnel. A skip is not a pass, and the harness is
 * what turns it into one.
 *
 * `META_HANDOFF_TEST_DATABASE_URL` is still honoured for a hand-pointed run.
 */

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const TEST_DATABASE_URL = process.env.META_HANDOFF_TEST_DATABASE_URL;
const BIZ_A = "11111111-1111-4111-8111-111111111111";
const BIZ_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";

if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

// The prod tunnel is refused outright even if something set the seam flag by
// hand. This file writes rows.
if ((SEAM || TEST_DATABASE_URL) && process.env.DATABASE_URL?.includes("15432")) {
  throw new Error(
    "launchpad handoff DB seam refused: DATABASE_URL points at the production tunnel",
  );
}

const suite = SEAM || TEST_DATABASE_URL ? describe : describe.skip;

function decision(
  overrides: Record<string, unknown> = {},
): MetaCanonicalDecision {
  return {
    decisionId: "dec_1",
    episodeId: "ep_1",
    sourceSnapshotId: "snap_1",
    providerAccountId: "act_1",
    identityGrain: "ad",
    sourceAuthority: {
      status: "native_exact",
      actionEligible: true,
      reviewOnlyReason: null,
      snapshotId: "snap_1",
      evaluationId: "eval_1",
      inputHash: "input_hash",
      decisionHash: "decision_hash",
      providerAccountRefId: "ref_1",
      engineVersion: "engine-v3",
      realAdId: "ad_1",
      authorizedAction: "refresh",
      jobRunId: "job_1",
    },
    sourceDecision: { snapshotAsOf: "2026-08-17" },
    parentChain: {
      campaign: { id: "camp_1" },
      adset: { id: "adset_1" },
      ad: { id: "ad_1" },
      creative: { id: "cre_1" },
    },
    deliveryScope: {
      state: "active",
      campaignStatus: "ACTIVE",
      adsetStatus: "ACTIVE",
      adStatus: "ACTIVE",
      reason: "active_hierarchy",
    },
    classification: {
      decisionState: "act",
      heldAction: null,
      blockers: [],
      lifecycleRole: { value: "main" },
    },
    ...overrides,
  } as unknown as MetaCanonicalDecision;
}

function copyCandidate(overrides: Record<string, unknown> = {}) {
  return {
    copyId: "copy:cre_1",
    providerAccountId: "act_1",
    assetType: "primary_text",
    sourceText: "The line that is running",
    alternates: ["The line that is running", "The other line Meta served"],
    campaignIds: ["camp_1"],
    adIds: ["ad_1", "ad_2"],
    creativeIds: ["cre_1"],
    ...overrides,
  };
}

const COPY_WINDOW = { startDate: "2026-07-19", endDate: "2026-08-17" };

suite("meta launchpad handoff persistence", () => {
  let mintLaunchpadHandoff: typeof import("@/lib/meta/launchpad-handoff").mintLaunchpadHandoff;
  let mintLaunchpadCopyHandoff: typeof import("@/lib/meta/launchpad-handoff").mintLaunchpadCopyHandoff;
  let consumeLaunchpadHandoff: typeof import("@/lib/meta/launchpad-handoff").consumeLaunchpadHandoff;
  let readConsumedLaunchpadHandoff: typeof import("@/lib/meta/launchpad-handoff").readConsumedLaunchpadHandoff;
  let listMetaLaunchDrafts: typeof import("@/lib/launchpad/meta-store").listMetaLaunchDrafts;
  let getDb: typeof import("@/lib/db").getDb;
  let closeDb: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    const handoff = await import("@/lib/meta/launchpad-handoff");
    const store = await import("@/lib/launchpad/meta-store");
    const db = await import("@/lib/db");
    mintLaunchpadHandoff = handoff.mintLaunchpadHandoff;
    mintLaunchpadCopyHandoff = handoff.mintLaunchpadCopyHandoff;
    consumeLaunchpadHandoff = handoff.consumeLaunchpadHandoff;
    readConsumedLaunchpadHandoff = handoff.readConsumedLaunchpadHandoff;
    listMetaLaunchDrafts = store.listMetaLaunchDrafts;
    getDb = db.getDb;
    closeDb =
      "closeDb" in db && typeof db.closeDb === "function"
        ? (db.closeDb as () => Promise<void>)
        : null;
    const sql = getDb();
    // `meta_launch_drafts.business_id` has a real FK, so the two businesses
    // this file writes under have to exist. Seeded idempotently rather than in
    // a one-shot `beforeAll`, so the file works whether it is run alone or as
    // part of the seam script's whole sequence.
    await sql`
      INSERT INTO users (id, name, email, password_hash)
      VALUES
        (${USER_A}, 'Handoff Seam A', 'handoff-seam-a@example.test', 'x'),
        (${USER_B}, 'Handoff Seam B', 'handoff-seam-b@example.test', 'x')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO businesses (id, name, owner_id)
      VALUES
        (${BIZ_A}, 'Handoff Seam Business A', ${USER_A}),
        (${BIZ_B}, 'Handoff Seam Business B', ${USER_B})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`DELETE FROM meta_launch_drafts`;
  });

  afterAll(async () => {
    if (closeDb) await closeDb();
  });

  const baseInput = {
    businessId: BIZ_A,
    providerAccountId: "act_1",
    createdByUserId: USER_A,
  };

  /**
   * The defect this seam was added for.
   *
   * `meta_launch_drafts.provider_account_id` exists and every account-scoped
   * reader filters on it — `listMetaLaunchDrafts` is
   * `WHERE business_id = $1 AND provider_account_id = $2`. The mint used to
   * leave it NULL, so a handoff row was consumable by reference and appeared in
   * NO list at all. Asserted through the real reader rather than by reading the
   * column back, because "the column is populated" and "the account's draft
   * list contains it" are different claims and only the second one is the bug.
   */
  it("mints an account-scoped row the account's own draft list can see", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
    });
    if (!minted.ok) throw new Error("mint failed");

    const sql = getDb();
    const rows = (await sql`
      SELECT provider_account_id FROM meta_launch_drafts WHERE id = ${minted.handoffId}
    `) as Array<{ provider_account_id: string | null }>;
    expect(rows[0]!.provider_account_id).toBe("act_1");

    const mine = await listMetaLaunchDrafts({
      businessId: BIZ_A,
      providerAccountId: "act_1",
    });
    expect(mine.map((draft) => draft.id)).toContain(minted.handoffId);

    // And it is scoped: another assigned account in the same business must not
    // see it.
    const other = await listMetaLaunchDrafts({
      businessId: BIZ_A,
      providerAccountId: "act_other",
    });
    expect(other.map((draft) => draft.id)).not.toContain(minted.handoffId);
  });

  it("persists the selection and the frozen evidence window", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
    });
    if (!minted.ok) throw new Error("mint failed");

    const sql = getDb();
    const rows = (await sql`
      SELECT payload_json FROM meta_launch_drafts WHERE id = ${minted.handoffId}
    `) as Array<{ payload_json: any }>;
    const handoff = rows[0]!.payload_json.handoff;
    expect(handoff.origin).toBe("decision");
    expect(handoff.selection.creativeIds).toEqual(["cre_1"]);
    expect(handoff.selection.adIds).toEqual(["ad_1"]);
    // A Refresh rebuilds one creative; it does not target an existing campaign,
    // so no campaign or ad set is preselected for it.
    expect(handoff.selection.campaignIds).toEqual([]);
    expect(handoff.evidenceWindow).toEqual({
      basis: "decision_snapshot",
      startDate: null,
      endDate: null,
      snapshotAsOf: "2026-08-17",
      computedAt: null,
    });
  });

  // A Scale becomes `add_to_existing`, and the campaign and ad set it is
  // duplicating INTO are what make that workflow land on a target instead of an
  // empty list.
  it("preselects the campaign and ad set for a duplicate", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision({
        sourceAuthority: {
          status: "native_exact",
          actionEligible: true,
          reviewOnlyReason: null,
          snapshotId: "snap_1",
          evaluationId: "eval_1",
          inputHash: null,
          decisionHash: null,
          providerAccountRefId: null,
          engineVersion: "engine-v3",
          realAdId: "ad_1",
          authorizedAction: "scale",
          jobRunId: null,
        },
        classification: {
          ...(decision().classification as object),
          lifecycleRole: { value: "test" },
        },
      }),
    });
    if (!minted.ok) throw new Error("mint failed");
    expect(minted.envelope.mode).toBe("duplicate");
    expect(minted.envelope.selection.campaignIds).toEqual(["camp_1"]);
    expect(minted.envelope.selection.adsetIds).toEqual(["adset_1"]);
  });

  it("persists an envelope whose token is stored only as a digest", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const token = minted.reference.split(".")[1]!;
    const sql = getDb();
    const rows = (await sql`
      SELECT id, business_id, status, created_by, payload_json
      FROM meta_launch_drafts
      WHERE id = ${minted.handoffId}
    `) as Array<Record<string, any>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe("draft");
    expect(row.business_id).toBe(BIZ_A);
    expect(row.created_by).toBe(USER_A);
    expect(row.payload_json.kind).toBe("meta_launchpad_decision_handoff");
    expect(row.payload_json.handoff.handoffId).toBe(minted.handoffId);
    expect(row.payload_json.handoff.mode).toBe("rebuild");
    expect(row.payload_json.handoff.authorizedAction).toBe("refresh");
    expect(row.payload_json.handoff.consumedAt).toBeNull();
    expect(row.payload_json.handoff.lineage.sourceSnapshotId).toBe("snap_1");
    // The bearer token is never at rest. A database reader cannot replay a
    // handoff by copying a row.
    expect(JSON.stringify(row.payload_json)).not.toContain(token);
    expect(row.payload_json.handoff.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes no row when the decision does not authorize a handoff", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision({
        classification: {
          decisionState: "act",
          heldAction: "cut",
          blockers: [],
        },
      }),
    });
    expect(minted).toEqual({ ok: false, refusal: "decision_held" });
    const sql = getDb();
    const rows = (await sql`SELECT count(*)::int AS n FROM meta_launch_drafts`) as Array<{
      n: number;
    }>;
    expect(rows[0]!.n).toBe(0);
  });

  it("consumes once and refuses the second read", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
    });
    if (!minted.ok) throw new Error("mint failed");

    const first = await consumeLaunchpadHandoff({
      reference: minted.reference,
      businessId: BIZ_A,
      providerAccountId: "act_1",
      actorUserId: USER_A,
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.envelope.mode).toBe("rebuild");
      expect(first.envelope.consumedAt).toBeTruthy();
    }

    const second = await consumeLaunchpadHandoff({
      reference: minted.reference,
      businessId: BIZ_A,
      providerAccountId: "act_1",
      actorUserId: USER_A,
    });
    expect(second).toEqual({ ok: false, refusal: "already_consumed" });
  });

  // Single use has to survive a race, not just a sequence. Two concurrent
  // reads of the same reference must produce exactly one success: the
  // conditional UPDATE is the arbiter, and the loser is told it lost rather
  // than being handed a second copy of the same authority.
  it("lets exactly one of two concurrent consumers win", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
    });
    if (!minted.ok) throw new Error("mint failed");

    const context = {
      reference: minted.reference,
      businessId: BIZ_A,
      providerAccountId: "act_1",
      actorUserId: USER_A,
    };
    const results = await Promise.all([
      consumeLaunchpadHandoff(context),
      consumeLaunchpadHandoff(context),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.refusal === "already_consumed"),
    ).toHaveLength(1);
  });

  it("refuses a cross-business read and leaves the handoff unconsumed", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
    });
    if (!minted.ok) throw new Error("mint failed");

    const crossed = await consumeLaunchpadHandoff({
      reference: minted.reference,
      businessId: BIZ_B,
      providerAccountId: "act_1",
      actorUserId: USER_A,
    });
    expect(crossed).toEqual({ ok: false, refusal: "business_mismatch" });

    // A refusal must not burn the handoff, or a wrong-business probe would be
    // a denial-of-service against the operator who actually owns it.
    const owner = await consumeLaunchpadHandoff({
      reference: minted.reference,
      businessId: BIZ_A,
      providerAccountId: "act_1",
      actorUserId: USER_A,
    });
    expect(owner.ok).toBe(true);
  });

  it("refuses a cross-account read", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
    });
    if (!minted.ok) throw new Error("mint failed");
    expect(
      await consumeLaunchpadHandoff({
        reference: minted.reference,
        businessId: BIZ_A,
        providerAccountId: "act_other",
        actorUserId: USER_A,
      }),
    ).toEqual({ ok: false, refusal: "provider_account_mismatch" });
  });

  it("refuses a read with no resolved provider account at all", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
    });
    if (!minted.ok) throw new Error("mint failed");
    expect(
      await consumeLaunchpadHandoff({
        reference: minted.reference,
        businessId: BIZ_A,
        providerAccountId: null,
        actorUserId: USER_A,
      }),
    ).toEqual({ ok: false, refusal: "provider_account_mismatch" });
  });

  it("refuses a forwarded link opened by a different user", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
    });
    if (!minted.ok) throw new Error("mint failed");
    expect(
      await consumeLaunchpadHandoff({
        reference: minted.reference,
        businessId: BIZ_A,
        providerAccountId: "act_1",
        actorUserId: USER_B,
      }),
    ).toEqual({ ok: false, refusal: "actor_mismatch" });
  });

  it("refuses a tampered token even when the id is real", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
    });
    if (!minted.ok) throw new Error("mint failed");
    const [id, token] = minted.reference.split(".");
    const flipped = `${token!.slice(0, -1)}${token!.endsWith("A") ? "B" : "A"}`;
    expect(
      await consumeLaunchpadHandoff({
        reference: `${id}.${flipped}`,
        businessId: BIZ_A,
        providerAccountId: "act_1",
        actorUserId: USER_A,
      }),
    ).toEqual({ ok: false, refusal: "token_mismatch" });
  });

  it("refuses an expired handoff", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
      now: new Date("2026-08-17T10:00:00.000Z"),
    });
    if (!minted.ok) throw new Error("mint failed");
    expect(
      await consumeLaunchpadHandoff({
        reference: minted.reference,
        businessId: BIZ_A,
        providerAccountId: "act_1",
        actorUserId: USER_A,
        now: new Date("2026-08-17T10:20:00.000Z"),
      }),
    ).toEqual({ ok: false, refusal: "expired" });
  });

  it("refuses a handoff id that names no record", async () => {
    expect(
      await consumeLaunchpadHandoff({
        reference: `0f1e2d3c-4b5a-4c7d-8e9f-a0b1c2d3e4f5.${"a".repeat(43)}`,
        businessId: BIZ_A,
        providerAccountId: "act_1",
        actorUserId: USER_A,
      }),
    ).toEqual({ ok: false, refusal: "not_found" });
  });

  // A handoff is stored in the same table as ordinary launch drafts, so an
  // ordinary draft's id must never be readable as a handoff.
  it("refuses a plain launch draft row that is not a handoff", async () => {
    const sql = getDb();
    const rows = (await sql`
      INSERT INTO meta_launch_drafts (business_id, name, payload_json, status)
      VALUES (${BIZ_A}, 'ordinary draft', ${JSON.stringify({ adSets: [] })}::jsonb, 'draft')
      RETURNING id
    `) as Array<{ id: string }>;
    expect(
      await consumeLaunchpadHandoff({
        reference: `${rows[0]!.id}.${"a".repeat(43)}`,
        businessId: BIZ_A,
        providerAccountId: "act_1",
        actorUserId: USER_A,
      }),
    ).toEqual({ ok: false, refusal: "not_found" });
  });

  // ── The Copies -> Launchpad handoff ──────────────────────────────────────
  //
  // Same table, same token discipline, same single-use consume. What must be
  // different is the AUTHORITY, and these prove it is: a copy handoff carries
  // none, and a row that has been edited to claim some is refused.

  it("mints a copy handoff that carries no execution authority at all", async () => {
    const minted = await mintLaunchpadCopyHandoff({
      ...baseInput,
      candidate: copyCandidate(),
      requestedAlternateText: "The other line Meta served",
      window: COPY_WINDOW,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    expect(minted.envelope.origin).toBe("copy");
    expect(minted.envelope.mode).toBe("copy_draft");
    expect(minted.envelope.authorizedAction).toBeNull();
    expect(minted.envelope.actionEligible).toBe(false);
    expect(minted.envelope.exactAdExecutionEligible).toBe(false);
    expect(minted.envelope.sourceAuthorityStatus).toBe("warehouse_discovery");
    // No decision id is fabricated. A copies row is a warehouse aggregate and
    // the canonical contract classes it as discovery evidence only.
    expect(minted.envelope.lineage).toBeNull();
    expect(minted.envelope.copy).toEqual({
      copyId: "copy:cre_1",
      alternateId: "alt-2",
      alternateText: "The other line Meta served",
      sourceText: "The line that is running",
      assetType: "primary_text",
    });
    expect(minted.envelope.evidenceWindow).toEqual({
      basis: "requested_metrics_window",
      startDate: "2026-07-19",
      endDate: "2026-08-17",
      snapshotAsOf: null,
      computedAt: null,
    });
  });

  // The alternate is read out of the SERVED lines, never taken on the caller's
  // word. Without this the drawer would be a way to put arbitrary ad text into
  // a draft that claims Meta's own served lines as its source.
  it("refuses a line the server never served for that copy", async () => {
    const minted = await mintLaunchpadCopyHandoff({
      ...baseInput,
      candidate: copyCandidate(),
      requestedAlternateText: "Buy now, operator-invented urgency!",
      window: COPY_WINDOW,
    });
    expect(minted).toEqual({ ok: false, refusal: "copy_identity_missing" });
    const sql = getDb();
    const rows = (await sql`SELECT count(*)::int AS n FROM meta_launch_drafts`) as Array<{
      n: number;
    }>;
    expect(rows[0]!.n).toBe(0);
  });

  it("refuses a copy handoff whose window is not a real window", async () => {
    expect(
      await mintLaunchpadCopyHandoff({
        ...baseInput,
        candidate: copyCandidate(),
        requestedAlternateText: "The other line Meta served",
        window: { startDate: "2026-08-17", endDate: "2026-07-19" },
      }),
    ).toEqual({ ok: false, refusal: "lineage_incomplete" });
  });

  it("consumes a copy handoff exactly once", async () => {
    const minted = await mintLaunchpadCopyHandoff({
      ...baseInput,
      candidate: copyCandidate(),
      requestedAlternateText: "The other line Meta served",
      window: COPY_WINDOW,
    });
    if (!minted.ok) throw new Error("mint failed");

    const context = {
      reference: minted.reference,
      businessId: BIZ_A,
      providerAccountId: "act_1",
      actorUserId: USER_A,
    };
    const first = await consumeLaunchpadHandoff(context);
    expect(first.ok).toBe(true);
    expect(await consumeLaunchpadHandoff(context)).toEqual({
      ok: false,
      refusal: "already_consumed",
    });
  });

  /**
   * The escalation this origin exists to make impossible.
   *
   * `payload_json` is ordinary JSON in a shared table. If anything that can
   * write it flipped a copy envelope's four authority fields, the row would
   * describe a warehouse aggregate wearing a canonical decision's authority.
   * The read side re-checks the envelope against its OWN origin, so the edited
   * row is not one of ours at all.
   */
  it("refuses a copy row edited to claim decision authority", async () => {
    const minted = await mintLaunchpadCopyHandoff({
      ...baseInput,
      candidate: copyCandidate(),
      requestedAlternateText: "The other line Meta served",
      window: COPY_WINDOW,
    });
    if (!minted.ok) throw new Error("mint failed");

    const sql = getDb();
    await sql`
      UPDATE meta_launch_drafts
      SET payload_json = jsonb_set(
        jsonb_set(
          jsonb_set(payload_json, '{handoff,actionEligible}', 'true'::jsonb, true),
          '{handoff,sourceAuthorityStatus}', '"native_exact"'::jsonb, true
        ),
        '{handoff,authorizedAction}', '"scale"'::jsonb, true
      )
      WHERE id = ${minted.handoffId}
    `;

    expect(
      await consumeLaunchpadHandoff({
        reference: minted.reference,
        businessId: BIZ_A,
        providerAccountId: "act_1",
        actorUserId: USER_A,
      }),
    ).toEqual({ ok: false, refusal: "not_found" });
  });

  // ── The prefill re-read (hop 2) ──────────────────────────────────────────

  it("re-reads a consumed handoff for the same actor, business and account", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
    });
    if (!minted.ok) throw new Error("mint failed");
    await consumeLaunchpadHandoff({
      reference: minted.reference,
      businessId: BIZ_A,
      providerAccountId: "act_1",
      actorUserId: USER_A,
    });

    const read = await readConsumedLaunchpadHandoff({
      handoffId: minted.handoffId,
      businessId: BIZ_A,
      providerAccountId: "act_1",
      actorUserId: USER_A,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.envelope.selection.creativeIds).toEqual(["cre_1"]);
  });

  /**
   * The re-read is not a second door.
   *
   * An UNCONSUMED handoff must not be readable by id: if it were, the id alone
   * would open a handoff and the bearer token would be decorative.
   */
  it("refuses to read a handoff that has not been consumed", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
    });
    if (!minted.ok) throw new Error("mint failed");

    expect(
      await readConsumedLaunchpadHandoff({
        handoffId: minted.handoffId,
        businessId: BIZ_A,
        providerAccountId: "act_1",
        actorUserId: USER_A,
      }),
    ).toEqual({ ok: false, refusal: "not_found" });
  });

  it.each([
    ["a different business", { businessId: BIZ_B }, "not_found"],
    ["a different account", { providerAccountId: "act_other" }, "not_found"],
    ["a different user", { actorUserId: USER_B }, "actor_mismatch"],
  ])(
    "refuses the prefill re-read from %s",
    async (_label, overrides, refusal) => {
      const minted = await mintLaunchpadHandoff({
        ...baseInput,
        decision: decision(),
      });
      if (!minted.ok) throw new Error("mint failed");
      await consumeLaunchpadHandoff({
        reference: minted.reference,
        businessId: BIZ_A,
        providerAccountId: "act_1",
        actorUserId: USER_A,
      });

      expect(
        await readConsumedLaunchpadHandoff({
          handoffId: minted.handoffId,
          businessId: BIZ_A,
          providerAccountId: "act_1",
          actorUserId: USER_A,
          ...overrides,
        }),
      ).toEqual({ ok: false, refusal });
    },
  );

  // Bounded, because a prefill that never expires is a durable capability
  // nobody asked for.
  it("refuses the prefill re-read once the consumption is old", async () => {
    const minted = await mintLaunchpadHandoff({
      ...baseInput,
      decision: decision(),
      now: new Date("2026-08-17T10:00:00.000Z"),
    });
    if (!minted.ok) throw new Error("mint failed");
    await consumeLaunchpadHandoff({
      reference: minted.reference,
      businessId: BIZ_A,
      providerAccountId: "act_1",
      actorUserId: USER_A,
      now: new Date("2026-08-17T10:01:00.000Z"),
    });

    expect(
      await readConsumedLaunchpadHandoff({
        handoffId: minted.handoffId,
        businessId: BIZ_A,
        providerAccountId: "act_1",
        actorUserId: USER_A,
        now: new Date("2026-08-17T10:45:00.000Z"),
      }),
    ).toEqual({ ok: false, refusal: "prefill_expired" });
  });
});
