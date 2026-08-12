import { describe, expect, it } from "vitest";

import { actorFor, toHistoryPage, toHistoryRow } from "@/lib/zero-base/meta/history-adapter";
import type { MetaHistoryEntry, MetaHistoryResponse } from "@/lib/meta/history-contract";

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

function payload(overrides: Partial<MetaHistoryResponse> = {}): MetaHistoryResponse {
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
    expect(actorFor(entry({ actor: { id: null, name: null, availability: "unavailable" } }))).toBeNull();
  });

  it("names the engine when no human actor applies", () => {
    expect(
      actorFor(entry({ actor: { id: null, name: null, availability: "not_applicable" } })),
    ).toBe("No human actor (engine)");
  });

  it("treats an available-but-empty name as unrecorded", () => {
    expect(actorFor(entry({ actor: { id: "u1", name: "  ", availability: "available" } }))).toBeNull();
  });
});

describe("replay provenance survives the mapping", () => {
  it("marks a replayed entry", () => {
    const row = toHistoryRow(entry({ replay: { date: "2026-08-01", engineVersion: "v3" } }));
    expect(row.replayed).toBe(true);
  });

  it("does not mark an entry recorded at the time", () => {
    expect(toHistoryRow(entry()).replayed).toBe(false);
  });
});

describe("served text is not re-derived", () => {
  it("uses the served title and status verbatim", () => {
    const row = toHistoryRow(entry({ title: "Resume ad set", status: "silent_failure" }));
    expect(row.action).toBe("Resume ad set");
    expect(row.outcome).toBe("silent_failure");
  });
});

describe("page cap disclosure", () => {
  it("says more exist when a cursor was returned", () => {
    const page = toHistoryPage(
      payload({ page: { limit: 40, returned: 40, total: null, nextCursor: "c1" } }),
    );
    expect(page.disclosure).toMatch(/More exist beyond this page/);
  });

  it("names the cap when the page is full without a cursor", () => {
    const page = toHistoryPage(
      payload({ page: { limit: 40, returned: 40, total: null, nextCursor: null } }),
    );
    expect(page.disclosure).toMatch(/maximum for one page/);
  });

  it("discloses nothing when the page is genuinely short", () => {
    expect(toHistoryPage(payload()).disclosure).toBeNull();
  });

  it("never states a total, because the cursor path does not compute one", () => {
    const page = toHistoryPage(
      payload({ page: { limit: 40, returned: 40, total: null, nextCursor: "c1" } }),
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
    expect(page.limitations).toEqual(["Rows without an account scope were omitted."]);
  });

  it("names the account the journal was read for", () => {
    expect(toHistoryPage(payload()).accountLabel).toBe("Main account");
  });
});
