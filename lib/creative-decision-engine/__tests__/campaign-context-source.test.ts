import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: mocks.query }),
}));

import {
  campaignContextProvenanceFor,
  readAdsetRoleMap,
  readCampaignContextMap,
  resolveCampaignContextMode,
} from "../campaign-context/source";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "../campaign-context/resolver";
import {
  applyMetaCampaignLabelGuard,
  buildMetaCampaignLabelKindMap,
  type MetaCampaignContextGuardEntry,
} from "@/lib/meta/campaign-label-guard";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

const INFERRED_ROW = {
  source_record_id: "00000000-0000-4000-8000-000000000101",
  provider_account_id: "act_1",
  campaign_id: "campaign-inferred",
  source_as_of_date: "2026-07-12",
  inferred_kind: "main",
  confidence_score: 0.91,
  confidence_class: "high",
  resolver_version: "campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01",
  kind_source: "system_inferred",
  kind_basis: "behavioral",
  source_updated_at: "2026-07-12 02:00:00+00",
};

describe("automatic campaign context source", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.query.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses account-scoped system inference as the sole role source but withholds unvalidated hard authority", async () => {
    mocks.query.mockResolvedValue([INFERRED_ROW]);

    const result = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred", "campaign-missing"],
      asOf: "2026-07-12",
    });

    expect(result.get("campaign-inferred")).toMatchObject({
      kind: "main",
      contextTrust: "medium",
      provenance: {
        mode: "automatic",
        source: "system_inferred",
        sourceRecordType: "engine_v3_campaign_context_daily",
        sourceRecordId: INFERRED_ROW.source_record_id,
        sourceAsOfDate: "2026-07-12",
        sourceUpdatedAt: "2026-07-12T02:00:00.000Z",
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(result.get("campaign-missing")?.provenance).toMatchObject({
      mode: "automatic",
      source: "unknown",
      campaignId: "campaign-missing",
    });
    expect(mocks.query.mock.calls[0]?.[0]).toContain(
      "provider_account_id IS NOT NULL",
    );
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      "biz-1",
      ["campaign-inferred", "campaign-missing"],
      "2026-07-12",
      2,
      "act_1",
      // No point-in-time bound on the production path: it reads at "now".
      null,
    ]);
  });

  /*
    ── HISTORICAL REPLAY: ONLY WHAT EXISTED AT THE CUTOFF ────────────────────

    engine_v3_campaign_context_daily is written with ON CONFLICT ... DO UPDATE
    ... updated_at = now(), so a row that existed at a replay's cutoff can have
    been rewritten since. The role the job read is then gone. It is withheld —
    never replaced by an older day the job did not read — and the campaign is
    left unresolved, which holds hard actions.
  */
  it("binds the read to rows created at or before a replay cutoff", async () => {
    mocks.query.mockResolvedValue([INFERRED_ROW]);
    await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred"],
      asOf: "2026-07-12",
      mode: "automatic",
      visibleAtCutoff: "2026-07-12T03:05:00.000Z",
    });
    expect(mocks.query.mock.calls[0]?.[0]).toContain(
      "AND ($6::timestamptz IS NULL OR created_at <= $6::timestamptz)",
    );
    expect(mocks.query.mock.calls[0]?.[1]?.[5]).toBe("2026-07-12T03:05:00.000Z");
  });

  it("POSITIVE: keeps a row last written before the cutoff", async () => {
    mocks.query.mockResolvedValue([INFERRED_ROW]); // updated 02:00
    const exclusions = new Map<string, string>();
    const map = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred"],
      asOf: "2026-07-12",
      mode: "automatic",
      visibleAtCutoff: "2026-07-12T03:05:00.000Z",
      pitExclusions: exclusions as never,
    });
    expect(map.get("campaign-inferred")?.kind).toBe("main");
    expect(exclusions.size).toBe(0);
  });

  it("NEGATIVE: withholds a row rewritten after the cutoff instead of trusting it", async () => {
    mocks.query.mockResolvedValue([
      { ...INFERRED_ROW, source_updated_at: "2026-07-12 09:00:00+00" },
    ]);
    const exclusions = new Map<string, string>();
    const map = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred"],
      asOf: "2026-07-12",
      mode: "automatic",
      visibleAtCutoff: "2026-07-12T03:05:00.000Z",
      pitExclusions: exclusions as never,
    });
    expect(exclusions.get("campaign-inferred")).toBe("overwritten_after_cutoff");
    // Unresolved, not the rewritten role and not an older one.
    expect(map.get("campaign-inferred")).toMatchObject({
      kind: null,
      contextTrust: "unknown",
    });
    // The same row with no cutoff is the production read and is trusted as before.
    const live = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred"],
      asOf: "2026-07-12",
      mode: "automatic",
    });
    expect(live.get("campaign-inferred")?.kind).toBe("main");
  });

  it("refuses a cutoff that is not an instant", async () => {
    await expect(
      readCampaignContextMap({
        businessId: "biz-1",
        providerAccountId: "act_1",
        campaignIds: ["campaign-inferred"],
        asOf: "2026-07-12",
        mode: "automatic",
        visibleAtCutoff: "yesterday",
      }),
    ).rejects.toThrow(/not an instant/);
  });

  it("grants high trust only to the exact independently approved resolver version", async () => {
    vi.stubEnv(
      "CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION",
      "campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01",
    );
    mocks.query.mockResolvedValue([INFERRED_ROW]);

    const result = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred"],
      asOf: "2026-07-12",
    });

    expect(result.get("campaign-inferred")?.contextTrust).toBe("high");
  });

  it("does not approve a stale persisted resolver when the current version is allowed", async () => {
    vi.stubEnv(
      "CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION",
      "campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01",
    );
    mocks.query.mockResolvedValue([
      { ...INFERRED_ROW, resolver_version: "campaign-context-resolver.v1" },
    ]);

    const result = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred"],
      asOf: "2026-07-12",
    });

    expect(result.get("campaign-inferred")?.contextTrust).toBe("medium");
  });

  it("cannot restore manual labels through the legacy mode value", async () => {
    vi.stubEnv("CAMPAIGN_CONTEXT_MODE", "legacy_labels");
    mocks.query.mockResolvedValue([INFERRED_ROW]);

    expect(resolveCampaignContextMode()).toBe("automatic");
    const result = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred"],
      asOf: "2026-07-12",
      mode: "legacy_labels",
    });
    expect(result.get("campaign-inferred")?.provenance.source).toBe(
      "system_inferred",
    );
  });

  it("keeps the emergency unknown mode fail-closed without a DB read", async () => {
    vi.stubEnv("CAMPAIGN_CONTEXT_MODE", "unknown");
    expect(resolveCampaignContextMode()).toBe("unknown");

    const result = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred"],
    });
    expect(result.size).toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("fails closed when physical provider-account scope is missing", async () => {
    const result = await readCampaignContextMap({
      businessId: "biz-1",
      campaignIds: ["campaign-inferred"],
      asOf: "2026-07-12",
    });

    expect(result.size).toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("represents missing campaign identity explicitly", () => {
    expect(
      campaignContextProvenanceFor({
        mode: "automatic",
        campaignId: null,
        entry: null,
      }),
    ).toEqual({
      mode: "automatic",
      source: "unknown",
      campaignId: null,
      kind: null,
      testDimension: null,
      contextTrust: null,
      sourceRecordType: null,
      sourceRecordId: null,
      sourceAsOfDate: null,
      sourceUpdatedAt: null,
      sourceHash: null,
    });
  });
});

// D081 Correction 6. These cases were first written as a throwaway probe that
// scored 10 failures out of 13 against the live reader. They live here now, at
// the same mocked-DB boundary the decisions jobs, ad-decisions, account pulse,
// lane classify and snapshot surfaces actually go through, so the reader can
// never drift back to trusting a normalised provenance string.
describe("readCampaignContextMap exact source and version provenance", () => {
  const AUTHORITY_ROW = {
    source_record_id: "00000000-0000-4000-8000-000000000101",
    provider_account_id: "act_1",
    campaign_id: "cmp-1",
    source_as_of_date: "2026-09-01",
    inferred_kind: "main",
    confidence_score: 0.91,
    confidence_class: "high",
    resolver_version: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    kind_source: "system_inferred",
    kind_basis: "behavioral",
    source_updated_at: "2026-09-01 02:00:00+00",
  };

  const row = (over: Record<string, unknown> = {}) => ({ ...AUTHORITY_ROW, ...over });

  const read = () =>
    readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["cmp-1"],
      asOf: "2026-09-01",
    });

  // The real mapping snapshot.ts performs from reader output to guard input.
  const toGuardMap = (
    resolved: Awaited<ReturnType<typeof readCampaignContextMap>>,
  ) => {
    const context = new Map<string, MetaCampaignContextGuardEntry>();
    for (const [campaignId, entry] of resolved) {
      context.set(campaignId, {
        kind: entry.kind,
        contextTrust: entry.contextTrust ?? "unknown",
        source: entry.provenance.source,
        inferenceConfidenceClass: entry.inferenceConfidenceClass,
        resolverAuthorityValidated: entry.resolverAuthorityValidated,
      });
    }
    return context;
  };

  const hardActionRec = (): MetaRecommendation => ({
    id: "rec-1",
    level: "campaign",
    campaignId: "cmp-1",
    campaignName: "Campaign 1",
    type: "scale_for_volume",
    lens: "volume",
    priority: "high",
    confidence: "high",
    confidenceScore: 0.88,
    confidenceReason: null,
    decisionState: "act",
    decision: "Scale this campaign",
    title: "Scale Campaign 1",
    why: "Campaign 1 is above the calibrated scale line.",
    summary: "Strong campaign.",
    recommendedAction: "Increase budget 10-15%.",
    expectedImpact: "More volume.",
    evidence: [{ label: "ROAS", value: "4.00x", tone: "positive" }],
    timeframeContext: {
      coreVerdict: "Strong",
      selectedRangeOverlay: "Selected range supports scale.",
      historicalSupport: "History supports scale.",
      seasonalityFlag: "none",
      note: null,
    },
  });

  const guardFor = async () =>
    applyMetaCampaignLabelGuard({
      recommendations: [hardActionRec()],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      campaignContextById: toGuardMap(await read()),
      automaticContextEnabled: true,
      activeCampaignIds: ["cmp-1"],
    });

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv(
      "CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION",
      CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    );
    mocks.query.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Positive control. Without this, every assertion below would also pass on a
  // reader that simply never grants authority to anything.
  it("grants high trust only for the exact automatic origin, class and identity", async () => {
    mocks.query.mockResolvedValue([row()]);

    const entry = (await read()).get("cmp-1");

    expect(entry).toMatchObject({
      kind: "main",
      contextTrust: "high",
      inferenceConfidenceClass: "high",
      resolverAuthorityValidated: true,
      provenance: { mode: "automatic", source: "system_inferred" },
    });

    const guard = await guardFor();
    expect(guard.downgradedCount).toBe(0);
    expect(guard.recommendations[0]?.decisionState).toBe("act");
  });

  it.each([
    "manual",
    "legacy_label",
    "user_override",
    "SYSTEM_INFERRED",
    " system_inferred",
    "system_inferred ",
    "",
    null,
  ])("never grants high trust to non-exact persisted kind_source %j", async (kindSource) => {
    mocks.query.mockResolvedValue([row({ kind_source: kindSource })]);

    const entry = (await read()).get("cmp-1");

    expect(entry?.contextTrust).not.toBe("high");
    expect(entry?.contextTrust).toBe("medium");
    // Never a synthesized origin: a non-exact source reports as unknown.
    expect(entry?.provenance.source).toBe("unknown");
  });

  it.each([
    ` ${CAMPAIGN_CONTEXT_RESOLVER_VERSION}`,
    `${CAMPAIGN_CONTEXT_RESOLVER_VERSION} `,
    CAMPAIGN_CONTEXT_RESOLVER_VERSION.toUpperCase(),
    "",
    null,
  ])(
    "never grants high trust to non-exact persisted resolver_version %j",
    async (resolverVersion) => {
      mocks.query.mockResolvedValue([row({ resolver_version: resolverVersion })]);

      const entry = (await read()).get("cmp-1");

      expect(entry?.contextTrust).not.toBe("high");
      expect(entry?.contextTrust).toBe("medium");
      expect(entry?.resolverAuthorityValidated).toBe(false);
    },
  );

  it.each([
    { label: "kind_source", over: { kind_source: " system_inferred" } },
    { label: "kind_source", over: { kind_source: "manual" } },
    {
      label: "resolver_version",
      over: { resolver_version: `${CAMPAIGN_CONTEXT_RESOLVER_VERSION} ` },
    },
  ])(
    "keeps the downstream guard demoted when $label is not exact",
    async ({ over }) => {
      mocks.query.mockResolvedValue([row(over)]);

      const guard = await guardFor();

      expect(guard.downgradedCount).toBe(1);
      expect(guard.recommendations[0]).toMatchObject({
        decisionState: "watch",
        automationReadiness: { autoExecuteEligible: false },
      });
    },
  );

  it("binds the raw provenance strings into the source hash", async () => {
    const variants = [
      {},
      { kind_source: " system_inferred" },
      { kind_source: "system_inferred " },
      { kind_source: "SYSTEM_INFERRED" },
      { kind_source: "" },
      { resolver_version: ` ${CAMPAIGN_CONTEXT_RESOLVER_VERSION}` },
      { resolver_version: `${CAMPAIGN_CONTEXT_RESOLVER_VERSION} ` },
    ];

    const hashes: string[] = [];
    for (const over of variants) {
      mocks.query.mockResolvedValue([row(over)]);
      const hash = (await read()).get("cmp-1")?.provenance.sourceHash;
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      hashes.push(hash as string);
    }

    // No whitespace or case variant may hash identically to the exact value,
    // or to another variant.
    expect(new Set(hashes).size).toBe(variants.length);
  });
});

describe("D118 — explicit entity role declarations at the source", () => {
  const AUTOMATIC_MEDIUM = {
    ...INFERRED_ROW,
    campaign_id: "cmp-main",
    confidence_class: "medium",
  };
  const declarationRow = (overrides: Record<string, unknown>) => ({
    id: "00000000-0000-4000-8000-00000000d118",
    business_id: "biz-1",
    provider_account_id: "act_1",
    entity_type: "campaign",
    entity_id: "cmp-main",
    parent_campaign_id: null,
    event: "declare",
    declared_role: "main",
    effective_from: "2026-07-12",
    declared_at: "2026-07-12T01:00:00.000Z",
    declared_by: "user-1",
    reason: null,
    contract_version: "meta-entity-role-declaration.v1",
    ...overrides,
  });
  const DECLARATIONS = [
    declarationRow({}),
    declarationRow({
      id: "00000000-0000-4000-8000-00000000d119",
      entity_type: "adset",
      entity_id: "as-test",
      parent_campaign_id: "cmp-main",
      declared_role: "test",
    }),
  ];

  function dispatch(declarationResult: () => unknown[]) {
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM engine_v3_campaign_context_daily")) return [AUTOMATIC_MEDIUM];
      if (sql.includes("FROM meta_entity_role_declarations")) {
        const rows = declarationResult();
        return rows.filter(
          (row) => (row as { entity_type: string }).entity_type === params[2],
        );
      }
      return [];
    });
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.query.mockReset();
  });

  it("a campaign declaration replaces the automatic row, and each ad set is resolved on its own", async () => {
    dispatch(() => DECLARATIONS);
    const campaigns = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["cmp-main"],
      asOf: "2026-07-12",
    });
    expect(campaigns.get("cmp-main")).toMatchObject({
      kind: "main",
      contextTrust: "high",
      declarationAuthorityValidated: true,
      resolverAuthorityValidated: false,
      roleEntityType: "campaign",
      provenance: {
        source: "operator_declared",
        sourceRecordType: "meta_entity_role_declarations",
      },
    });
    const adsets = await readAdsetRoleMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      adsets: [
        { adsetId: "as-test", campaignId: "cmp-main" },
        { adsetId: "as-open", campaignId: "cmp-main" },
      ],
      campaignContext: campaigns,
      asOf: "2026-07-12",
    });
    expect(adsets.get("as-test")).toMatchObject({
      kind: "test",
      contextTrust: "high",
      declarationAuthorityValidated: true,
      roleEntityType: "adset",
    });
    expect(adsets.get("as-open")).toMatchObject({
      kind: "main",
      contextTrust: "medium",
      declarationAuthorityValidated: false,
      roleBasis: "parent_campaign_suggestion",
    });
  });

  it("the unknown circuit breaker disables declarations with automatic context", async () => {
    vi.stubEnv("CAMPAIGN_CONTEXT_MODE", "unknown");
    dispatch(() => DECLARATIONS);
    const campaigns = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["cmp-main"],
      asOf: "2026-07-12",
    });
    expect(campaigns.size).toBe(0);
    const adsets = await readAdsetRoleMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      adsets: [{ adsetId: "as-test", campaignId: "cmp-main" }],
      campaignContext: campaigns,
      asOf: "2026-07-12",
    });
    expect(adsets.get("as-test")).toMatchObject({ kind: null, contextTrust: "unknown" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("before the migration the missing table reads as nothing declared; any other failure throws", async () => {
    dispatch(() => {
      throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
    });
    const campaigns = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["cmp-main"],
      asOf: "2026-07-12",
    });
    expect(campaigns.get("cmp-main")).toMatchObject({
      contextTrust: "medium",
      provenance: { source: "system_inferred" },
    });
    dispatch(() => {
      throw Object.assign(new Error("statement timeout"), { code: "57014" });
    });
    await expect(
      readCampaignContextMap({
        businessId: "biz-1",
        providerAccountId: "act_1",
        campaignIds: ["cmp-main"],
        asOf: "2026-07-12",
      }),
    ).rejects.toThrow("statement timeout");
  });

  it("a declared ad set placed under another campaign carries no declared role", async () => {
    dispatch(() => DECLARATIONS);
    const campaigns = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["cmp-main"],
      asOf: "2026-07-12",
    });
    const adsets = await readAdsetRoleMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      adsets: [{ adsetId: "as-test", campaignId: "cmp-moved" }],
      campaignContext: campaigns,
      asOf: "2026-07-12",
    });
    expect(adsets.get("as-test")).toMatchObject({
      contextTrust: "unknown",
      declarationAuthorityValidated: false,
    });
    expect(adsets.get("as-test")?.roleBasis).not.toBe("declared");
  });

  it("binds declarations to the knowledge of the run that publishes the generation", async () => {
    dispatch(() => DECLARATIONS);
    await readAdsetRoleMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      adsets: [{ adsetId: "as-test", campaignId: "cmp-main" }],
      campaignContext: new Map(),
      asOf: "2026-07-12",
      declarationKnowledgeJobRunId: "00000000-0000-4000-8000-0000000000aa",
    });
    const [sql, params] = mocks.query.mock.calls.find(([text]) =>
      String(text).includes("FROM meta_entity_role_declarations"),
    )!;
    expect(String(sql)).toMatch(
      /declared_at <= \(\s*SELECT run\.started_at FROM engine_v3_job_runs run WHERE run\.id = \$7::uuid\s*\)/,
    );
    expect(params[6]).toBe("00000000-0000-4000-8000-0000000000aa");
  });

  it("a replay binds the declaration read to its cutoff", async () => {
    dispatch(() => DECLARATIONS);
    await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["cmp-main"],
      asOf: "2026-07-12",
      visibleAtCutoff: "2026-07-12T00:59:00.000Z",
    });
    const declarationCall = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM meta_entity_role_declarations"),
    );
    expect(declarationCall?.[1]).toEqual([
      "biz-1",
      "act_1",
      "campaign",
      ["cmp-main"],
      "2026-07-12",
      "2026-07-12T00:59:00.000Z",
      null,
    ]);
  });
});
