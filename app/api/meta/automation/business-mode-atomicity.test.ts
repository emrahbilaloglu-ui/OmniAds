import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * `set_business_mode` is one operator act, not four.
 *
 * The four per-type writes used to commit one at a time, so a failure on the
 * second, third or fourth type answered 500 with the earlier types already
 * changed. On `mode: "auto"` that is the case that matters: the caller reads
 * the failed request as "nothing was armed" while an unattended action family
 * is in fact armed, and the business is left in a mixture nobody chose.
 *
 * These cases therefore assert the DURABLE effect, not that a particular
 * function was called. The fake below is a database that can roll back: a write
 * made while `runDbTransaction` is on the stack is only visible after the
 * callback resolves, and a write made outside one — which is exactly what the
 * pre-fix loop did — is visible immediately and can never be taken back.
 */
const ledger = vi.hoisted(() => ({
  committed: [] as string[],
  pending: [] as string[],
  depth: 0,
  /** Decision type whose write should throw, or null for a clean run. */
  failOn: null as string | null,
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  runDbTransaction: vi.fn(async (run: () => Promise<unknown>) => {
    ledger.depth += 1;
    try {
      const result = await run();
      ledger.committed.push(...ledger.pending);
      ledger.pending = [];
      return result;
    } catch (error) {
      // ROLLBACK: everything this transaction wrote is discarded.
      ledger.pending = [];
      throw error;
    } finally {
      ledger.depth -= 1;
    }
  }),
}));

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(async () => ["act_1"]),
}));

vi.mock("@/lib/meta/automation-control-plane", () => ({
  ensureBusinessControlRow: vi.fn(async () => ({ created: false })),
  engageMetaAutomationKillSwitch: vi.fn(),
  releaseMetaAutomationKillSwitch: vi.fn(),
  setMetaAutomationDecisionTypeMode: vi.fn(
    async (input: { decisionType: string }) => {
      if (input.decisionType === ledger.failOn) {
        throw new Error(`mode write failed for ${input.decisionType}`);
      }
      // Durable only when a transaction is holding it; otherwise it is already
      // committed and no later failure can undo it.
      if (ledger.depth > 0) ledger.pending.push(input.decisionType);
      else ledger.committed.push(input.decisionType);
      return [];
    },
  ),
  setMetaAutomationGuardrailPolicy: vi.fn(),
  getMetaAutomationControlPlane: vi.fn(async () => ({
    contractVersion: "meta-automation-control-plane.v1",
  })),
  getMetaWriteBlockState: vi.fn(),
  writeActivityLedgerRow: vi.fn(async () => undefined),
  META_AUTOMATION_DECISION_TYPES: ["pause", "bid", "budget", "creative"],
  normalizeCleanApprovalThreshold: (value: unknown) => {
    if (value === null || value === undefined || value === "") return null;
    const next = Number(value);
    return Number.isFinite(next) && next >= 1 ? Math.trunc(next) : null;
  },
  normalizeQuietHourTime: (value: unknown) => {
    if (typeof value !== "string") return null;
    const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?/.exec(value.trim());
    return match ? `${match[1]}:${match[2]}` : null;
  },
}));

const db = await import("@/lib/db");
const access = await import("@/lib/access");
const controlPlane = await import("@/lib/meta/automation-control-plane");
const { POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

function postRequest(body: unknown) {
  return new NextRequest(
    `http://localhost/api/meta/automation?businessId=${BUSINESS_ID}&providerAccountId=act_1`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

describe("POST /api/meta/automation set_business_mode atomicity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    ledger.committed = [];
    ledger.pending = [];
    ledger.depth = 0;
    ledger.failOn = null;
    // A proven LIVE workspace, so the demo gate is not what these cases test.
    vi.mocked(db.getDb).mockReturnValue(
      vi.fn(async () => [{ is_demo_business: false }]) as never,
    );
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } },
      // `auto` takes the admin floor; anything less is refused before the write.
      membership: { businessId: BUSINESS_ID, role: "admin" },
    } as never);
  });

  it("arms no decision type when a later type's write fails", async () => {
    ledger.failOn = "budget";

    const response = await POST(
      postRequest({ action: "set_business_mode", mode: "auto" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error.code).toBe("automation_action_failed");
    // The whole point: `pause` and `bid` were written before `budget` threw,
    // and the operator was told the request failed. Neither may survive it.
    expect(ledger.committed).toEqual([]);
    expect(
      vi.mocked(controlPlane.setMetaAutomationDecisionTypeMode).mock.calls.map(
        (call) => (call[0] as { decisionType: string }).decisionType,
      ),
    ).toEqual(["pause", "bid", "budget"]);
  });

  it("commits all four decision types together on success", async () => {
    const response = await POST(
      postRequest({ action: "set_business_mode", mode: "semi_auto" }),
    );

    expect(response.status).toBe(200);
    expect(ledger.committed).toEqual(["pause", "bid", "budget", "creative"]);
    expect(ledger.pending).toEqual([]);
  });
});
