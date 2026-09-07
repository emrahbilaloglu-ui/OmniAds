import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  HistoricalReplayChrome,
  historyFiltersForReportingWindow,
  META_HISTORY_PARTIAL_REASON,
  MetaHistoryEntries,
} from "@/app/(dashboard)/platforms/meta/history/history-view";
import type { MetaHistoryEntry } from "@/lib/meta/history-contract";
import type { MetaHistoryClientFilters } from "@/lib/meta/history-client";

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
  it("uses the shell reporting window without dropping journal filters", () => {
    const filters: MetaHistoryClientFilters = {
      kind: "decisions",
      entity: "campaign",
      label: "scale",
      outcome: null,
      from: null,
      to: null,
      q: "prospecting",
    };
    const windowed = historyFiltersForReportingWindow(
      filters,
      new URLSearchParams("window=28d&startDate=2026-08-09&endDate=2026-09-05"),
      "2026-09-06",
    );

    expect(windowed).toEqual({
      ...filters,
      from: "2026-08-09",
      to: "2026-09-05",
    });
  });

  it.each([
    ["a URL without dates", ""],
    ["a preset-only URL", "window=28d"],
  ])("waits for canonical exact dates for %s", (_label, query) => {
    expect(
      historyFiltersForReportingWindow(
        {
          kind: null,
          entity: null,
          label: null,
          outcome: null,
          from: null,
          to: null,
          q: null,
        },
        new URLSearchParams(query),
        "2026-09-06",
      ),
    ).toBeNull();
  });

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
    expect(html).toContain("Not recorded");
    expect(html).not.toContain(">System<");
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

  it("renders automated decision rows without engine or inference jargon", () => {
    const html = renderToStaticMarkup(
      <MetaHistoryEntries
        entries={[
          {
            ...unavailableEntry,
            title:
              "Refresh campaign evidence and rerun automatic role inference before taking hard action.",
            summary:
              "Automatic Main/Test/Mixed campaign role is unresolved. Fresh high-confidence context is required before the engine emits hard scale, cut, bid, or budget moves.",
            entity: {
              type: "campaign",
              id: "238901234567890",
              name: "238901234567890",
            },
            actor: { id: null, name: null, availability: "not_applicable" },
            provenance: {
              provider: "meta",
              source: "engine_v3_decision_snapshots_daily",
              sourceId: "snapshot-1",
              accountScopeBasis: "unique_creative_key",
              attribution: "engine_snapshot",
            },
          },
        ]}
      />,
    );

    expect(html).toContain("Review campaign setup | Unnamed campaign");
    expect(html).toContain(
      "Campaign setup is unclear, so spend changes are waiting for fresher evidence.",
    );
    expect(html).toContain("Automated");
    expect(html).not.toContain("238901234567890");
    expect(html).not.toMatch(/role inference|engine emits|hard scale/i);
  });

  it("shows an entity once, inside the action, rather than duplicating it", () => {
    const html = renderToStaticMarkup(
      <MetaHistoryEntries
        entries={[
          {
            ...unavailableEntry,
            title: "Pause",
            entity: { type: "ad", id: "ad_1", name: "Summer ad" },
          },
        ]}
      />,
    );

    expect(html.match(/Summer ad/g)).toHaveLength(1);
    expect(html).toContain("Pause | Summer ad");
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
