/**
 * The approval column is the whole authority for an unattended activation, and
 * this route is the only thing in the application that writes it — approve on
 * one branch, revoke on the other.
 *
 * Both branches used to build their write from the intent read at the top of
 * the handler and then hand it to a store writer whose UPDATE names only
 * `(business_id, id)` and a status. So an approval POST that overlapped a
 * revocation replaced the revoked document with a live one, and the scheduled
 * activation runtime could then turn real provider entities on despite the
 * operator having explicitly withdrawn the approval.
 *
 * The compare-and-set that fixed that could not see the case where the column
 * started NULL. A revocation there found nothing to stamp and stored NULL — the
 * value already in the column — so the version the guard is made of never
 * moved, and an approval that had read NULL before the revocation compared NULL
 * to NULL, passed, and stored a live approval anyway. The lock and the
 * transaction were correct throughout; a guard cannot catch a change nothing
 * recorded. A revocation now always leaves a document.
 *
 * The seam these cases drive is `getMetaLaunchIntent`: its first call returns
 * the state the request decided against and the concurrent write lands
 * immediately after, which is exactly "committed while this request was in
 * flight". That concurrent write is the real exported POST wherever the
 * property is about ordering, so both halves of a race are the shipped handler.
 * Everything else — the builder, the copy hash, the validator — is the real
 * module, so a case that passes here passes against the shipped documents.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { validateActivationApproval } from "@/lib/meta/launch-activation-approval";

const requireBusinessAccess = vi.fn();
const rejectIfLaunchpadDemoWrite = vi.fn(async () => null);
const getMetaLaunchIntent = vi.fn();
const recordMetaLaunchIntentActivationApproval = vi.fn();
/** Ordered trace of what the write phase actually did, in one place. */
const events: string[] = [];
const statements: string[] = [];

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("../../../demo-write-authority", () => ({ rejectIfLaunchpadDemoWrite }));
vi.mock("@/lib/launchpad/meta-launch-intent-store", () => ({
  getMetaLaunchIntent,
  recordMetaLaunchIntentActivationApproval,
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => {
      events.push("begin");
      const result = await fn();
      events.push("commit");
      return result;
    }),
    getDb: vi.fn(() => (strings: TemplateStringsArray) => {
      const statement = strings.join("?");
      statements.push(statement);
      events.push(
        statement.includes("pg_advisory_xact_lock") ? "lock" : "statement",
      );
      return Promise.resolve([]);
    }),
  };
});

const { POST } = await import("./route");
/*
  Imported after the mocks, not with the others at the top of the file.
  `launch-intent-activation` imports the launch-intent store, and a static
  import of it would be hoisted above the `vi.fn()` declarations the store's
  mock factory closes over.
*/
const { ACTIVATION_POLICY_VERSION } = await import(
  "@/lib/meta/launch-intent-activation"
);

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
/** `buildActivationApproval` refuses a non-UUID approver, so this is one. */
const USER_ID = "5f2b8c41-0b3a-4a2e-9c17-3f0d1c8ae4b2";
const INTENT_ID = "intent_1";

type StoredApproval = {
  contractVersion: string;
  approvedBy: string;
  approvedAt: string;
  revokedAt: string | null;
};

/** What sits in `activation_approval_json` right now. */
let stored: unknown = null;
/**
 * Committed by somebody else the instant this request finishes its read.
 *
 * Awaited, so it may be a whole second POST through the real handler: that is
 * how a race between two shipped requests is expressed here rather than
 * simulated by hand-writing what the other one would have stored.
 */
let concurrentWrite: (() => void | Promise<void>) | null = null;

/**
 * What the unattended path would make of the column as it now stands.
 *
 * The real validator, against the same intent and receipt `intentRow` describes.
 * This is the question that matters after every case below, because the queue's
 * own gate is only `activation_approval_json IS NOT NULL` — once a document is
 * there at all, this verdict is the last thing between it and a provider write.
 */
function verdictFor(document: unknown) {
  return validateActivationApproval({
    stored: document,
    intent: {
      id: INTENT_ID,
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      operation: "new_campaign",
      requestFingerprint: "fingerprint_1",
    },
    identities: {
      campaignId: "camp_1",
      adsetIds: ["adset_1"],
      adIds: ["ad_1"],
      creativeIds: ["creative_1"],
    },
    policyVersion: ACTIVATION_POLICY_VERSION,
    now: new Date(),
  });
}

function liveApproval(approvedAt: string): StoredApproval {
  return {
    contractVersion: "meta.launch-activation-approval.v2",
    approvedBy: USER_ID,
    approvedAt,
    revokedAt: null,
  };
}

function intentRow() {
  return {
    id: INTENT_ID,
    businessId: BUSINESS_ID,
    providerAccountId: "act_123",
    operation: "new_campaign",
    requestFingerprint: "fingerprint_1",
    requestPayload: { creatives: ["creative_1"] },
    status: "succeeded",
    resultReceipt: {
      campaignId: "camp_1",
      adsetIds: ["adset_1"],
      adIds: ["ad_1"],
    },
    errorReceipt: null,
    activationApproval: stored,
  };
}

function request(body: Record<string, unknown>) {
  return new NextRequest(
    `http://localhost/api/launchpad/meta/intents/${INTENT_ID}/activation-approval`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        businessId: BUSINESS_ID,
        actionOrigin: "manual_operator_v1",
        manualConfirmation: "explicit_operator_confirmation",
        ...body,
      }),
    },
  );
}

function post(body: Record<string, unknown>) {
  return POST(request(body), { params: Promise.resolve({ id: INTENT_ID }) });
}

describe("POST /api/launchpad/meta/intents/[id]/activation-approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored = null;
    concurrentWrite = null;
    events.length = 0;
    statements.length = 0;

    requireBusinessAccess.mockResolvedValue({
      session: { user: { id: USER_ID, email: "operator@example.com" } },
      membership: { businessId: BUSINESS_ID },
    } as never);
    rejectIfLaunchpadDemoWrite.mockResolvedValue(null);

    getMetaLaunchIntent.mockImplementation(async () => {
      // The snapshot is taken BEFORE the concurrent write, so the caller holds
      // the state it decided against and the other writer commits after it.
      const snapshot = intentRow();
      events.push("read");
      if (concurrentWrite) {
        const write = concurrentWrite;
        concurrentWrite = null;
        await write();
      }
      return snapshot;
    });
    recordMetaLaunchIntentActivationApproval.mockImplementation(
      async (input: { approval: unknown }) => {
        events.push("write");
        stored = input.approval;
        return intentRow();
      },
    );
  });

  it("refuses an approval whose document was revoked while it was in flight", async () => {
    const revokedAt = "2026-09-06T00:00:00.000Z";
    stored = liveApproval("2026-09-05T00:00:00.000Z");
    concurrentWrite = () => {
      stored = { ...(stored as StoredApproval), revokedAt };
    };

    const response = await post({ approvedScope: "ad", ttlHours: 24 });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("activation_approval_conflict");
    expect(recordMetaLaunchIntentActivationApproval).not.toHaveBeenCalled();
    // The revocation still stands: nothing was resurrected.
    expect((stored as StoredApproval).revokedAt).toBe(revokedAt);
  });

  it("refuses an approval when another approval landed while it was in flight", async () => {
    const other = liveApproval("2026-09-05T12:00:00.000Z");
    stored = null;
    concurrentWrite = () => {
      stored = other;
    };

    const response = await post({ approvedScope: "ad", ttlHours: 24 });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("activation_approval_conflict");
    expect(recordMetaLaunchIntentActivationApproval).not.toHaveBeenCalled();
    expect(stored).toEqual(other);
  });

  it("revokes the approval that stands now, not the one it read first", async () => {
    stored = liveApproval("2026-09-05T00:00:00.000Z");
    concurrentWrite = () => {
      stored = liveApproval("2026-09-05T18:00:00.000Z");
    };

    const response = await post({ revoke: true });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.revoked).toBe(true);
    const written = recordMetaLaunchIntentActivationApproval.mock
      .calls[0][0].approval as StoredApproval;
    // The newer approval is the one withdrawn — a revocation always wins, and
    // the record names what it actually took away.
    expect(written.approvedAt).toBe("2026-09-05T18:00:00.000Z");
    expect(written.revokedAt).not.toBeNull();
    expect((stored as StoredApproval).revokedAt).not.toBeNull();
  });

  it("records an uncontended approval under the intent's advisory lock", async () => {
    stored = null;

    const response = await post({ approvedScope: "ad", ttlHours: 24 });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.revoked).toBe(false);
    expect(recordMetaLaunchIntentActivationApproval).toHaveBeenCalledTimes(1);
    // The check and the write are one step: both happen after the lock and
    // inside the transaction that holds it.
    expect(events).toEqual(["read", "begin", "lock", "read", "write", "commit"]);
    expect(statements.join("\n")).toContain("pg_advisory_xact_lock");
  });

  /*
    The case the compare-and-set could not see: an intent that was never
    approved at all.

    NULL is every intent's default and the state the dangerous sequence starts
    from, so this is not an exotic corner — it is the ordinary one. All three
    cases here drive both halves through the real POST.
  */
  describe("when the column starts NULL", () => {
    it("refuses a stale approval behind a revocation that found nothing to revoke", async () => {
      stored = null;
      concurrentWrite = async () => {
        const revoke = await post({ revoke: true });
        expect(revoke.status).toBe(200);
      };

      const response = await post({ approvedScope: "hierarchy", ttlHours: 24 });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error.code).toBe("activation_approval_conflict");
      // One write in the whole sequence, and it is the revocation's.
      expect(recordMetaLaunchIntentActivationApproval).toHaveBeenCalledTimes(1);
      /*
        And the intent is still non-authorizing. This is the assertion the
        defect actually failed: before the fix the approve answered 200 and the
        column held a complete v2 approval with `revokedAt: null`, which the
        scheduled runtime would have honoured.
      */
      expect(verdictFor(stored)).toEqual({
        approved: false,
        refusal: "activation_approval_revoked",
      });
    });

    it("withdraws the approval that landed mid-flight, not the NULL it read first", async () => {
      stored = null;
      concurrentWrite = async () => {
        const approve = await post({ approvedScope: "hierarchy", ttlHours: 24 });
        expect(approve.status).toBe(200);
      };

      const response = await post({ revoke: true });

      expect(response.status).toBe(200);
      expect((await response.json()).revoked).toBe(true);
      const held = stored as Record<string, unknown>;
      /*
        Not a tombstone. The revocation re-read under the lock, found the new
        approval, and stamped THAT — so the record still names who approved what
        and the withdrawal covers the approval that actually exists.
      */
      expect(held.contractVersion).toBe("meta.launch-activation-approval.v2");
      expect(held.approvedBy).toBe(USER_ID);
      expect(typeof held.revokedAt).toBe("string");
      expect(verdictFor(stored)).toEqual({
        approved: false,
        refusal: "activation_approval_revoked",
      });
    });

    it("leaves a document the real validator refuses as revoked, not as malformed", async () => {
      stored = null;

      const response = await post({ revoke: true });
      expect(response.status).toBe(200);

      const tombstone = stored as Record<string, unknown>;
      expect(tombstone.contractVersion).toBe("meta.launch-activation-revocation.v1");
      expect(tombstone.revokedBy).toBe(USER_ID);
      /*
        Non-authorizing by construction, not by a check somebody has to
        remember: there is no approver, no expiry, no scope and no approved set
        in it, so there is no field a careless reader could turn into
        permission.
      */
      for (const field of [
        "approvedBy",
        "approvedAt",
        "expiresAt",
        "approvedScope",
        "approvedAssets",
        "approvedDestination",
      ]) {
        expect(tombstone, field).not.toHaveProperty(field);
      }
      /*
        And this is the edge that makes the reason matter. Both unattended gates
        ask only `activation_approval_json IS NOT NULL`
        (budget-automation-scheduled.ts and activation-proposal-producer.ts), so
        storing ANY document flips them true for a revoked intent and
        `validateActivationApproval` becomes the only thing left. It refuses
        under the revocation's own code — a minimal document used to be refused
        as `activation_approval_malformed`, which is fail-closed but tells the
        operator the wrong thing about their own act.
      */
      expect(verdictFor(stored)).toEqual({
        approved: false,
        refusal: "activation_approval_revoked",
      });
    });
  });

  /*
    Repeats and retries across the whole family. Nothing here is a race — these
    are the sequences an operator, a double-click or a client retry produces.
  */
  describe("repeats and retries", () => {
    it("reaffirms on a second revoke: the moment stays, the version moves", async () => {
      /*
        This case previously asserted the opposite — that a second Revoke wrote
        NOTHING — and that was the defect, not the design.

        "Already withdrawn" is the state that exists after every revocation. A
        revoke that writes nothing moves no version, so an approval that read
        the withdrawn document passes its compare-and-set and lands live while
        the operator's concurrent Revoke answers 200. The next case drives
        exactly that sequence.

        `revokedAt` still names when authority ended; `reaffirmedAt` carries the
        button press, so the document differs and the fence holds.
      */
      stored = null;
      expect((await post({ revoke: true })).status).toBe(200);
      const afterFirst = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
      expect(recordMetaLaunchIntentActivationApproval).toHaveBeenCalledTimes(1);

      const second = await post({ revoke: true });

      expect(second.status).toBe(200);
      expect((await second.json()).revoked).toBe(true);
      expect(recordMetaLaunchIntentActivationApproval).toHaveBeenCalledTimes(2);
      const afterSecond = stored as Record<string, unknown>;
      expect(afterSecond.revokedAt).toBe(afterFirst.revokedAt);
      expect(JSON.stringify(afterSecond)).not.toBe(JSON.stringify(afterFirst));
      expect(verdictFor(afterSecond)).toMatchObject({
        approved: false,
        refusal: "activation_approval_revoked",
      });
    });

    it("refuses a stale approval behind a revoke of an ALREADY withdrawn document", async () => {
      /*
        The sequence the reviewer found and the reason the short-circuit is
        gone. Start from a withdrawn column — the state after any revocation —
        let an approve read it, then let a Revoke land first. Before the
        reaffirmation the second Revoke wrote nothing, the version was
        unchanged, and this approve answered 200 with a LIVE approval.
      */
      stored = null;
      expect((await post({ revoke: true })).status).toBe(200);

      concurrentWrite = async () => {
        expect((await post({ revoke: true })).status).toBe(200);
      };

      const stale = await post({ approvedScope: "hierarchy", ttlHours: 24 });

      expect(stale.status).toBe(409);
      expect((await stale.json()).error).toMatchObject({
        code: "activation_approval_conflict",
      });
      expect(verdictFor(stored as Record<string, unknown>)).toMatchObject({
        approved: false,
        refusal: "activation_approval_revoked",
      });
    });

    it("takes one of two approvals sent from the same read and refuses the other", async () => {
      // A double-click, or a client retrying a request that had not answered
      // yet: both compute their expected version from the same column.
      stored = null;
      concurrentWrite = async () => {
        expect((await post({ approvedScope: "hierarchy", ttlHours: 24 })).status).toBe(200);
      };

      const response = await post({ approvedScope: "hierarchy", ttlHours: 24 });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("activation_approval_conflict");
      expect(recordMetaLaunchIntentActivationApproval).toHaveBeenCalledTimes(1);
      expect(verdictFor(stored).approved).toBe(true);
    });

    it("lets a deliberate re-approval supersede a withdrawal, from a fresh read", async () => {
      stored = null;
      expect((await post({ revoke: true })).status).toBe(200);
      const withdrawn = JSON.stringify(stored);

      // The operator looks at the withdrawal and decides to grant a new one.
      const response = await post({ approvedScope: "hierarchy", ttlHours: 24 });

      expect(response.status).toBe(200);
      expect(JSON.stringify(stored)).not.toBe(withdrawn);
      expect(verdictFor(stored)).toMatchObject({ approved: true, scope: "hierarchy" });
    });

    it("never lets a withdrawn document look like a live one across approve/revoke/approve", async () => {
      stored = null;
      const seen: string[] = [];
      expect((await post({ approvedScope: "hierarchy", ttlHours: 24 })).status).toBe(200);
      seen.push(JSON.stringify(stored));
      expect((await post({ revoke: true })).status).toBe(200);
      seen.push(JSON.stringify(stored));
      expect((await post({ approvedScope: "hierarchy", ttlHours: 24 })).status).toBe(200);
      seen.push(JSON.stringify(stored));

      /*
        The version is the document, so ABA is a real question: could the column
        come back to a value some in-flight request already read?

        Across a withdrawal it cannot, and that is the direction that matters. A
        withdrawn document carries a `revokedAt` string and a live one carries
        null, so no live document can ever hash equal to a revoked one — a
        request that read either side of a revocation is always caught.

        Between two APPROVALS it is not impossible: `approvedAt` and `expiresAt`
        come from `new Date()`, so two approvals by the same operator, with the
        same scope, asset version and TTL, landing in the same millisecond,
        produce equal documents. The residual is bounded by what it takes to
        reach it — the operator has to have deliberately re-approved in that
        millisecond, so the stale request lands an approval equivalent to the one
        that already stands, never one over a withdrawal.
      */
      expect(seen[1]).not.toBe(seen[0]);
      expect(seen[1]).not.toBe(seen[2]);
    });
  });
});
