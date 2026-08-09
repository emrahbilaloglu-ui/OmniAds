import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { META_HISTORY_SOURCES } from "@/lib/meta/history-contract";

/**
 * External changes, at every level an operator can edit.
 *
 * History projected campaign budget changes and nothing else. That is the
 * narrowest possible reading of "a direct Ads Manager edit appears as an
 * external History row": accounts that budget at the ad-set level looked like
 * nobody had touched them in months, and an ad paused by hand — the commonest
 * external change there is — was invisible while a campaign budget edit was
 * not. An incident review that cannot see who paused the ad is not a review.
 *
 * Each level below has a local source, so each is projected. This test pins
 * level to source: a level losing its projection fails here rather than
 * quietly narrowing what History can show.
 */
const readModel = readFileSync("lib/meta/history-read-model.ts", "utf8");

const LEVELS = [
  {
    level: "campaign",
    source: "meta_campaign_config_history",
    what: "budget and bid configuration",
  },
  {
    level: "adset",
    source: "meta_adset_config_history",
    what: "budget, bid and optimization goal",
  },
  {
    level: "ad and creative",
    source: "meta_entity_state_history",
    what: "status transitions",
  },
] as const;

describe("every editable level reaches History", () => {
  for (const entry of LEVELS) {
    it(`${entry.level} ${entry.what} is projected from ${entry.source}`, () => {
      expect(META_HISTORY_SOURCES).toContain(entry.source);
      expect(
        readModel.includes(`FROM ${entry.source}`),
        `${entry.source} is declared but never queried`,
      ).toBe(true);
    });
  }

  it("covers all four entity levels through the state history", () => {
    // meta_entity_state_history is the only source that reaches ad and
    // creative, and it is CHECK-constrained to exactly these four.
    const migrations = readFileSync("lib/migrations.ts", "utf8");
    expect(migrations).toContain(
      "CHECK (entity_type IN ('campaign', 'adset', 'ad', 'creative'))",
    );
    for (const level of ["campaign", "adset", "ad", "creative"]) {
      expect(readModel).toContain(`WHEN '${level}' THEN`);
    }
  });
});

describe("a re-observation is not a change", () => {
  it("requires a previous ad-set config that actually differs", () => {
    // Without this, every sync run would file an ad set as edited.
    expect(readModel).toContain(
      "adset_previous.daily_budget IS DISTINCT FROM adset_config.daily_budget",
    );
    expect(readModel).toContain(
      "adset_previous.optimization_goal IS DISTINCT FROM adset_config.optimization_goal",
    );
  });

  it("requires a previous status, and a different one", () => {
    // The first observation of an ad is not somebody pausing it, and an
    // unchanged re-read is not either. Both would turn the syncer's own
    // cadence into a stream of fake operator activity.
    expect(readModel).toContain(
      "entity_previous.configured_status IS NOT NULL",
    );
    expect(readModel).toContain(
      "entity_previous.configured_status IS DISTINCT FROM entity_state.configured_status",
    );
  });

  it("carries the previous value so the reader sees the movement", () => {
    // "Status changed" without the old value tells nobody what happened.
    expect(readModel).toContain("'previousConfiguredStatus', entity_previous.configured_status");
    expect(readModel).toContain("'previousDailyBudget', adset_previous.daily_budget");
  });
});

describe("every new branch is scoped to the caller's account", () => {
  for (const source of ["meta_adset_config_history", "meta_entity_state_history"]) {
    it(`${source} filters by business and provider account`, () => {
      // A projection that forgot its scope would show one tenant another
      // tenant's edits.
      const branch = readModel.slice(
        readModel.indexOf(`FROM ${source} `),
        readModel.indexOf(`FROM ${source} `) + 2600,
      );
      expect(branch).toMatch(/\.business_id = \$1/);
      expect(branch).toMatch(/\.provider_account_id = \$2/);
    });
  }
});

describe("what still cannot be seen locally", () => {
  it("names the provider fact with no local source", () => {
    // Creative *content* edits — swapping an image or rewriting body text in
    // Ads Manager — produce a new creative id rather than a diff we store, and
    // no local table records the previous asset. That is a genuine
    // production-only gap, not a projection we skipped, and it is recorded in
    // the ledger rather than implied by silence.
    const ledger = readFileSync(
      "docs/full-ui-redesign/UX_REMEDIATION_LEDGER.md",
      "utf8",
    );
    expect(ledger).toContain("creative asset content");
  });
});
