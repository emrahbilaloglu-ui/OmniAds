import fs from "node:fs";
import path from "node:path";
import {
  GUARDED_WRITE_TABLES,
  IDENTITY_WRITE_HELPERS,
  MAX_CALL_DEPTH,
  REQUEST_PATH_WRITE_EXCEPTIONS,
  collectEvidence,
  createModuleGraph,
  exceptionKey,
  findMatchingException,
  traceReachableWrites,
  validateExceptionRegistry,
  type Evidence,
  type FunctionCall,
  type ResolvedFunctionTarget,
} from "./read-path-write-reachability";

type FindingType =
  | "migration_call"
  | "migration_import"
  | "state_write_call"
  | "projection_write_call"
  | "cache_write_call"
  | "refresh_trigger_call"
  | "serving_write_owner_violation"
  | "mixed_live_warehouse_projection"
  | "large_mixed_concern"
  // ── added after a GET rewrote provider_connections through one indirection ──
  /** A request path reaches a write to a guarded table with no registry entry. */
  | "guarded_table_write_call"
  /** A registry entry matches nothing any more; the hole it opened is stale. */
  | "unused_request_path_write_exception"
  /** The registry itself is malformed (missing reason, unknown table, …). */
  | "write_exception_registry_defect"
  /** A route file whose handlers could not be resolved: a blind spot, not a pass. */
  | "route_handler_not_analyzable"
  /** The call-graph walk hit MAX_CALL_DEPTH; results below it are unknown. */
  | "reachability_depth_truncated";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

interface Finding {
  type: FindingType;
  file: string;
  summary: string;
  evidence: Evidence[];
  route?: string;
  methods?: string[];
  transitiveSource?: string | null;
}

interface RouteGraph {
  dependencies: Set<string>;
  parents: Map<string, string | null>;
}

const repoRoot = process.cwd();
const moduleGraph = createModuleGraph(repoRoot);
const { getModuleInfo, resolveModule, resolveExportedFunction } = moduleGraph;
const routeRoot = path.join(repoRoot, "app");
const HTTP_METHODS = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
]);
const READ_ONLY_METHODS = new Set<HttpMethod>(["GET", "HEAD"]);
const readOnlyRouteExclusions = new Set([
  path.join(repoRoot, "app/api/oauth/google/callback/route.ts"),
  path.join(repoRoot, "app/api/oauth/meta/callback/route.ts"),
]);

const mixedConcernTargets = new Set(
  [
    "lib/google-ads/serving.ts",
    "lib/google-ads/warehouse.ts",
    "lib/meta/serving.ts",
    "lib/migrations.ts",
    "lib/overview-service.ts",
    "lib/shopify/read-adapter.ts",
    "app/api/overview-summary/route.ts",
    "app/(dashboard)/platforms/meta/legacy-page.tsx",
  ].map((value) => path.join(repoRoot, value)),
);

const cacheWriteTargets = new Set([
  "setCachedReport",
  "setCachedRouteReport",
  "setSeoResultsCache",
  "writeCachedReportSnapshot",
  "writeCachedRouteReport",
  "writeSeoResultsCacheEntry",
]);
const projectionWriteTargets = new Set([
  "hydrateOverviewSummaryRangeFromMeta",
  "hydrateOverviewSummaryRangeFromGoogle",
  "upsertOverviewSummaryRows",
  "markOverviewSummaryRangeHydrated",
  "refreshOverviewSummaryFromMetaAccountRows",
  "refreshOverviewSummaryFromGoogleAccountRows",
  "materializeOverviewSummaryRows",
  "materializeOverviewSummaryRange",
  "materializeOverviewSummaryRangeFromMeta",
  "materializeOverviewSummaryRangeFromGoogle",
  "refreshOverviewSummaryMaterializationFromMetaAccountRows",
  "refreshOverviewSummaryMaterializationFromGoogleAccountRows",
  "clearOverviewSummaryRangeManifests",
]);
const stateWriteTargets = new Set([
  "upsertShopifyServingState",
  "insertShopifyReconciliationRun",
  "setSessionActiveBusiness",
  "persistShopifyOverviewServingState",
  "recordShopifyOverviewReconciliationRun",
]);
const refreshTriggerTargets = new Set([
  "requestProviderAccountSnapshotRefresh",
  "scheduleProviderAccountSnapshotRefresh",
  "forceProviderAccountSnapshotRefresh",
  "enqueueGoogleAdsScheduledWork",
  "enqueueMetaScheduledWork",
  "refreshGoogleAdsSyncStateForBusiness",
  "refreshMetaSyncStateForBusiness",
  "repairMetaWarehouseTruthRange",
  "repairCampaignRowsFromSnapshots",
  "repairAdSetRowsFromSnapshots",
]);
const servingWriteOwnerRules = [
  {
    surface: "overview_summary_projection",
    patterns: [
      /\bINSERT\s+INTO\s+platform_overview_daily_summary\b/i,
      /\bINSERT\s+INTO\s+platform_overview_summary_ranges\b/i,
      /\bDELETE\s+FROM\s+platform_overview_summary_ranges\b/i,
    ],
    allowedFiles: new Set([
      path.join(repoRoot, "lib/overview-summary-materializer.ts"),
      path.join(repoRoot, "scripts/db-normalization-support.ts"),
      path.join(repoRoot, "scripts/db-write-benchmark.ts"),
    ]),
  },
  {
    surface: "user_facing_reporting_cache",
    patterns: [
      /\bINSERT\s+INTO\s+provider_reporting_snapshots\b/i,
      /\bDELETE\s+FROM\s+provider_reporting_snapshots\b/i,
      /\bUPDATE\s+provider_reporting_snapshots\b/i,
    ],
    allowedFiles: new Set([
      path.join(repoRoot, "lib/reporting-cache-writer.ts"),
      path.join(repoRoot, "lib/google-ads/warehouse.ts"),
      path.join(repoRoot, "scripts/reset-google-ads-stack.ts"),
      path.join(repoRoot, "scripts/db-normalization-support.ts"),
      path.join(repoRoot, "scripts/db-write-benchmark.ts"),
    ]),
  },
  {
    surface: "seo_results_cache",
    patterns: [
      /\bINSERT\s+INTO\s+seo_results_cache\b/i,
      /\bDELETE\s+FROM\s+seo_results_cache\b/i,
      /\bUPDATE\s+seo_results_cache\b/i,
    ],
    allowedFiles: new Set([
      path.join(repoRoot, "lib/seo/results-cache-writer.ts"),
    ]),
  },
  {
    surface: "shopify_overview_serving_state",
    patterns: [
      /\bINSERT\s+INTO\s+shopify_reconciliation_runs\b/i,
      /\bINSERT\s+INTO\s+shopify_serving_state\b/i,
      /\bINSERT\s+INTO\s+shopify_serving_state_history\b/i,
      /\bUPDATE\s+shopify_serving_state\b/i,
      /\bDELETE\s+FROM\s+shopify_reconciliation_runs\b/i,
      /\bDELETE\s+FROM\s+shopify_serving_state\b/i,
    ],
    allowedFiles: new Set([
      path.join(repoRoot, "lib/shopify/overview-materializer.ts"),
      path.join(repoRoot, "scripts/db-write-benchmark.ts"),
    ]),
  },
] as const;

/**
 * Named identity writers, used as a floor under the table-based detection.
 *
 * The primary detector is the TABLE: any reached function whose body writes a
 * guarded table is flagged regardless of its name. These names exist so that a
 * wrapper which delegates its SQL elsewhere is still recognised, and so a
 * rename of one of them shows up as a resolvable-symbol assertion failure in
 * lib/read-path-write-reachability.test.ts rather than as a quiet gap.
 */
const identityWriteHelperSymbols: ReadonlySet<string> = new Set(IDENTITY_WRITE_HELPERS);

const notes = [
  "Migration detection still covers every Next HTTP route handler under app/**/route.ts.",
  `Guarded-table reachability runs on EVERY HTTP method and is anchored on the table (${GUARDED_WRITE_TABLES.join(", ")}), not on a hand-maintained list of function names — the list is what missed upsertIntegration one hop away.`,
  `Every request-path write to a guarded table must have an entry in REQUEST_PATH_WRITE_EXCEPTIONS (scripts/read-path-write-reachability.ts) keyed on caller->writer plus an exact table set; ${REQUEST_PATH_WRITE_EXCEPTIONS.length} are registered today.`,
  "A registry entry that stops matching is reported as stale, so the inventory is frozen in both directions.",
  `The call-graph walk is bounded at ${MAX_CALL_DEPTH} hops and reports truncation instead of passing quietly; dynamic import(), calls through values, class methods and export-default handlers are NOT followed.`,
  "GET/HEAD write detection is now function-scoped: it starts from exported read handlers and follows local, named, and namespace imports transitively.",
  "Read-path findings are grouped as state writes, projection writes, durable cache writes, and refresh/repair triggers.",
  "OAuth callback GET routes are excluded from the legacy NAMED-target read-only guard, but NOT from guarded-table reachability: each one carries its own registry entry naming the tables it may write and why.",
  "User-facing serving/projection/cache writes are also checked for explicit owner-module ownership; tiny allowlists cover out-of-scope admin/reset lanes only.",
];

function toRepoPath(filePath: string) {
  return path.relative(repoRoot, filePath) || filePath;
}

function readFile(filePath: string) {
  return fs.readFileSync(filePath, "utf8");
}

function walkDir(currentPath: string, found: string[] = []) {
  if (!fs.existsSync(currentPath)) return found;
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      walkDir(absolutePath, found);
      continue;
    }
    if (entry.isFile() && absolutePath.endsWith(`${path.sep}route.ts`)) {
      found.push(path.normalize(absolutePath));
    }
  }
  return found;
}

function walkSourceFiles(currentPath: string, found: string[] = []) {
  if (!fs.existsSync(currentPath)) return found;
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walkSourceFiles(absolutePath, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|mts|cts|mjs)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx|mts|cts|mjs)$/.test(entry.name)) continue;
    found.push(path.normalize(absolutePath));
  }
  return found;
}

function discoverRouteEntrypoints() {
  return walkDir(routeRoot).sort((left, right) => left.localeCompare(right));
}

function discoverSourceFiles() {
  return [
    ...walkSourceFiles(path.join(repoRoot, "app")),
    ...walkSourceFiles(path.join(repoRoot, "lib")),
    ...walkSourceFiles(path.join(repoRoot, "scripts")),
  ].sort((left, right) => left.localeCompare(right));
}

function collectRouteGraph(entrypoint: string): RouteGraph {
  const dependencies = new Set<string>();
  const parents = new Map<string, string | null>();
  const queue = [entrypoint];
  parents.set(entrypoint, null);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (dependencies.has(current)) continue;
    dependencies.add(current);

    const moduleInfo = getModuleInfo(current);
    const specifiers = new Set<string>();
    for (const binding of moduleInfo.imports.values()) {
      specifiers.add(binding.specifier);
    }
    for (const binding of moduleInfo.reExports.values()) {
      specifiers.add(binding.specifier);
    }

    for (const specifier of specifiers) {
      const resolved = resolveModule(specifier, current);
      if (!resolved || dependencies.has(resolved)) continue;
      if (!parents.has(resolved)) {
        parents.set(resolved, current);
      }
      queue.push(resolved);
    }
  }

  return { dependencies, parents };
}

function buildImportChain(parents: Map<string, string | null>, targetFile: string) {
  const chain: string[] = [];
  let current: string | null | undefined = targetFile;
  while (current) {
    chain.unshift(toRepoPath(current));
    current = parents.get(current) ?? null;
  }
  return chain;
}

/**
 * Which HTTP handlers a route file exports, and where each one's body actually
 * lives.
 *
 * `export { getGoogleAccountsRoute as GET } from "@/lib/google-api-routes"` is a
 * handler too. Nine route files use that shape, and because the previous
 * version of this function looked only at locally-declared functions, all nine
 * were scanned for NOTHING — the read-path write walk never had an entry point
 * to start from. They did not appear as failures; they appeared as silence.
 */
function extractRouteMethods(filePath: string) {
  const methods = new Map<HttpMethod, ResolvedFunctionTarget | null>();
  const moduleInfo = getModuleInfo(filePath);

  for (const [name, fn] of moduleInfo.functions.entries()) {
    if (fn.exported && HTTP_METHODS.has(name as HttpMethod)) {
      methods.set(name as HttpMethod, { modulePath: filePath, functionName: name });
    }
  }

  for (const exportName of moduleInfo.reExports.keys()) {
    if (!HTTP_METHODS.has(exportName as HttpMethod)) continue;
    if (methods.has(exportName as HttpMethod)) continue;
    methods.set(
      exportName as HttpMethod,
      resolveExportedFunction(filePath, exportName),
    );
  }

  return methods;
}

function getFindingTypeForTarget(targetName: string): FindingType | null {
  if (cacheWriteTargets.has(targetName)) return "cache_write_call";
  if (projectionWriteTargets.has(targetName)) return "projection_write_call";
  if (stateWriteTargets.has(targetName)) return "state_write_call";
  if (refreshTriggerTargets.has(targetName)) return "refresh_trigger_call";
  return null;
}

function hasMixedLiveWarehouseProjection(content: string) {
  const hasLive = /\blive\b|liveReport|liveTotals|current_day|current-day/i.test(content);
  const hasWarehouse = /\bwarehouse\b|_daily\b/i.test(content);
  const hasProjection =
    /\bprojection\b|platform_overview_daily_summary|platform_overview_summary_ranges/i.test(
      content,
    );
  return hasLive && hasWarehouse && hasProjection;
}

function detectGeneralFindings(filePath: string, inRouteGraph: boolean): Finding[] {
  const findings: Finding[] = [];
  const { content, lineCount } = getModuleInfo(filePath);
  const repoPath = toRepoPath(filePath);

  if (inRouteGraph && hasMixedLiveWarehouseProjection(content)) {
    findings.push({
      type: "mixed_live_warehouse_projection",
      file: repoPath,
      summary: "Module mixes live, warehouse, and projection concerns",
      evidence: [
        {
          line: 1,
          snippet: "Detected live + warehouse + projection keywords in the same module",
        },
      ],
    });
  }

  const shouldCheckMixedConcern = mixedConcernTargets.has(filePath) || lineCount >= 800;
  if (shouldCheckMixedConcern) {
    const hasFetch = /\bfetch\s*\(/.test(content);
    const hasSql = /\bSELECT\b|\bINSERT INTO\b|\bUPDATE\b|\bDELETE FROM\b|sql`/i.test(content);
    const hasRouteOrUiComposition =
      /NextResponse\.json|buildMetricCard|useQuery\s*\(|return\s*\(/.test(content);
    const concernCount = [hasFetch, hasSql, hasRouteOrUiComposition].filter(Boolean).length;

    if (lineCount >= 800 && concernCount >= 2) {
      findings.push({
        type: "large_mixed_concern",
        file: repoPath,
        summary: `Large mixed-concern file (${lineCount} lines)`,
        evidence: [
          {
            line: 1,
            snippet: `signals: fetch=${hasFetch}, sql=${hasSql}, compose=${hasRouteOrUiComposition}`,
          },
        ],
      });
    }
  }

  return findings;
}

function detectServingWriteOwnerViolations(sourceFiles: string[]): Finding[] {
  const findings: Finding[] = [];

  for (const filePath of sourceFiles) {
    const content = readFile(filePath);
    for (const rule of servingWriteOwnerRules) {
      if (rule.allowedFiles.has(filePath)) continue;
      const evidence = rule.patterns.flatMap((pattern) => collectEvidence(content, pattern, 2));
      if (evidence.length === 0) continue;
      findings.push({
        type: "serving_write_owner_violation",
        file: toRepoPath(filePath),
        summary: `Writes ${rule.surface} outside approved owner modules`,
        evidence,
      });
    }
  }

  return findings;
}

function detectMigrationFindings(input: {
  routeFile: string;
  routeMethods: HttpMethod[];
  graph: RouteGraph;
}): Finding[] {
  const findings: Finding[] = [];
  const routeRepoPath = toRepoPath(input.routeFile);

  for (const dependency of input.graph.dependencies) {
    const info = getModuleInfo(dependency);
    const dependencyRepoPath = toRepoPath(dependency);
    const chain = buildImportChain(input.graph.parents, dependency);
    const transitiveSource = dependency === input.routeFile ? null : dependencyRepoPath;
    const chainSuffix = chain.length > 1 ? ` via ${chain.join(" -> ")}` : "";

    if (info.migrationImportEvidence.length > 0) {
      findings.push({
        type: "migration_import",
        file: routeRepoPath,
        route: routeRepoPath,
        methods: input.routeMethods,
        transitiveSource,
        summary:
          dependency === input.routeFile
            ? `HTTP route imports runMigrations() directly (${input.routeMethods.join(", ") || "unknown"})`
            : `HTTP route transitively imports runMigrations() from ${dependencyRepoPath} (${input.routeMethods.join(", ") || "unknown"})${chainSuffix}`,
        evidence:
          dependency === input.routeFile
            ? info.migrationImportEvidence
            : [
                {
                  line: 1,
                  snippet: chain.join(" -> "),
                },
                ...info.migrationImportEvidence.slice(0, 2),
              ],
      });
    }

    if (info.migrationCallEvidence.length > 0) {
      findings.push({
        type: "migration_call",
        file: routeRepoPath,
        route: routeRepoPath,
        methods: input.routeMethods,
        transitiveSource,
        summary:
          dependency === input.routeFile
            ? `HTTP route calls runMigrations() directly (${input.routeMethods.join(", ") || "unknown"})`
            : `HTTP route transitively reaches runMigrations() in ${dependencyRepoPath} (${input.routeMethods.join(", ") || "unknown"})${chainSuffix}`,
        evidence:
          dependency === input.routeFile
            ? info.migrationCallEvidence
            : [
                {
                  line: 1,
                  snippet: chain.join(" -> "),
                },
                ...info.migrationCallEvidence.slice(0, 2),
              ],
      });
    }
  }

  return findings;
}

function createReadWriteFinding(input: {
  type: FindingType;
  routeFile: string;
  method: HttpMethod;
  call: FunctionCall;
  mutationTarget: string;
  chain: string[];
  transitiveSource: string | null;
}) {
  const routeRepoPath = toRepoPath(input.routeFile);
  const categoryLabel =
    input.type === "cache_write_call"
      ? "durable cache write"
      : input.type === "projection_write_call"
        ? "projection write"
        : input.type === "state_write_call"
          ? "state write"
          : "refresh/repair trigger";

  return {
    type: input.type,
    file: routeRepoPath,
    route: routeRepoPath,
    methods: [input.method],
    transitiveSource: input.transitiveSource,
    summary: `${input.method} route reaches ${categoryLabel} ${input.mutationTarget}()`,
    evidence: [
      {
        line: 1,
        snippet: input.chain.join(" -> "),
      },
      {
        line: input.call.line,
        snippet: input.call.snippet,
      },
    ],
  } satisfies Finding;
}

function detectReadPathWriteFindingsForRouteMethod(input: {
  routeFile: string;
  method: HttpMethod;
  entry: ResolvedFunctionTarget;
}): Finding[] {
  const findings: Finding[] = [];
  const visited = new Set<string>();

  const traceFunction = (target: ResolvedFunctionTarget, chain: string[]) => {
    const visitKey = `${target.modulePath}:${target.functionName}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    const moduleInfo = getModuleInfo(target.modulePath);
    const fn = moduleInfo.functions.get(target.functionName);
    if (!fn) return;

    for (const call of fn.calls) {
      if (call.type === "identifier" && call.name) {
        const localTargetType = getFindingTypeForTarget(call.name);
        if (localTargetType) {
          findings.push(
            createReadWriteFinding({
              type: localTargetType,
              routeFile: input.routeFile,
              method: input.method,
              call,
              mutationTarget: call.name,
              chain,
              transitiveSource: toRepoPath(target.modulePath),
            }),
          );
          continue;
        }

        const localFunction = moduleInfo.functions.get(call.name);
        if (localFunction) {
          traceFunction(
            {
              modulePath: target.modulePath,
              functionName: call.name,
            },
            [...chain, `${toRepoPath(target.modulePath)}#${call.name}`],
          );
          continue;
        }

        const importBinding = moduleInfo.imports.get(call.name);
        if (!importBinding) continue;
        const resolvedModule = resolveModule(importBinding.specifier, target.modulePath);
        if (!resolvedModule) continue;
        const importedName = importBinding.importedName ?? call.name;
        const importTargetType = getFindingTypeForTarget(importedName);
        if (importTargetType) {
          findings.push(
            createReadWriteFinding({
              type: importTargetType,
              routeFile: input.routeFile,
              method: input.method,
              call,
              mutationTarget: importedName,
              chain,
              transitiveSource: toRepoPath(resolvedModule),
            }),
          );
          continue;
        }

        if (importBinding.kind === "namespace") continue;
        const resolvedTarget =
          importedName === "default"
            ? null
            : resolveExportedFunction(resolvedModule, importedName);
        if (!resolvedTarget) continue;
        traceFunction(
          resolvedTarget,
          [...chain, `${toRepoPath(resolvedTarget.modulePath)}#${resolvedTarget.functionName}`],
        );
        continue;
      }

      if (call.type === "namespace" && call.namespace && call.propertyName) {
        const importBinding = moduleInfo.imports.get(call.namespace);
        if (!importBinding || importBinding.kind !== "namespace") continue;
        const resolvedModule = resolveModule(importBinding.specifier, target.modulePath);
        if (!resolvedModule) continue;
        const targetType = getFindingTypeForTarget(call.propertyName);
        if (targetType) {
          findings.push(
            createReadWriteFinding({
              type: targetType,
              routeFile: input.routeFile,
              method: input.method,
              call,
              mutationTarget: call.propertyName,
              chain,
              transitiveSource: toRepoPath(resolvedModule),
            }),
          );
          continue;
        }

        const resolvedTarget = resolveExportedFunction(resolvedModule, call.propertyName);
        if (!resolvedTarget) continue;
        traceFunction(
          resolvedTarget,
          [...chain, `${toRepoPath(resolvedTarget.modulePath)}#${resolvedTarget.functionName}`],
        );
      }
    }
  };

  traceFunction(input.entry, routeChainPrefix(input.routeFile, input.method, input.entry));

  return findings;
}

/**
 * The chain a route's handler starts from.
 *
 * When the handler is re-exported from a library module the chain must still
 * begin at the ROUTE — that is the thing an operator sees in a URL, and it is
 * what the exception registry keys `via` on.
 */
function routeChainPrefix(
  routeFile: string,
  method: HttpMethod,
  entry: ResolvedFunctionTarget,
) {
  const routeLabel = `${toRepoPath(routeFile)}#${method}`;
  const entryLabel = `${toRepoPath(entry.modulePath)}#${entry.functionName}`;
  return routeLabel === entryLabel ? [routeLabel] : [routeLabel, entryLabel];
}

/**
 * Every guarded-table write this route's handler can reach, minus the ones the
 * registry sanctions.
 *
 * This runs on EVERY HTTP method, not just GET/HEAD. A POST that rewrites
 * `provider_connections` is usually legitimate — but "usually" is the state the
 * previous guard was in, and it is indistinguishable from silence. Requiring
 * every one of them to be registered means the inventory is complete, so a NEW
 * unregistered write fails whichever method it arrives on.
 */
function detectGuardedTableWriteFindings(input: {
  routeFile: string;
  method: HttpMethod;
  entry: ResolvedFunctionTarget;
  matchedExceptionKeys: Set<string>;
}): Finding[] {
  const findings: Finding[] = [];
  const routeRepoPath = toRepoPath(input.routeFile);

  const result = traceReachableWrites({
    graph: moduleGraph,
    entryModule: input.entry.modulePath,
    entryFunction: input.entry.functionName,
    bannedSymbols: identityWriteHelperSymbols,
    chainPrefix: routeChainPrefix(input.routeFile, input.method, input.entry),
  });

  if (result.truncatedAtDepthLimit) {
    findings.push({
      type: "reachability_depth_truncated",
      file: routeRepoPath,
      route: routeRepoPath,
      methods: [input.method],
      transitiveSource: null,
      summary: `${input.method} call graph hit the ${MAX_CALL_DEPTH}-hop bound; writes below it were not examined`,
      evidence: [{ line: 1, snippet: `visited ${result.visitedCount} function(s)` }],
    });
  }

  for (const write of result.writes) {
    if (write.kind !== "table_write") continue;
    const matched = findMatchingException(write);
    if (matched) {
      input.matchedExceptionKeys.add(exceptionKey(matched));
      continue;
    }
    findings.push({
      type: "guarded_table_write_call",
      file: routeRepoPath,
      route: routeRepoPath,
      methods: [input.method],
      transitiveSource: write.writeSite,
      summary: `${input.method} route reaches an unregistered write to ${write.tables.join(", ")} in ${write.writeSite}`,
      evidence: [
        { line: 1, snippet: write.chain.join(" -> ") },
        { line: write.line, snippet: write.snippet },
      ],
    });
  }

  return findings;
}

function dedupeFindings(findings: Finding[]) {
  const seen = new Set<string>();
  const deduped: Finding[] = [];

  for (const finding of findings) {
    const key = [
      finding.type,
      finding.file,
      finding.summary,
      finding.transitiveSource ?? "",
      (finding.methods ?? []).join(","),
      finding.evidence.map((item) => `${item.line}:${item.snippet}`).join("|"),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }

  return deduped;
}

function sortFindings(findings: Finding[]) {
  return [...findings].sort((left, right) => {
    if (left.file === right.file) {
      return left.type.localeCompare(right.type);
    }
    return left.file.localeCompare(right.file);
  });
}

function printReport(findings: Finding[], modulesScanned: number, routesScanned: number) {
  const grouped = new Map<FindingType, Finding[]>();
  for (const finding of findings) {
    const bucket = grouped.get(finding.type) ?? [];
    bucket.push(finding);
    grouped.set(finding.type, bucket);
  }

  console.log("HTTP-route side-effect scan");
  console.log(`Routes scanned: ${routesScanned}`);
  console.log(`Modules scanned: ${modulesScanned}`);
  console.log(`Findings: ${findings.length}`);
  for (const note of notes) {
    console.log(`Note: ${note}`);
  }

  const sections: Array<[FindingType, string]> = [
    ["migration_import", "Migration imports"],
    ["migration_call", "Migration calls"],
    ["state_write_call", "GET state writes"],
    ["projection_write_call", "GET projection writes"],
    ["cache_write_call", "GET durable cache writes"],
    ["refresh_trigger_call", "GET refresh/repair triggers"],
    ["guarded_table_write_call", "Unregistered request-path writes to guarded tables"],
    ["unused_request_path_write_exception", "Stale write-exception registry entries"],
    ["write_exception_registry_defect", "Write-exception registry defects"],
    ["route_handler_not_analyzable", "Route handlers the scan could not resolve"],
    ["reachability_depth_truncated", "Call graphs truncated at the depth bound"],
    ["serving_write_owner_violation", "Serving write-owner violations"],
    ["mixed_live_warehouse_projection", "Mixed live/warehouse/projection modules"],
    ["large_mixed_concern", "Large mixed-concern files"],
  ];

  for (const [type, title] of sections) {
    const entries = grouped.get(type) ?? [];
    console.log(`\n${title}: ${entries.length}`);
    for (const entry of entries) {
      const routeSuffix = entry.route ? ` [route: ${entry.route}]` : "";
      console.log(`- ${entry.file}: ${entry.summary}${routeSuffix}`);
      for (const item of entry.evidence) {
        console.log(`  - line ${item.line}: ${item.snippet}`);
      }
    }
  }
}

function main() {
  const routeEntrypoints = discoverRouteEntrypoints();
  const routeGraphs = routeEntrypoints.map((routeFile) => ({
    routeFile,
    routeMethods: extractRouteMethods(routeFile),
    graph: collectRouteGraph(routeFile),
  }));

  const migrationFindings = routeGraphs.flatMap((entry) =>
    detectMigrationFindings({
      routeFile: entry.routeFile,
      routeMethods: [...entry.routeMethods.keys()].sort(),
      graph: entry.graph,
    }),
  );

  const getWriteFindings = routeGraphs.flatMap((entry) =>
    readOnlyRouteExclusions.has(entry.routeFile)
      ? []
      : [...entry.routeMethods]
          .filter(([method, target]) => READ_ONLY_METHODS.has(method) && target != null)
          .flatMap(([method, target]) =>
            detectReadPathWriteFindingsForRouteMethod({
              routeFile: entry.routeFile,
              method,
              entry: target!,
            }),
          ),
  );

  // ── guarded-table reachability, on every method ────────────────────────────
  const matchedExceptionKeys = new Set<string>();
  const guardedTableFindings = routeGraphs.flatMap((entry) =>
    [...entry.routeMethods]
      .filter(([, target]) => target != null)
      .flatMap(([method, target]) =>
        detectGuardedTableWriteFindings({
          routeFile: entry.routeFile,
          method,
          entry: target!,
          matchedExceptionKeys,
        }),
      ),
  );

  // A route file that exports handlers this scan cannot resolve is a blind
  // spot, and a blind spot must not read as a pass.
  const unanalyzableFindings: Finding[] = routeGraphs.flatMap((entry) => {
    const unresolved = [...entry.routeMethods]
      .filter(([, target]) => target == null)
      .map(([method]) => method);
    const repoPath = toRepoPath(entry.routeFile);
    if (unresolved.length > 0) {
      return [
        {
          type: "route_handler_not_analyzable" as const,
          file: repoPath,
          route: repoPath,
          methods: unresolved,
          transitiveSource: null,
          summary: `Exported handler(s) ${unresolved.join(", ")} could not be resolved to a function body`,
          evidence: [{ line: 1, snippet: "re-export target missing, default export, or non-function binding" }],
        },
      ];
    }
    if (entry.routeMethods.size === 0) {
      return [
        {
          type: "route_handler_not_analyzable" as const,
          file: repoPath,
          route: repoPath,
          methods: [],
          transitiveSource: null,
          summary: "Route file exports no recognisable HTTP handler",
          evidence: [{ line: 1, snippet: "no exported GET/POST/... function or named re-export" }],
        },
      ];
    }
    return [];
  });

  // A registry entry that no longer matches anything is a hole nobody is using
  // — and a hole nobody is using is a hole nobody is watching.
  const staleExceptionFindings: Finding[] = REQUEST_PATH_WRITE_EXCEPTIONS.filter(
    (entry) => !matchedExceptionKeys.has(exceptionKey(entry)),
  ).map((entry) => ({
    type: "unused_request_path_write_exception" as const,
    file: "scripts/read-path-write-reachability.ts",
    transitiveSource: entry.writeSite,
    summary: `Registered request-path write exception "${exceptionKey(entry)}" no longer matches any route; delete it`,
    evidence: [{ line: 1, snippet: entry.reason.slice(0, 200) }],
  }));

  const registryDefectFindings: Finding[] = validateExceptionRegistry().map((problem) => ({
    type: "write_exception_registry_defect" as const,
    file: "scripts/read-path-write-reachability.ts",
    transitiveSource: null,
    summary: problem,
    evidence: [{ line: 1, snippet: problem }],
  }));

  const allDependencies = new Set<string>();
  for (const routeGraph of routeGraphs) {
    for (const dependency of routeGraph.graph.dependencies) {
      allDependencies.add(dependency);
    }
  }
  for (const target of mixedConcernTargets) {
    if (fs.existsSync(target)) allDependencies.add(target);
  }

  const generalFindings = [...allDependencies]
    .filter((filePath) => fs.existsSync(filePath))
    .flatMap((filePath) => detectGeneralFindings(filePath, allDependencies.has(filePath)));
  const servingOwnerFindings = detectServingWriteOwnerViolations(discoverSourceFiles());

  const findings = sortFindings(
    dedupeFindings([
      ...migrationFindings,
      ...getWriteFindings,
      ...guardedTableFindings,
      ...unanalyzableFindings,
      ...staleExceptionFindings,
      ...registryDefectFindings,
      ...servingOwnerFindings,
      ...generalFindings,
    ]),
  );

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          routesScanned: routeEntrypoints.length,
          modulesScanned: allDependencies.size,
          notes,
          findings,
        },
        null,
        2,
      ),
    );
    return;
  }

  printReport(findings, allDependencies.size, routeEntrypoints.length);
}

main();
