import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CSV_COLUMNS,
  FORBIDDEN_PENDING_WORDS,
  GOOGLE_PENDING_COPY,
  MAX_BATCH_ITEMS,
  REFERENCE_WRITE_STATES,
  buildPlan,
  LINK_WITHHELD,
  csvCell,
  fromAdaptedRecommendation,
  gateBatch,
  googleDeepLink,
  pendingCopyIsClean,
  planToCsv,
  planToText,
  supportsPartiallyApplied,
  type ServedRecommendation,
} from "@/lib/zero-base/google/manual-plan";

const ROOT = process.cwd();

function rec(o: Partial<ServedRecommendation> = {}): ServedRecommendation {
  return {
    id: "r1",
    rank: 1,
    title: "Raise budget on Brand",
    rationale: "Impression share lost to budget.",
    entityId: "c-1",
    entityName: "Brand",
    executionTargetType: "campaign",
    executionTargetId: "c-1",
    deepLinkUrl: "https://ads.google.com/aw/campaigns?__e=1234567890&id=c-1",
    ...o,
  };
}

describe("the plan uses the server's own order", () => {
  it("orders by served rank", () => {
    const steps = buildPlan([rec({ id: "b", rank: 2 }), rec({ id: "a", rank: 1 })]);
    expect(steps.map((s) => s.id)).toEqual(["a", "b"]);
    expect(steps.map((s) => s.position)).toEqual([1, 2]);
  });

  it("keeps unranked items after ranked ones rather than inventing an order", () => {
    const steps = buildPlan([rec({ id: "x", rank: null }), rec({ id: "a", rank: 1 })]);
    expect(steps.map((s) => s.id)).toEqual(["a", "x"]);
  });

  it("states dependency and stabilization weaknesses on the step itself", () => {
    const steps = buildPlan([
      rec({ dependencyReadiness: "not_ready", stabilizationNote: "14 days of stable spend" }),
    ]);
    expect(steps[0].weaknesses).toEqual([
      "Dependency not ready: not_ready.",
      "Stabilization: 14 days of stable spend",
    ]);
  });

  it("adds no weakness when the dependency is ready", () => {
    expect(buildPlan([rec({ dependencyReadiness: "ready" })])[0].weaknesses).toEqual([]);
  });
});

describe("Google pending copy never borrows Meta's word", () => {
  it("says what to check instead of promising a settlement", () => {
    expect(pendingCopyIsClean(GOOGLE_PENDING_COPY)).toBe(true);
    expect(GOOGLE_PENDING_COPY).toMatch(/change history in Google Ads/);
  });

  it("detects the forbidden words if they were ever introduced", () => {
    for (const word of FORBIDDEN_PENDING_WORDS) {
      expect(pendingCopyIsClean(`Pending ${word} of this change`), word).toBe(false);
    }
  });
});

describe("deep links are served, never assembled", () => {
  it("uses the link Google served", () => {
    expect(googleDeepLink(rec())).toBe(
      "https://ads.google.com/aw/campaigns?__e=1234567890&id=c-1",
    );
  });

  it("withholds the link when Google served none", () => {
    // The previous version built one from an accountId the recommendation
    // never carries, which crashed on `.replace()` of undefined.
    expect(googleDeepLink(rec({ deepLinkUrl: null }))).toBeNull();
    expect(LINK_WITHHELD).toMatch(/did not serve a direct link/);
  });

  it("refuses a link that is not an https Google URL", () => {
    expect(googleDeepLink(rec({ deepLinkUrl: "http://ads.google.com/x" }))).toBeNull();
    expect(googleDeepLink(rec({ deepLinkUrl: "https://evil.example/aw" }))).toBeNull();
    expect(googleDeepLink(rec({ deepLinkUrl: "not a url" }))).toBeNull();
  });

  it("never throws on a recommendation with no identity at all", () => {
    expect(() =>
      googleDeepLink({ deepLinkUrl: null, executionTargetId: null, executionTargetType: null }),
    ).not.toThrow();
  });
});

describe("copy and CSV are exact", () => {
  const steps = buildPlan([rec()]);

  it("copies the plan with its rationale and position", () => {
    const text = planToText(steps);
    expect(text).toContain("1. Raise budget on Brand");
    expect(text).toContain("Why: Impression share lost to budget.");
    expect(text).toContain("Entity: Brand (c-1)");
  });

  it("escapes commas, quotes and newlines per RFC 4180", () => {
    // Each of these silently shifts every later column in a naive CSV.
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
  });

  it("keeps every column aligned when a field contains a comma", () => {
    const csv = planToCsv(buildPlan([rec({ rationale: "Lost to budget, and to rank." })]));
    const [header, row] = csv.split("\r\n");
    expect(header.split(",")).toHaveLength(CSV_COLUMNS.length);
    // The quoted comma must not create a tenth field.
    expect(row).toContain('"Lost to budget, and to rank."');
    const fields = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.filter((f) => f !== "") ?? [];
    expect(fields.length).toBe(CSV_COLUMNS.length);
  });

  it("uses CRLF so a spreadsheet on any platform reads the same file", () => {
    expect(planToCsv(steps)).toContain("\r\n");
  });

  it("carries the deep link in the export", () => {
    expect(planToCsv(steps)).toContain("ads.google.com");
  });
});

describe("batch validation", () => {
  const steps = buildPlan([
    rec({ id: "a", executionTargetType: "campaign" }),
    rec({ id: "b", executionTargetType: "campaign" }),
    rec({ id: "c", executionTargetType: "keyword" }),
  ]);

  it("accepts one type in one account", () => {
    expect(gateBatch({ steps, selectedIds: ["a", "b"] }).ok).toBe(true);
  });

  it("refuses a mixed entity type", () => {
    const gate = gateBatch({ steps, selectedIds: ["a", "c"] });
    // A batch spanning types is not one operation.
    expect(gate.ok).toBe(false);
    expect(!gate.ok && gate.reason).toMatch(/one execution target type/);
  });

  it("refuses more than 250", () => {
    const many = buildPlan(
      Array.from({ length: 251 }, (_, i) => rec({ id: `x${i}`, rank: i })),
    );
    const gate = gateBatch({ steps: many, selectedIds: many.map((s) => s.id) });
    expect(!gate.ok && gate.reason).toMatch(/limited to 250 items\. 251 were selected/);
    expect(MAX_BATCH_ITEMS).toBe(250);
  });

  it("refuses an empty selection", () => {
    expect(gateBatch({ steps, selectedIds: [] }).ok).toBe(false);
  });
});

describe("reference write posture", () => {
  it("keeps both modes disabled with a stated reason", () => {
    for (const state of REFERENCE_WRITE_STATES) {
      expect(state.enabled).toBe(false);
      expect(state.reason.length).toBeGreaterThan(30);
    }
    expect(REFERENCE_WRITE_STATES.map((s) => s.mode)).toEqual(["single", "batch"]);
  });

  it("says no Google mutation layer exists", () => {
    expect(REFERENCE_WRITE_STATES.map((s) => s.reason).join(" ")).toMatch(
      /No Google mutation layer exists/,
    );
  });

  it("renders the partially-applied specimen only because the contract carries it", () => {
    // `partially_applied` is a real GoogleExecutionStatus, so the specimen is
    // supported rather than invented.
    expect(supportsPartiallyApplied(["applied", "partially_applied"])).toBe(true);
    expect(supportsPartiallyApplied(["applied", "failed"])).toBe(false);
  });
});

describe("no pause_ad control and no Google mutation endpoint", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("appears nowhere in the shipped Google surfaces", () => {
    const files = [
      ...walk(path.join(ROOT, "components", "zero-base", "google")),
      ...walk(path.join(ROOT, "lib", "zero-base", "google")),
      ...walk(path.join(ROOT, "app", "c", "[businessId]", "google")),
    ];
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      // google-contract.ts declares the forbidden vocabulary as a constant so
      // the vocabulary test can check for it; that declaration is not a control.
      if (file.endsWith("google-contract.ts")) continue;
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
      // Not disabled — absent. A greyed control implies it is coming.
      expect(source.includes("pause_ad"), path.basename(file)).toBe(false);
      expect(/method:\s*["']POST["']/.test(source), `${path.basename(file)} posts`).toBe(false);
    }
  });
});


describe("plan steps are mapped from the real recommendation", () => {
  it("takes rank from rankScore and rationale from summary", () => {
    const step = fromAdaptedRecommendation({
      id: "r1",
      title: "Raise budget",
      summary: "Impression share lost to budget.",
      why: "why text",
      doBucket: "do_now",
      rankScore: 42,
      level: "campaign",
      entityId: "c-1",
      entityName: "Brand",
      executionTargetType: "campaign",
      executionTargetId: "c-1",
      deepLinkUrl: "https://ads.google.com/aw/campaigns?id=c-1",
      rollbackGuidance: "Revert the budget within 24h.",
    });
    expect(step.rank).toBe(42);
    expect(step.rationale).toBe("Impression share lost to budget.");
    expect(step.executionTargetId).toBe("c-1");
    expect(step.stabilizationNote).toBe("Revert the budget within 24h.");
    // No accountId anywhere: the served recommendation has none.
    expect("accountId" in step).toBe(false);
  });

  it("falls back to why when no summary was served", () => {
    const step = fromAdaptedRecommendation({
      id: "r1", title: "t", summary: null, why: "because", doBucket: "do_later",
      rankScore: null, level: null, entityId: null, entityName: null,
      executionTargetType: null, executionTargetId: null, deepLinkUrl: null, rollbackGuidance: null,
    });
    expect(step.rationale).toBe("because");
    expect(step.rank).toBeNull();
  });
});
