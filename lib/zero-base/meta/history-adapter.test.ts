import { describe, expect, it } from "vitest";

import {
  actionFor,
  actorFor,
  historyAccountLabel,
  historyEntityLabel,
  historyLabelFor,
  historySummaryFor,
  moneyFactText,
  toHistoryPage,
  toHistoryRow,
} from "@/lib/zero-base/meta/history-adapter";
import type {
  MetaHistoryEntry,
  MetaHistoryResponse,
} from "@/lib/meta/history-contract";

function entry(overrides: Partial<MetaHistoryEntry> = {}): MetaHistoryEntry {
  return {
    id: "h1",
    kind: "writes",
    occurredAt: "2026-08-11T09:00:00.000Z",
    title: "Pause ad",
    summary: null,
    entity: { type: "ad", id: "ad-1", name: "Ad 1" },
    label: null,
    status: "verified_success",
    actor: { id: "u1", name: "Ada", availability: "available" },
    identity: {
      canonicalDecisionId: null,
      sourceId: "s1",
      sourceIdKind: "persisted_uuid",
      limitation: "",
    },
    provenance: {
      provider: "meta",
      source: "meta_ads_action_log",
      sourceId: "s1",
      accountScopeBasis: "exact_entity_key",
      attribution: "provider_write_log",
    },
    correlation: { status: "keyed", key: "k1", reason: null },
    replay: null,
    money: [],
    detail: null,
    ...overrides,
  } as MetaHistoryEntry;
}

function outcomeEntry(
  overrides: Partial<MetaHistoryEntry> = {},
): MetaHistoryEntry {
  return entry({
    kind: "outcomes",
    status: "improved",
    actor: { id: null, name: null, availability: "not_applicable" },
    provenance: {
      provider: "meta",
      source: "meta_decision_action_outcome_logs",
      sourceId: "outcome-1",
      accountScopeBasis: "exact_entity_key",
      attribution: "correlational_outcome",
    },
    ...overrides,
  });
}

function decisionEntry(
  overrides: Partial<MetaHistoryEntry> = {},
): MetaHistoryEntry {
  return entry({
    kind: "decisions",
    status: "published",
    entity: { type: "creative", id: "creative-1", name: "Creative 1" },
    actor: { id: null, name: null, availability: "not_applicable" },
    provenance: {
      provider: "meta",
      source: "engine_v3_decision_snapshots_daily",
      sourceId: "snapshot-1",
      accountScopeBasis: "unique_creative_key",
      attribution: "engine_snapshot",
    },
    ...overrides,
  });
}

function payload(
  overrides: Partial<MetaHistoryResponse> = {},
): MetaHistoryResponse {
  return {
    mode: "read_only",
    scope: {
      businessId: "biz-1",
      providerAccountId: "act_1",
      providerAccountName: "Main account",
      currency: "USD",
      timezone: "UTC",
    },
    filters: {
      businessId: "biz-1",
      providerAccountId: "act_1",
      kind: null,
      entity: null,
      label: null,
      from: null,
      to: null,
      q: null,
    },
    entries: [entry()],
    page: { limit: 40, returned: 1, total: null, nextCursor: null },
    identityContract: {
      canonicalDecisionIdAvailable: false,
      grouping: "persisted_source_rows",
      limitation: "",
    },
    limitations: [],
    ...overrides,
  } as MetaHistoryResponse;
}

describe("actor provenance survives the mapping", () => {
  it("passes a recorded name through", () => {
    expect(actorFor(entry())).toBe("Ada");
  });

  it("returns null when the actor is unavailable, so the view says not recorded", () => {
    // Not "System": that would be a claim about who acted.
    expect(
      actorFor(
        entry({ actor: { id: null, name: null, availability: "unavailable" } }),
      ),
    ).toBeNull();
  });

  it("names automation only for engine-owned events", () => {
    expect(
      actorFor(
        entry({
          actor: { id: null, name: null, availability: "not_applicable" },
          provenance: {
            provider: "meta",
            source: "engine_v3_decision_snapshots_daily",
            sourceId: "snapshot-1",
            accountScopeBasis: "unique_creative_key",
            attribution: "engine_snapshot",
          },
        }),
      ),
    ).toBe("Automated");
  });

  it("calls warehouse and outcome facts observed rather than automated", () => {
    expect(
      actorFor(
        entry({
          kind: "structures",
          actor: { id: null, name: null, availability: "not_applicable" },
          provenance: {
            provider: "meta",
            source: "meta_campaign_dimensions",
            sourceId: "campaign-1",
            accountScopeBasis: "direct_provider_account_id",
            attribution: "warehouse_dimension",
          },
        }),
      ),
    ).toBe("Observed");
  });

  it("does not invent automation for an unattributed write", () => {
    expect(
      actorFor(
        entry({
          actor: { id: null, name: null, availability: "not_applicable" },
          provenance: {
            provider: "meta",
            source: "meta_decision_action_outcome_logs",
            sourceId: "action-1",
            accountScopeBasis: "exact_entity_key",
            attribution: "provider_write_log",
          },
        }),
      ),
    ).toBeNull();
  });

  it("uses event provenance for transitions and measured outcomes", () => {
    expect(
      actorFor(
        entry({
          kind: "label_flips",
          actor: { id: null, name: null, availability: "not_applicable" },
          provenance: {
            provider: "meta",
            source: "engine_v3_decision_events",
            sourceId: "event-1",
            accountScopeBasis: "unique_creative_key",
            attribution: "engine_transition",
          },
        }),
      ),
    ).toBe("Automated");
    expect(
      actorFor(
        entry({
          kind: "outcomes",
          actor: { id: null, name: null, availability: "not_applicable" },
          provenance: {
            provider: "meta",
            source: "engine_v3_decision_outcomes_daily",
            sourceId: "outcome-1",
            accountScopeBasis: "unique_creative_key",
            attribution: "correlational_outcome",
          },
        }),
      ),
    ).toBe("Observed");
  });

  it("treats unattributed external changes as observations", () => {
    expect(
      actorFor(
        entry({
          kind: "external_changes",
          actor: { id: null, name: null, availability: "not_applicable" },
        }),
      ),
    ).toBe("Observed");
  });

  it("respects unavailable actor evidence even on an engine event", () => {
    expect(
      actorFor(
        entry({
          actor: { id: null, name: null, availability: "unavailable" },
          provenance: {
            provider: "meta",
            source: "engine_v3_decision_events",
            sourceId: "manual-event-1",
            accountScopeBasis: "unique_creative_key",
            attribution: "engine_transition",
          },
        }),
      ),
    ).toBeNull();
  });

  it("treats an available-but-empty name as unrecorded", () => {
    expect(
      actorFor(
        entry({ actor: { id: "u1", name: "  ", availability: "available" } }),
      ),
    ).toBeNull();
  });

  it("never publishes a pseudo-actor name without trustworthy provenance", () => {
    expect(
      actorFor(
        entry({ actor: { id: "service", name: "System", availability: "available" } }),
      ),
    ).toBeNull();
    expect(
      actorFor(
        decisionEntry({
          actor: { id: "service", name: "System", availability: "available" },
        }),
      ),
    ).toBe("Automated");
  });
});

describe("replay provenance survives the mapping", () => {
  it("marks a replayed entry", () => {
    const row = toHistoryRow(
      entry({ replay: { date: "2026-08-01", engineVersion: "v3" } }),
    );
    expect(row.replayed).toBe(true);
  });

  it("does not mark an entry recorded at the time", () => {
    expect(toHistoryRow(entry()).replayed).toBe(false);
  });

  it("carries the engine version the replay names", () => {
    // The boolean alone cannot answer the question the design's replay caveat
    // raises ("Replay ≠ live; V1/V2 snapshot badges"): which engine produced
    // the snapshot. Dropping it here left no replay able to say.
    const row = toHistoryRow(
      entry({ replay: { date: "2026-08-01", engineVersion: "v3" } }),
    );
    expect(row.replayEngineVersion).toBe("v3");
  });

  it("keeps a null engine version null rather than substituting one", () => {
    // An unsupplied fact stays unsupplied; the view renders it as an em-dash.
    const row = toHistoryRow(
      entry({ replay: { date: "2026-08-01", engineVersion: null } }),
    );
    expect(row.replayed).toBe(true);
    expect(row.replayEngineVersion).toBeNull();
  });
});

describe("the row names the entity it is about", () => {
  it("appends the entity when the served title does not already carry it", () => {
    // The decisions branch serves a bare verdict ("Persisted decision" /
    // "Scale budget"), so the operator could not tell which campaign or ad set
    // a money move concerned.
    expect(
      actionFor(
        entry({
          title: "Scale budget",
          entity: { type: "campaign", id: "c-1", name: "Prospecting — broad" },
        }),
      ),
    ).toBe("Scale budget | Prospecting — broad");
  });

  it("does not duplicate an entity the SQL already folded into the title", () => {
    // Write and external-change rows are served as "… | <entity>" already.
    expect(
      actionFor(
        entry({
          title: "Pause Ad | Ad 1",
          entity: { type: "ad", id: "ad-1", name: "Ad 1" },
        }),
      ),
    ).toBe("Pause Ad | Ad 1");
  });

  it("uses a neutral entity label instead of exposing the provider id", () => {
    expect(
      actionFor(
        entry({
          title: "Scale budget",
          entity: { type: "adset", id: "as-9", name: null },
        }),
      ),
    ).toBe("Scale budget | Unnamed ad set");
  });

  it("replaces a provider id already folded into the title", () => {
    const providerId = "238901234567890";
    const action = actionFor(
      entry({
        title: `Pause Ad | ${providerId}`,
        entity: { type: "ad", id: providerId, name: providerId },
      }),
    );

    expect(action).toBe("Pause Ad | Unnamed ad");
    expect(action).not.toContain(providerId);
  });

  it("leaves the title alone when no entity was served", () => {
    expect(
      actionFor(
        entry({
          title: "Scale budget",
          entity: { type: "ad", id: "", name: null },
        }),
      ),
    ).toBe("Scale budget");
  });

  it("replaces internal campaign-role instructions with a buyer action", () => {
    const action = actionFor(
      entry({
        title:
          "Refresh campaign evidence and rerun automatic role inference before taking hard action.",
        entity: { type: "campaign", id: "campaign-1", name: "Prospecting" },
      }),
    );

    expect(action).toBe("Review campaign setup | Prospecting");
    expect(action).not.toMatch(/inference|engine|hard action/i);
  });

  it("does not turn a resolved campaign role into an unclear setup", () => {
    const action = actionFor(
      decisionEntry({
        title: "Automatic campaign role resolved as Main",
        entity: { type: "campaign", id: "campaign-1", name: "Prospecting" },
      }),
    );

    expect(action).toBe("Campaign role confirmed: Main | Prospecting");
    expect(action).not.toContain("Review campaign setup");
  });

  it("turns workflow storage titles into concise decision activity", () => {
    expect(
      actionFor(
        entry({
          kind: "decisions",
          title: "Workflow acknowledge",
          entity: { type: "recommendation", id: "decision:key", name: null },
        }),
      ),
    ).toBe("Decision acknowledged | Unnamed recommendation");
  });

  it("turns provider-attempt storage titles into a buyer action", () => {
    expect(
      actionFor(
        entry({
          kind: "writes",
          title: "Provider write provider_response_verified_success",
          status: "verified_success",
          entity: { type: "ad", id: "ad-1", name: "Summer ad" },
        }),
      ),
    ).toBe("Change verified | Summer ad");
  });

  it("turns the engine's out-of-scope title into a buyer-facing result", () => {
    const action = actionFor(
      decisionEntry({
        title: "Out Of Scope decision",
        label: "out_of_scope",
        entity: { type: "creative", id: "creative-1", name: "Summer video" },
      }),
    );

    expect(action).toBe("No recommendation | Summer video");
    expect(action).not.toMatch(/out of scope decision/i);
  });

  it("maps every persisted Engine V3 event title and fails closed on additions", () => {
    const eventEntry = (title: string) =>
      entry({
        kind: "label_flips",
        title,
        status: "recorded",
        entity: { type: "creative", id: "creative-1", name: "Summer video" },
        actor: { id: null, name: null, availability: "not_applicable" },
        provenance: {
          provider: "meta",
          source: "engine_v3_decision_events",
          sourceId: "event-1",
          accountScopeBasis: "unique_creative_key",
          attribution: "engine_transition",
        },
      });

    expect(
      [
        "Decision Changed",
        "Operator Action",
        "Data Disabled",
        "Manual Override",
      ].map((title) => actionFor(eventEntry(title))),
    ).toEqual([
      "Decision changed | Summer video",
      "Operator action recorded | Summer video",
      "Decision data unavailable | Summer video",
      "Decision changed manually | Summer video",
    ]);
    expect(actionFor(eventEntry("New Backend Event"))).toBe(
      "Decision changed | Summer video",
    );
  });

  it("maps outcome-log storage actions without claiming an unverified rollback", () => {
    const actionOutcome = (
      title: string,
      kind: MetaHistoryEntry["kind"],
      status: MetaHistoryEntry["status"],
    ) =>
      entry({
        kind,
        title,
        status,
        entity: { type: "ad", id: "ad-1", name: "Summer ad" },
        actor: { id: null, name: null, availability: "not_applicable" },
        provenance: {
          provider: "meta",
          source: "meta_decision_action_outcome_logs",
          sourceId: "outcome-log-1",
          accountScopeBasis: "exact_entity_key",
          attribution:
            kind === "outcomes" ? "correlational_outcome" : "provider_write_log",
        },
      });

    expect(
      actionFor(actionOutcome("Operator Response", "responses", "recorded")),
    ).toBe("Operator response recorded | Summer ad");
    expect(actionFor(actionOutcome("Preflight", "writes", "recorded"))).toBe(
      "Change checked | Summer ad",
    );
    expect(actionFor(actionOutcome("Execute", "writes", "executing"))).toBe(
      "Change in progress | Summer ad",
    );
    expect(
      actionFor(actionOutcome("Rollback", "writes", "recorded")),
    ).toBe("Change recorded | Summer ad");
    expect(actionFor(actionOutcome("Outcome", "outcomes", "positive"))).toBe(
      "Outcome recorded | Summer ad",
    );
    expect(
      actionFor(actionOutcome("Unknown Internal Step", "writes", "failed")),
    ).toBe("Change failed | Summer ad");
  });

  it("replaces backend error titles with a truthful status action", () => {
    const action = actionFor(
      entry({
        title: "Database relation history_rows failed at history-read-model.sql:42",
        status: "failed",
        entity: { type: "ad", id: "ad-1", name: "Summer ad" },
      }),
    );

    expect(action).toBe("Change failed | Summer ad");
    expect(action).not.toMatch(/database|relation|\.sql/i);
  });

  it("keeps a partial write truthful when its stored title is unusable", () => {
    expect(
      actionFor(
        entry({
          title: "provider_partial_write_error",
          status: "partially_succeeded",
          entity: { type: "ad", id: "ad-1", name: "Summer ad" },
        }),
      ),
    ).toBe("Change partially applied | Summer ad");
    expect(
      actionFor(
        entry({
          title: "Provider write provider_partial_write_error",
          status: "partially_succeeded",
          entity: { type: "ad", id: "ad-1", name: "Summer ad" },
        }),
      ),
    ).toBe("Change partially applied | Summer ad");
  });

  it("only translates known launch titles and hides arbitrary LaunchIntent detail", () => {
    expect(
      actionFor(
        entry({
          kind: "launches",
          title: "New Campaign LaunchIntent",
          entity: { type: "launch_intent", id: "launch-1", name: "Prospecting" },
        }),
      ),
    ).toBe("New campaign launch | Prospecting");
    expect(
      actionFor(
        entry({
          kind: "launches",
          title: "Retry database_error LaunchIntent",
          entity: { type: "launch_intent", id: "launch-1", name: "Prospecting" },
        }),
      ),
    ).toBe("Launch updated | Prospecting");
  });

  it("masks provider ids in the entity heading", () => {
    expect(
      historyEntityLabel(
        entry({
          entity: {
            type: "creative",
            id: "238901234567890",
            name: "238901234567890",
          },
        }),
      ),
    ).toBe("Unnamed creative");
  });

  it("shows only known buyer labels and hides stored codes", () => {
    expect(historyLabelFor(entry({ label: "test_more" }))).toBe("Test more");
    expect(
      historyLabelFor(
        entry({ label: "role_source_not_system_inferred" }),
      ),
    ).toBeNull();
    expect(historyLabelFor(entry({ label: "238901234567890" }))).toBeNull();
  });
});

describe("served detail reaches the row", () => {
  it("carries buyer-facing summary prose and money facts", () => {
    const money = [
      {
        label: "Before spend",
        amount: 120,
        currency: "USD",
        availability: "available" as const,
        attribution: "meta_attributed" as const,
      },
    ];
    const row = toHistoryRow(
      outcomeEntry({ summary: "Spend outran the floor.", money }),
    );
    expect(row.summary).toBe("Spend outran the floor.");
    expect(row.money).toEqual(money);
  });

  it("maps automatic KPI storage text without losing the measured result", () => {
    const raw = "auto_kpi_7d: improved (ROAS 1.25 -> 2.10, operator acted)";
    const row = toHistoryRow(outcomeEntry({ status: "improved", summary: raw }));
    expect(row.summary).toBe(
      "ROAS improved from 1.25 to 2.10 over the next 7 days. A recorded action was applied.",
    );
    expect(row.summary).not.toContain("auto_kpi_7d");
  });

  it("replaces the Engine V3 outcome projection and hides unexpected source text", () => {
    const engineOutcome = (summary: string) =>
      entry({
        kind: "outcomes",
        title: "7-day outcome",
        summary,
        status: "positive",
        entity: { type: "creative", id: "creative-1", name: "Summer video" },
        actor: { id: null, name: null, availability: "not_applicable" },
        provenance: {
          provider: "meta",
          source: "engine_v3_decision_outcomes_daily",
          sourceId: "outcome-1",
          accountScopeBasis: "unique_creative_key",
          attribution: "correlational_outcome",
        },
      });

    expect(
      historySummaryFor(
        engineOutcome("Persisted correlational outcome for test more."),
      ),
    ).toBe("Performance outcome recorded for this recommendation.");
    expect(
      historySummaryFor(engineOutcome("Classifier completed normally.")),
    ).toBeNull();
  });

  it("does not publish free-form Engine V3 event notes", () => {
    expect(
      historySummaryFor(
        entry({
          kind: "label_flips",
          title: "Decision Changed",
          summary: "Transition persisted after nightly evaluation.",
          status: "recorded",
          provenance: {
            provider: "meta",
            source: "engine_v3_decision_events",
            sourceId: "event-1",
            accountScopeBasis: "unique_creative_key",
            attribution: "engine_transition",
          },
        }),
      ),
    ).toBeNull();
  });

  it("allows measured outcome prose but hides unknown outcome-log summaries", () => {
    expect(
      historySummaryFor(
        outcomeEntry({ status: "positive", summary: "Analysis completed." }),
      ),
    ).toBeNull();
    expect(
      historySummaryFor(
        outcomeEntry({
          status: "positive",
          summary: "Revenue improved while spend held steady.",
        }),
      ),
    ).toBe("Revenue improved while spend held steady.");
  });

  it("hides unknown machine summaries while preserving the status", () => {
    const item = decisionEntry({
      status: "unknown",
      summary: "source_read_failed: relation activity missing",
    });
    expect(historySummaryFor(item)).toBe("The result could not be verified.");
    expect(toHistoryRow(item).outcome).toBe("unknown");
  });

  it("rewrites campaign-role engine language without dropping the reason", () => {
    const item = decisionEntry({
      summary:
        "Automatic Main/Test/Mixed campaign role is unresolved. Fresh high-confidence context is required before the engine emits hard scale, cut, bid, or budget moves.",
    });
    expect(historySummaryFor(item)).toBe(
      "Campaign setup is unclear, so spend changes are waiting for fresher evidence.",
    );
  });

  it("keeps useful evidence before replacing an internal role-inference clause", () => {
    const item = decisionEntry({
      summary:
        "ROAS is 1.4 against a 2.5 target. Automatic campaign-role inference is unresolved, so this hard action is capped to soft-only.",
    });
    expect(historySummaryFor(item)).toBe(
      "ROAS is 1.4 against a 2.5 target. Campaign setup is unclear, so spend changes are waiting for fresher evidence.",
    );
  });

  it("preserves a resolved role without fabricating a campaign blocker", () => {
    expect(
      historySummaryFor(
        decisionEntry({ summary: "Automatic campaign role resolved as Main" }),
      ),
    ).toBe("Campaign role: Main.");
  });

  it("keeps buyer metrics beside a translated resolved role", () => {
    expect(
      historySummaryFor(
        decisionEntry({
          summary:
            "ROAS improved from 1.8 to 2.3. Automatic campaign role resolved as Main.",
        }),
      ),
    ).toBe("ROAS improved from 1.8 to 2.3. Campaign role: Main.");
  });

  it("keeps an explicit low-confidence blocker even when a role was classified", () => {
    expect(
      historySummaryFor(
        decisionEntry({
          summary:
            "Automatic campaign role resolved as Main, but campaign context has low confidence.",
        }),
      ),
    ).toBe(
      "Campaign setup is unclear, so spend changes are waiting for fresher evidence.",
    );
  });

  it("turns a human workflow reason code into readable copy", () => {
    expect(historySummaryFor(entry({ summary: "seasonal_expected" }))).toBe(
      "Seasonal change was expected.",
    );
  });

  it("does not expose a technical machine code", () => {
    expect(
      historySummaryFor(
        entry({ status: "failed", summary: "provider_source_read_failed" }),
      ),
    ).toBe("The result could not be verified.");
  });

  it("fails closed on an unknown machine code even when it sounds harmless", () => {
    expect(
      historySummaryFor(
        decisionEntry({ summary: "unknown_operator_reason" }),
      ),
    ).toBeNull();
  });

  it("never exposes provider or database error prose", () => {
    expect(
      historySummaryFor(
        entry({
          status: "failed",
          summary:
            "Provider request failed because database relation decisions does not exist.",
        }),
      ),
    ).toBe("The result could not be verified.");
  });

  it("states partial application without presenting it as a total failure", () => {
    expect(
      historySummaryFor(
        entry({
          status: "partially_succeeded",
          summary: "provider_partial_write_error",
        }),
      ),
    ).toBe(
      "Some changes were applied. Review the result before continuing.",
    );
  });

  it("states partial application even when stored detail sounds successful", () => {
    expect(
      historySummaryFor(
        entry({
          status: "partially_succeeded",
          summary: "Two ads were updated and one remains unchanged.",
        }),
      ),
    ).toBe(
      "Some changes were applied. Review the result before continuing.",
    );
    expect(
      historySummaryFor(
        entry({ status: "partially_succeeded", summary: null }),
      ),
    ).toBe(
      "Some changes were applied. Review the result before continuing.",
    );
  });

  it("falls back on unknown error prose instead of exposing its detail", () => {
    expect(
      historySummaryFor(
        entry({
          status: "failed",
          summary: "Request failed with HTTP 500 at apply-change.ts:42.",
          provenance: {
            provider: "meta",
            source: "meta_ads_action_log",
            sourceId: "action-1",
            accountScopeBasis: "exact_entity_key",
            attribution: "provider_write_log",
          },
        }),
      ),
    ).toBe("The result could not be verified.");
  });

  it("preserves normal buyer-facing performance evidence", () => {
    const summary =
      "ROAS improved from 1.80 to 2.35 while CPA fell from 42 to 31.";
    expect(historySummaryFor(outcomeEntry({ summary }))).toBe(summary);
  });

  it("rewrites state-row implementation language", () => {
    expect(
      historySummaryFor(
        decisionEntry({
          summary:
            "Entity is mature enough for coverage but does not meet a scenario action threshold.",
        }),
      ),
    ).toBe("Current performance does not justify a change.");
    expect(
      historySummaryFor(
        decisionEntry({
          summary:
            "Adset is configured for landing page views delivery; not evaluated in the purchase decision engine.",
        }),
      ),
    ).toBe(
      "Ad set is optimized for landing page views, so purchase-based changes do not apply.",
    );
  });

  it("translates creative context failures without exposing engine language", () => {
    expect(
      historySummaryFor(
        decisionEntry({
          summary: "mixed decision context; evaluate at ad grain",
        }),
      ),
    ).toBe(
      "This creative appears in multiple ads, so no single recommendation was made.",
    );
    expect(
      historySummaryFor(
        decisionEntry({
          summary:
            "decision context identity unavailable; evaluate at ad grain",
        }),
      ),
    ).toBe(
      "The matching ad could not be identified, so no recommendation was made.",
    );
  });

  it("removes decision-engine tags while keeping ROAS evidence", () => {
    expect(
      historySummaryFor(
        decisionEntry({
          summary:
            "[soft-only - cut blocked] ROAS 2.72 (28d) = 49% of target after 4,938 spend. (threshold baseline account_history has low confidence (meta AOV ready))",
        }),
      ),
    ).toBe(
      "ROAS 2.72 (28d) = 49% of target after 4,938 spend.",
    );
  });

  it("does not let a soft-only prefix carry backend detail through", () => {
    expect(
      historySummaryFor(
        decisionEntry({
          status: "unknown",
          summary: "[soft-only - cut blocked] Redis connection timed out.",
        }),
      ),
    ).toBe("The result could not be verified.");
  });

  it("does not let target tags carry backend detail through", () => {
    expect(
      historySummaryFor(
        decisionEntry({
          status: "unknown",
          summary: "[at target] Redis connection timed out.",
        }),
      ),
    ).toBe("The result could not be verified.");
  });

  it("adds campaign setup copy only when the stored blocker says campaign context", () => {
    expect(
      historySummaryFor(
        decisionEntry({
          summary:
            "[Campaign context low confidence - hard action restricted] ROAS 1.20 is 34% of target.",
        }),
      ),
    ).toBe(
      "ROAS 1.20 is 34% of target. Campaign setup is unclear, so spend changes are waiting for fresher evidence.",
    );
  });

  it("does not treat a resolved campaign-context tag as a blocker", () => {
    expect(
      historySummaryFor(
        decisionEntry({
          summary:
            "[Campaign context resolved] ROAS 2.40 is above target.",
        }),
      ),
    ).toBe("ROAS 2.40 is above target.");
  });
});

describe("buyer-facing account labels", () => {
  it("uses a real account name", () => {
    expect(historyAccountLabel({ id: "act_12345678", name: "Main" })).toBe(
      "Main",
    );
  });

  it("masks an unnamed account instead of exposing the provider id", () => {
    const label = historyAccountLabel({ id: "act_12345678", name: null });
    expect(label).toBe("Meta account ••••5678");
    expect(label).not.toContain("act_12345678");
  });

  it("treats a provider id copied into the name field as unnamed", () => {
    expect(
      historyAccountLabel({ id: "act_12345678", name: "act_12345678" }),
    ).toBe("Meta account ••••5678");
    expect(historyAccountLabel({ id: "act_12345678", name: "12345678" })).toBe(
      "Meta account ••••5678",
    );
  });

  it("masks a different opaque identifier copied into the account name", () => {
    for (const name of [
      "act_87654321",
      "238901234567890",
      "123e4567-e89b-42d3-a456-426614174000",
    ]) {
      const label = historyAccountLabel({ id: "act_12345678", name });
      expect(label).toBe("Meta account ••••5678");
      expect(label).not.toContain(name);
    }
  });
});

describe("money is only money in a currency", () => {
  it("prints the served amount with its currency", () => {
    expect(
      moneyFactText({
        label: "Outcome spend",
        amount: 41.5,
        currency: "EUR",
        availability: "available",
        attribution: "meta_attributed",
      }),
    ).toBe("41.5 EUR");
  });

  it("prints an em-dash when the currency could not be resolved", () => {
    // A bare number would be read in whatever currency the operator assumes,
    // which is a figure nobody served.
    expect(
      moneyFactText({
        label: "Outcome spend",
        amount: null,
        currency: null,
        availability: "currency_unavailable",
        attribution: "meta_attributed",
      }),
    ).toBe("—");
  });
});

describe("stored truth survives the buyer-facing mapping", () => {
  it("copies the stored status through and keeps a normal action intact", () => {
    const row = toHistoryRow(
      entry({ title: "Resume ad set", status: "silent_failure" }),
    );
    expect(row.action.startsWith("Resume ad set")).toBe(true);
    expect(row.action).toBe("Resume ad set | Ad 1");
    expect(row.outcome).toBe("silent_failure");
  });

  it("leaves a title that already names its entity exactly as served", () => {
    const row = toHistoryRow(
      entry({ title: "Resume ad set | Ad 1", status: "verified_success" }),
    );
    expect(row.action).toBe("Resume ad set | Ad 1");
  });
});

describe("page cap disclosure", () => {
  it("says more exist when a cursor was returned", () => {
    const page = toHistoryPage(
      payload({
        page: { limit: 40, returned: 40, total: null, nextCursor: "c1" },
      }),
    );
    expect(page.disclosure).toMatch(/More exist beyond this page/);
  });

  it("names the cap when the page is full without a cursor", () => {
    const page = toHistoryPage(
      payload({
        page: { limit: 40, returned: 40, total: null, nextCursor: null },
      }),
    );
    expect(page.disclosure).toMatch(/maximum for one page/);
  });

  it("discloses nothing when the page is genuinely short", () => {
    expect(toHistoryPage(payload()).disclosure).toBeNull();
  });

  it("never states a total, because the cursor path does not compute one", () => {
    const page = toHistoryPage(
      payload({
        page: { limit: 40, returned: 40, total: null, nextCursor: "c1" },
      }),
    );
    expect(page.disclosure).not.toMatch(/\btotal\b/i);
    expect(page.disclosure).not.toMatch(/\bof \d+/);
  });

  it("carries the read model's own limitation messages through", () => {
    const page = toHistoryPage(
      payload({
        limitations: [
          {
            code: "business_only_rows_omitted",
            message: "Rows without an account scope were omitted.",
          },
        ],
      } as Partial<MetaHistoryResponse>),
    );
    expect(page.limitations).toEqual([
      "Rows without an account scope were omitted.",
    ]);
  });

  it("names the account the journal was read for", () => {
    expect(toHistoryPage(payload()).accountLabel).toBe("Main account");
  });

  it("does not use the full account id when its name is unavailable", () => {
    const page = toHistoryPage(
      payload({
        scope: {
          ...payload().scope,
          providerAccountId: "act_12345678",
          providerAccountName: null,
        },
      }),
    );
    expect(page.accountLabel).toBe("Meta account ••••5678");
    expect(page.accountLabel).not.toContain("act_12345678");
  });
});
