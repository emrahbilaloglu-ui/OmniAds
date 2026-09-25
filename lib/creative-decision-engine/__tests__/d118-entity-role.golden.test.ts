import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  adsetRoleEntryFromParent,
  adsetRoleKey,
  declaredEntityRoleEntry,
  ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
  isEntityRoleTrustedForAction,
  selectActiveEntityRoleDeclaration,
  validateEntityRoleDeclarationRequest,
  type EntityRoleDeclarationEvent,
} from "../campaign-context/entity-role";
import type { CampaignContextEntryWithProvenance } from "../campaign-context/source";
import {
  applyCreativeCampaignLabelGuard,
  withCreativeCampaignLabelContext,
} from "../campaign-label-guard";
import { nativeAdRoleEntry } from "../jobs/ad-decisions-job";
import type { DecisionOutput } from "../types";

/*
  D118 golden cases — campaign and ad set roles are separate entities.

  The anchor case is the one the operator named: a Main campaign that runs a
  separate Test ad set. An Ad's role-dependent semantics follow its OWN ad
  set; the campaign's role reaches an ad set only as a suggestion capped below
  authority. Names are never read.
*/

const BUSINESS = "biz_d118";
const ACCOUNT = "act_d118";
const AS_OF = "2026-09-25";
const MAIN_CAMPAIGN = "120251964505870042";
const TEST_ADSET = "120251964505870100";
const UNDECLARED_ADSET = "120251964505870200";

function event(
  overrides: Partial<EntityRoleDeclarationEvent> = {},
): EntityRoleDeclarationEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    entityType: "campaign",
    entityId: MAIN_CAMPAIGN,
    parentCampaignId: null,
    event: "declare",
    declaredRole: "main",
    effectiveFrom: "2026-09-25",
    declaredAt: "2026-09-25T08:00:00.000Z",
    declaredBy: "user_1",
    reason: "Always-on prospecting",
    contractVersion: ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
    ...overrides,
  };
}

const campaignDeclaration = event();
const testAdsetDeclaration = event({
  id: "00000000-0000-4000-8000-000000000002",
  entityType: "adset",
  entityId: TEST_ADSET,
  parentCampaignId: MAIN_CAMPAIGN,
  declaredRole: "test",
  reason: "Creative test cell inside the Main campaign",
});

function mainCampaignEntry() {
  return declaredEntityRoleEntry({ declaration: campaignDeclaration, mode: "automatic" });
}

function automaticCampaignEntry(
  contextTrust: "high" | "medium",
): CampaignContextEntryWithProvenance {
  return {
    kind: "main",
    testDimension: null,
    contextTrust,
    inferenceConfidenceClass: contextTrust,
    resolverAuthorityValidated: contextTrust === "high",
    provenance: {
      mode: "automatic",
      source: "system_inferred",
      campaignId: MAIN_CAMPAIGN,
      kind: "main",
      testDimension: null,
      contextTrust,
      sourceRecordType: "engine_v3_campaign_context_daily",
      sourceRecordId: "context-1",
      sourceAsOfDate: AS_OF,
      sourceUpdatedAt: `${AS_OF}T02:00:00.000Z`,
      sourceHash: "a".repeat(64),
    },
  };
}

function hardDecision(label: "cut" | "scale" | "refresh"): DecisionOutput {
  return {
    creativeId: "creative-1",
    creativeName: "Creative",
    label,
    reason: "Mature verdict.",
    confidence: 80,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: label === "cut" ? 0.4 : 1.8,
    badges: [],
    metrics: { spend: 500, purchases: 4, roas: 0.8, recent7dRoas: 0.8 },
    preAuthorityLabel: label,
    authorityBlocker: null,
    blockedActionType: null,
    engineVersion: "fixture",
    generatedAt: `${AS_OF}T03:00:00.000Z`,
  };
}

function ad(adsetId: string | null) {
  return {
    providerAccountId: ACCOUNT,
    adsetId,
    campaignId: MAIN_CAMPAIGN,
  };
}

describe("D118 — a Main campaign can run a Test ad set", () => {
  const campaignContextById = new Map([[MAIN_CAMPAIGN, mainCampaignEntry()]]);
  const adsetRoleByKey = new Map([
    [
      adsetRoleKey(ACCOUNT, TEST_ADSET),
      declaredEntityRoleEntry({ declaration: testAdsetDeclaration, mode: "automatic" }),
    ],
  ]);

  it("R118-01: an Ad in the declared Test ad set carries Test semantics under a declared Main campaign", () => {
    const role = nativeAdRoleEntry({
      ad: ad(TEST_ADSET),
      campaignContextById,
      adsetRoleByKey,
      mode: "automatic",
    });
    expect(role).toMatchObject({
      kind: "test",
      contextTrust: "high",
      roleEntityType: "adset",
      roleEntityId: TEST_ADSET,
      roleBasis: "declared",
      provenance: { source: "operator_declared", roleEntityType: "adset" },
    });
    expect(isEntityRoleTrustedForAction(role)).toBe(true);
    expect(withCreativeCampaignLabelContext({ campaignId: MAIN_CAMPAIGN }, campaignContextById, role))
      .toMatchObject({ campaignKind: "test" });
    const guarded = applyCreativeCampaignLabelGuard({
      decision: hardDecision("scale"),
      input: { campaignId: MAIN_CAMPAIGN },
      campaignLabelsById: campaignContextById,
      roleEntry: role,
    });
    expect(guarded).toMatchObject({
      label: "scale",
      authorityBlocker: null,
      blockedActionType: null,
      campaignRoleStatus: "resolved",
      campaignKind: "test",
    });
  });

  it("R118-02: an Ad in an undeclared ad set of the same Main campaign gets the campaign role only as a suggestion", () => {
    const role = nativeAdRoleEntry({
      ad: ad(UNDECLARED_ADSET),
      campaignContextById,
      adsetRoleByKey,
      mode: "automatic",
    });
    expect(role).toMatchObject({
      kind: "main",
      contextTrust: "medium",
      resolverAuthorityValidated: false,
      declarationAuthorityValidated: false,
      roleEntityType: "adset",
      roleEntityId: UNDECLARED_ADSET,
      roleBasis: "parent_campaign_suggestion",
    });
    expect(isEntityRoleTrustedForAction(role)).toBe(false);
    expect(withCreativeCampaignLabelContext({ campaignId: MAIN_CAMPAIGN }, campaignContextById, role).campaignKind)
      .toBeNull();
    const guarded = applyCreativeCampaignLabelGuard({
      decision: hardDecision("cut"),
      input: { campaignId: MAIN_CAMPAIGN },
      campaignLabelsById: campaignContextById,
      roleEntry: role,
    });
    // The verdict survives (D097); only the role-dependent action is held.
    expect(guarded).toMatchObject({
      label: "cut",
      authorityBlocker: "campaign_context",
      blockedActionType: "cut",
    });
  });

  it("R118-03: a trusted automatic campaign role never passes down to an undeclared ad set", () => {
    const role = nativeAdRoleEntry({
      ad: ad(UNDECLARED_ADSET),
      campaignContextById: new Map([[MAIN_CAMPAIGN, automaticCampaignEntry("high")]]),
      adsetRoleByKey: new Map(),
      mode: "automatic",
    });
    expect(role.contextTrust).toBe("medium");
    expect(isEntityRoleTrustedForAction(role)).toBe(false);
    // Omitting the ad set map is not a back door either.
    const omitted = nativeAdRoleEntry({
      ad: ad(UNDECLARED_ADSET),
      campaignContextById: new Map([[MAIN_CAMPAIGN, automaticCampaignEntry("high")]]),
      mode: "automatic",
    });
    expect(isEntityRoleTrustedForAction(omitted)).toBe(false);
  });

  it("R118-04: a declared ad set is authority even when its campaign has no role at all", () => {
    const role = nativeAdRoleEntry({
      ad: ad(TEST_ADSET),
      campaignContextById: new Map(),
      adsetRoleByKey,
      mode: "automatic",
    });
    expect(role.kind).toBe("test");
    expect(isEntityRoleTrustedForAction(role)).toBe(true);
  });

  it("R118-13: a declared ad set role does not follow the ad set into another campaign", () => {
    const role = nativeAdRoleEntry({
      ad: { providerAccountId: ACCOUNT, adsetId: TEST_ADSET, campaignId: "120251964505879999" },
      campaignContextById,
      adsetRoleByKey,
      mode: "automatic",
    });
    expect(role.roleBasis).not.toBe("declared");
    expect(isEntityRoleTrustedForAction(role)).toBe(false);
  });

  it("R118-05: an Ad without an ad set identity has no role authority", () => {
    const role = nativeAdRoleEntry({
      ad: ad(null),
      campaignContextById,
      adsetRoleByKey,
      mode: "automatic",
    });
    expect(role.roleEntityId).toBeNull();
    expect(isEntityRoleTrustedForAction(role)).toBe(false);
  });
});

describe("D118 — which declaration is in force", () => {
  const scope = {
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    entityType: "adset" as const,
    entityId: TEST_ADSET,
    asOf: AS_OF,
  };

  it("R118-06: the latest recorded event wins, and a revoke removes the role", () => {
    const later = event({
      ...testAdsetDeclaration,
      id: "00000000-0000-4000-8000-000000000003",
      declaredRole: "main",
      declaredAt: "2026-09-25T09:00:00.000Z",
    });
    expect(selectActiveEntityRoleDeclaration([testAdsetDeclaration, later], scope)?.declaredRole)
      .toBe("main");
    const revoke = event({
      ...testAdsetDeclaration,
      id: "00000000-0000-4000-8000-000000000004",
      event: "revoke",
      declaredRole: null,
      declaredAt: "2026-09-25T10:00:00.000Z",
    });
    expect(selectActiveEntityRoleDeclaration([testAdsetDeclaration, later, revoke], scope)).toBeNull();
  });

  it("R118-07: a replay sees a declaration only from when it was recorded, and a future-dated one not yet", () => {
    expect(
      selectActiveEntityRoleDeclaration([testAdsetDeclaration], {
        ...scope,
        visibleAtCutoff: "2026-09-25T07:59:59.000Z",
      }),
    ).toBeNull();
    expect(
      selectActiveEntityRoleDeclaration(
        [event({ ...testAdsetDeclaration, effectiveFrom: "2026-09-26" })],
        scope,
      ),
    ).toBeNull();
  });

  it("R118-08: another account, business, entity type or contract never applies", () => {
    for (const foreign of [
      event({ ...testAdsetDeclaration, providerAccountId: "act_other" }),
      event({ ...testAdsetDeclaration, businessId: "biz_other" }),
      event({ ...testAdsetDeclaration, entityType: "campaign" }),
      event({ ...testAdsetDeclaration, contractVersion: "meta-entity-role-declaration.v0" }),
      // An ad set cannot be declared Mixed; a stray row is ignored, not repaired.
      event({ ...testAdsetDeclaration, declaredRole: "mixed" }),
    ]) {
      expect(selectActiveEntityRoleDeclaration([foreign], scope)).toBeNull();
    }
  });

  it("R118-09: a declaration cannot reach back before the day it is recorded", () => {
    const now = new Date("2026-09-25T12:00:00.000Z");
    const request = {
      entityType: "adset",
      entityId: TEST_ADSET,
      event: "declare",
      role: "test",
      effectiveFrom: "2026-09-24",
    };
    expect(validateEntityRoleDeclarationRequest(request, now)).toBeNull();
    expect(validateEntityRoleDeclarationRequest({ ...request, effectiveFrom: "2026-09-23" }, now))
      .toBe("effective_from_backdated");
    expect(validateEntityRoleDeclarationRequest({ ...request, role: "mixed" }, now))
      .toBe("role_invalid_for_entity");
    expect(validateEntityRoleDeclarationRequest({ ...request, event: "revoke" }, now))
      .toBe("role_present_on_revoke");
    expect(validateEntityRoleDeclarationRequest({ ...request, entityId: "TS_TEST_BIDCAP" }, now))
      .toBe("entity_id_missing");
  });
});

describe("D118 — what does not change", () => {
  it("R118-10: NEGATIVE CONTROL — with nothing declared, an undeclared ad set carries the campaign entry unchanged when it is below high", () => {
    const campaign = automaticCampaignEntry("medium");
    const role = adsetRoleEntryFromParent({
      adsetId: UNDECLARED_ADSET,
      campaignId: MAIN_CAMPAIGN,
      parent: campaign,
      mode: "automatic",
    });
    // Same trust, same provenance object: the hashed evaluation input of every
    // pre-D118 row is reproduced exactly.
    expect(role.contextTrust).toBe("medium");
    expect(role.provenance).toBe(campaign.provenance);
  });

  it("R118-11: only two provenances can be authority, each with its own proof", () => {
    const declared = declaredEntityRoleEntry({ declaration: campaignDeclaration, mode: "automatic" });
    expect(isEntityRoleTrustedForAction(declared)).toBe(true);
    expect(isEntityRoleTrustedForAction({ ...declared, declarationAuthorityValidated: false })).toBe(false);
    expect(isEntityRoleTrustedForAction(automaticCampaignEntry("high"))).toBe(true);
    expect(
      isEntityRoleTrustedForAction({ ...automaticCampaignEntry("high"), resolverAuthorityValidated: false }),
    ).toBe(false);
    // The retired manual origins are never authority, whatever trust they claim.
    for (const source of ["user_override", "legacy_label", "unknown"] as const) {
      expect(
        isEntityRoleTrustedForAction({
          ...declared,
          provenance: { ...declared.provenance, source },
        }),
      ).toBe(false);
    }
  });

  it("R118-12: role authority never reads a name or the retired manual-label table", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/creative-decision-engine/campaign-context/entity-role.ts"),
      "utf8",
    );
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(executable).not.toMatch(/campaign_name|campaignName|adset_name|adsetName|entity_name|\.name\b/);
    expect(executable).not.toMatch(/meta_campaign_labels?|meta_campaign_label_history/);
  });
});
