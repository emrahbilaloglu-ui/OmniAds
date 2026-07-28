import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GUARDED_WRITE_TABLES,
  MAX_CALL_DEPTH,
  REQUEST_PATH_WRITE_EXCEPTIONS,
  createModuleGraph,
  detectGuardedTableWrites,
  exceptionKey,
  findMatchingException,
  traceReachableWrites,
  validateExceptionRegistry,
  type ReachedWrite,
  type RequestPathWriteException,
} from "@/scripts/read-path-write-reachability";

/**
 * The anti-vacuity contract for the read-path write guards.
 *
 * A guard that cannot demonstrate it still catches the defect it was written
 * for is a guard nobody can trust, and the two guards this replaces had exactly
 * that problem: both were green throughout the period in which an authenticated
 * GET was rewriting `provider_connections`.
 *
 * So the decisive case here is not a unit test of a helper. It is the ORIGINAL
 * DEFECT SHAPE, reconstructed in a synthetic module tree: a read-path module
 * that reaches a connection writer through ONE level of indirection. The suite
 * asserts, on that tree, both halves of what went wrong —
 *
 *   - the old guard's technique (grep the read-path module for the writer's
 *     name) finds NOTHING, and
 *   - the new walk finds it, and names the chain.
 *
 * Everything runs on a temp directory, so it neither depends on nor perturbs
 * the real repository.
 */

let root: string;

function write(relativePath: string, source: string) {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source, "utf8");
  return absolute;
}

function trace(entryRelative: string, entryFunction: string, bannedSymbols: string[] = []) {
  const graph = createModuleGraph(root);
  return traceReachableWrites({
    graph,
    entryModule: path.join(root, entryRelative),
    entryFunction,
    bannedSymbols: new Set(bannedSymbols),
  });
}

function tableWrites(result: { writes: ReachedWrite[] }) {
  return result.writes.filter((entry) => entry.kind === "table_write");
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "read-path-guard-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the reintroduced defect shape", () => {
  /**
   * `lib/read-path.ts` → `lib/token-refresh.ts` → `lib/connections.ts`.
   *
   * This is the production shape, minimised: the read path never names the
   * writer, and the writer is two modules away.
   */
  beforeAll(() => {
    write(
      "lib/connections.ts",
      `import { getDb } from "./db";
       export async function upsertConnection(input: { businessId: string }) {
         const sql = getDb();
         await sql\`
           INSERT INTO provider_connections (business_id, status)
           VALUES (\${input.businessId}, 'connected')
           ON CONFLICT (business_id) DO UPDATE SET status = 'connected'
         \`;
       }`,
    );
    write(
      "lib/token-refresh.ts",
      `import { upsertConnection } from "./connections";
       export async function resolveAccessToken(businessId: string) {
         await upsertConnection({ businessId });
         return "token";
       }`,
    );
    write(
      "lib/read-path.ts",
      `import { resolveAccessToken } from "./token-refresh";
       export async function executeQuery(businessId: string) {
         const token = await resolveAccessToken(businessId);
         return { token, rows: [] };
       }`,
    );
    write("lib/db.ts", `export function getDb() { return (() => {}) as never; }`);
  });

  it("the OLD technique — grepping the read-path module — finds nothing", () => {
    const source = fs.readFileSync(path.join(root, "lib/read-path.ts"), "utf8");
    // This is precisely why lib/get-read-path-module-guard.test.ts stayed green
    // while the defect was live in production.
    expect(source).not.toMatch(/\bupsertConnection\s*\(/);
    expect(source).not.toMatch(/provider_connections/);
  });

  it("the transitive walk finds it, through one level of indirection", () => {
    const writes = tableWrites(trace("lib/read-path.ts", "executeQuery"));
    expect(writes).toHaveLength(1);
    expect(writes[0].tables).toEqual(["provider_connections"]);
    expect(writes[0].writeSite).toBe("lib/connections.ts#upsertConnection");
    expect(writes[0].via).toBe("lib/token-refresh.ts#resolveAccessToken");
  });

  it("the failure names the whole chain, not just the endpoint", () => {
    const [write_] = tableWrites(trace("lib/read-path.ts", "executeQuery"));
    expect(write_.chain).toEqual([
      "lib/read-path.ts#executeQuery",
      "lib/token-refresh.ts#resolveAccessToken",
      "lib/connections.ts#upsertConnection",
    ]);
  });

  it("removing the indirection's write makes it clean again", () => {
    write(
      "lib/connections.ts",
      `import { getDb } from "./db";
       export async function upsertConnection(input: { businessId: string }) {
         const sql = getDb();
         await sql\`SELECT status FROM provider_connections WHERE business_id = \${input.businessId}\`;
       }`,
    );
    // A fresh graph: the module cache is per-graph, so this reads the new file.
    expect(tableWrites(trace("lib/read-path.ts", "executeQuery"))).toEqual([]);

    // …and putting it back re-fails, so the pass above is a fact about the
    // code and not about a stale cache.
    write(
      "lib/connections.ts",
      `import { getDb } from "./db";
       export async function upsertConnection(input: { businessId: string }) {
         const sql = getDb();
         await sql\`UPDATE provider_connections SET status = 'connected' WHERE business_id = \${input.businessId}\`;
       }`,
    );
    expect(tableWrites(trace("lib/read-path.ts", "executeQuery"))).toHaveLength(1);
  });

  it("survives a rename of the writer, because it is anchored on the table", () => {
    // The exact event this guard was written through: the production writer was
    // renamed from `upsertIntegration` to `refreshIntegrationCredentialTokens`
    // mid-flight. A name list would have gone quiet.
    write(
      "lib/connections.ts",
      `import { getDb } from "./db";
       export async function persistCredentialUnderANewName(input: { businessId: string }) {
         const sql = getDb();
         await sql\`UPDATE provider_connections SET status = 'connected' WHERE business_id = \${input.businessId}\`;
       }`,
    );
    write(
      "lib/token-refresh.ts",
      `import { persistCredentialUnderANewName } from "./connections";
       export async function resolveAccessToken(businessId: string) {
         await persistCredentialUnderANewName({ businessId });
         return "token";
       }`,
    );
    const writes = tableWrites(trace("lib/read-path.ts", "executeQuery"));
    expect(writes).toHaveLength(1);
    expect(writes[0].writeSite).toBe("lib/connections.ts#persistCredentialUnderANewName");
  });
});

describe("the exception registry is narrow", () => {
  const sanctioned: RequestPathWriteException = {
    writeSite: "lib/connections.ts#persistCredentialUnderANewName",
    via: "lib/token-refresh.ts#resolveAccessToken",
    tables: ["provider_connections"],
    reason:
      "synthetic fixture reason, long enough to satisfy the registry's minimum-length rule for a written justification",
  };

  function only(result: { writes: ReachedWrite[] }) {
    const writes = tableWrites(result);
    expect(writes).toHaveLength(1);
    return writes[0];
  }

  it("a matching entry suppresses the finding", () => {
    const found = only(trace("lib/read-path.ts", "executeQuery"));
    expect(findMatchingException(found, [sanctioned])).toBe(sanctioned);
  });

  it("a DIFFERENT caller of the same writer is not covered", () => {
    write(
      "lib/other-read-path.ts",
      `import { persistCredentialUnderANewName } from "./connections";
       export async function somethingElse(businessId: string) {
         await persistCredentialUnderANewName({ businessId });
       }`,
    );
    const found = only(trace("lib/other-read-path.ts", "somethingElse"));
    expect(found.via).toBe("lib/other-read-path.ts#somethingElse");
    // The whole point: registering one sanctioned caller must not open the
    // writer to every caller. That is the mistake that would re-create the
    // original defect.
    expect(findMatchingException(found, [sanctioned])).toBeNull();
  });

  it("a second caller does not hide behind a registered first caller in the SAME walk", () => {
    // This was a live hole in the first version of the walk. Memoising the whole
    // visit meant only the first path to a writer was recorded — so within one
    // route's walk, an unregistered second caller of an already-visited writer
    // produced no finding at all. It hid a real edge in this repository
    // (lib/sync/shopify-sync.ts#ensureShopifyProviderReady ->
    // lib/integrations.ts#mergeIntegrationMetadata) behind a registered one.
    write(
      "lib/shared-writer.ts",
      `import { getDb } from "./db";
       export async function sharedWrite() {
         const sql = getDb();
         await sql\`UPDATE integration_credentials SET access_token = 'x' WHERE business_id = 'b'\`;
       }`,
    );
    write(
      "lib/registered-caller.ts",
      `import { sharedWrite } from "./shared-writer";
       export async function registeredCaller() { await sharedWrite(); }`,
    );
    write(
      "lib/unregistered-caller.ts",
      `import { sharedWrite } from "./shared-writer";
       export async function unregisteredCaller() { await sharedWrite(); }`,
    );
    write(
      "lib/two-callers-entry.ts",
      `import { registeredCaller } from "./registered-caller";
       import { unregisteredCaller } from "./unregistered-caller";
       export async function entry() {
         await registeredCaller();
         await unregisteredCaller();
       }`,
    );

    const registry: RequestPathWriteException[] = [
      {
        writeSite: "lib/shared-writer.ts#sharedWrite",
        via: "lib/registered-caller.ts#registeredCaller",
        tables: ["integration_credentials"],
        reason:
          "synthetic fixture reason, long enough to satisfy the registry's minimum-length rule for a written justification",
      },
    ];

    const writes = tableWrites(trace("lib/two-callers-entry.ts", "entry"));
    const unmatched = writes.filter((entry) => findMatchingException(entry, registry) === null);
    expect(unmatched.map((entry) => entry.via)).toEqual([
      "lib/unregistered-caller.ts#unregisteredCaller",
    ]);
  });

  it("a table the entry does not list is not covered", () => {
    write(
      "lib/connections.ts",
      `import { getDb } from "./db";
       export async function persistCredentialUnderANewName(input: { businessId: string }) {
         const sql = getDb();
         await sql\`UPDATE provider_connections SET status = 'connected' WHERE business_id = \${input.businessId}\`;
         await sql\`UPDATE integration_credentials SET access_token = 'x' WHERE business_id = \${input.businessId}\`;
       }`,
    );
    const found = only(trace("lib/read-path.ts", "executeQuery"));
    expect(found.tables).toEqual(["provider_connections", "integration_credentials"]);
    expect(findMatchingException(found, [sanctioned])).toBeNull();
  });

  it("rejects entries whose justification is not written down", () => {
    const problems = validateExceptionRegistry([
      { ...sanctioned, reason: "ok" },
      { ...sanctioned, tables: [] },
    ]);
    expect(problems.some((problem) => problem.includes("reason shorter than"))).toBe(true);
    expect(problems.some((problem) => problem.includes("allows no tables"))).toBe(true);
  });
});

describe("walk mechanics", () => {
  it("indexes object-literal members so adapter modules are not vacuous", () => {
    write(
      "lib/adapters.ts",
      `import { getDb } from "./db";
       export const workerAdapter = {
         loadAccounts: async (businessId: string) => {
           const sql = getDb();
           await sql\`UPDATE integration_credentials SET access_token = 'x' WHERE business_id = \${businessId}\`;
         },
         async run(businessId: string) {
           await workerAdapter.loadAccounts(businessId);
         },
       };`,
    );
    const graph = createModuleGraph(root);
    const info = graph.getModuleInfo(path.join(root, "lib/adapters.ts"));
    expect([...info.functions.keys()]).toContain("workerAdapter.loadAccounts");
    expect([...info.functions.keys()]).toContain("workerAdapter.run");

    const writes = tableWrites(trace("lib/adapters.ts", "workerAdapter.loadAccounts"));
    expect(writes.map((entry) => entry.tables)).toEqual([["integration_credentials"]]);
  });

  it("follows named re-exports, so `export { handler as GET } from …` is analysable", () => {
    write(
      "lib/handler-impl.ts",
      `import { getDb } from "./db";
       export async function handlerImpl() {
         const sql = getDb();
         await sql\`DELETE FROM business_provider_accounts WHERE business_id = 'x'\`;
       }`,
    );
    write("app/api/thing/route.ts", `export { handlerImpl as GET } from "@/lib/handler-impl";`);

    const graph = createModuleGraph(root);
    const resolved = graph.resolveExportedFunction(path.join(root, "app/api/thing/route.ts"), "GET");
    expect(resolved).not.toBeNull();
    expect(graph.toRepoPath(resolved!.modulePath)).toBe("lib/handler-impl.ts");

    const result = traceReachableWrites({
      graph,
      entryModule: resolved!.modulePath,
      entryFunction: resolved!.functionName,
      chainPrefix: ["app/api/thing/route.ts#GET"],
    });
    const writes = tableWrites(result);
    expect(writes).toHaveLength(1);
    expect(writes[0].chain[0]).toBe("app/api/thing/route.ts#GET");
    expect(writes[0].via).toBe("app/api/thing/route.ts#GET");
  });

  it("reports truncation instead of passing quietly at the depth bound", () => {
    const depth = 6;
    write(
      "lib/deep-writer.ts",
      `import { getDb } from "./db";
       export async function deepWrite() {
         const sql = getDb();
         await sql\`UPDATE provider_account_assignments SET account_ids = '{}' WHERE business_id = 'x'\`;
       }`,
    );
    for (let index = 0; index < depth; index += 1) {
      const next = index === depth - 1 ? "./deep-writer" : `./hop-${index + 1}`;
      const nextFn = index === depth - 1 ? "deepWrite" : `hop${index + 1}`;
      write(
        `lib/hop-${index}.ts`,
        `import { ${nextFn} } from "${next}";
         export async function hop${index}() { await ${nextFn}(); }`,
      );
    }

    const graph = createModuleGraph(root);
    const deep = traceReachableWrites({
      graph,
      entryModule: path.join(root, "lib/hop-0.ts"),
      entryFunction: "hop0",
      maxDepth: 2,
    });
    expect(deep.truncatedAtDepthLimit).toBe(true);
    expect(tableWrites(deep)).toEqual([]);

    const full = traceReachableWrites({
      graph,
      entryModule: path.join(root, "lib/hop-0.ts"),
      entryFunction: "hop0",
    });
    expect(full.truncatedAtDepthLimit).toBe(false);
    expect(tableWrites(full)).toHaveLength(1);
  });

  it("terminates on a cycle", () => {
    write("lib/cycle-a.ts", `import { b } from "./cycle-b"; export async function a() { await b(); }`);
    write("lib/cycle-b.ts", `import { a } from "./cycle-a"; export async function b() { await a(); }`);
    const result = trace("lib/cycle-a.ts", "a");
    expect(result.writes).toEqual([]);
    expect(result.truncatedAtDepthLimit).toBe(false);
  });

  it("flags banned symbols by name as well as by table", () => {
    write(
      "lib/banned.ts",
      `import { persistCredentialUnderANewName } from "./connections";
       export async function reader() { await persistCredentialUnderANewName({ businessId: "x" }); }`,
    );
    const result = trace("lib/banned.ts", "reader", ["persistCredentialUnderANewName"]);
    const banned = result.writes.filter((entry) => entry.kind === "banned_symbol");
    expect(banned.map((entry) => entry.writeSite)).toEqual(["persistCredentialUnderANewName"]);
  });
});

describe("SQL write detection", () => {
  it.each(GUARDED_WRITE_TABLES)("detects INSERT/UPDATE/DELETE on %s", (table) => {
    expect(detectGuardedTableWrites(`INSERT INTO ${table} (a) VALUES (1)`)).toContain(table);
    expect(detectGuardedTableWrites(`UPDATE ${table} SET a = 1`)).toContain(table);
    expect(detectGuardedTableWrites(`DELETE FROM ${table} WHERE a = 1`)).toContain(table);
  });

  it("does not fire on reads or on ON CONFLICT DO UPDATE clauses alone", () => {
    expect(detectGuardedTableWrites("SELECT * FROM provider_connections")).toEqual([]);
    expect(detectGuardedTableWrites("... ON CONFLICT (id) DO UPDATE SET status = 'x'")).toEqual([]);
  });
});

describe("the live registry", () => {
  it("is well formed", () => {
    expect(validateExceptionRegistry()).toEqual([]);
  });

  it("has no duplicate keys", () => {
    const keys = REQUEST_PATH_WRITE_EXCEPTIONS.map(exceptionKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the depth bound above the deepest chain the repo actually has", () => {
    // 14 hops today (/api/sync/cron POST through the repair executor to the
    // credential write). If this ever needs raising, raise it — do not let the
    // walk truncate.
    expect(MAX_CALL_DEPTH).toBeGreaterThanOrEqual(20);
  });
});
