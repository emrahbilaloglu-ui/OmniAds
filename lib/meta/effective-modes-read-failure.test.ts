import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));
vi.mock("@/lib/meta/anomalies", () => ({
  readMetaAnomaliesForBusiness: vi.fn(async () => ({ anomalies: [] })),
  deliveryConstrainedAdsetIdsFrom: () => new Set(),
}));
vi.mock("@/lib/meta/snapshot", () => ({
  readLatestMetaDecisionSnapshot: vi.fn(async () => ({ status: "not_found", recommendations: [] })),
}));
vi.mock("@/lib/meta/budget-proposal-write-context", () => ({
  buildMetaBudgetWriteContextForProposal: vi.fn(async () => ({ account: { id: "act_modes" } })),
}));

import * as db from "@/lib/db";
import {
  resolveEffectiveMetaMode,
  resolveEffectiveMetaModes,
  resolveMetaWriteCapability,
} from "@/lib/meta/automation-control-plane";
import { buildMetaDailyBrief } from "@/lib/meta/daily-brief";
import { projectNativeAdProposals } from "@/lib/meta/automation-proposals";
import { runMetaBudgetAutomationSweepIfDue } from "@/lib/meta/budget-automation-scheduled";
import { projectMetaBudgetProposals } from "@/lib/meta/budget-proposal-producer";
import { projectMetaBidProposals } from "@/lib/meta/bid-proposal-producer";
import { projectMetaLaunchProposals } from "@/lib/meta/launch-proposal-producer";
import { projectMetaLaunchIntents } from "@/lib/meta/launch-intent-producer";

const BUSINESS = "c9a20000-0000-4000-8000-0000000000b1";
const ACCOUNT = "act_modes";
let modeFailure: Error | null = null;
let modeRows: Array<{ decision_type: string; mode: string }> = [];
const statements: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  statements.length = 0;
  modeFailure = null;
  modeRows = [{ decision_type: "pause", mode: "semi_auto" }];
  const query = async (text: string) => {
    statements.push(text);
    if (text.includes("FROM meta_automation_decision_type_modes")) {
      if (modeFailure) throw modeFailure;
      return modeRows;
    }
    if (text.includes("INSERT INTO meta_automation_proposals")) return [{ id: "native-proposal" }];
    if (text.includes("FROM meta_automation_business_controls")) {
      return [{ business_id: BUSINESS, provider_account_id: ACCOUNT }];
    }
    if (text.includes("FROM businesses business")) {
      return [{
        business_id: BUSINESS, is_demo_business: false, kill_switch_engaged: false,
        readiness_tier: "manual_review", guardrails_json: { dryRunOnly: false },
      }];
    }
    if (text.includes("meta_automation_activity_ledger")) return [];
    if (text.includes("meta_automation_proposals")) return [{ pending: 0 }];
    throw new Error(`Unexpected storage operation: ${text}`);
  };
  // Real control-plane store and real callers; only the storage boundary is a
  // double, so swallowing the failure inside the resolver cannot be hidden.
  const sql = Object.assign(
    (parts: TemplateStringsArray) => query(parts.join("?")),
    { query },
  );
  vi.mocked(db.getDb).mockReturnValue(sql as unknown as ReturnType<typeof db.getDb>);
});
afterEach(() => vi.unstubAllEnvs());

describe("effective modes preserve unreadable versus successfully absent rows", () => {
  it("defaults absent rows to manual only after a successful read", async () => {
    modeRows = [];
    expect(await resolveEffectiveMetaModes(BUSINESS))
      .toEqual({ pause: "manual", budget: "manual", bid: "manual", creative: "manual" });
  });

  it("propagates a transient store failure and recovers the persisted modes on retry", async () => {
    modeFailure = new Error("mode read timed out");
    await expect(resolveEffectiveMetaModes(BUSINESS)).rejects.toThrow("mode read timed out");
    await expect(resolveEffectiveMetaMode(BUSINESS, "pause")).rejects.toThrow("mode read timed out");
    expect(statements.filter((text) => text.includes("meta_automation_decision_type_modes"))).toHaveLength(2);
    modeFailure = null;
    expect(await resolveEffectiveMetaModes(BUSINESS))
      .toEqual({ pause: "semi_auto", budget: "manual", bid: "manual", creative: "manual" });
  });

  it("reports the brief's mode section unavailable instead of four claimed manual settings", async () => {
    modeFailure = new Error("mode read timed out");
    const input = { businessId: BUSINESS, providerAccountId: ACCOUNT };
    expect((await buildMetaDailyBrief(input)).modes)
      .toEqual({ state: "unavailable", pause: null, budget: null, bid: null, creative: null });
    modeFailure = null;
    expect((await buildMetaDailyBrief(input)).modes)
      .toMatchObject({ state: "read", pause: "semi_auto" });
  });

  it("keeps native projection retryable and performs no queue write on an unreadable mode", async () => {
    modeFailure = new Error("mode read timed out");
    const input = { businessId: BUSINESS, snapshotDate: "2026-09-06" };
    expect(await projectNativeAdProposals(input))
      .toEqual({ projected: 0, ran: false, withheld: "standing_mode_unreadable" });
    expect(statements.some((text) => text.includes("INSERT INTO"))).toBe(false);
    modeFailure = null;
    expect(await projectNativeAdProposals(input))
      .toEqual({ projected: 1, ran: true, withheld: null });
    expect(statements.filter((text) => text.includes("INSERT INTO"))).toHaveLength(1);
  });

  it("stops the sweep with an unavailable reason before selecting or claiming a proposal", async () => {
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
    modeFailure = new Error("mode read timed out");
    const result = await runMetaBudgetAutomationSweepIfDue();
    expect(result).toMatchObject({ skipped: false, reports: [{ ran: false, blockers: ["decision_type_modes_unreadable"] }] });
    expect(statements.some((text) => text.includes("meta_automation_proposals"))).toBe(false);
    modeFailure = null;
    expect(await runMetaBudgetAutomationSweepIfDue())
      .toMatchObject({ skipped: false, reports: [] });
  });

  it("does not report the capability verified when the mode read failed", async () => {
    modeFailure = new Error("mode read timed out");
    expect(await resolveMetaWriteCapability({ businessId: BUSINESS }))
      .toMatchObject({ effectiveModes: null, verified: false, writeBlocked: true, blockReason: "control_state_unavailable" });
    modeFailure = null;
    expect(await resolveMetaWriteCapability({ businessId: BUSINESS }))
      .toMatchObject({ effectiveModes: { pause: "semi_auto" }, verified: true, writeBlocked: false });
  });

  it("budget projection remains available when the standing mode read fails", async () => {
    const listCandidates = vi.fn(async () => []);
    modeFailure = new Error("mode read timed out");

    await expect(projectMetaBudgetProposals({
      businessId: BUSINESS,
      snapshotDate: "2026-09-06",
      providerAccountIds: [ACCOUNT],
      listCandidates,
      insertProposal: async () => null,
      loadCompositionSources: async () => null,
    })).resolves.toMatchObject({ ran: true, candidates: 0 });
    expect(listCandidates).toHaveBeenCalledOnce();
    expect(statements.some((text) =>
      text.includes("FROM meta_automation_decision_type_modes"))).toBe(false);
  });

  it.each(["bid", "launch", "launch-intent"])(
    "%s producer exposes the failure before reading candidates and resumes after recovery",
    async (family) => {
      modeRows = [
        { decision_type: "budget", mode: "semi_auto" },
        { decision_type: "bid", mode: "semi_auto" },
        { decision_type: "creative", mode: "semi_auto" },
      ];
      const listCandidates = vi.fn(async () => []);
      const insertProposal = vi.fn(async () => null);
      const common = {
        businessId: BUSINESS,
        snapshotDate: "2026-09-06",
        providerAccountIds: [ACCOUNT],
        listCandidates,
        insertProposal,
      };
      const produce = () => {
        if (family === "bid") return projectMetaBidProposals(common);
        if (family === "launch") return projectMetaLaunchProposals(common);
        return projectMetaLaunchIntents(common);
      };
      modeFailure = new Error("mode read timed out");
      await expect(produce()).rejects.toThrow("mode read timed out");
      expect(listCandidates).not.toHaveBeenCalled();
      expect(insertProposal).not.toHaveBeenCalled();
      modeFailure = null;
      await expect(produce()).resolves.toMatchObject({ ran: true, candidates: 0 });
      expect(listCandidates).toHaveBeenCalledOnce();
    },
  );
});
