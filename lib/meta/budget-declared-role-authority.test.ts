import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: vi.fn(async () => []) }),
  runDbTransaction: vi.fn(),
}));

import {
  ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
  type EntityRoleDeclarationEvent,
} from "@/lib/creative-decision-engine/campaign-context/entity-role";
import {
  BUDGET_DECLARED_ROLE_AUTHORITY_CONTRACT,
  declaredBudgetRoleBindsScope,
  resolveDeclaredBudgetRoleAuthority,
  type DeclaredBudgetRoleRequest,
} from "./budget-declared-role-authority";

/*
  D121 golden — declared role authority for a budget proposal.

  A Main campaign runs a separate Test ad set. The campaign's budget reads the
  campaign's declaration; the ad set's budget reads the ad set's, bound to the
  campaign it was declared under. Knowledge is bounded by the run's start and
  by both the decision's day and the proposal's day.
*/

const BIZ = "biz-1";
const ACCOUNT = "act_1";
const MAIN_CAMPAIGN = "120251964505870042";
const TEST_ADSET = "120251964734540042";
const RUN_STARTED = "2026-09-25T03:00:00.000Z";

let seq = 0;
function event(over: Partial<EntityRoleDeclarationEvent> = {}): EntityRoleDeclarationEvent {
  seq += 1;
  return {
    id: `e-${seq}`,
    businessId: BIZ,
    providerAccountId: ACCOUNT,
    entityType: "adset",
    entityId: TEST_ADSET,
    parentCampaignId: MAIN_CAMPAIGN,
    event: "declare",
    declaredRole: "test",
    effectiveFrom: "2026-09-20",
    declaredAt: "2026-09-20T10:00:00.000Z",
    declaredBy: "user-1",
    reason: null,
    contractVersion: ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
    ...over,
  };
}

const campaignMain = () => event({
  entityType: "campaign",
  entityId: MAIN_CAMPAIGN,
  parentCampaignId: null,
  declaredRole: "main",
});

function request(over: Partial<DeclaredBudgetRoleRequest> = {}): DeclaredBudgetRoleRequest {
  return {
    businessId: BIZ,
    providerAccountId: ACCOUNT,
    ownerGrain: "adset",
    entityId: TEST_ADSET,
    parentCampaignId: MAIN_CAMPAIGN,
    decisionDay: "2026-09-24",
    decidedAt: "2026-09-24T15:00:00.000Z",
    proposalDay: "2026-09-25",
    recordedBy: RUN_STARTED,
    ...over,
  };
}

describe("D121 — which declaration authorises a budget proposal", () => {
  it("R121-01: a Test ad set inside a Main campaign binds its OWN Test declaration", () => {
    const result = resolveDeclaredBudgetRoleAuthority(request(), [campaignMain(), event()]);
    expect(result).toMatchObject({
      status: "declared",
      authority: {
        contract: BUDGET_DECLARED_ROLE_AUTHORITY_CONTRACT,
        declarationContract: ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
        role: "test",
        entityGrain: "adset",
        entityId: TEST_ADSET,
        campaignId: MAIN_CAMPAIGN,
        recordedBy: RUN_STARTED,
      },
    });
  });

  it("R121-02: the Main campaign's budget binds the campaign's declaration, not its ad set's", () => {
    const result = resolveDeclaredBudgetRoleAuthority(
      request({ ownerGrain: "campaign", entityId: MAIN_CAMPAIGN, parentCampaignId: null }),
      [campaignMain(), event()],
    );
    expect(result).toMatchObject({
      status: "declared",
      authority: { role: "main", entityGrain: "campaign", campaignId: MAIN_CAMPAIGN },
    });
  });

  it("R121-03: an undeclared ad set of a declared Main campaign has NO declared role", () => {
    expect(resolveDeclaredBudgetRoleAuthority(request(), [campaignMain()]))
      .toEqual({ status: "none", refusal: "declaration_absent" });
  });

  it("R121-04: a declaration recorded after the run began is not this run's knowledge", () => {
    // A decision recorded after the run began, so the run start is the bound.
    const decidedLater = request({ decidedAt: "2026-09-25T06:30:00.000Z" });
    const late = event({ declaredAt: "2026-09-25T03:00:00.001Z" });
    expect(resolveDeclaredBudgetRoleAuthority(decidedLater, [late]))
      .toEqual({ status: "none", refusal: "declaration_absent" });
    const exact = event({ declaredAt: RUN_STARTED });
    expect(resolveDeclaredBudgetRoleAuthority(decidedLater, [exact]).status).toBe("declared");
  });

  it("R121-05: a declaration effective only after the decision day refuses, without fallback", () => {
    const fromToday = event({ effectiveFrom: "2026-09-25", declaredAt: "2026-09-25T01:00:00.000Z" });
    expect(resolveDeclaredBudgetRoleAuthority(request(), [fromToday]))
      .toEqual({ status: "none", refusal: "declaration_not_in_force_on_decision_day" });
  });

  it("R121-06: a revoke effective since the decision day withdraws it, without fallback", () => {
    const revoke = event({
      event: "revoke", declaredRole: null,
      effectiveFrom: "2026-09-25", declaredAt: "2026-09-25T01:00:00.000Z",
    });
    expect(resolveDeclaredBudgetRoleAuthority(request(), [event(), revoke]))
      .toEqual({ status: "none", refusal: "declaration_withdrawn_since_decision_day" });
  });

  it("R121-07: a role changed since the decision day refuses", () => {
    const toMain = event({
      declaredRole: "main", effectiveFrom: "2026-09-25", declaredAt: "2026-09-25T01:00:00.000Z",
    });
    expect(resolveDeclaredBudgetRoleAuthority(request(), [event(), toMain]))
      .toEqual({ status: "none", refusal: "declaration_changed_since_decision_day" });
  });

  it("R121-08: an ad set now under ANOTHER campaign does not receive its declaration", () => {
    expect(resolveDeclaredBudgetRoleAuthority(
      request({ parentCampaignId: "120251964505870999" }), [event()],
    )).toEqual({ status: "none", refusal: "adset_declaration_parent_mismatch" });
    expect(resolveDeclaredBudgetRoleAuthority(request({ parentCampaignId: null }), [event()]))
      .toEqual({ status: "none", refusal: "adset_parent_unknown" });
  });

  it("R121-09: both days' records must name the placement", () => {
    const moved = event({
      parentCampaignId: "120251964505870999",
      effectiveFrom: "2026-09-25", declaredAt: "2026-09-25T01:00:00.000Z",
    });
    expect(resolveDeclaredBudgetRoleAuthority(request(), [event(), moved]))
      .toEqual({ status: "none", refusal: "adset_declaration_parent_mismatch" });
  });

  it("R121-10: another account, business or contract is not this entity's declaration", () => {
    for (const foreign of [
      event({ providerAccountId: "act_2" }),
      event({ businessId: "biz-2" }),
      event({ contractVersion: "meta-entity-role-declaration.v0" }),
      // A campaign declaration never stands in for the ad set with the same id.
      event({ entityType: "campaign", parentCampaignId: null }),
    ]) {
      expect(resolveDeclaredBudgetRoleAuthority(request(), [foreign]))
        .toEqual({ status: "none", refusal: "declaration_absent" });
    }
  });

  it("R121-11: an ad set can never hold a Mixed declaration", () => {
    expect(resolveDeclaredBudgetRoleAuthority(request(), [event({ declaredRole: "mixed" })]))
      .toEqual({ status: "none", refusal: "declaration_absent" });
  });

  it("R121-12: an unparseable knowledge bound admits nothing", () => {
    expect(resolveDeclaredBudgetRoleAuthority(request({ recordedBy: "not-an-instant" }), [event()]))
      .toEqual({ status: "none", refusal: "declaration_knowledge_bound_invalid" });
  });
});

describe("D121 C1 — the decision's own knowledge bounds the decision day", () => {
  /*
    The counterexample: a decision computed 24 Sep 15:00; a declaration
    recorded 25 Sep 16:00 with effectiveFrom 24 Sep; a proposal run 25 Sep
    17:00. The decision was never made under that declaration, so it can
    never be lifted into a proposal by it.
  */
  const counterexample = () => request({
    decisionDay: "2026-09-24",
    decidedAt: "2026-09-24T15:00:00.000Z",
    proposalDay: "2026-09-25",
    recordedBy: "2026-09-25T17:00:00.000Z",
  });

  it("R121-13: a declaration recorded after the decision never authorises that decision", () => {
    const late = event({ effectiveFrom: "2026-09-24", declaredAt: "2026-09-25T16:00:00.000Z" });
    expect(resolveDeclaredBudgetRoleAuthority(counterexample(), [late]))
      .toEqual({ status: "none", refusal: "declaration_not_in_force_on_decision_day" });
  });

  it("R121-14: the proposal run still sees a revoke recorded after the decision", () => {
    const before = event({ effectiveFrom: "2026-09-20", declaredAt: "2026-09-24T10:00:00.000Z" });
    const revoke = event({
      event: "revoke", declaredRole: null,
      effectiveFrom: "2026-09-25", declaredAt: "2026-09-25T16:00:00.000Z",
    });
    expect(resolveDeclaredBudgetRoleAuthority(counterexample(), [before]).status).toBe("declared");
    expect(resolveDeclaredBudgetRoleAuthority(counterexample(), [before, revoke]))
      .toEqual({ status: "none", refusal: "declaration_withdrawn_since_decision_day" });
  });

  it("R121-15: in the deciding run itself, the run's start is the tighter decision bound", () => {
    const sameRun = request({
      decisionDay: "2026-09-25",
      decidedAt: "2026-09-25T06:30:00.000Z",
      proposalDay: "2026-09-25",
      recordedBy: "2026-09-25T03:00:00.000Z",
    });
    const betweenStartAndDecision = event({
      effectiveFrom: "2026-09-24", declaredAt: "2026-09-25T05:00:00.000Z",
    });
    expect(resolveDeclaredBudgetRoleAuthority(sameRun, [betweenStartAndDecision]))
      .toEqual({ status: "none", refusal: "declaration_absent" });
  });

  it("R121-16: an unparseable decision instant admits nothing", () => {
    expect(resolveDeclaredBudgetRoleAuthority(
      request({ decidedAt: "not-an-instant" }), [event()],
    )).toEqual({ status: "none", refusal: "declaration_knowledge_bound_invalid" });
  });
});

describe("D121 — the composition re-checks what the loader resolved", () => {
  const bound = () => {
    const result = resolveDeclaredBudgetRoleAuthority(request(), [event()]);
    if (result.status !== "declared") throw new Error("fixture must bind");
    return result.authority;
  };
  const scope = {
    ownerGrain: "adset" as const,
    entityId: TEST_ADSET,
    parentCampaignId: MAIN_CAMPAIGN,
    decidedAt: "2026-09-24T15:00:00.000Z",
    knowledgeMs: Date.parse("2026-09-25T04:00:00.000Z"),
  };

  it("binds exactly the scope it was resolved for", () => {
    expect(declaredBudgetRoleBindsScope(bound(), scope)).toBe(true);
  });

  it("refuses a different entity, grain, parent, contract or a late record", () => {
    const authority = bound();
    expect(declaredBudgetRoleBindsScope(authority, { ...scope, entityId: "other" })).toBe(false);
    expect(declaredBudgetRoleBindsScope(authority, { ...scope, ownerGrain: "campaign" })).toBe(false);
    expect(declaredBudgetRoleBindsScope(authority, { ...scope, parentCampaignId: "other" })).toBe(false);
    expect(declaredBudgetRoleBindsScope({ ...authority, contract: "x" as never }, scope)).toBe(false);
    expect(declaredBudgetRoleBindsScope({ ...authority, role: "mixed" }, scope)).toBe(false);
    expect(declaredBudgetRoleBindsScope(authority, {
      ...scope, knowledgeMs: Date.parse("2026-09-25T02:00:00.000Z"),
    })).toBe(false);
    expect(declaredBudgetRoleBindsScope({
      ...authority, declaredAt: "2026-09-25T03:30:00.000Z",
    }, scope)).toBe(false);
    expect(declaredBudgetRoleBindsScope(null, scope)).toBe(false);
    // D121 C1: another decision, or a decision record made after the decision.
    expect(declaredBudgetRoleBindsScope(authority, {
      ...scope, decidedAt: "2026-09-23T15:00:00.000Z",
    })).toBe(false);
    expect(declaredBudgetRoleBindsScope(authority, { ...scope, decidedAt: null })).toBe(false);
    expect(declaredBudgetRoleBindsScope({
      ...authority, decisionDeclaredAt: "2026-09-24T15:00:00.001Z",
    }, scope)).toBe(false);
    // A decision record the reading run could not have known.
    expect(declaredBudgetRoleBindsScope({
      ...authority,
      decidedAt: "2026-09-26T00:00:00.000Z",
      decisionDeclaredAt: "2026-09-25T03:00:00.001Z",
    }, { ...scope, decidedAt: "2026-09-26T00:00:00.000Z" })).toBe(false);
  });
});
