import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/meta/automation-rules-store", () => ({
  // No enforced guard rules: this suite is about the capability, the readiness
  // tier and rehearsal, which are all read before any rule would be.
  listAutomationRules: vi.fn(async () => []),
  anchorsFromTargetPack: vi.fn(() => null),
  countAutomationRuleFirings: vi.fn(async () => 0),
}));

import * as db from "@/lib/db";
import { getMetaWriteBlockState } from "@/lib/meta/automation-control-plane";
import {
  metaWriteIsRehearsal,
  readMetaWritePosture,
} from "@/lib/meta/automation-write-guard";

// Deliberately NOT the demo business id: that one is refused before any of
// the gates this suite is about are even read.
const BUSINESS_ID = "3f2a91c4-77b5-4d1e-9a60-5c8e2d0b41af";

/**
 * The posture read, driven through the REAL control-plane query.
 *
 * The bypass this suite disables is the point: `getMetaWriteBlockState`
 * short-circuits to "not blocked" under vitest unless
 * `META_AUTOMATION_WRITE_GUARD_TEST_READS=1`, which is why a green suite could
 * coexist with an unenforced capability. Every case here opts in.
 */
function controlRow(overrides: Record<string, unknown> = {}) {
  return {
    business_id: BUSINESS_ID,
    is_demo_business: false,
    kill_switch_engaged: false,
    kill_switch_reason: null,
    auto_execution_enabled: false,
    readiness_tier: "manual_review",
    guardrails_json: { dryRunOnly: false },
    updated_at: "2026-09-05T08:00:00.000Z",
    updated_by: "user_1",
    ...overrides,
  };
}

function withControl(row: Record<string, unknown> | null) {
  const sql = vi.fn(async (parts: TemplateStringsArray) => {
    const query = Array.from(parts).join("?");
    if (query.includes("LEFT JOIN meta_automation_business_controls")) {
      return row ? [row] : [];
    }
    return [];
  }) as unknown as ReturnType<typeof db.getDb>;
  (sql as unknown as { query: unknown }).query = vi.fn(async () => []);
  vi.mocked(db.getDb).mockReturnValue(sql);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // Read the real control plane rather than the vitest short-circuit.
  vi.stubEnv("META_AUTOMATION_WRITE_GUARD_TEST_READS", "1");
});

describe("the release capability is enforced by the server, not only by the screens", () => {
  it("blocks every write when the capability is shut", async () => {
    /*
      The gap this closes. `readMetaReleaseGates` decided what the UI offered
      and the write path never asked, so a hand-built request, a stale tab or
      any caller that skipped the UI reached a provider POST with the
      capability closed.
    */
    withControl(controlRow());
    const posture = await getMetaWriteBlockState({ businessId: BUSINESS_ID });
    expect(posture).toMatchObject({
      blocked: true,
      reason: "release_capability_closed",
    });
  });

  it("permits the write once the capability is open", async () => {
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
    withControl(controlRow());
    const posture = await getMetaWriteBlockState({ businessId: BUSINESS_ID });
    expect(posture).toMatchObject({ blocked: false, rehearsal: false });
  });
});

describe("the read-only readiness tier is enforced", () => {
  it("refuses a business deliberately parked in read_only", async () => {
    // Two consumers required this tier and neither enforced it, so a business
    // whose whole posture said "do not write here" could still be written to.
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
    withControl(controlRow({ readiness_tier: "read_only" }));
    const posture = await getMetaWriteBlockState({ businessId: BUSINESS_ID });
    expect(posture).toMatchObject({
      blocked: true,
      reason: "readiness_tier_read_only",
    });
  });
});

describe("rehearsal is a server posture, not a request field", () => {
  it("reports rehearsal for a business whose guardrail says so", async () => {
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
    withControl(controlRow({ guardrails_json: { dryRunOnly: true } }));
    const posture = await getMetaWriteBlockState({ businessId: BUSINESS_ID });
    // NOT blocked: a rehearsal still runs, verifies and journals. It just
    // never posts.
    expect(posture).toMatchObject({ blocked: false, rehearsal: true });
  });

  it("rehearses on the shipped default, where the guardrail says nothing", async () => {
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
    withControl(controlRow({ guardrails_json: {} }));
    const posture = await getMetaWriteBlockState({ businessId: BUSINESS_ID });
    expect(posture.rehearsal).toBe(true);
  });

  it("a request that OMITS dryRun cannot escape a rehearsing business", async () => {
    /*
      The exact defect. Every entity and ad route computed `dryRun` from the
      request body alone, so omitting the field reached a real provider POST
      while the business's persisted guardrail said rehearse.
    */
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
    withControl(controlRow({ guardrails_json: { dryRunOnly: true } }));
    const posture = await readMetaWritePosture({ businessId: BUSINESS_ID });

    expect(metaWriteIsRehearsal({ posture, requestedDryRun: false })).toBe(true);
    // And a client asking for a dry run on a LIVE business still gets one:
    // the flag may always add.
    expect(metaWriteIsRehearsal({
      posture: { rehearsal: false }, requestedDryRun: true,
    })).toBe(true);
    expect(metaWriteIsRehearsal({
      posture: { rehearsal: false }, requestedDryRun: false,
    })).toBe(false);
  });
});

describe("an unreadable posture never reads as permission", () => {
  it("blocks and rehearses when the control row cannot be read", async () => {
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
    withControl(null);
    const posture = await readMetaWritePosture({ businessId: BUSINESS_ID });
    expect(posture).toMatchObject({
      blocked: true,
      rehearsal: true,
      reason: "control_state_unavailable",
    });
  });

  it("blocks when the control-plane read throws outright", async () => {
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
    vi.mocked(db.getDb).mockImplementation(() => {
      throw new Error("connection refused");
    });
    const posture = await readMetaWritePosture({ businessId: BUSINESS_ID });
    expect(posture.blocked).toBe(true);
    expect(posture.rehearsal).toBe(true);
  });
});

describe("the gate order says what it means", () => {
  it("refuses a closed capability before reading guard rules", async () => {
    // A build that may not write at all should not be reporting which rule
    // would have stopped it.
    withControl(controlRow({ kill_switch_engaged: false }));
    const posture = await getMetaWriteBlockState({ businessId: BUSINESS_ID });
    expect(posture.reason).toBe("release_capability_closed");
  });

  it("still refuses the STOP first, whatever the capability says", async () => {
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
    withControl(controlRow({
      kill_switch_engaged: true, kill_switch_reason: "Operator stop.",
    }));
    const posture = await getMetaWriteBlockState({ businessId: BUSINESS_ID });
    expect(posture).toMatchObject({
      blocked: true, reason: "business_kill_switch",
    });
  });
});
