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
  agency_today_viewed: "app/api/agency-today/route.ts",
  search_submitted: "app/api/search/route.ts",
  search_zero_result: "app/api/search/route.ts",
  decision_workflow_changed: "app/api/meta/decision-workflow/route.ts",
  guarded_action_preflight: "app/api/meta/decision-action/preflight/route.ts",
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
      expect(source, `${file} does not call the recorder`).toContain(
        "await recordProductInstrumentationEvent(",
      );
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
