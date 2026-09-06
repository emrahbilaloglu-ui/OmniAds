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
 * The seam these cases drive is `getMetaLaunchIntent`: its first call returns
 * the state the request decided against and the concurrent write lands
 * immediately after, which is exactly "committed while this request was in
 * flight". Everything else — the builder, the copy hash, the validator — is the
 * real module, so a case that passes here passes against the shipped documents.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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
/** Committed by somebody else the instant this request finishes its read. */
let concurrentWrite: (() => void) | null = null;

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
        write();
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
});
