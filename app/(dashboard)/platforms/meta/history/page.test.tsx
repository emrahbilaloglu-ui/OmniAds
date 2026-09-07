import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  HistoricalReplayChrome,
  META_HISTORY_PARTIAL_REASON,
  MetaHistoryEntries,
} from "@/app/(dashboard)/platforms/meta/history/history-view";
import type { MetaHistoryEntry } from "@/lib/meta/history-contract";

const unavailableEntry: MetaHistoryEntry = {
  id: "meta_ads_action_log:log_1",
  kind: "writes",
  occurredAt: "2026-07-10T10:00:00.000Z",
  title: "Pause | Summer ad",
  summary:
    "Provider response was recorded, but no decision reference was persisted.",
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
  it("uses buyer-facing copy for incomplete optional history sources", () => {
    expect(META_HISTORY_PARTIAL_REASON).toBe(
      "Some history data is unavailable. Try again.",
    );
    expect(META_HISTORY_PARTIAL_REASON).not.toMatch(/optional|source|journal/i);
  });

  /**
   * D078 R5: the manual Test/Main campaign-label product is gone (D074/
   * D074b); no buyer-facing Meta surface may advertise it. The persisted
   * wire kind stays `label_flips` for history compatibility, but the
   * rendered vocabulary is automatic-decision wording.
   */
  it("renders the label_flips wire kind as automatic-decision vocabulary, never 'Label flips'", () => {
    const labelFlipEntry: MetaHistoryEntry = {
      ...unavailableEntry,
      id: "meta_history:flip_1",
      kind: "label_flips",
      title: "Decision changed | Summer ad",
      summary: "Served decision changed between snapshots.",
    };
    const html = renderToStaticMarkup(
      <MetaHistoryEntries entries={[labelFlipEntry]} onOpenReplay={vi.fn()} />,
    );
    expect(html).toContain("Decision transitions");
    expect(html).not.toContain("Label flips");
    // No buyer-facing manual-label ask anywhere on the rendered surface.
    expect(html).not.toMatch(/manage labels|label campaign|label is required/i);
  });

  it("renders concise past-decision chrome without engine details", () => {
    const html = renderToStaticMarkup(
      <HistoricalReplayChrome date="2026-07-10" engineVersions={["v3-test"]} />,
    );

    expect(html).toContain("Past decisions");
    expect(html).toContain("Review decisions recorded on this date.");
    expect(html).toContain("Actions unavailable");
    expect(html).not.toContain("v3-test");
    expect(html).not.toContain("<form");
    expect(html).not.toContain('method="post"');
  });

  it("shows user-facing status and unavailable currency without technical joins", () => {
    const html = renderToStaticMarkup(
      <MetaHistoryEntries
        entries={[unavailableEntry]}
        onOpenReplay={vi.fn()}
      />,
    );

    expect(html).toContain("Needs review");
    expect(html).toContain("System");
    expect(html).toContain("currency unavailable");
    expect(html).not.toContain("Join unavailable");
    expect(html).not.toContain(
      "The action log does not persist a decision reference",
    );
    expect(html).not.toContain("meta_ads_action_log");
    expect(html).toContain('type="button"');
    expect(html).not.toContain("$0");
    expect(html).not.toContain("USD");
  });

  it("maps stored automatic KPI summaries to buyer-facing result copy", () => {
    const html = renderToStaticMarkup(
      <MetaHistoryEntries
        entries={[
          {
            ...unavailableEntry,
            status: "regressed",
            summary:
              "auto_kpi_7d: regressed (ROAS 2.40 -> 1.30, operator did not act)",
          },
        ]}
      />,
    );

    expect(html).toContain(
      "ROAS declined from 2.40 to 1.30 over the next 7 days. No action was recorded.",
    );
    expect(html).not.toContain("auto_kpi_7d");
  });
});
