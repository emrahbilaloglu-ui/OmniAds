import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const db = await import("@/lib/db");
const { DEMO_BUSINESS_ID } = await import("@/lib/demo-business-support");
const { rejectIfAutomationDemoWrite } = await import("./demo-write-authority");

const LIVE_BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

describe("Automation demo write authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // LAW (docs/creative-decision-center/INVARIANTS.md): "Demo businesses have
  // zero Meta write authority even if a presentation defect supplies an
  // action." Automation held that rule only inside `getMetaWriteBlockState`,
  // which the two write routes consult from exactly one place (proposals
  // `approve`). Everything else — kill switch, decision-type mode, guardrail
  // policy, rules, rule evaluation, proposal modify/dismiss — went through.
  // The role check does not cover it: `/api/auth/demo-login` opens a session as
  // an ADMIN of the demo business under a non-reviewer email.
  it("refuses the well-known demo business without reading the table", async () => {
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await rejectIfAutomationDemoWrite(
      DEMO_BUSINESS_ID,
      "automation_rule_create",
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
    expect(sql).not.toHaveBeenCalled();
    const body = await response!.json();
    expect(body.error.code).toBe("demo_business_read_only");
    expect(body.error.action).toBe("automation_rule_create");
  });

  it("refuses a business the table flags as demo", async () => {
    const sql = vi.fn(async () => [{ is_demo_business: true }]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await rejectIfAutomationDemoWrite(
      LIVE_BUSINESS_ID,
      "automation_proposal_dismiss",
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
    const body = await response!.json();
    expect(body.error.code).toBe("demo_business_read_only");
  });

  // LAW: missing or unreadable data must never become success. A database
  // outage is not proof that this workspace is real, and a write must not
  // proceed on an unproven claim. 503, not 200 and not a silent pass.
  it("holds the write when the demo flag cannot be read", async () => {
    const sql = vi.fn(async () => {
      throw new Error("db down");
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await rejectIfAutomationDemoWrite(
      LIVE_BUSINESS_ID,
      "automation_guardrail_policy",
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    const body = await response!.json();
    expect(body.error.code).toBe("demo_status_unverified");
  });

  // The caller is already authorized against a membership on this business, so
  // "no row" is a broken read, not proof of a live workspace.
  it("holds the write when the business row is absent", async () => {
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await rejectIfAutomationDemoWrite(
      LIVE_BUSINESS_ID,
      "automation_kill_switch_release",
    );

    expect(response!.status).toBe(503);
  });

  it("returns null only for a proven live workspace", async () => {
    const sql = vi.fn(async () => [{ is_demo_business: false }]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      rejectIfAutomationDemoWrite(LIVE_BUSINESS_ID, "automation_rule_toggle"),
    ).resolves.toBeNull();
  });

  // The codes are Launchpad's codes and the Automation viewer envelope's codes.
  // If this ever drifts, the disabled control on screen and the response from
  // the route would name different reasons for the same refusal.
  it("spells the codes the same way the surface restates them", async () => {
    const { AUTOMATION_DEMO_WRITE_REFUSAL, AUTOMATION_UNVERIFIED_WRITE_REFUSAL } =
      await import("./demo-write-authority");
    expect(AUTOMATION_DEMO_WRITE_REFUSAL).toContain(
      "zero Meta write authority",
    );
    expect(AUTOMATION_UNVERIFIED_WRITE_REFUSAL).toContain(
      "could not be confirmed as a live",
    );
  });
});
