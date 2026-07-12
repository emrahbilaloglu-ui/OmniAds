import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  HistoricalReplayChrome,
  MetaHistoryEntries,
} from "@/app/(dashboard)/platforms/meta/history/history-view";
import type { MetaHistoryEntry } from "@/lib/meta/history-contract";

const unavailableEntry: MetaHistoryEntry = {
  id: "meta_ads_action_log:log_1",
  kind: "writes",
  occurredAt: "2026-07-10T10:00:00.000Z",
  title: "Pause | Summer ad",
  summary: "Provider response was recorded, but no decision reference was persisted.",
  entity: { type: "ad", id: "ad_1", name: "Summer ad" },
  label: "cut",
  status: "silent_failure",
  actor: { id: null, name: null, availability: "unavailable" },
  identity: {
    canonicalDecisionId: null,
    sourceId: "log_1",
    sourceIdKind: "persisted_uuid",
    limitation: "A canonical date-free decision ID is not persisted yet.",
  },
  provenance: {
    provider: "meta",
    source: "meta_ads_action_log",
    sourceId: "log_1",
    accountScopeBasis: "exact_entity_key",
    attribution: "provider_write_log",
  },
  correlation: {
    status: "unavailable",
    key: null,
    reason: "The action log does not persist a decision reference.",
  },
  replay: { date: "2026-07-10", engineVersion: "meta-v1" },
  money: [
    {
      label: "Spend at decision",
      amount: null,
      currency: null,
      availability: "currency_unavailable",
      attribution: "meta_attributed",
    },
  ],
  detail: { verification: { status: "ACTIVE" } },
};

describe("Meta History route UI", () => {
  it("renders unmistakable read-only Historical Replay chrome", () => {
    const html = renderToStaticMarkup(
      <HistoricalReplayChrome date="2026-07-10" engineVersions={["v3-test"]} />,
    );

    expect(html).toContain("Historical Replay");
    expect(html).toContain("actions disabled");
    expect(html).toContain("Persisted decision snapshots only");
    expect(html).toContain("read only");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("method=\"post\"");
  });

  it("shows unavailable joins, actors, and currency rather than fabricated values", () => {
    const html = renderToStaticMarkup(
      <MetaHistoryEntries entries={[unavailableEntry]} onOpenReplay={vi.fn()} />,
    );

    expect(html).toContain("Silent failure");
    expect(html).toContain("Actor unavailable");
    expect(html).toContain("Join unavailable");
    expect(html).toContain("The action log does not persist a decision reference");
    expect(html).toContain("unavailable - currency not persisted");
    expect(html).toContain("meta_ads_action_log");
    expect(html).toContain("type=\"button\"");
    expect(html).not.toContain("$0");
    expect(html).not.toContain("USD");
  });
});
