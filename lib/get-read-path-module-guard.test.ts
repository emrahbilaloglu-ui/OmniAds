import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  IDENTITY_WRITE_HELPERS,
  MAX_CALL_DEPTH,
  createModuleGraph,
  findMatchingException,
  traceReachableWrites,
} from "@/scripts/read-path-write-reachability";

/**
 * Read-path modules must not write — TRANSITIVELY.
 *
 * ── WHY THIS FILE LOOKS DIFFERENT NOW ────────────────────────────────────────
 *
 * The previous version of this guard was a set of regexes run against the TEXT
 * of nine files. It banned `upsertIntegration(` in `lib/google-ads-gaql.ts`,
 * `lib/google-analytics-reporting.ts` and `lib/search-console.ts`.
 *
 * It passed while an ordinary authenticated GET rewrote `provider_connections`
 * and `integration_credentials` on every expired-token request, because the
 * call had moved ONE HOP away: `lib/google-ads-gaql.ts` called
 * `resolveGoogleAccessTokenWithGeneration`, and THAT called
 * `upsertIntegration`. The banned literal was no longer in any guarded file, so
 * there was nothing to match. The guard was not wrong about what it checked; it
 * checked a property — "this file does not contain this string" — that is not
 * the property anyone cares about — "this file cannot cause this write".
 *
 * Each guarded module is now checked three ways:
 *
 *   1. the original literal ban, kept because it is exact, cheap, and gives a
 *      precise message on a direct reintroduction;
 *
 *   2. REACHABILITY of the banned symbols: a call-graph walk from every
 *      analysable export of the module, following resolved imports and named
 *      re-exports, failing if the symbol can be reached at all — through any
 *      number of intermediate modules;
 *
 *   3. REACHABILITY of a write to any guarded table, anchored on the TABLE
 *      rather than on a symbol name, so a renamed or newly introduced writer is
 *      caught without anyone remembering to add it to a list. (That is not
 *      hypothetical: while this guard was being written the refresh's writer was
 *      renamed from `upsertIntegration` to `refreshIntegrationCredentialTokens`,
 *      and check (3) followed it across the rename without edits.)
 *
 * (2) and (3) are what make the original defect detectable. (1) alone never
 * could be.
 *
 * The walk's limits are stated in scripts/read-path-write-reachability.ts and
 * are real: dynamic `import()`, calls made through a value rather than a name,
 * and class methods are not followed. This guard is a floor, not a proof.
 */

const repoRoot = process.cwd();
const graph = createModuleGraph(repoRoot);

/**
 * `"registered"` — reaching a guarded-table write is a failure unless
 * REQUEST_PATH_WRITE_EXCEPTIONS sanctions that exact caller→writer edge.
 *
 * `{ backgroundLane: reason }` — the module is not a request path, so the
 * request-path registry does not describe it. The banned-symbol check (2) still
 * applies; only the table check (3) is waived, and only with a reason.
 */
type TableWritePolicy = "registered" | { backgroundLane: string };

const guardMatrix: Array<{
  relativePath: string;
  forbiddenPatterns: RegExp[];
  /** Symbols that must not be REACHABLE, not merely absent from the text. */
  forbiddenReachableSymbols: string[];
  tableWrites: TableWritePolicy;
}> = [
  {
    relativePath: "lib/google-ads/serving.ts",
    forbiddenPatterns: [/\bhydrateOverviewSummaryRangeFromGoogle\s*\(/],
    forbiddenReachableSymbols: ["hydrateOverviewSummaryRangeFromGoogle"],
    tableWrites: "registered",
  },
  {
    relativePath: "lib/overview-service.ts",
    forbiddenPatterns: [/\bsetCachedReport\s*\(/],
    forbiddenReachableSymbols: ["setCachedReport"],
    tableWrites: "registered",
  },
  {
    relativePath: "lib/shopify/read-adapter.ts",
    forbiddenPatterns: [/\bupsertShopifyServingState\s*\(/, /\binsertShopifyReconciliationRun\s*\(/],
    forbiddenReachableSymbols: ["upsertShopifyServingState", "insertShopifyReconciliationRun"],
    tableWrites: "registered",
  },
  {
    relativePath: "lib/shopify/overview.ts",
    forbiddenPatterns: [/\bsetCachedReport\s*\(/],
    forbiddenReachableSymbols: ["setCachedReport"],
    tableWrites: "registered",
  },
  {
    relativePath: "lib/provider-account-discovery.ts",
    forbiddenPatterns: [/\brequestProviderAccountSnapshotRefresh\s*\(/, /\bforceProviderAccountSnapshotRefresh\s*\(/],
    forbiddenReachableSymbols: [
      "requestProviderAccountSnapshotRefresh",
      "forceProviderAccountSnapshotRefresh",
    ],
    tableWrites: "registered",
  },
  {
    // The module the original defect ran through. `upsertIntegration` is banned
    // REACHABLY here, not just textually — a text ban is what it defeated.
    relativePath: "lib/google-ads-gaql.ts",
    forbiddenPatterns: [/\bupsertIntegration\s*\(/, /\breadGaqlFromDb\s*\(/, /\bwriteGaqlToDb\s*\(/],
    forbiddenReachableSymbols: ["upsertIntegration", "readGaqlFromDb", "writeGaqlToDb"],
    tableWrites: "registered",
  },
  {
    relativePath: "lib/google-analytics-reporting.ts",
    forbiddenPatterns: [/\blogGa4QuotaUsage\s*\(/, /\bupsertIntegration\s*\(/],
    forbiddenReachableSymbols: ["logGa4QuotaUsage", "upsertIntegration"],
    tableWrites: "registered",
  },
  {
    relativePath: "lib/search-console.ts",
    forbiddenPatterns: [/\bupsertIntegration\s*\(/],
    forbiddenReachableSymbols: ["upsertIntegration"],
    tableWrites: "registered",
  },
  {
    // The funnel every Google GET-path token refresh runs through, and the
    // module that made the ban on the three above pointless: they stopped
    // calling `upsertIntegration` directly and called this instead, which
    // called it for them. `upsertIntegration` is the connect/reconnect writer —
    // any write carrying an access token is `authorityChanged` and therefore
    // `isReconnect` — so routing an hourly token refresh through it rewrote
    // provider_connections.status, provider_account_id, updated_at and
    // connection_generation from an authenticated GET.
    relativePath: "lib/google-token-refresh.ts",
    forbiddenPatterns: [/\bupsertIntegration\s*\(/],
    forbiddenReachableSymbols: ["upsertIntegration"],
    // Registered: this module owns the one sanctioned read-path write, and the
    // registry entry names integration_credentials ONLY. If its persist ever
    // reaches provider_connections again — the original defect — check (3)
    // fails, because that table is deliberately absent from the entry.
    tableWrites: "registered",
  },
  {
    // Same defect, background edition: this loader's own caller passes the
    // generation captured BEFORE the refresh as the snapshot claim's
    // `expectedConnectionGeneration`, so a refresh that bumped the generation
    // invalidated the claim it was running under.
    relativePath: "lib/sync/provider-worker-adapters.ts",
    forbiddenPatterns: [/\bupsertIntegration\s*\(/],
    forbiddenReachableSymbols: ["upsertIntegration"],
    tableWrites: {
      backgroundLane:
        "Durable worker lane, not a request path: its credential refresh is a worker-lane write and the request-path registry does not describe it. The banned-symbol check still applies, which is the check that matters here — the defect was reaching the connect/reconnect writer, not writing credentials.",
    },
  },
  {
    relativePath: "lib/business-context.ts",
    forbiddenPatterns: [/\bsetSessionActiveBusiness\s*\(/],
    forbiddenReachableSymbols: ["setSessionActiveBusiness"],
    tableWrites: "registered",
  },
  {
    relativePath: "app/api/analytics/overview/route.ts",
    forbiddenPatterns: [/\bsetCachedRouteReport\s*\(/],
    forbiddenReachableSymbols: ["setCachedRouteReport"],
    tableWrites: "registered",
  },
  {
    relativePath: "app/api/analytics/audience/route.ts",
    forbiddenPatterns: [/\bsetCachedRouteReport\s*\(/],
    forbiddenReachableSymbols: ["setCachedRouteReport"],
    tableWrites: "registered",
  },
  {
    relativePath: "app/api/analytics/cohorts/route.ts",
    forbiddenPatterns: [/\bsetCachedRouteReport\s*\(/],
    forbiddenReachableSymbols: ["setCachedRouteReport"],
    tableWrites: "registered",
  },
  {
    relativePath: "app/api/analytics/demographics/route.ts",
    forbiddenPatterns: [/\bsetCachedRouteReport\s*\(/],
    forbiddenReachableSymbols: ["setCachedRouteReport"],
    tableWrites: "registered",
  },
  {
    relativePath: "app/api/analytics/landing-page-performance/route.ts",
    forbiddenPatterns: [/\bsetCachedRouteReport\s*\(/],
    forbiddenReachableSymbols: ["setCachedRouteReport"],
    tableWrites: "registered",
  },
  {
    relativePath: "app/api/analytics/landing-pages/route.ts",
    forbiddenPatterns: [/\bsetCachedRouteReport\s*\(/],
    forbiddenReachableSymbols: ["setCachedRouteReport"],
    tableWrites: "registered",
  },
  {
    relativePath: "app/api/analytics/products/route.ts",
    forbiddenPatterns: [/\bsetCachedRouteReport\s*\(/],
    forbiddenReachableSymbols: ["setCachedRouteReport"],
    tableWrites: "registered",
  },
  {
    relativePath: "app/api/seo/overview/route.ts",
    forbiddenPatterns: [/\bsetSeoResultsCache\s*\(/],
    forbiddenReachableSymbols: ["setSeoResultsCache"],
    tableWrites: "registered",
  },
  {
    relativePath: "app/api/seo/findings/route.ts",
    forbiddenPatterns: [/\bsetSeoResultsCache\s*\(/],
    forbiddenReachableSymbols: ["setSeoResultsCache"],
    tableWrites: "registered",
  },
];

interface ReachabilityReport {
  entryPoints: string[];
  bannedSymbolHits: string[];
  unregisteredTableWrites: string[];
  truncated: boolean;
}

/**
 * Walk out from every analysable export of a read-path module.
 *
 * The entry set is the module's exports because that is the whole surface a
 * caller can reach: if any export can get to a write, the module can cause that
 * write. Object-literal members (`export const adapter = { run: … }`) are
 * included — without them the durable worker adapters have no entry points at
 * all and their check would be vacuous rather than clean.
 */
function analyzeReadPathModule(
  relativePath: string,
  bannedSymbols: string[],
): ReachabilityReport {
  const absolute = path.join(repoRoot, relativePath);
  const info = graph.getModuleInfo(absolute);
  const bannedSet = new Set(bannedSymbols);

  const entryPoints: string[] = [];
  const bannedSymbolHits: string[] = [];
  const unregisteredTableWrites: string[] = [];
  let truncated = false;

  for (const [functionName, fn] of info.functions.entries()) {
    if (!fn.exported) continue;
    entryPoints.push(functionName);

    const result = traceReachableWrites({
      graph,
      entryModule: absolute,
      entryFunction: functionName,
      bannedSymbols: bannedSet,
    });
    truncated ||= result.truncatedAtDepthLimit;

    for (const write of result.writes) {
      if (write.kind === "banned_symbol") {
        bannedSymbolHits.push(
          `${write.chain.join(" -> ")} -> ${write.writeSite}()  [line ${write.line}: ${write.snippet}]`,
        );
        continue;
      }
      if (findMatchingException(write)) continue;
      unregisteredTableWrites.push(
        `${write.chain.join(" -> ")}  writes ${write.tables.join(", ")}`,
      );
    }
  }

  return { entryPoints, bannedSymbolHits, unregisteredTableWrites, truncated };
}

const reportCache = new Map<string, ReachabilityReport>();
function reportFor(entry: (typeof guardMatrix)[number]) {
  const cached = reportCache.get(entry.relativePath);
  if (cached) return cached;
  const report = analyzeReadPathModule(entry.relativePath, entry.forbiddenReachableSymbols);
  reportCache.set(entry.relativePath, report);
  return report;
}

describe("GET read-path module guard", () => {
  for (const entry of guardMatrix) {
    it(`${entry.relativePath} does not retain banned read-time mutators`, () => {
      const content = fs.readFileSync(path.join(repoRoot, entry.relativePath), "utf8");
      for (const pattern of entry.forbiddenPatterns) {
        expect(content).not.toMatch(pattern);
      }
    });

    it(`${entry.relativePath} cannot REACH a banned read-time mutator`, () => {
      // The failure value is the call chain, because "it is banned" is not
      // actionable and "here is how you get there" is.
      expect(reportFor(entry).bannedSymbolHits).toEqual([]);
    });

    if (entry.tableWrites === "registered") {
      it(`${entry.relativePath} cannot REACH an unregistered guarded-table write`, () => {
        expect(reportFor(entry).unregisteredTableWrites).toEqual([]);
      });
    }
  }

  it("no guarded module's reachability check is vacuous", () => {
    // A module with no analysable export passes every reachability check
    // trivially. That is indistinguishable from a clean pass in the output and
    // must therefore be a failure, not a shrug.
    const vacuous = guardMatrix
      .filter((entry) => reportFor(entry).entryPoints.length === 0)
      .map((entry) => entry.relativePath);
    expect(
      vacuous,
      "these modules expose no analysable export, so their reachability checks prove nothing",
    ).toEqual([]);
  });

  it("no guarded module's walk was truncated at the depth bound", () => {
    const truncated = guardMatrix
      .filter((entry) => reportFor(entry).truncated)
      .map((entry) => entry.relativePath);
    // Truncation is not a pass. If this fires, raise MAX_CALL_DEPTH rather than
    // accept an unexamined tail of the graph.
    expect(truncated, `raise MAX_CALL_DEPTH (currently ${MAX_CALL_DEPTH})`).toEqual([]);
  });

  it("every named identity write helper still resolves to a real exported function", () => {
    // A rename would otherwise leave a dead name in the floor list, matching
    // nothing, while the guard went on reporting green.
    const found = new Set<string>();
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (dirent.name === "node_modules" || dirent.name === ".next" || dirent.name === "archive") {
            continue;
          }
          walk(absolute);
          continue;
        }
        if (!/\.tsx?$/.test(dirent.name) || /\.test\.tsx?$/.test(dirent.name)) continue;
        for (const [name, fn] of graph.getModuleInfo(absolute).functions.entries()) {
          if (fn.exported) found.add(name);
        }
      }
    };
    walk(path.join(repoRoot, "lib"));

    const missing = IDENTITY_WRITE_HELPERS.filter((name) => !found.has(name));
    expect(
      missing,
      "these identity write helpers no longer exist under lib/; update IDENTITY_WRITE_HELPERS in scripts/read-path-write-reachability.ts",
    ).toEqual([]);
  });
});
