import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADVISOR_HORIZONS,
  FORBIDDEN_GOOGLE_VOCABULARY,
  REFERENCE_CARD_FIELDS,
  containsForbiddenVocabulary,
  googleValue,
  groupAdvisor,
  referenceCardComplete,
  resolveGoogleScope,
  type GoogleAccount,
} from "@/lib/zero-base/google/google-contract";

const ROOT = process.cwd();

function account(o: Partial<GoogleAccount> = {}): GoogleAccount {
  return { id: "acc-1", name: "Main", currency: "USD", timezone: "UTC", ...o };
}

describe("account scope is explicit", () => {
  it("says when no account is assigned", () => {
    const scope = resolveGoogleScope([]);
    expect(scope.kind).toBe("none");
  });

  it("names the single account with its currency and timezone", () => {
    const scope = resolveGoogleScope([account()]);
    expect(scope.kind).toBe("single");
    expect(scope.kind === "single" && scope.label).toBe("Main · USD · UTC");
  });

  it("says when a currency or timezone was not served rather than assuming one", () => {
    const scope = resolveGoogleScope([account({ currency: null, timezone: null })]);
    expect(scope.kind === "single" && scope.label).toContain("currency not served");
    expect(scope.kind === "single" && scope.label).toContain("timezone not served");
  });

  it("sums a portfolio only when every account agrees", () => {
    const scope = resolveGoogleScope([account(), account({ id: "acc-2" })]);
    expect(scope.kind).toBe("portfolio");
    expect(scope.kind === "portfolio" && scope.summable).toBe(true);
    expect(scope.kind === "portfolio" && scope.unsummableReason).toBeNull();
  });

  it("refuses to sum across currencies", () => {
    const scope = resolveGoogleScope([account(), account({ id: "acc-2", currency: "TRY" })]);
    // Two currencies cannot become one number.
    expect(scope.kind === "portfolio" && scope.summable).toBe(false);
    expect(scope.kind === "portfolio" && scope.unsummableReason).toMatch(/2 currencies/);
  });

  it("refuses to sum across time zones", () => {
    const scope = resolveGoogleScope([account(), account({ id: "acc-2", timezone: "Europe/Istanbul" })]);
    // Two time zones do not share a "yesterday".
    expect(scope.kind === "portfolio" && scope.unsummableReason).toMatch(/2 time zones/);
  });

  it("names both problems when both apply", () => {
    const scope = resolveGoogleScope([
      account(),
      account({ id: "acc-2", currency: "TRY", timezone: "Europe/Istanbul" }),
    ]);
    const reason = scope.kind === "portfolio" ? scope.unsummableReason : "";
    expect(reason).toMatch(/currencies and .* time zones/);
  });
});

describe("unavailable is not zero", () => {
  it("reports an absent value with its reason", () => {
    for (const absent of [null, undefined, Number.NaN]) {
      const value = googleValue(absent as number | null, String);
      expect(value.available).toBe(false);
    }
  });

  it("keeps a measured zero", () => {
    const value = googleValue(0, (v) => v.toFixed(2));
    expect(value.available).toBe(true);
    expect(value.available && value.raw).toBe(0);
  });
});

describe("advisor horizons", () => {
  it("has exactly Do now, Next and Later", () => {
    expect([...ADVISOR_HORIZONS]).toEqual(["do_now", "next", "later"]);
  });

  it("groups by the urgency the server assigned", () => {
    const groups = groupAdvisor([
      { id: "1", title: "a", rationale: null, urgency: "high" },
      { id: "2", title: "b", rationale: null, urgency: "medium" },
      { id: "3", title: "c", rationale: null, urgency: "low" },
    ]);
    expect(groups.map((g) => g.items.length)).toEqual([1, 1, 1]);
  });

  it("puts an item with no urgency in Later rather than promoting it", () => {
    // Guessing upward manufactures urgency the engine never expressed.
    const groups = groupAdvisor([{ id: "1", title: "a", rationale: null }]);
    expect(groups[0].items).toHaveLength(0);
    expect(groups[2].items).toHaveLength(1);
  });
});

describe("default-off reference cards", () => {
  const card = {
    id: "c1",
    title: "Raise a bid",
    reason: "The signal has not stabilized.",
    fingerprint: "sha:abc",
    dependency: "Conversion import freshness",
    stabilization: "14 days",
    unverified: "Incremental lift",
  };

  it("requires all five fields", () => {
    expect([...REFERENCE_CARD_FIELDS]).toEqual([
      "reason",
      "fingerprint",
      "dependency",
      "stabilization",
      "unverified",
    ]);
    expect(referenceCardComplete(card)).toBe(true);
  });

  it("is not rendered as a card when any field is missing", () => {
    for (const field of REFERENCE_CARD_FIELDS) {
      // A card missing its dependency looks like a feature awaiting a switch.
      expect(referenceCardComplete({ ...card, [field]: "" }), field).toBe(false);
    }
  });
});

describe("Google vocabulary stays Google", () => {
  it("detects Meta lane words and Meta-only concepts", () => {
    for (const word of FORBIDDEN_GOOGLE_VOCABULARY) {
      expect(containsForbiddenVocabulary(`Something ${word} here`), word).toContain(word);
    }
  });

  it("passes ordinary Google copy", () => {
    expect(containsForbiddenVocabulary("Do now, Next, Later. Search terms and assets.")).toEqual([]);
  });

  it("appears in none of the shipped Google surfaces", () => {
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
      }
      return out;
    }
    const files = [
      ...walk(path.join(ROOT, "components", "zero-base", "google")),
      ...walk(path.join(ROOT, "app", "c", "[businessId]", "google")),
    ];
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
      // `pause_ad`, repair-gap and Launchpad imply Meta-only write paths.
      for (const word of ["pause_ad", "repair-gap", "launchpad", "due date"]) {
        expect(source.toLowerCase().includes(word), `${path.basename(file)} → ${word}`).toBe(false);
      }
    }
  });
});
