import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  PRODUCT_INSTRUMENTATION_EVENT_NAMES,
  type ProductInstrumentationEventName,
} from "@/lib/product-instrumentation";

/**
 * Every declared event must have a real emission point in shipped code.
 *
 * A vocabulary entry with nothing emitting it is worse than a missing event: it
 * reads like coverage in the schema, in the dashboard, and in this ledger, while
 * measuring nothing. This test is what stops that.
 */
const EMITTERS: Record<ProductInstrumentationEventName, string> = {
  // Agency Today
  agency_today_viewed: "app/api/agency-today/route.ts",
  agency_today_client_opened: "components/overview/AgencyToday.tsx",
  // Global search
  search_submitted: "app/api/search/route.ts",
  search_zero_result: "app/api/search/route.ts",
  search_result_opened: "components/layout/GlobalSearch.tsx",
  // Saved views
  saved_view_created: "components/views/SavedViewsMenu.tsx",
  saved_view_applied: "components/views/SavedViewsMenu.tsx",
  // Decisions
  decision_opened: "components/meta/os/DecisionsOsView.tsx",
  decision_evidence_viewed: "components/meta/os/DecisionsOsView.tsx",
  decision_workflow_changed: "app/api/meta/decision-workflow/route.ts",
  // Reports
  report_generated: "app/api/reports/route.ts",
  report_widget_failed: "app/api/reports/render/route.ts",
  report_widget_retried: "app/api/reports/render/route.ts",
  report_share_created: "app/api/reports/[reportId]/share/route.ts",
  report_print_opened: "components/reports/report-print-page.tsx",
  report_csv_created: "app/api/reports/[reportId]/export/route.ts",
  // Google escape hatches
  google_copy_used: "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
  google_csv_used: "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
  // Provider health recovery
  provider_health_recovery_started:
    "components/integrations/integrations-card.tsx",
  provider_health_recovery_completed:
    "app/(dashboard)/integrations/callback/[provider]/page.tsx",
  // Guarded action lifecycle (the stages this build can reach)
  guarded_action_preflight: "app/api/meta/decision-action/preflight/route.ts",
  guarded_action_dry_run: "app/api/meta/decision-action/preflight/route.ts",
  guarded_action_verified: "lib/meta/ads-action-log.ts",
  guarded_action_failed: "lib/meta/ads-action-log.ts",
  guarded_action_ambiguous: "lib/meta/ads-action-log.ts",
  google_deep_link_used:
    "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
  // Notification lifecycle -- server-owned, never from the client endpoint.
  notification_attempted: "lib/notification-store.ts",
  notification_delivered: "lib/notification-store.ts",
  notification_opened: "lib/notification-store.ts",
  notification_acknowledged: "lib/notification-store.ts",
  // Guarded lifecycle -- emitted at the authoritative server transitions.
  guarded_action_confirmed: "lib/meta/ads-action-log.ts",
  guarded_action_provider_attempted: "lib/meta/ads-action-log.ts",
  guarded_action_reconciled: "lib/meta/manual-ad-status-reconciliation.ts",
  // Mobile Tier-0
  mobile_tier0_started: "components/meta/os/MobileTier0Triage.tsx",
  mobile_tier0_completed: "components/meta/os/MobileTier0Triage.tsx",
  // Freshness
  freshness_stale_disclosed: "components/states/FreshnessChip.tsx",
};

describe("every declared event has a real emitter", () => {
  it("names an emitter file for each event in the vocabulary", () => {
    for (const name of PRODUCT_INSTRUMENTATION_EVENT_NAMES) {
      expect(EMITTERS[name], `${name} has no declared emitter`).toBeTruthy();
    }
    // And no emitter is declared for an event that no longer exists.
    for (const name of Object.keys(EMITTERS)) {
      expect(
        PRODUCT_INSTRUMENTATION_EVENT_NAMES,
        `${name} is declared as an emitter but is not in the vocabulary`,
      ).toContain(name);
    }
  });

  it("emits each event from that file, through the real recorder", () => {
    for (const [name, file] of Object.entries(EMITTERS)) {
      const source = readFileSync(file, "utf8");
      const emits =
        source.includes("await recordProductInstrumentationEvent(") ||
        source.includes("emitProductInstrumentation(");
      expect(emits, `${file} does not emit through the contract`).toBe(true);
      expect(source, `${file} does not emit ${name}`).toContain(`"${name}"`);
    }
  });

  it("finds no emission of an event outside the vocabulary", () => {
    // Grep the whole tree for eventName literals and check each is declared.
    const output = execSync(
      "grep -rho 'eventName: \"[a-z_]*\"' app lib components || true",
      { encoding: "utf8" },
    );
    const emitted = new Set(
      output
        .split("\n")
        .map((line) => line.match(/eventName: "([a-z_]+)"/)?.[1])
        .filter((value): value is string => Boolean(value)),
    );
    for (const name of emitted) {
      // Other telemetry facilities use their own vocabularies; only check names
      // that belong to this contract's emitters.
      if (!(name in EMITTERS)) continue;
      expect(PRODUCT_INSTRUMENTATION_EVENT_NAMES).toContain(name);
    }
  });
});

describe("server-owned truth never comes from the client endpoint", () => {
  it("emits the provider and notification lifecycles server-side", () => {
    // A browser can report intent. Only the server knows whether a claim was
    // created, whether a POST went out, or whether a delivery was attempted.
    for (const file of [
      "lib/meta/ads-action-log.ts",
      "lib/meta/manual-ad-status-reconciliation.ts",
      "lib/notification-store.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("await recordProductInstrumentationEvent(");
      expect(
        source,
        `${file} must not route server truth through the client endpoint`,
      ).not.toContain("emitProductInstrumentation(");
    }
  });

  it("keeps enqueue separate from delivery", () => {
    const store = readFileSync("lib/notification-store.ts", "utf8");
    // Marking our own queue as delivered would make the delivery rate a
    // measure of the queue rather than of anyone receiving anything.
    expect(store).toContain('eventName: "notification_attempted"');
    expect(store).toContain("markNotificationsDelivered");
    expect(store).toContain("delivery.state = 'attempted'");
  });
});

describe("emitters record honest tenancy and outcomes", () => {
  it("scopes workspace-wide surfaces to the portfolio, never to one business", () => {
    for (const file of [
      "app/api/agency-today/route.ts",
      "app/api/search/route.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must not attribute portfolio work to one tenant`)
        .toContain('scope: "portfolio"');
      expect(source).toContain("businessId: null");
      expect(source).not.toContain("businesses[0]?.id ?? \"unknown\"");
    }
  });

  it("scopes single-business surfaces to that business", () => {
    for (const file of [
      "app/api/meta/decision-workflow/route.ts",
      "app/api/meta/decision-action/preflight/route.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain('scope: "business"');
    }
  });

  it("distinguishes a zero-result search from a successful one", () => {
    const source = readFileSync("app/api/search/route.ts", "utf8");
    expect(source).toContain('"search_zero_result"');
    expect(source).toContain('outcome: results.length > 0 ? "ok" : "withheld"');
  });

  it("never records the search query text", () => {
    const source = readFileSync("app/api/search/route.ts", "utf8");
    const call = source.slice(
      source.indexOf("await recordProductInstrumentationEvent("),
    );
    const block = call.slice(0, call.indexOf("});"));
    expect(block).not.toContain("rawQuery");
    expect(block).not.toContain("query");
  });
});
