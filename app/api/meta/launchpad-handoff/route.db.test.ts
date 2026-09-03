import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEMO_BUSINESS_ID } from "@/lib/demo-business-support";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import { SHOPIFY_REVIEWER_EMAIL } from "@/lib/reviewer-access";

/**
 * `POST /api/meta/launchpad-handoff` — the MINT endpoint, proven behaviourally.
 *
 * WHY THIS FILE EXISTS. The route had no test of any kind. Its reviewer
 * refusal, its provider-account assignment gate, its cross-business gate, its
 * mapping of an engine refusal onto a status code, and the exact shape of the
 * body it returns were all unproven — and this is the first move of a WRITE
 * workflow, so "unproven" there is not a documentation gap.
 *
 * WHY IT IS A DATABASE SEAM AND NOT A MOCKED ROUTE TEST. Almost every gate in
 * this route is a database fact:
 *
 *   - `requireBusinessAccess` is a session read joined to a membership row, so
 *     "a caller cannot mint into a business they are not a member of" is only
 *     shown by a real session for a real user with no real membership;
 *   - `getProviderAccountAssignments` is a join between
 *     `business_provider_accounts` and `provider_accounts` filtered on
 *     `is_selected`, so "an unassigned account is refused" is a WHERE clause;
 *   - a successful mint is an INSERT plus a `jsonb_set`, and the thing the
 *     caller is handed (`handoff`) is only usable if the row it names exists.
 *
 * A mocked `requireBusinessAccess` returns whatever it is told and proves none
 * of that: it would pass just as happily against a route that never checked.
 * So the session, the membership, the assignment and the persisted draft are
 * all real here, on a throwaway PostgreSQL migrated from zero.
 *
 * THE ONE MOCK, AND WHY IT IS THE RIGHT SEAM.
 * `readServedMetaDecision` is the upstream READ — the canonical decisions read
 * model plus one provider GET of the current active-ad inventory. Standing it
 * up would mean seeding the entire native-decision warehouse, and it is not
 * what this file is making a claim about. It is mocked, which also means
 * `@/lib/api/meta` is never imported by this test at all. Real provider
 * mutations performed by this file: ZERO. Real provider calls of any kind:
 * ZERO.
 *
 * What the mock is NOT allowed to do is decide the outcome. The decision it
 * returns is fed to the REAL `authorizeLaunchpadHandoff` and the REAL
 * `mintLaunchpadHandoff`, so every refusal asserted below is the engine's own
 * verdict travelling through the route, not a stubbed status code. The engine's
 * thresholds, decisions and authority rules are untouched by this file; it only
 * proves the route reports them.
 *
 * HOW IT RUNS. `scripts/ephemeral-postgres-launchpad-handoff-seam.ts` boots the
 * cluster (random free port, never 5432, never 15432), migrates from zero with
 * the repo's real deploy entry point, and runs this file with
 * `ADSECUTE_EPHEMERAL_DB_SEAM=1`. That script is wired into
 * `scripts/verify-database-seams.sh`, which `.github/workflows/ci.yml` invokes.
 *
 * Outside that harness every test below SKIPS rather than running against
 * whatever `DATABASE_URL` happens to be — in this working copy that is
 * PRODUCTION over an SSH tunnel, and this file writes rows. A skip is not a
 * pass; the harness is what turns it into one, and the harness asserts the skip
 * as its own negative control so the gate cannot be deleted to make a failure
 * go away.
 */

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const TEST_DATABASE_URL = process.env.META_HANDOFF_TEST_DATABASE_URL;

if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

// Refused outright even if something set the seam flag by hand.
if ((SEAM || TEST_DATABASE_URL) && process.env.DATABASE_URL?.includes("15432")) {
  throw new Error(
    "launchpad handoff route seam refused: DATABASE_URL points at the production tunnel",
  );
}

const suite = SEAM || TEST_DATABASE_URL ? describe : describe.skip;

const USER_OPERATOR = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
const USER_OUTSIDER = "6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b";
const USER_REVIEWER = "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c";
const USER_GUEST = "8d8d8d8d-8d8d-4d8d-8d8d-8d8d8d8d8d8d";
const BIZ_LIVE = "9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e";
const BIZ_OTHER = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const PROVIDER_REF_LIVE = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const PROVIDER_REF_DEMO = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const ACCOUNT_LIVE = "act_seam_live";
const ACCOUNT_DEMO = "act_seam_demo";

/**
 * The upstream read, and the ONLY thing stubbed in this file.
 *
 * It answers "which decision is the server currently serving under this id and
 * snapshot id". Everything the route then does with that answer — authorize,
 * mint, persist, respond — is real.
 */
const decisionSource = vi.hoisted(() => ({
  readServedMetaDecision: vi.fn(),
}));

vi.mock("@/lib/meta/launchpad-handoff-decision-source", () => ({
  readServedMetaDecision: decisionSource.readServedMetaDecision,
}));

/**
 * A decision that DOES authorize a handoff: native exact authority, action
 * eligible, an authorized `refresh`, decision state `act`, nothing held and no
 * blockers. Overrides below take exactly one of those away at a time.
 */
function decision(overrides: Record<string, unknown> = {}): MetaCanonicalDecision {
  return {
    decisionId: "dec_route_1",
    episodeId: "ep_route_1",
    sourceSnapshotId: "snap_route_1",
    providerAccountId: ACCOUNT_LIVE,
    identityGrain: "ad",
    sourceAuthority: {
      status: "native_exact",
      actionEligible: true,
      reviewOnlyReason: null,
      snapshotId: "snap_route_1",
      evaluationId: "eval_route_1",
      inputHash: "input_hash",
      decisionHash: "decision_hash",
      providerAccountRefId: PROVIDER_REF_LIVE,
      engineVersion: "engine-v3",
      realAdId: "ad_route_1",
      authorizedAction: "refresh",
      jobRunId: "job_route_1",
      executionReadiness: "live_preflight_required",
    },
    sourceDecision: { snapshotAsOf: "2026-08-17" },
    parentChain: {
      campaign: { id: "camp_route_1" },
      adset: { id: "adset_route_1" },
      ad: { id: "ad_route_1" },
      creative: { id: "cre_route_1" },
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

function authority(overrides: Record<string, unknown>) {
  const base = decision().sourceAuthority as unknown as Record<string, unknown>;
  return { sourceAuthority: { ...base, ...overrides } };
}

suite("POST /api/meta/launchpad-handoff", () => {
  let POST: typeof import("@/app/api/meta/launchpad-handoff/route").POST;
  let getDb: typeof import("@/lib/db").getDb;
  let closeDb: (() => Promise<void>) | null = null;
  const tokens = new Map<string, string>();

  function request(body: unknown, session: string | null) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const token = session ? tokens.get(session) : null;
    if (token) headers.cookie = `omniads_session=${token}`;
    return new NextRequest("https://example.test/api/meta/launchpad-handoff", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  const VALID_BODY = {
    businessId: BIZ_LIVE,
    providerAccountId: ACCOUNT_LIVE,
    decisionId: "dec_route_1",
    sourceSnapshotId: "snap_route_1",
  };

  async function draftCount(businessId: string) {
    const sql = getDb();
    const rows = (await sql`
      SELECT COUNT(*)::int AS count
      FROM meta_launch_drafts
      WHERE business_id = ${businessId}
    `) as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    decisionSource.readServedMetaDecision.mockResolvedValue({
      status: "found",
      decision: decision(),
    });

    const route = await import("@/app/api/meta/launchpad-handoff/route");
    const db = await import("@/lib/db");
    const auth = await import("@/lib/auth");
    POST = route.POST;
    getDb = db.getDb;
    closeDb =
      "closeDb" in db && typeof db.closeDb === "function"
        ? (db.closeDb as () => Promise<void>)
        : null;

    const sql = getDb();

    // Real people, real workspaces, real memberships. The reviewer is seeded
    // under the configured reviewer address, because `isReviewerEmail` compares
    // the SESSION's email — a fabricated flag would prove nothing.
    await sql`
      INSERT INTO users (id, name, email, password_hash)
      VALUES
        (${USER_OPERATOR}, 'Handoff Route Operator', 'handoff-route-op@example.test', 'x'),
        (${USER_OUTSIDER}, 'Handoff Route Outsider', 'handoff-route-out@example.test', 'x'),
        (${USER_GUEST}, 'Handoff Route Guest', 'handoff-route-guest@example.test', 'x'),
        (${USER_REVIEWER}, 'Handoff Route Reviewer', ${SHOPIFY_REVIEWER_EMAIL}, 'x')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO businesses (id, name, owner_id)
      VALUES
        (${BIZ_LIVE}, 'Handoff Route Live', ${USER_OPERATOR}),
        (${BIZ_OTHER}, 'Handoff Route Other', ${USER_OUTSIDER}),
        (${DEMO_BUSINESS_ID}, 'Handoff Route Demo', ${USER_REVIEWER})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO memberships (user_id, business_id, role, status)
      VALUES
        (${USER_OPERATOR}, ${BIZ_LIVE}, 'collaborator', 'active'),
        (${USER_OUTSIDER}, ${BIZ_OTHER}, 'collaborator', 'active'),
        (${USER_GUEST}, ${BIZ_LIVE}, 'guest', 'active'),
        (${USER_REVIEWER}, ${DEMO_BUSINESS_ID}, 'collaborator', 'active')
      ON CONFLICT (user_id, business_id) DO NOTHING
    `;

    // The assignment the route checks: a selected binding row joined to a
    // provider account. `is_selected` is written explicitly because the
    // post-cutover default is FALSE, and an unselected row is not an
    // assignment.
    await sql`
      INSERT INTO provider_accounts (id, provider, external_account_id, account_name)
      VALUES
        (${PROVIDER_REF_LIVE}, 'meta', ${ACCOUNT_LIVE}, 'Seam Live'),
        (${PROVIDER_REF_DEMO}, 'meta', ${ACCOUNT_DEMO}, 'Seam Demo')
      ON CONFLICT (provider, external_account_id) DO NOTHING
    `;
    await sql`
      INSERT INTO business_provider_accounts (
        business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected
      )
      VALUES
        (${BIZ_LIVE}, 'meta', ${PROVIDER_REF_LIVE}, ${ACCOUNT_LIVE}, 0, TRUE),
        (${DEMO_BUSINESS_ID}, 'meta', ${PROVIDER_REF_DEMO}, ${ACCOUNT_DEMO}, 0, TRUE)
      ON CONFLICT (business_id, provider, provider_account_ref_id) DO NOTHING
    `;

    // Only this file's own rows are cleared. Another seam file shares the
    // cluster and owns different businesses.
    await sql`
      DELETE FROM meta_launch_drafts
      WHERE business_id IN (${BIZ_LIVE}, ${BIZ_OTHER}, ${DEMO_BUSINESS_ID})
    `;

    if (tokens.size === 0) {
      for (const [name, userId] of [
        ["operator", USER_OPERATOR],
        ["outsider", USER_OUTSIDER],
        ["guest", USER_GUEST],
        ["reviewer", USER_REVIEWER],
      ] as const) {
        const created = await auth.createSession({ userId });
        tokens.set(name, created.token);
      }
    }
  });

  afterAll(async () => {
    if (closeDb) await closeDb();
  });

  // ── The success path ───────────────────────────────────────────────────

  /**
   * The whole chain in one assertion: a real session, a real membership, a real
   * assignment, the real engine authority check, a real INSERT, and a reference
   * that names the row that was actually written.
   */
  it("mints a handoff and persists the row the reference names", async () => {
    const response = await POST(request(VALID_BODY, "operator"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(typeof body.handoff).toBe("string");
    const [handoffId, token] = String(body.handoff).split(".");
    expect(handoffId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The token rides in the reference and is NEVER stored, so a database
    // reader cannot replay a handoff.
    expect(token).toBeTruthy();

    const sql = getDb();
    const rows = (await sql`
      SELECT business_id, provider_account_id, status, created_by, payload_json
      FROM meta_launch_drafts
      WHERE id = ${handoffId}
    `) as Array<{
      business_id: string;
      provider_account_id: string | null;
      status: string;
      created_by: string | null;
      payload_json: { kind: string; handoff: Record<string, unknown> };
    }>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.business_id).toBe(BIZ_LIVE);
    expect(row.provider_account_id).toBe(ACCOUNT_LIVE);
    expect(row.status).toBe("draft");
    // The creator is the SESSION's user, not anything the body said.
    expect(row.created_by).toBe(USER_OPERATOR);
    expect(row.payload_json.kind).toBe("meta_launchpad_decision_handoff");
    expect(row.payload_json.handoff.handoffId).toBe(handoffId);
    expect(row.payload_json.handoff.origin).toBe("decision");
    // Stored as a digest only.
    expect(row.payload_json.handoff.tokenHash).not.toBe(token);
    expect(String(row.payload_json.handoff.tokenHash)).not.toContain(token!);
  });

  /**
   * THE RESPONSE SHAPE, EXACTLY.
   *
   * Pinned as a whole key set rather than field by field, because the risk here
   * is an ADDED field: anything extra this route returns is something a client
   * may start treating as authority. The five below are the contract — one
   * reference, the wizard mode, the engine's own authorized action, the expiry,
   * and the eligibility flag that is echoed as EVIDENCE and never as permission.
   */
  it("returns exactly the documented response shape", async () => {
    const response = await POST(request(VALID_BODY, "operator"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      "authorizedAction",
      "exactAdExecutionEligible",
      "expiresAt",
      "handoff",
      "mode",
    ]);
    // `refresh` maps to `rebuild` and to nothing else. This is the engine's
    // action reported verbatim, not a re-derived one.
    expect(body.authorizedAction).toBe("refresh");
    expect(body.mode).toBe("rebuild");
    expect(typeof body.expiresAt).toBe("string");
    expect(Number.isFinite(Date.parse(String(body.expiresAt)))).toBe(true);
    expect(typeof body.exactAdExecutionEligible).toBe("boolean");
    // No token, no envelope, no lineage, no selection leaks into the response.
    expect(body).not.toHaveProperty("envelope");
    expect(body).not.toHaveProperty("tokenHash");
  });

  it("reports a scale as duplicate without inventing the mode", async () => {
    decisionSource.readServedMetaDecision.mockResolvedValue({
      status: "found",
      decision: decision({
        ...authority({ authorizedAction: "scale" }),
        classification: {
          ...(decision().classification as object),
          lifecycleRole: { value: "test" },
        },
      }),
    });

    const response = await POST(request(VALID_BODY, "operator"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authorizedAction).toBe("scale");
    expect(body.mode).toBe("duplicate");
  });

  // ── Identity and scope refusals ────────────────────────────────────────

  it("refuses an unauthenticated caller before reading anything", async () => {
    const response = await POST(request(VALID_BODY, null));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("auth_error");
    expect(decisionSource.readServedMetaDecision).not.toHaveBeenCalled();
    expect(await draftCount(BIZ_LIVE)).toBe(0);
  });

  /**
   * CROSS-BUSINESS. The outsider holds a genuine session and a genuine
   * collaborator membership — of a DIFFERENT business. The body naming
   * `BIZ_LIVE` is a request, not authority, and the membership lookup is what
   * settles it.
   */
  it("refuses a caller who is not a member of the named business", async () => {
    const response = await POST(request(VALID_BODY, "outsider"));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("auth_error");
    expect(body.message).toBe("You do not have access to this business.");
    expect(decisionSource.readServedMetaDecision).not.toHaveBeenCalled();
    expect(await draftCount(BIZ_LIVE)).toBe(0);
  });

  /**
   * The mirror image, and the reason the check cannot be "is the user a member
   * of anything": the operator IS a member of `BIZ_LIVE` and is not a member of
   * `BIZ_OTHER`, so minting into `BIZ_OTHER` must fail for them too.
   */
  it("refuses a member of one business minting into another", async () => {
    const response = await POST(
      request({ ...VALID_BODY, businessId: BIZ_OTHER }, "operator"),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("auth_error");
    expect(await draftCount(BIZ_OTHER)).toBe(0);
  });

  /**
   * A handoff is the opening move of a write, so the route asks for
   * `collaborator`. A guest is a real, active member and still may not mint.
   */
  it("refuses an active guest because a handoff opens a write", async () => {
    const response = await POST(request(VALID_BODY, "guest"));
    expect(response.status).toBe(403);
    expect((await response.json()).message).toBe(
      "Insufficient role permissions for this action.",
    );
    expect(await draftCount(BIZ_LIVE)).toBe(0);
  });

  /**
   * REVIEWER. The Shopify reviewer is a genuine active collaborator of the demo
   * workspace — `requireBusinessAccess` lets them through — and the route
   * refuses them by NAME afterwards, under its own error code, because reviewer
   * access is read-only. Proven with the session's real email rather than a
   * stubbed predicate.
   */
  it("refuses the reviewer even where the reviewer has collaborator access", async () => {
    const response = await POST(
      request(
        {
          businessId: DEMO_BUSINESS_ID,
          providerAccountId: ACCOUNT_DEMO,
          decisionId: "dec_route_1",
          sourceSnapshotId: "snap_route_1",
        },
        "reviewer",
      ),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("reviewer_read_only");
    expect(body.message).toContain("read-only");
    // Refused before the decision source is consulted and before anything is
    // written.
    expect(decisionSource.readServedMetaDecision).not.toHaveBeenCalled();
    expect(await draftCount(DEMO_BUSINESS_ID)).toBe(0);
  });

  /**
   * UNASSIGNED ACCOUNT. `act_seam_demo` is a real provider account with a real
   * selected binding — to the DEMO business. The operator's business has no
   * binding to it, so the account id in the body is refused. This is the check
   * that stops a URL- or body-supplied account from acting as authority.
   */
  it("refuses an account that is not assigned to the caller's business", async () => {
    const response = await POST(
      request({ ...VALID_BODY, providerAccountId: ACCOUNT_DEMO }, "operator"),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("provider_account_not_assigned");
    expect(decisionSource.readServedMetaDecision).not.toHaveBeenCalled();
    expect(await draftCount(BIZ_LIVE)).toBe(0);
  });

  /**
   * The same account, DESELECTED. `business_provider_accounts` rows are never
   * deleted when an operator deselects an account — only marked unselected — so
   * "the row exists" and "the account is assigned" are different claims, and
   * only the second one may open a write.
   */
  it("refuses an account whose binding row exists but is deselected", async () => {
    const sql = getDb();
    await sql`
      UPDATE business_provider_accounts
      SET is_selected = FALSE
      WHERE business_id = ${BIZ_LIVE} AND provider_account_ref_id = ${PROVIDER_REF_LIVE}
    `;
    try {
      const response = await POST(request(VALID_BODY, "operator"));
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe(
        "provider_account_not_assigned",
      );
      expect(await draftCount(BIZ_LIVE)).toBe(0);
    } finally {
      await sql`
        UPDATE business_provider_accounts
        SET is_selected = TRUE
        WHERE business_id = ${BIZ_LIVE} AND provider_account_ref_id = ${PROVIDER_REF_LIVE}
      `;
    }
  });

  // ── Engine refusals, reported and never re-derived ─────────────────────

  /**
   * Each case removes exactly one thing from an otherwise mintable decision and
   * expects the engine's own refusal code back on a 409. The route does not
   * classify anything here: `authorizeLaunchpadHandoff` decides, and the route's
   * only job is to report the name it was given. The row count assertion is the
   * substantive half — a refusal that still wrote a draft would be a refusal in
   * name only.
   */
  const engineRefusals: Array<[string, Record<string, unknown>, string]> = [
    [
      "a held action",
      { classification: { decisionState: "act", heldAction: "cut", blockers: [] } },
      "decision_held",
    ],
    [
      "a blocked decision",
      {
        classification: {
          decisionState: "blocked",
          heldAction: null,
          blockers: ["tracking"],
        },
      },
      "decision_blocked",
    ],
    [
      "blockers on an otherwise acting decision",
      {
        classification: {
          decisionState: "act",
          heldAction: null,
          blockers: ["tracking"],
        },
      },
      "decision_blocked",
    ],
    [
      "an action-ineligible authority",
      authority({ actionEligible: false }),
      "action_not_eligible",
    ],
    [
      "a demo synthetic decision",
      authority({ status: "demo_synthetic_review_only" }),
      "demo_synthetic_review_only",
    ],
    [
      "a review-only authority",
      authority({ status: "warehouse_discovery" }),
      "source_authority_review_only",
    ],
    [
      "an authorized action with no Launchpad mode",
      authority({ authorizedAction: "cut" }),
      "authorized_action_has_no_launchpad_mode",
    ],
    [
      "a decision belonging to another account",
      { providerAccountId: "act_somewhere_else" },
      "provider_account_mismatch",
    ],
  ];

  for (const [label, overrides, refusal] of engineRefusals) {
    it(`refuses ${label} with the engine's own code and writes nothing`, async () => {
      decisionSource.readServedMetaDecision.mockResolvedValue({
        status: "found",
        decision: decision(overrides),
      });

      const response = await POST(request(VALID_BODY, "operator"));
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe(refusal);
      // A refusal an operator can act on, not "it didn't work".
      expect(typeof body.message).toBe("string");
      expect(String(body.message).length).toBeGreaterThan(0);
      expect(await draftCount(BIZ_LIVE)).toBe(0);
    });
  }

  // ── Source availability ────────────────────────────────────────────────

  /**
   * A decision that is not in the served universe is a 404. It is NOT reported
   * as a refusal of the decision, because "we could not find it" and "the
   * engine said no" are different answers and only one of them means the
   * operator should stop asking.
   */
  it("refuses a decision the server is not currently serving", async () => {
    decisionSource.readServedMetaDecision.mockResolvedValue({
      status: "not_served",
    });

    const response = await POST(request(VALID_BODY, "operator"));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("decision_not_served");
    expect(await draftCount(BIZ_LIVE)).toBe(0);
  });

  /**
   * An UNREADABLE decision source is 503, never 404 and never a mint. A failed
   * read is not an empty result: reporting it as "that decision is not served"
   * would be an outage presented as a verdict.
   */
  it("refuses when the decision source cannot be read at all", async () => {
    decisionSource.readServedMetaDecision.mockResolvedValue({
      status: "source_unavailable",
      message: "The canonical decision source could not be read.",
    });

    const response = await POST(request(VALID_BODY, "operator"));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("decision_source_unavailable");
    expect(body.message).toContain("could not be read");
    expect(await draftCount(BIZ_LIVE)).toBe(0);
  });

  it("refuses when the assignment source itself is unavailable", async () => {
    const assignments = await import("@/lib/provider-account-assignments");
    const spy = vi
      .spyOn(assignments, "getProviderAccountAssignments")
      .mockRejectedValue(new Error("assignment source down"));
    try {
      const response = await POST(request(VALID_BODY, "operator"));
      expect(response.status).toBe(503);
      expect((await response.json()).error).toBe(
        "provider_account_scope_unverified",
      );
      expect(await draftCount(BIZ_LIVE)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  // ── Body validation ────────────────────────────────────────────────────

  it("requires a JSON body", async () => {
    const response = await POST(request("not json", "operator"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_body");
  });

  /**
   * All four identifiers are required, and the pair (decisionId,
   * sourceSnapshotId) especially: matching on the decision id alone would let a
   * handoff bind to a re-evaluation of the same entity, which is a different
   * verdict wearing the same name.
   */
  const requiredFields = [
    "businessId",
    "providerAccountId",
    "decisionId",
    "sourceSnapshotId",
  ] as const;

  for (const field of requiredFields) {
    it(`refuses a body missing ${field}`, async () => {
      const body: Record<string, unknown> = { ...VALID_BODY };
      delete body[field];
      const response = await POST(request(body, "operator"));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_body");
      expect(await draftCount(BIZ_LIVE)).toBe(0);
    });
  }

  it("ignores authority fields a client tries to assert in the body", async () => {
    const response = await POST(
      request(
        {
          ...VALID_BODY,
          // None of these are read. The envelope is built from the SERVER-read
          // decision, so a caller cannot promote their own handoff.
          authorizedAction: "scale",
          mode: "duplicate",
          exactAdExecutionEligible: true,
          actionEligible: true,
          createdByUserId: USER_OUTSIDER,
        },
        "operator",
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // The server-read decision authorizes `refresh`/`rebuild`; the body claimed
    // `scale`/`duplicate` and was ignored.
    expect(body.authorizedAction).toBe("refresh");
    expect(body.mode).toBe("rebuild");

    const sql = getDb();
    const handoffId = String(body.handoff).split(".")[0];
    const rows = (await sql`
      SELECT created_by, payload_json FROM meta_launch_drafts WHERE id = ${handoffId}
    `) as Array<{ created_by: string | null; payload_json: { handoff: Record<string, unknown> } }>;
    expect(rows[0]!.created_by).toBe(USER_OPERATOR);
    expect(rows[0]!.payload_json.handoff.createdByUserId).toBe(USER_OPERATOR);
  });
});
