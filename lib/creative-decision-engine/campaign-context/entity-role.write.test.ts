import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: mocks.query }),
  runDbTransaction: mocks.transaction,
}));

import {
  appendEntityRoleDeclarations,
  ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
} from "./entity-role";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const CAMPAIGN = "120251964505870042";
const ADSET = "120251964734540042";

function binding(observed: Record<string, string[]>) {
  mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("FROM meta_entity_state_history")) {
      return (observed[String(params[3])] ?? []).map((campaign_id) => ({ campaign_id }));
    }
    if (sql.includes("INSERT INTO meta_entity_role_declarations")) {
      return [
        {
          id: `row-${String(params[3])}`,
          business_id: params[0],
          provider_account_id: params[1],
          entity_type: params[2],
          entity_id: params[3],
          parent_campaign_id: params[4],
          event: params[5],
          declared_role: params[6],
          effective_from: params[7],
          declared_at: params[8],
          declared_by: params[9],
          reason: params[10],
          contract_version: params[11],
        },
      ];
    }
    return [];
  });
}

const insertCalls = () =>
  mocks.query.mock.calls.filter(([sql]) =>
    String(sql).includes("INSERT INTO meta_entity_role_declarations"),
  );

describe("D118 — writing a declaration", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.transaction.mockClear();
  });

  it("records a campaign and a Test ad set as two separate rows, the ad set bound to its observed campaign", async () => {
    binding({ [CAMPAIGN]: [CAMPAIGN], [ADSET]: [CAMPAIGN] });
    const result = await appendEntityRoleDeclarations({
      businessId: "biz",
      providerAccountId: "act_1",
      declaredBy: "user_1",
      now: NOW,
      requests: [
        { entityType: "campaign", entityId: CAMPAIGN, event: "declare", role: "main", effectiveFrom: "2026-09-25" },
        { entityType: "adset", entityId: ADSET, event: "declare", role: "test", effectiveFrom: "2026-09-25", reason: "Test cell" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((event) => [event.entityType, event.declaredRole, event.parentCampaignId])).toEqual([
      ["campaign", "main", null],
      ["adset", "test", CAMPAIGN],
    ]);
    expect(result.events.every((event) => event.contractVersion === ENTITY_ROLE_DECLARATION_CONTRACT_VERSION)).toBe(true);
    expect(result.events.every((event) => event.declaredAt === NOW.toISOString())).toBe(true);
  });

  it("writes nothing when any entity in the batch was never observed in the account", async () => {
    binding({ [CAMPAIGN]: [CAMPAIGN] });
    const result = await appendEntityRoleDeclarations({
      businessId: "biz",
      providerAccountId: "act_1",
      declaredBy: "user_1",
      now: NOW,
      requests: [
        { entityType: "campaign", entityId: CAMPAIGN, event: "declare", role: "main", effectiveFrom: "2026-09-25" },
        { entityType: "adset", entityId: ADSET, event: "declare", role: "test", effectiveFrom: "2026-09-25" },
      ],
    });
    expect(result).toEqual({
      ok: false,
      refusal: "entity_not_observed_in_account",
      index: 1,
      entityId: ADSET,
    });
    expect(insertCalls()).toHaveLength(0);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses an ad set whose parent campaign is not unique", async () => {
    binding({ [ADSET]: [CAMPAIGN, "120251964505870999"] });
    const result = await appendEntityRoleDeclarations({
      businessId: "biz",
      providerAccountId: "act_1",
      declaredBy: "user_1",
      now: NOW,
      requests: [{ entityType: "adset", entityId: ADSET, event: "declare", role: "test", effectiveFrom: "2026-09-25" }],
    });
    expect(result).toMatchObject({ ok: false, refusal: "entity_parent_ambiguous" });
    expect(insertCalls()).toHaveLength(0);
  });

  it("refuses the same entity twice in one batch before touching the database", async () => {
    binding({ [CAMPAIGN]: [CAMPAIGN] });
    const result = await appendEntityRoleDeclarations({
      businessId: "biz",
      providerAccountId: "act_1",
      declaredBy: "user_1",
      now: NOW,
      requests: [
        { entityType: "campaign", entityId: CAMPAIGN, event: "declare", role: "main", effectiveFrom: "2026-09-25" },
        { entityType: "campaign", entityId: CAMPAIGN, event: "revoke", effectiveFrom: "2026-09-25" },
      ],
    });
    expect(result).toMatchObject({ ok: false, refusal: "duplicate_entity_in_request", index: 1 });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
