/**
 * Transitive read-path write reachability.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * A production cutover's backup verification failed because an ordinary
 * authenticated GET mutated `provider_connections` and `integration_credentials`.
 * The Google token refresh persisted through `upsertIntegration`, which cannot
 * tell a refresh from a reconnect, and `executeGaqlQuery` calls that refresh on
 * every query — so ~36 read routes wrote to the identity tables.
 *
 * TWO guards existed specifically to stop read paths writing, and BOTH missed it:
 *
 *   1. `lib/get-read-path-module-guard.test.ts` banned the literal string
 *      `upsertIntegration(` inside three read-path modules. The call had moved
 *      ONE HOP away, into `lib/google-token-refresh.ts`, so the literal no
 *      longer appeared in any guarded file. A grep over one file is defeated by
 *      a single indirection.
 *
 *   2. `scripts/check-request-path-side-effects.ts` already walked the call
 *      graph transitively — but only for symbols enumerated by hand in
 *      `cacheWriteTargets` / `projectionWriteTargets` / `stateWriteTargets` /
 *      `refreshTriggerTargets`. Neither `upsertIntegration` nor the refresh
 *      helper was in any of them. A hand-maintained name list is only as good
 *      as the last person who remembered to extend it.
 *
 * ── WHAT CHANGED ─────────────────────────────────────────────────────────────
 *
 * Detection is no longer anchored on FUNCTION NAMES. It is anchored on the
 * TABLE. A request path is flagged when the call graph reaches any function
 * whose body writes one of GUARDED_WRITE_TABLES, whatever that function is
 * called and however many hops away it sits.
 *
 * That property is what makes this survive the refactor that was landing while
 * this guard was written: the refresh's write moved from `upsertIntegration` to
 * a new, narrower `refreshIntegrationCredentialTokens`. A name list would have
 * gone quiet. This did not — it re-reported the new writer immediately, under
 * its new name, because the SQL was still there.
 *
 * ── HONEST LIMITS ────────────────────────────────────────────────────────────
 *
 * This is a syntactic call-graph walk over resolved relative/`@/` imports. It
 * is an over-approximation in some directions and an UNDER-approximation in
 * these, which are the ways a write can still hide:
 *
 *   - Dynamic `await import(...)` is not followed.
 *   - Calls through a value rather than a name — `const f = writer; f()`,
 *     `handlers[key]()`, `obj.method()` where `obj` is a local object or class
 *     instance — are not followed. Class methods are not indexed at all.
 *   - `export default` and `export * from` are not followed (named re-exports
 *     ARE followed, including `export { x as GET } from "..."`).
 *   - Table names built at runtime (`UPDATE ${table}`) are invisible.
 *   - Module top-level side effects are not attributed to any handler.
 *   - Non-`app/**​/route.ts` entry points — server components, middleware,
 *     instrumentation — are outside the request-path scan.
 *
 * Every one of those is a real gap. They are listed rather than papered over so
 * that "the guard passed" is never read as "there is no such write".
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Depth bound on the call-graph walk.
 *
 * The deepest real chain in this repository is 9 hops
 * (`app/api/overview/route.ts#GET` → overview-service → google serving →
 * reporting → reporting-core → gaql → gaql → token-refresh → the credential
 * write). 24 leaves ~2.5x headroom for the graph to grow without anyone having
 * to think about this number.
 *
 * It is not a performance knob: traversal is memoised per (module#function,
 * shallowest depth seen), so the bound changes almost nothing about cost. It
 * exists so a pathological cycle cannot hang CI. Hitting it is REPORTED
 * (`truncatedAtDepthLimit`) rather than swallowed, because a silent truncation
 * is indistinguishable from a clean pass.
 */
export const MAX_CALL_DEPTH = 24;

/**
 * Tables whose writes must never happen on a request path without a registered,
 * written justification.
 *
 * The first four are the connection-identity surface: who is connected, with
 * which credential, to which provider account, and which accounts are selected.
 * A read that rewrites any of them can silently revoke authority, invalidate a
 * credential, or — as happened — make a backup's readback disagree with the
 * live row.
 *
 * `sync_runtime_instances` is here for a different reason: `/api/build-info`
 * and the admin health surfaces write it on GET deliberately, as a runtime
 * heartbeat. It is included precisely so that legitimate write is REGISTERED
 * rather than invisible, and so a second, unconsidered heartbeat write cannot
 * be added to a read path without someone writing down why.
 */
export const GUARDED_WRITE_TABLES = [
  "provider_connections",
  "integration_credentials",
  "business_provider_accounts",
  "provider_account_assignments",
  "sync_runtime_instances",
] as const;

export type GuardedWriteTable = (typeof GUARDED_WRITE_TABLES)[number];

const TABLE_WRITE_PATTERNS: ReadonlyArray<readonly [GuardedWriteTable, RegExp]> =
  GUARDED_WRITE_TABLES.map(
    (table) =>
      [table, new RegExp(String.raw`(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+${table}\b`, "i")] as const,
  );

/**
 * Named helpers that must never be reached from a read path, kept as a FLOOR
 * under the table-based detection rather than as the detection itself.
 *
 * Table detection catches a writer only if the SQL is lexically inside the
 * function it walks to. These names cover the wrappers a future refactor might
 * put in front of that SQL — and they are asserted to be resolvable, so a
 * rename cannot leave a dead entry quietly matching nothing.
 */
export const IDENTITY_WRITE_HELPERS = [
  // lib/integrations.ts
  "upsertIntegration",
  "refreshIntegrationCredentialTokens",
  "disconnectIntegration",
  "disconnectAllIntegrationsForProvider",
  "setIntegrationError",
  "mergeIntegrationMetadata",
  "backfillIntegrationSecretsEncryption",
  // lib/provider-account-assignments.ts
  "replaceProviderAccountSelection",
  "upsertProviderAccountAssignments",
  "clearProviderAccountAssignments",
  "clearAllProviderAccountAssignmentsForProvider",
  // lib/provider-selection-revocation.ts
  "revokeAllProviderAccountSelection",
  // lib/sync/runtime-contract.ts
  "upsertRuntimeContractInstance",
  // lib/google-token-refresh.ts — the credential-refresh path itself. Named
  // here so that the refresh is a recognised write boundary even if its
  // persist moves behind another indirection again.
  "resolveGoogleAccessTokenWithGeneration",
] as const;

/**
 * A request-path write that is legitimate, and is therefore REGISTERED rather
 * than silent.
 *
 * The key is the last EDGE of the call chain — the function that performs the
 * write, plus the function that called it — and the exact set of guarded tables
 * that edge may write. That grain is deliberate:
 *
 *   - keying only on the writer (`lib/integrations.ts#upsertIntegration`) would
 *     re-open the original defect, because ANY read path reaching it would then
 *     pass;
 *   - keying on every (route, method, writer) triple would mean ~59 entries,
 *     most of them restating the same fact, and a registry nobody maintains is
 *     a registry that gets silenced;
 *   - keying on the edge means the ONE sanctioned caller of a writer is named,
 *     and a second caller — the shape of the defect this guard exists for —
 *     fails.
 *
 * The original defect fails against this registry twice over: it entered
 * `lib/integrations.ts#upsertIntegration` (a different writer than the
 * registered one) and it wrote `provider_connections` (a table the refresh
 * boundary is not registered for).
 */
export interface RequestPathWriteException {
  /** `<repo-relative module>#<function>` that contains the write. */
  writeSite: string;
  /**
   * `<repo-relative module>#<function>` that calls the write site, or `null`
   * when the write is inline in the entry handler itself.
   */
  via: string | null;
  /** Exactly the guarded tables this edge is allowed to write. */
  tables: GuardedWriteTable[];
  /** Why this write is legitimate on a request path. Enforced non-trivial. */
  reason: string;
}

/**
 * Every request-path write to a guarded table that exists today, with the
 * reason it is allowed to.
 *
 * Adding an entry here is a deliberate act: it needs a writer, its one
 * sanctioned caller, an explicit table list, and a reason long enough that
 * "ok" does not pass. Removing the last thing an entry matched is also a
 * deliberate act — a stale entry is reported as `unused_request_path_write_exception`
 * rather than left to rot into a permanent hole.
 */
export const REQUEST_PATH_WRITE_EXCEPTIONS: ReadonlyArray<RequestPathWriteException> = [
  // ── credential refresh ─────────────────────────────────────────────────────
  {
    writeSite: "lib/integrations.ts#refreshIntegrationCredentialTokens",
    via: "lib/google-token-refresh.ts#resolveGoogleAccessTokenWithGeneration",
    tables: ["integration_credentials"],
    reason:
      "The only sanctioned read-path write. An expired Google access token must be re-minted mid-request or every Google read fails, and the new token has to be persisted or the next request mints another one. It is registered for integration_credentials ONLY: rewriting provider_connections from here is the defect that made a cutover's backup readback disagree with the live row, so that table is deliberately absent and re-adding it must be argued for.",
  },

  // ── OAuth callbacks: connect/reconnect, GET only because of the redirect ───
  {
    writeSite: "lib/integrations.ts#upsertIntegration",
    via: "app/api/oauth/google/callback/route.ts#GET",
    tables: ["provider_connections", "integration_credentials", "business_provider_accounts"],
    reason:
      "OAuth callback: this IS the connect/reconnect writer. It is a GET only because the provider redirects the browser back here; the user has just granted authority and rewriting the connection row is the entire point of the request.",
  },
  {
    writeSite: "lib/integrations.ts#upsertIntegration",
    via: "app/api/oauth/meta/callback/route.ts#GET",
    tables: ["provider_connections", "integration_credentials", "business_provider_accounts"],
    reason:
      "OAuth callback: this IS the connect/reconnect writer for Meta. GET only because the provider redirects the browser back here after the user grants authority.",
  },
  {
    writeSite: "lib/integrations.ts#upsertIntegration",
    via: "app/api/oauth/google-analytics/callback/route.ts#GET",
    tables: ["provider_connections", "integration_credentials", "business_provider_accounts"],
    reason:
      "OAuth callback: this IS the connect writer for the GA4 grant. GET only because the provider redirects the browser back here after the user grants authority.",
  },
  {
    writeSite: "lib/integrations.ts#upsertIntegration",
    via: "app/api/oauth/search_console/callback/route.ts#GET",
    tables: ["provider_connections", "integration_credentials", "business_provider_accounts"],
    reason:
      "OAuth callback: this IS the connect writer for the Search Console grant. GET only because the provider redirects the browser back here after the user grants authority.",
  },
  {
    writeSite: "lib/integrations.ts#upsertIntegration",
    via: "app/api/oauth/shopify/callback/route.ts#GET",
    tables: ["provider_connections", "integration_credentials", "business_provider_accounts"],
    reason:
      "OAuth callback: this IS the connect writer for the Shopify install grant. GET only because Shopify redirects the browser back here after the merchant approves the scopes.",
  },
  {
    writeSite: "lib/provider-account-assignments.ts#replaceProviderAccountSelection",
    via: "lib/oauth/post-connect-schedule.ts#scheduleAfterProviderConnect",
    tables: ["business_provider_accounts", "provider_account_assignments"],
    reason:
      "Reached only from the Google and Meta OAuth callbacks, immediately after a successful grant, to seed the initial account selection so a freshly connected business is not left with nothing selected. Bounded to the connect moment, not a general read path.",
  },

  // ── runtime heartbeat ──────────────────────────────────────────────────────
  {
    writeSite: "lib/sync/runtime-contract.ts#upsertRuntimeContractInstance",
    via: "app/api/build-info/route.ts#GET",
    tables: ["sync_runtime_instances"],
    reason:
      "Deliberate liveness heartbeat: /api/build-info is how an operator and the post-deploy verifier learn which build a web instance is running, and the registry row is that answer. Writing it on GET is the design — the row is per-instance runtime presence, not business data, and the call is .catch()-swallowed so the read still answers if the write fails.",
  },
  {
    writeSite: "lib/sync/runtime-contract.ts#upsertRuntimeContractInstance",
    via: "app/api/meta/status/route.ts#GET",
    tables: ["sync_runtime_instances"],
    reason:
      "Same liveness heartbeat as /api/build-info, on the Meta status surface: the instance registers its runtime contract so a status read from an instance running a stale build is identifiable as such.",
  },
  {
    writeSite: "lib/sync/runtime-contract.ts#upsertRuntimeContractInstance",
    via: "lib/admin-operations-health.ts#getAdminOperationsHealth",
    tables: ["sync_runtime_instances"],
    reason:
      "The admin operations-health composite registers the answering instance before reporting on the registry, so 'which instances are live' includes the one being asked. Reached from the admin GET surfaces and from the cron lane.",
  },

  // ── explicit user/operator actions on non-read methods ─────────────────────
  {
    writeSite: "lib/integrations.ts#upsertIntegration",
    via: "lib/search-console-selection-writer.ts#writeSearchConsoleSiteSelection",
    tables: ["provider_connections", "integration_credentials", "business_provider_accounts"],
    reason:
      "Persisting the Search Console site the operator picked. Reached only from the two POST select-site surfaces; the selection is stored on the integration row, so the connection writer is the writer.",
  },
  {
    writeSite: "lib/integrations.ts#upsertIntegration",
    via: "lib/shopify/install-context.ts#finalizeShopifyInstall",
    tables: ["provider_connections", "integration_credentials", "business_provider_accounts"],
    reason:
      "Finalising a Shopify install (POST /api/oauth/shopify/finalize) binds the shop's offline token to a business. This is a connect, on an explicit POST.",
  },
  {
    writeSite: "lib/integrations.ts#upsertIntegration",
    via: "app/api/google-analytics/select-property/route.ts#POST",
    tables: ["provider_connections", "integration_credentials", "business_provider_accounts"],
    reason:
      "Persisting the GA4 property the operator picked, on an explicit POST. The selection lives on the integration row.",
  },
  {
    writeSite: "lib/integrations.ts#mergeIntegrationMetadata",
    via: "app/api/admin/integrations/health/shopify/route.ts#PATCH",
    tables: ["integration_credentials"],
    reason:
      "Admin repair surface: rewrites the recorded Shopify shop domain when it has drifted from the live shop. Explicit PATCH by an admin, touches metadata only — but it does bump integration_credentials.updated_at, which is why it is registered rather than assumed harmless.",
  },
  {
    writeSite: "lib/integrations.ts#mergeIntegrationMetadata",
    via: "lib/sync/shopify-sync.ts#ensureShopifyProviderReady",
    tables: ["integration_credentials"],
    reason:
      "The Shopify readiness bootstrap writes its own progress into integration metadata so a long bootstrap is observable while it runs. Reached from the admin health surface's repair actions. Metadata only, but it bumps integration_credentials.updated_at — and this edge stayed invisible until the walk started recording every caller of an already-seen writer, which is why it is written down here rather than assumed.",
  },
  {
    writeSite: "lib/integrations.ts#disconnectIntegration",
    via: "app/api/integrations/route.ts#DELETE",
    tables: ["provider_connections", "integration_credentials", "business_provider_accounts"],
    reason:
      "The user disconnecting a provider. DELETE, and the write is the requested effect.",
  },
  {
    writeSite: "lib/provider-account-assignments.ts#replaceProviderAccountSelection",
    via: "lib/provider-account-assignments.ts#upsertProviderAccountAssignments",
    tables: ["business_provider_accounts", "provider_account_assignments"],
    reason:
      "The operator changing which provider accounts a business uses, from the POST assign-accounts surfaces. Increasing authority, so it stays behind every ordinary selection rule; registered here because it is a request-path write, not because it is exempt from those rules.",
  },
  {
    writeSite: "lib/provider-selection-revocation.ts#revokeAllProviderAccountSelection",
    via: "lib/provider-assignment-service.ts#handleProviderAssignmentRequest",
    tables: ["business_provider_accounts"],
    reason:
      "'Stop using my accounts' from the POST assign-accounts surfaces. Deliberately NOT lane-guarded — a user is more likely to want to revoke when the integration is broken, not less — and safe to exempt because it can only ever set is_selected=FALSE. Registered so that this exemption is visible rather than inferred from its absence.",
  },
  {
    writeSite: "app/api/businesses/[businessId]/route.ts#DELETE",
    via: null,
    tables: ["provider_connections", "business_provider_accounts"],
    reason:
      "Deleting a business tears down its provider connections and account bindings inline. DELETE, and the write is the requested effect.",
  },
  {
    writeSite: "app/api/admin/businesses/[businessId]/route.ts#DELETE",
    via: null,
    tables: ["provider_connections", "business_provider_accounts"],
    reason:
      "Admin deletion of a business, same teardown as the owner-facing DELETE.",
  },
  {
    writeSite: "app/api/webhooks/shopify/shop-redact/route.ts#POST",
    via: null,
    tables: ["provider_connections"],
    reason:
      "Shopify's mandatory shop/redact compliance webhook: 48h after uninstall the connection rows for that shop MUST be deleted. Registered with its exposure stated plainly — this endpoint is public and authenticated by HMAC alone, so the HMAC verification in lib/shopify/webhook-verification.ts is the only thing standing between an unauthenticated caller and a DELETE of provider_connections.",
  },
];

const MIN_REASON_LENGTH = 60;

export function validateExceptionRegistry(
  entries: ReadonlyArray<RequestPathWriteException> = REQUEST_PATH_WRITE_EXCEPTIONS,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = exceptionKey(entry);
    if (seen.has(key)) problems.push(`duplicate registry entry: ${key}`);
    seen.add(key);
    if (entry.reason.trim().length < MIN_REASON_LENGTH) {
      problems.push(
        `registry entry ${key} has a reason shorter than ${MIN_REASON_LENGTH} characters; say why the write is legitimate`,
      );
    }
    if (entry.tables.length === 0) {
      problems.push(`registry entry ${key} allows no tables; delete it instead`);
    }
    for (const table of entry.tables) {
      if (!(GUARDED_WRITE_TABLES as readonly string[]).includes(table)) {
        problems.push(`registry entry ${key} names unknown table ${table}`);
      }
    }
    if (!entry.writeSite.includes("#")) {
      problems.push(`registry entry ${key} writeSite must be "<module>#<function>"`);
    }
  }
  return problems;
}

export function exceptionKey(entry: RequestPathWriteException) {
  return `${entry.via ?? "<direct>"} -> ${entry.writeSite}`;
}

// ── module graph ─────────────────────────────────────────────────────────────

export interface ImportBinding {
  localName: string;
  importedName: string | null;
  specifier: string;
  kind: "named" | "namespace" | "default";
  line: number;
  snippet: string;
}

export interface ReExportBinding {
  exportName: string;
  importedName: string;
  specifier: string;
}

export interface FunctionCall {
  type: "identifier" | "namespace";
  name?: string;
  namespace?: string;
  propertyName?: string;
  line: number;
  snippet: string;
}

export interface FunctionInfo {
  name: string;
  line: number;
  exported: boolean;
  bodyText: string;
  calls: FunctionCall[];
}

export interface ModuleInfo {
  filePath: string;
  content: string;
  sourceFile: ts.SourceFile;
  imports: Map<string, ImportBinding>;
  reExports: Map<string, ReExportBinding>;
  functions: Map<string, FunctionInfo>;
  lineCount: number;
  migrationImportEvidence: Evidence[];
  migrationCallEvidence: Evidence[];
}

export interface Evidence {
  line: number;
  snippet: string;
}

export interface ResolvedFunctionTarget {
  modulePath: string;
  functionName: string;
}

export function lineForOffset(content: string, offset: number) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export function collectEvidence(content: string, pattern: RegExp, limit = 5) {
  const evidence: Evidence[] = [];
  const globalPattern = pattern.global
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`);
  for (const match of content.matchAll(globalPattern)) {
    if (match.index == null) continue;
    evidence.push({
      line: lineForOffset(content, match.index),
      snippet: match[0].trim(),
    });
    if (evidence.length >= limit) break;
  }
  return evidence;
}

export function normalizeSnippet(snippet: string, maxLength = 220) {
  const normalized = snippet.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function getNodeLine(sourceFile: ts.SourceFile, node: ts.Node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function hasExportModifier(node: ts.Node) {
  if (!ts.canHaveModifiers(node)) return false;
  return (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function collectFunctionCalls(
  sourceFile: ts.SourceFile,
  node: ts.FunctionLikeDeclarationBase,
): FunctionCall[] {
  const calls: FunctionCall[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child)) {
      const line = getNodeLine(sourceFile, child);
      const snippet = normalizeSnippet(child.getText(sourceFile));
      if (ts.isIdentifier(child.expression)) {
        calls.push({ type: "identifier", name: child.expression.text, line, snippet });
      } else if (
        ts.isPropertyAccessExpression(child.expression) &&
        ts.isIdentifier(child.expression.expression)
      ) {
        calls.push({
          type: "namespace",
          namespace: child.expression.expression.text,
          propertyName: child.expression.name.text,
          line,
          snippet,
        });
      }
    }
    ts.forEachChild(child, visit);
  };

  if (node.body) ts.forEachChild(node.body, visit);
  return calls;
}

export interface ModuleGraph {
  repoRoot: string;
  toRepoPath: (filePath: string) => string;
  getModuleInfo: (filePath: string) => ModuleInfo;
  resolveModule: (specifier: string, fromFile: string) => string | null;
  resolveExportedFunction: (
    modulePath: string,
    exportName: string,
    seen?: Set<string>,
  ) => ResolvedFunctionTarget | null;
}

export function createModuleGraph(repoRoot: string): ModuleGraph {
  const cache = new Map<string, ModuleInfo>();

  const toRepoPath = (filePath: string) => path.relative(repoRoot, filePath) || filePath;

  const resolveModule = (specifier: string, fromFile: string) => {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;

    const basePath = specifier.startsWith("@/")
      ? path.join(repoRoot, specifier.slice(2))
      : path.resolve(path.dirname(fromFile), specifier);

    const candidates = [
      basePath,
      `${basePath}.ts`,
      `${basePath}.tsx`,
      `${basePath}.mts`,
      `${basePath}.cts`,
      path.join(basePath, "index.ts"),
      path.join(basePath, "index.tsx"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return path.normalize(candidate);
      }
    }
    return null;
  };

  const getModuleInfo = (filePath: string): ModuleInfo => {
    const cached = cache.get(filePath);
    if (cached) return cached;

    const content = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const imports = new Map<string, ImportBinding>();
    const reExports = new Map<string, ReExportBinding>();
    const functions = new Map<string, FunctionInfo>();

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        const importClause = statement.importClause;
        if (importClause?.name) {
          imports.set(importClause.name.text, {
            localName: importClause.name.text,
            importedName: "default",
            specifier,
            kind: "default",
            line: getNodeLine(sourceFile, statement),
            snippet: normalizeSnippet(statement.getText(sourceFile)),
          });
        }
        const namedBindings = importClause?.namedBindings;
        if (namedBindings && ts.isNamespaceImport(namedBindings)) {
          imports.set(namedBindings.name.text, {
            localName: namedBindings.name.text,
            importedName: null,
            specifier,
            kind: "namespace",
            line: getNodeLine(sourceFile, statement),
            snippet: normalizeSnippet(statement.getText(sourceFile)),
          });
        } else if (namedBindings && ts.isNamedImports(namedBindings)) {
          for (const element of namedBindings.elements) {
            const localName = element.name.text;
            const importedName = (element.propertyName ?? element.name).text;
            imports.set(localName, {
              localName,
              importedName,
              specifier,
              kind: "named",
              line: getNodeLine(sourceFile, element),
              snippet: normalizeSnippet(element.getText(sourceFile)),
            });
          }
        }
        continue;
      }

      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const specifier = statement.moduleSpecifier.text;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const exportName = element.name.text;
            const importedName = (element.propertyName ?? element.name).text;
            reExports.set(exportName, { exportName, importedName, specifier });
          }
        }
        continue;
      }

      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        functions.set(statement.name.text, {
          name: statement.name.text,
          line: getNodeLine(sourceFile, statement),
          exported: hasExportModifier(statement),
          bodyText: statement.body.getText(sourceFile),
          calls: collectFunctionCalls(sourceFile, statement),
        });
        continue;
      }

      if (ts.isVariableStatement(statement)) {
        const exported = hasExportModifier(statement);
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;

          if (
            ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer)
          ) {
            functions.set(declaration.name.text, {
              name: declaration.name.text,
              line: getNodeLine(sourceFile, declaration),
              exported,
              bodyText: declaration.initializer.body.getText(sourceFile),
              calls: collectFunctionCalls(sourceFile, declaration.initializer),
            });
            continue;
          }

          // Object-literal members, indexed as `<const>.<member>`.
          //
          // `lib/sync/provider-worker-adapters.ts` exports its three durable
          // lanes as `export const googleAdsWorkerAdapter: ProviderWorkerAdapter
          // = { … }` and nothing else. Without this, that module had ZERO
          // analysable exports: a reachability check on it was not clean, it was
          // vacuous, and the entire durable worker lane — which performs a
          // credential refresh — was invisible to the walk.
          //
          // Members are indexed as entry points. Resolving a CALL through such a
          // member (`adapter.loadAccounts()` where `adapter` is a local
          // variable) is still not possible here; see the limits note at the top.
          if (ts.isObjectLiteralExpression(declaration.initializer)) {
            for (const property of declaration.initializer.properties) {
              const propertyName = property.name;
              if (!propertyName || !(ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName))) {
                continue;
              }
              const memberKey = `${declaration.name.text}.${propertyName.text}`;
              if (
                ts.isPropertyAssignment(property) &&
                (ts.isArrowFunction(property.initializer) ||
                  ts.isFunctionExpression(property.initializer))
              ) {
                functions.set(memberKey, {
                  name: memberKey,
                  line: getNodeLine(sourceFile, property),
                  exported,
                  bodyText: property.initializer.body.getText(sourceFile),
                  calls: collectFunctionCalls(sourceFile, property.initializer),
                });
                continue;
              }
              if (ts.isMethodDeclaration(property) && property.body) {
                functions.set(memberKey, {
                  name: memberKey,
                  line: getNodeLine(sourceFile, property),
                  exported,
                  bodyText: property.body.getText(sourceFile),
                  calls: collectFunctionCalls(sourceFile, property),
                });
              }
            }
          }
        }
      }
    }

    const info: ModuleInfo = {
      filePath,
      content,
      sourceFile,
      imports,
      reExports,
      functions,
      lineCount: content.split("\n").length,
      migrationImportEvidence: collectEvidence(
        content,
        /import\s+[\s\S]*?\brunMigrations\b[\s\S]*?from\s+["']@\/lib\/migrations["']|\{\s*runMigrations\s*\}\s*=\s*await\s*import\(\s*["']@\/lib\/migrations["']\s*\)/g,
        5,
      ),
      migrationCallEvidence: collectEvidence(content, /\brunMigrations\s*\(/g, 5),
    };

    cache.set(filePath, info);
    return info;
  };

  const resolveExportedFunction = (
    modulePath: string,
    exportName: string,
    seen = new Set<string>(),
  ): ResolvedFunctionTarget | null => {
    const loopKey = `${modulePath}:${exportName}`;
    if (seen.has(loopKey)) return null;
    seen.add(loopKey);

    const moduleInfo = getModuleInfo(modulePath);
    if (moduleInfo.functions.has(exportName)) return { modulePath, functionName: exportName };

    const reExport = moduleInfo.reExports.get(exportName);
    if (!reExport) return null;

    const resolvedModule = resolveModule(reExport.specifier, modulePath);
    if (!resolvedModule) return null;

    return resolveExportedFunction(resolvedModule, reExport.importedName, seen);
  };

  return { repoRoot, toRepoPath, getModuleInfo, resolveModule, resolveExportedFunction };
}

// ── reachability ─────────────────────────────────────────────────────────────

export function detectGuardedTableWrites(bodyText: string): GuardedWriteTable[] {
  const tables: GuardedWriteTable[] = [];
  for (const [table, pattern] of TABLE_WRITE_PATTERNS) {
    if (pattern.test(bodyText)) tables.push(table);
  }
  return tables;
}

export interface ReachedWrite {
  kind: "table_write" | "banned_symbol";
  /** `<module>#<function>` chain from the entry to the write site. */
  chain: string[];
  /** `<module>#<function>` performing the write, or the banned symbol name. */
  writeSite: string;
  /** The caller of the write site, or `null` when the entry writes inline. */
  via: string | null;
  tables: GuardedWriteTable[];
  line: number;
  snippet: string;
}

export interface TraceResult {
  writes: ReachedWrite[];
  /** True when the walk stopped at MAX_CALL_DEPTH; findings may be incomplete. */
  truncatedAtDepthLimit: boolean;
  /** Distinct `<module>#<function>` nodes visited. */
  visitedCount: number;
}

export interface TraceOptions {
  graph: ModuleGraph;
  entryModule: string;
  entryFunction: string;
  /** Extra symbol names to flag on sight, on top of table-write detection. */
  bannedSymbols?: ReadonlySet<string>;
  /**
   * Chain entries preceding the entry function. Used when a route re-exports
   * its handler (`export { handler as GET } from …`) so the reported chain — and
   * therefore the `via` a registry entry is keyed on — starts at the ROUTE, not
   * at the library function the route happens to borrow.
   */
  chainPrefix?: string[];
  maxDepth?: number;
}

/**
 * Walk the call graph from one entry function and report every guarded-table
 * write and banned symbol it can reach.
 *
 * Memoisation records the SHALLOWEST depth each node was reached at and
 * re-visits when a shorter path arrives, so the depth bound cannot make a node
 * that is genuinely near the entry invisible because some long path found it
 * first.
 */
export function traceReachableWrites(options: TraceOptions): TraceResult {
  const { graph, entryModule, entryFunction } = options;
  const maxDepth = options.maxDepth ?? MAX_CALL_DEPTH;
  const bannedSymbols = options.bannedSymbols ?? new Set<string>();

  const writes: ReachedWrite[] = [];
  const seenWriteKeys = new Set<string>();
  const visitedAtDepth = new Map<string, number>();
  let truncatedAtDepthLimit = false;

  const record = (write: ReachedWrite) => {
    const key = `${write.kind}|${write.via ?? ""}|${write.writeSite}|${write.tables.join(",")}`;
    if (seenWriteKeys.has(key)) return;
    seenWriteKeys.add(key);
    writes.push(write);
  };

  const walk = (modulePath: string, functionName: string, chain: string[], depth: number) => {
    const nodeKey = `${modulePath}#${functionName}`;

    if (depth > maxDepth) {
      truncatedAtDepthLimit = true;
      return;
    }

    const moduleInfo = graph.getModuleInfo(modulePath);
    const fn = moduleInfo.functions.get(functionName);
    if (!fn) return;

    // Record this node's OWN write on EVERY arrival, before the visited check.
    //
    // Memoising the whole visit would report only the first path that reached a
    // writer — and `via` (the caller) is what the exception registry is keyed
    // on. A second, unregistered caller of an already-visited writer would then
    // hide behind the registered first one: exactly the "one sanctioned caller
    // silently becomes every caller" failure this registry exists to prevent.
    //
    // Deeper writes keep the first chain that found them, which is sound for
    // the registry: a deep write's `via` is its immediate caller, and that is
    // the same node however the walk arrived at it.
    const tables = detectGuardedTableWrites(fn.bodyText);
    if (tables.length > 0) {
      record({
        kind: "table_write",
        chain,
        writeSite: `${graph.toRepoPath(modulePath)}#${functionName}`,
        via: chain.length >= 2 ? chain[chain.length - 2] : null,
        tables,
        line: fn.line,
        snippet: `writes ${tables.join(", ")}`,
      });
    }

    const previousDepth = visitedAtDepth.get(nodeKey);
    if (previousDepth != null && previousDepth <= depth) return;
    visitedAtDepth.set(nodeKey, depth);

    for (const call of fn.calls) {
      if (call.type === "identifier" && call.name) {
        if (bannedSymbols.has(call.name)) {
          record({
            kind: "banned_symbol",
            chain,
            writeSite: call.name,
            via: chain[chain.length - 1] ?? null,
            tables: [],
            line: call.line,
            snippet: call.snippet,
          });
        }

        const localFunction = moduleInfo.functions.get(call.name);
        if (localFunction) {
          walk(
            modulePath,
            call.name,
            [...chain, `${graph.toRepoPath(modulePath)}#${call.name}`],
            depth + 1,
          );
          continue;
        }

        const importBinding = moduleInfo.imports.get(call.name);
        if (!importBinding) continue;
        const resolvedModule = graph.resolveModule(importBinding.specifier, modulePath);
        if (!resolvedModule) continue;
        const importedName = importBinding.importedName ?? call.name;
        if (bannedSymbols.has(importedName) && importedName !== call.name) {
          record({
            kind: "banned_symbol",
            chain,
            writeSite: importedName,
            via: chain[chain.length - 1] ?? null,
            tables: [],
            line: call.line,
            snippet: call.snippet,
          });
        }
        if (importBinding.kind === "namespace" || importedName === "default") continue;
        const resolvedTarget = graph.resolveExportedFunction(resolvedModule, importedName);
        if (!resolvedTarget) continue;
        walk(
          resolvedTarget.modulePath,
          resolvedTarget.functionName,
          [
            ...chain,
            `${graph.toRepoPath(resolvedTarget.modulePath)}#${resolvedTarget.functionName}`,
          ],
          depth + 1,
        );
        continue;
      }

      if (call.type === "namespace" && call.namespace && call.propertyName) {
        const importBinding = moduleInfo.imports.get(call.namespace);
        if (!importBinding || importBinding.kind !== "namespace") continue;
        const resolvedModule = graph.resolveModule(importBinding.specifier, modulePath);
        if (!resolvedModule) continue;
        if (bannedSymbols.has(call.propertyName)) {
          record({
            kind: "banned_symbol",
            chain,
            writeSite: call.propertyName,
            via: chain[chain.length - 1] ?? null,
            tables: [],
            line: call.line,
            snippet: call.snippet,
          });
        }
        const resolvedTarget = graph.resolveExportedFunction(resolvedModule, call.propertyName);
        if (!resolvedTarget) continue;
        walk(
          resolvedTarget.modulePath,
          resolvedTarget.functionName,
          [
            ...chain,
            `${graph.toRepoPath(resolvedTarget.modulePath)}#${resolvedTarget.functionName}`,
          ],
          depth + 1,
        );
      }
    }
  };

  const entryLabel = `${graph.toRepoPath(entryModule)}#${entryFunction}`;
  const prefix = options.chainPrefix ?? [];
  walk(
    entryModule,
    entryFunction,
    prefix[prefix.length - 1] === entryLabel ? [...prefix] : [...prefix, entryLabel],
    0,
  );

  return { writes, truncatedAtDepthLimit, visitedCount: visitedAtDepth.size };
}

/**
 * Does the registry sanction this reached write?
 *
 * Both the writer AND its caller must match, and every table the writer touches
 * must be listed. A writer that grows a new table, or gains a second caller,
 * is not covered by the entry that covered it before.
 */
export function findMatchingException(
  write: ReachedWrite,
  entries: ReadonlyArray<RequestPathWriteException> = REQUEST_PATH_WRITE_EXCEPTIONS,
): RequestPathWriteException | null {
  for (const entry of entries) {
    if (entry.writeSite !== write.writeSite) continue;
    if (entry.via !== write.via) continue;
    const allowed = new Set<string>(entry.tables);
    if (!write.tables.every((table) => allowed.has(table))) continue;
    return entry;
  }
  return null;
}
