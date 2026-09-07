import { describe, expect, it } from "vitest";

import {
  actionFor,
  actorFor,
  historyAccountLabel,
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
    kind: "decision",
    occurredAt: "2026-08-11T09:00:00.000Z",
    title: "Pause ad",
    summary: null,
    entity: { type: "ad", id: "ad-1", name: "Ad 1" },
    label: null,
    status: "verified",
    actor: { id: "u1", name: "Ada", availability: "available" },
    identity: {
      canonicalDecisionId: null,
      sourceId: "s1",
      sourceIdKind: "meta_ad_status_attempt",
      limitation: "",
    },
    provenance: {
      provider: "meta",
      source: "meta_ad_status_attempts",
      sourceId: "s1",
      accountScopeBasis: "attempt_provider_account",
      attribution: "provider_write_log",
    },
    correlation: { status: "keyed", key: "k1", reason: null },
    replay: null,
    money: [],
    detail: null,
    ...overrides,
  } as MetaHistoryEntry;
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

  it("names the engine when no human actor applies", () => {
    expect(
      actorFor(
        entry({
          actor: { id: null, name: null, availability: "not_applicable" },
        }),
      ),
    ).toBe("No human actor (engine)");
  });

  it("treats an available-but-empty name as unrecorded", () => {
    expect(
      actorFor(
        entry({ actor: { id: "u1", name: "  ", availability: "available" } }),
      ),
    ).toBeNull();
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
      entry({ summary: "Spend outran the floor.", money }),
    );
    expect(row.summary).toBe("Spend outran the floor.");
    expect(row.money).toEqual(money);
  });

  it("maps automatic KPI storage text without losing the measured result", () => {
    const raw = "auto_kpi_7d: improved (ROAS 1.25 -> 2.10, operator acted)";
    const row = toHistoryRow(entry({ status: "improved", summary: raw }));
    expect(row.summary).toBe(
      "ROAS improved from 1.25 to 2.10 over the next 7 days. A recorded action was applied.",
    );
    expect(row.summary).not.toContain("auto_kpi_7d");
  });

  it("hides unknown machine summaries while preserving the status", () => {
    const item = entry({
      status: "unknown",
      summary: "source_read_failed: relation activity missing",
    });
    expect(historySummaryFor(item)).toBeNull();
    expect(toHistoryRow(item).outcome).toBe("unknown");
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

describe("served text is not re-derived", () => {
  // Restated, not relaxed. The law was and is: nothing here recomputes what the
  // read model served — the status word is copied through untouched, and the
  // served title is never rewritten, reworded or replaced.
  //
  // What this test used to also assert, incidentally, was that the Action cell
  // is *nothing but* the title. That was pinning a data loss: the decisions
  // branch serves a bare verdict ("Scale budget"), so a money move arrived with
  // no campaign or ad set on it and the operator could not tell what it was
  // about. The served entity is now appended after the served title, in the same
  // " | " form the SQL already uses on the branches that fold it in themselves.
  // Appended, never substituted.
  it("copies the served status through and keeps the served title intact", () => {
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
