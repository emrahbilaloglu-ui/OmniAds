import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The durable guard against a forty-first definition of "complete".
 *
 * The defect was never one bad function. It was that "is this Google Ads range
 * complete?" had no owner, so every surface answered it with the cheapest
 * signal to hand — `SELECT DISTINCT date`, or a partition row with
 * status='succeeded'. Migrating those call sites fixes today. It does not stop
 * the next feature from reaching for coverage again, because coverage is still
 * the most convenient number in the codebase.
 *
 * So this test scans the repository for the SHAPE of that mistake and requires
 * every occurrence to be registered below with an explicit classification:
 *
 *   authoritative     — this site owns the completion decision. Only the two
 *                       modules that ARE the decision may claim this.
 *   data-availability — this site asks "do we have any rows / which dates are
 *                       literally absent", which is a real question about data
 *                       and not a claim about freshness.
 *
 * An unregistered hit fails the test. That is the point: adding a new
 * completion computation should be a deliberate act with a written
 * justification, not something that slips in because the arithmetic was easy.
 */

const ROOTS = ["app", "lib", "components", "hooks", "scripts"] as const;

const PATTERNS = [
  {
    id: "percent-from-days",
    // covered / totalDays * 100 — the arithmetic that produced a green 100%
    // over a day captured once at 01:40.
    re: /\/\s*[A-Za-z_.]*[Tt]otalDays\s*\)?\s*\)?\s*\*\s*100/,
  },
  {
    id: "days-ge-total",
    re: /(?:completed|covered|observed|ready|synced|available)Days\s*[><=!]=+\s*[A-Za-z_.]*[Tt]otalDays/i,
  },
  {
    id: "length-ge-total",
    re: /\.length\s*>=\s*[A-Za-z_.]*[Tt]otalDays/,
  },
  {
    id: "covered-dates",
    re: /getGoogleAdsCoveredDates/,
  },
] as const;

type Classification = "authoritative" | "data-availability";

interface RegisteredSite {
  file: string;
  pattern: (typeof PATTERNS)[number]["id"];
  classification: Classification;
  /**
   * How many lines in this file match this pattern.
   *
   * Counted, not just listed, so a new offence added to an ALREADY-registered
   * file still fails. Without this, one exemption would shelter every future
   * one in the same file — and some of these files carry both Google and Meta
   * code, so a per-file pass would be a wide hole.
   */
  occurrences: number;
  /** Why this is not a freshness claim — required for data-availability. */
  justification: string;
}

/**
 * The frozen inventory.
 *
 * Registered per (file, pattern) rather than per line, so ordinary edits do not
 * churn this list while a genuinely NEW kind of completion computation in a new
 * file still fails.
 */
const INVENTORY: RegisteredSite[] = [
  {
    file: "lib/google-ads/completion-semantics.ts",
    pattern: "percent-from-days",
    classification: "authoritative",
    occurrences: 1,
    justification:
      "This IS the decision. Percent is computed from post-close observed days, never from coverage.",
  },
  {
    file: "lib/google-ads/warehouse.ts",
    pattern: "covered-dates",
    classification: "data-availability",
    occurrences: 1,
    justification:
      "Definition site. Returns which dates have rows; it makes no freshness claim and its name says so.",
  },
  {
    file: "lib/sync/google-ads-sync.ts",
    pattern: "covered-dates",
    classification: "data-availability",
    occurrences: 9,
    justification:
      "Planner gap detection: a date with zero rows needs a first fetch regardless of freshness. Re-reading a covered-but-stale date is scheduled separately from the persisted next-due evidence, not from coverage.",
  },
  {
    file: "lib/sync/provider-repair-engine.ts",
    pattern: "covered-dates",
    classification: "data-availability",
    occurrences: 1,
    justification:
      "Repair planning asks which dates are literally absent so it can queue them; absence is a fact about rows, not a claim about settlement.",
  },
  {
    file: "app/api/google-ads/repair-recent-gap/route.ts",
    pattern: "covered-dates",
    classification: "data-availability",
    occurrences: 2,
    justification:
      "Operator gap repair: reports and queues dates with no rows at all.",
  },
  {
    file: "scripts/google-ads-advisor-blocker-diagnostic.ts",
    pattern: "covered-dates",
    classification: "data-availability",
    occurrences: 2,
    justification:
      "Read-only diagnostic that prints which dates have rows so an operator can see what is absent; it drives no product state and now reports the freshness verdict beside it.",
  },
  {
    file: "lib/google-ads/serving.ts",
    pattern: "covered-dates",
    classification: "data-availability",
    occurrences: 2,
    justification:
      "Builds missingWindows — the days with no rows at all. dataState/ready is decided separately by resolveServingDataState from the freshness verdict, so coverage here answers only what is absent.",
  },
  {
    file: "app/api/google-ads/status/route.ts",
    pattern: "covered-dates",
    classification: "data-availability",
    occurrences: 5,
    justification:
      "Reads which dates exist so the response can report warehouse coverage and pick a renderable range; every readiness and percent field on the response comes from the freshness snapshot instead.",
  },
  {
    file: "app/api/google-ads/status/route.ts",
    pattern: "days-ge-total",
    classification: "data-availability",
    occurrences: 6,
    justification:
      "Each is one half of a conjunction whose other half is post-close observation (isPostCloseObserved / scopePostCloseObserved), or counts post-close observed days rather than covered days; none can reach ready on coverage alone.",
  },
  {
    file: "lib/admin-operations-health.ts",
    pattern: "days-ge-total",
    classification: "data-availability",
    occurrences: 8,
    justification:
      "Four are Meta-provider legs outside Google Ads scope; the four Google legs are conjunctive with recentPostCloseObservedDays, so fullyReady cannot be reached without observation evidence.",
  },
];

function sourceFiles() {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      // Tests may state the arithmetic in order to forbid it.
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      files.push(full);
    }
  };
  for (const root of ROOTS) {
    if (fs.existsSync(root)) walk(root);
  }
  return files;
}

function scan() {
  const hits: Array<{ file: string; line: number; pattern: string; text: string }> = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, "utf8");
    // Only Google Ads surfaces are in scope; Meta has its own provider model.
    //
    // The PATH counts as well as the contents. Gating on contents alone left a
    // hole this test was written to close: a new module dropped into
    // lib/google-ads/ that computed `completedDays / totalDays * 100` without
    // ever spelling "google" in its body was skipped entirely, which is exactly
    // the shape of the next regression.
    if (!/google/i.test(file) && !/google|Google/.test(source)) continue;
    source.split(/\r?\n/).forEach((text, index) => {
      // Prose describing the mistake is not the mistake. Strip block-comment
      // bodies and trailing `//` remarks before matching, so a comment
      // explaining what a line used to be does not register as a new offence.
      if (/^\s*(?:\/\/|\*|\/\*)/.test(text)) return;
      const code = text.replace(/\/\/.*$/, "");
      for (const pattern of PATTERNS) {
        if (pattern.re.test(code)) {
          hits.push({ file, line: index + 1, pattern: pattern.id, text: text.trim() });
        }
      }
    });
  }
  return hits;
}

describe("Google Ads completion inventory", () => {
  const hits = scan();
  const registered = new Set(INVENTORY.map((site) => `${site.file}::${site.pattern}`));

  it("counts every registered site, so a new offence cannot hide in an exempt file", () => {
    const counts = new Map<string, number>();
    for (const hit of hits) {
      const key = `${hit.file}::${hit.pattern}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const drifted = INVENTORY.filter((site) => {
      const key = `${site.file}::${site.pattern}`;
      return counts.has(key) && counts.get(key) !== site.occurrences;
    }).map((site) => {
      const key = `${site.file}::${site.pattern}`;
      return `${site.file} [${site.pattern}] registered ${site.occurrences}, found ${counts.get(key)}`;
    });
    expect(
      drifted,
      "The number of coverage-shaped expressions in a registered file changed. If you ADDED one, it needs its own justification — say what it asks and why that is not a freshness claim — then update the count.",
    ).toEqual([]);
  });

  it("has no unregistered row-existence completion implementation", () => {
    const unregistered = hits
      .filter((hit) => !registered.has(`${hit.file}::${hit.pattern}`))
      .map((hit) => `${hit.file}:${hit.line} [${hit.pattern}] ${hit.text}`);

    expect(
      unregistered,
      unregistered.length === 0
        ? ""
        : [
            "A new Google Ads completion/coverage computation appeared outside the registered inventory.",
            "",
            "If it is a freshness or completion claim, do not compute it here: read the verdict from",
            "readGoogleAdsFreshness / resolveGoogleAdsCompletion. Coverage cannot tell you whether a date",
            "was ever re-read after it closed, which is the whole defect this inventory exists to prevent.",
            "",
            "If it genuinely only asks 'do we have rows for this date', register it in INVENTORY with a",
            "one-line justification saying so.",
            "",
            ...unregistered,
          ].join("\n"),
    ).toEqual([]);
  });

  it("has no stale inventory entries", () => {
    const seen = new Set(hits.map((hit) => `${hit.file}::${hit.pattern}`));
    const stale = INVENTORY.filter((site) => !seen.has(`${site.file}::${site.pattern}`)).map(
      (site) => `${site.file} [${site.pattern}]`,
    );
    expect(
      stale,
      "These inventory entries no longer match anything. Remove them so the list keeps its meaning.",
    ).toEqual([]);
  });

  it("lets only the decision modules own the completion answer", () => {
    const owners = INVENTORY.filter((site) => site.classification === "authoritative").map(
      (site) => site.file,
    );
    expect(owners.sort()).toEqual(["lib/google-ads/completion-semantics.ts"]);
  });

  it("requires every data-availability exemption to say why", () => {
    for (const site of INVENTORY) {
      if (site.classification !== "data-availability") continue;
      expect(site.justification.length, `${site.file} needs a real justification`).toBeGreaterThan(
        40,
      );
    }
  });

  it("keeps the authoritative percent off coverage", () => {
    // Belt and braces: the decision module itself must not read coveredDays
    // into its progress arithmetic, whatever the surrounding code does.
    const source = fs.readFileSync("lib/google-ads/completion-semantics.ts", "utf8");
    const percentLine = source
      .split(/\r?\n/)
      .find((line) => /\*\s*100/.test(line) && !/^\s*(?:\/\/|\*)/.test(line));
    expect(percentLine).toBeDefined();
    expect(percentLine).toContain("observed");
    expect(percentLine).not.toContain("covered");
  });
});
