import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The contract: NO production Search Console selection writer may persist a
 * property without the Google connection generation its authority derives from.
 *
 * Search Console is the one provider whose selection and whose authority live on
 * different connections — the selection lands on `search_console`, the listing
 * that validated it and every later sync run on the GOOGLE credential — so a
 * Google reconnect moves a generation the write's own compare-and-set never
 * looks at.
 *
 * That binding used to be an OPTIONAL argument on `upsertIntegration` which the
 * two writers of the day happened to pass. This test exists because "happened to
 * pass" is not a guarantee, and because a test that asserts it about a
 * hand-written list of writers stops being true the moment someone adds a third.
 *
 * ── Why this enumeration cannot silently miss a new writer ──────────────────
 *
 * Nothing here names a route. The candidate set is computed, at test time, from
 * two facts about the repository:
 *
 *   1. Every HTTP entry point in this app is a `route.ts` under `app/` — that is
 *      the only thing Next.js serves. The set is read off the filesystem, so a
 *      new endpoint is a new candidate the moment the file exists, with no list
 *      to update and nothing to remember.
 *   2. Persisting a provider selection means reaching `lib/integrations.ts`,
 *      the single module that writes `provider_connections`. Reachability is
 *      computed here by walking each route's transitive import graph, so a
 *      writer that hides behind a brand-new helper module is still a candidate:
 *      the helper has to import `lib/integrations` to write, and the route has
 *      to import the helper to call it.
 *
 * Each candidate is then DRIVEN — every exported HTTP method is invoked with a
 * Search-Console-selection-shaped request while `upsertIntegration` is replaced
 * by a recorder — and every recorded `search_console` write that names a
 * property is checked. Nothing is matched against source text, so renaming a
 * variable, aliasing an import, or building the parameters dynamically changes
 * nothing about what this observes.
 *
 * Two honest limits, and what covers them:
 *
 *   - The driver sends ONE request shape. A future writer whose contract this
 *     shape does not satisfy would return early and record nothing, and this
 *     test would pass without having proven anything about it. That is why the
 *     guarantee does not live here: `upsertIntegration` refuses an unbound
 *     Search Console selection at compile time (its parameter type has no shape
 *     that expresses one) and at run time (`DerivedAuthorityRequiredError`).
 *     This test proves the production paths ARE bound and that the guard is not
 *     dead code; the type and the runtime check are what make an unbound writer
 *     impossible.
 *   - A writer that is not an HTTP route — a sync worker, a script — is not
 *     driven here. It is still refused by the same two mechanisms.
 *
 * The floor assertion below is the canary for the first limit: if the driver
 * ever stops reaching ANY Search Console selection writer, the suite fails
 * loudly instead of passing vacuously.
 */

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
/** The provider's own spelling of the one site the fake connection can see. */
const PROVIDER_SITE = "sc-domain:mine.example";
const SEARCH_CONSOLE_GENERATION = "3:connected";
const GOOGLE_GENERATION = "11:connected";

interface RecordedWrite {
  /** The route module being driven when the write was recorded. */
  candidate: string;
  params: Record<string, unknown>;
  stack: string;
}

const recorded: RecordedWrite[] = [];
let currentCandidate = "<none>";

const requireBusinessAccess = vi.fn(async () => ({ session: {}, membership: {} }));
const isDemoBusiness = vi.fn(async () => false);
const resolveSearchConsoleContext = vi.fn(async () => ({
  businessId: BUSINESS_ID,
  accessToken: "token",
  siteUrl: null,
  integration: {
    id: "int-sc",
    provider: "search_console",
    status: "connected",
    connection_generation: 3,
    metadata: {},
    connected_at: "2026-07-01T00:00:00.000Z",
  },
  googleIntegration: {
    id: "int-google",
    provider: "google",
    status: "connected",
    connection_generation: 11,
  },
}));

const upsertIntegration = vi.fn(async (params: Record<string, unknown>) => {
  recorded.push({
    candidate: currentCandidate,
    params,
    stack: new Error("write").stack ?? "",
  });
  return {
    id: "int-sc",
    business_id: BUSINESS_ID,
    provider: params.provider,
    status: params.status,
    provider_account_id: params.providerAccountId ?? null,
    provider_account_name: params.providerAccountName ?? null,
    metadata: params.metadata ?? {},
    connected_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    connection_generation: 3,
  };
});

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/business-mode.server", () => ({ isDemoBusiness }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const unusable = () => {
    throw new Error("No candidate may reach the database in this test.");
  };
  return {
    ...actual,
    getDb: vi.fn(unusable),
    getDbWithTimeout: vi.fn(unusable),
    runDbTransaction: vi.fn(unusable),
  };
});
vi.mock("@/lib/integrations", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, upsertIntegration };
});
vi.mock("@/lib/search-console", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveSearchConsoleContext };
});

// ── Enumeration ────────────────────────────────────────────────────

const REPO_ROOT = process.cwd();
/** The only module in the repo that writes `provider_connections`. */
const WRITE_PRIMITIVE = path.join(REPO_ROOT, "lib/integrations.ts");

function collectRouteModules(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectRouteModules(full, out);
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

/**
 * Import specifiers, taken from the module text rather than from a bundler.
 *
 * This reads WHICH modules a file depends on; it never inspects what the file
 * does with them. Extraction failure is safe in the direction that matters: an
 * unreadable edge only ever removes an edge, and the write primitive is imported
 * by name in every writer that exists, so a writer cannot disconnect itself from
 * the graph without also being unable to write.
 */
const IMPORT_SPECIFIER =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

const dependencyCache = new Map<string, string[]>();

function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(REPO_ROOT, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

function dependenciesOf(file: string): string[] {
  const cached = dependencyCache.get(file);
  if (cached) return cached;
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    dependencyCache.set(file, []);
    return [];
  }
  const resolved: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    const target = resolveSpecifier(specifier, file);
    if (target) resolved.push(target);
  }
  dependencyCache.set(file, resolved);
  return resolved;
}

const reachCache = new Map<string, boolean>();

function reachesWritePrimitive(file: string, visiting = new Set<string>()): boolean {
  if (file === WRITE_PRIMITIVE) return true;
  const cached = reachCache.get(file);
  if (cached !== undefined) return cached;
  if (visiting.has(file)) return false;
  visiting.add(file);
  let reaches = false;
  for (const dependency of dependenciesOf(file)) {
    if (dependency === WRITE_PRIMITIVE || reachesWritePrimitive(dependency, visiting)) {
      reaches = true;
      break;
    }
  }
  visiting.delete(file);
  reachCache.set(file, reaches);
  return reaches;
}

function moduleSpecifier(file: string): string {
  return `@/${path.relative(REPO_ROOT, file).replace(/\.tsx?$/, "")}`;
}

// ── Driving ────────────────────────────────────────────────────────

const DRIVEN_METHODS = ["POST", "PUT", "PATCH", "GET"] as const;

function selectionRequest(method: string): never {
  const url =
    `https://selection.test/drive?businessId=${BUSINESS_ID}` +
    `&siteUrl=${encodeURIComponent(PROVIDER_SITE)}` +
    `&property_url=${encodeURIComponent(PROVIDER_SITE)}`;
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "content-type": "application/json" };
    // Every field name the known selection writers read, so a new writer that
    // reuses any of them is driven all the way to its write.
    init.body = JSON.stringify({
      businessId: BUSINESS_ID,
      siteUrl: PROVIDER_SITE,
      property_url: PROVIDER_SITE,
      propertyId: PROVIDER_SITE,
      propertyName: PROVIDER_SITE,
    });
  }
  return Object.assign(new Request(url, init), {
    nextUrl: new URL(url),
    cookies: {
      get: () => undefined,
      getAll: () => [],
      has: () => false,
      set: () => undefined,
      delete: () => undefined,
    },
  }) as never;
}

function listingResponse(siteUrls: string[]) {
  return new Response(
    JSON.stringify({ siteEntry: siteUrls.map((siteUrl) => ({ siteUrl })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Which candidates could not even be loaded, and therefore were not driven. */
const importFailures: Array<{ candidate: string; message: string }> = [];
let candidates: string[] = [];

// ── The contract ───────────────────────────────────────────────────

function namesSearchConsoleProperty(params: Record<string, unknown>): string | null {
  if (params.provider !== "search_console") return null;
  const metadata = params.metadata as Record<string, unknown> | undefined;
  const metadataSite = metadata?.siteUrl;
  if (typeof metadataSite === "string" && metadataSite.trim()) return metadataSite.trim();
  const account = params.providerAccountId;
  if (typeof account === "string" && account.trim()) return account.trim();
  return null;
}

function derivedGoogleAuthority(params: Record<string, unknown>): string | null {
  const derived = params.expectedDerivedAuthority as
    | { provider?: unknown; connectionGeneration?: unknown }
    | null
    | undefined;
  if (!derived || derived.provider !== "google") return null;
  if (typeof derived.connectionGeneration !== "string") return null;
  return derived.connectionGeneration.trim() || null;
}

/**
 * Where the write came from, read off the call stack rather than assumed.
 *
 * `route` is the endpoint a user reaches; `site` is the module that actually
 * called `upsertIntegration`, which is normally the shared selection writer and
 * is the interesting one when someone bypasses it. Both are recovered from
 * frames, so a writer that moves into a new file is reported at its new file
 * with nothing to update here.
 */
function attribute(write: RecordedWrite): { route: string; site: string; label: string } {
  const frames = write.stack
    .split("\n")
    .map((line) => line.match(/\(?(\/[^\s():]+\.tsx?)[:)]/)?.[1])
    .filter(
      (file): file is string =>
        typeof file === "string" &&
        file.startsWith(REPO_ROOT) &&
        !file.includes("/node_modules/") &&
        !file.endsWith("site-selection-authority.test.ts"),
    )
    .map((file) => path.relative(REPO_ROOT, file));
  const fallback = `${write.candidate.replace(/^@\//, "")}.ts`;
  const route = frames.find((file) => file.endsWith("/route.ts")) ?? fallback;
  const site = frames[0] ?? fallback;
  return {
    route,
    site,
    label: route === site ? route : `${route} (write issued in ${site})`,
  };
}

describe("Search Console selection writers all carry derived Google authority", () => {
  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    Object.assign(process.env, {
      ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
      ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED: "enabled",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => listingResponse([PROVIDER_SITE])),
    );

    candidates = collectRouteModules(path.join(REPO_ROOT, "app"))
      .filter((file) => reachesWritePrimitive(file))
      .map(moduleSpecifier)
      .sort();

    for (const candidate of candidates) {
      currentCandidate = candidate;
      let module: Record<string, unknown>;
      try {
        module = (await import(/* @vite-ignore */ candidate)) as Record<string, unknown>;
      } catch (error) {
        importFailures.push({
          candidate,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const method of DRIVEN_METHODS) {
        const handler = module[method];
        if (typeof handler !== "function") continue;
        try {
          await (handler as (request: never) => Promise<unknown>)(selectionRequest(method));
        } catch {
          // A handler that throws persisted nothing, which is all this cares
          // about. Only what reached `upsertIntegration` is evidence.
        }
      }
    }
    currentCandidate = "<none>";
  }, 120_000);

  it("enumerates the route surface from the filesystem, not from a list", () => {
    // If this ever collapses, the enumeration broke and everything below it is
    // vacuous. The numbers are floors, never exact counts, so adding routes
    // never edits this test.
    expect(candidates.length).toBeGreaterThan(20);
    expect(candidates).toContain("@/app/api/search-console/sites/route");
    expect(candidates).toContain("@/app/api/google-search-console/select-site/route");
  });

  it("loads every candidate, so none is skipped without saying so", () => {
    expect(importFailures).toEqual([]);
  });

  it("reaches at least the Search Console selection writers it knows about", () => {
    // The canary for the driver, not the enumeration: a FLOOR that proves the
    // request shape still gets a selection all the way to a write. Without it a
    // driver that silently stopped reaching every writer would leave the
    // contract below passing on an empty set.
    const writers = new Set(
      recorded
        .filter((write) => namesSearchConsoleProperty(write.params))
        .map((write) => attribute(write).route),
    );
    expect([...writers]).toContain("app/api/search-console/sites/route.ts");
    expect([...writers]).toContain(
      "app/api/google-search-console/select-site/route.ts",
    );
  });

  it("refuses to let any enumerated writer persist a property unbound", () => {
    const unbound = recorded
      .filter((write) => namesSearchConsoleProperty(write.params))
      .filter((write) => derivedGoogleAuthority(write.params) !== GOOGLE_GENERATION)
      .map(
        (write) =>
          `${attribute(write).label} persisted Search Console property ` +
          `"${namesSearchConsoleProperty(write.params)}" with derived authority ` +
          `${JSON.stringify(write.params.expectedDerivedAuthority ?? null)} ` +
          `(expected { provider: "google", connectionGeneration: "${GOOGLE_GENERATION}" })`,
      );

    expect(unbound).toEqual([]);
  });

  it("binds every enumerated writer to the Search Console generation too", () => {
    const unbound = recorded
      .filter((write) => namesSearchConsoleProperty(write.params))
      .filter((write) => write.params.expectedConnectionGeneration !== SEARCH_CONSOLE_GENERATION)
      .map(
        (write) =>
          `${attribute(write).label} persisted a Search Console property with ` +
          `expectedConnectionGeneration ${JSON.stringify(
            write.params.expectedConnectionGeneration ?? null,
          )}`,
      );

    expect(unbound).toEqual([]);
  });

  it("leaves connect-time Search Console writes alone", () => {
    // A write that names no property cannot express a selection, so it needs no
    // derived authority — and must not be forced to invent one. This is the
    // reason the discriminant is "does it name a property", not "is it Search
    // Console": `app/api/oauth/search_console/callback` and
    // `app/api/oauth/google/callback` legitimately create the connection with
    // nothing selected.
    const connectTime = recorded.filter(
      (write) =>
        write.params.provider === "search_console" &&
        namesSearchConsoleProperty(write.params) === null,
    );
    for (const write of connectTime) {
      expect(write.params.expectedDerivedAuthority ?? null).toBeNull();
    }
  });
});
