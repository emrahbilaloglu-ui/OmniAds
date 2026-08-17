import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * proxy.ts is NOT authentication.
 *
 * It admits any request whose `omniads_session` cookie is merely non-empty
 * (`Boolean(request.cookies.get(AUTH_COOKIE)?.value)`), while a genuine session
 * is a random token hashed and looked up in the `sessions` table with an expiry
 * check (lib/auth.ts findSessionByToken). So `Cookie: omniads_session=x` walks
 * straight through the proxy.
 *
 * That is tolerable only because it is a coarse routing gate: the authority
 * decision belongs to each route handler. It stops being tolerable the moment a
 * route has no check of its own, because then the forged cookie IS the whole
 * authorisation. `/api/db-test` was exactly that — it ran CREATE TABLE / INSERT
 * / DROP TABLE against the production database, returned information_schema
 * columns for the core tables, and echoed raw Postgres errors, with no identity
 * check anywhere. It had no callers and has been deleted.
 *
 * This test pins the property structurally, because the defect is the ABSENCE
 * of code and no runtime test can assert an absence it does not know to look
 * for. It is deliberately bidirectional: adding an unauthenticated route fails,
 * and so does leaving a route on the allowlist after it gains a real check.
 */

const API_ROOT = path.join(process.cwd(), "app/api");

/**
 * ENFORCERS refuse by themselves: each returns a 401/403 response (or throws)
 * when the caller lacks authority, so seeing one is proof of a decision.
 */
const ENFORCERS = [
  "requireAuthedRequest",
  "requireBusinessAccess",
  "requireAdmin",
  "requireInternalOrAdminSyncAccess",
  "verifyShopifyWebhook",
];

/**
 * READS merely observe identity. Calling one proves nothing on its own — the
 * route must also refuse. `resolveRequestLanguage` is exactly why this
 * distinction is needed: it calls getSessionFromRequest to pick a language, and
 * counting that as authorisation marked the login and password-reset routes as
 * guarded when they check nothing.
 */
const IDENTITY_READS = [
  "getSessionFromRequest",
  "getSessionFromCookies",
  "isSuperadmin",
  "CRON_SECRET",
  "createHmac",
  "timingSafeEqual",
];

const REFUSAL = /\b(?:401|403)\b/;

/**
 * Routes that are public BY DESIGN. Each entry needs a reason, because this list
 * is the exception to "the proxy is not authentication" — anything on it is
 * reachable by a total stranger with no cookie at all.
 */
const INTENTIONALLY_PUBLIC: Record<string, string> = {
  "auth/login": "the credential check IS the endpoint",
  "auth/signup": "account creation is open by product design",
  "auth/logout": "clearing your own cookie needs no proof of identity",
  "auth/demo-login": "linked from the landing page; mints the shared demo session",
  "auth/password-reset/request": "pre-authentication, responds generically to avoid enumeration",
  "auth/password-reset/confirm": "the emailed token IS the credential",
  "healthz": "liveness probe, returns no tenant data",
  "build-info": "release provenance, returns no tenant data",
  "release-authority": "release provenance, returns no tenant data",
  "migrate": "retired: returns 410 unconditionally and touches nothing",
  "oauth/sign-with-google/start": "pre-authentication leg of the sign-in flow",
  "oauth/sign-with-google/callback": "pre-authentication leg; validates OAuth state",
  "oauth/sign-with-facebook/start": "pre-authentication leg of the sign-in flow",
  "oauth/sign-with-facebook/callback": "pre-authentication leg; validates OAuth state",
  "media/meta-preview": "image proxy restricted to an allow-list of Meta CDN hosts",
  "media/cache/[...key]": "opaque storage-key capability URL, existence-checked, traversal-guarded",
  "oauth/shopify/start": "pre-authentication leg of the Shopify install flow",
};

/**
 * Routes that make no decision themselves but forward the caller's own
 * credentials to a route that does. Legitimate, and distinct from public — a
 * stranger with no cookie gets nothing back.
 */
const DELEGATES_AUTHORITY: Record<string, string> = {
  "creatives/inbox":
    "fans out to /api/creatives/briefing with the caller's cookie; that route enforces requireBusinessAccess, and the per-process cache is keyed on a hash of the caller's credentials",
};

function listRouteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listRouteFiles(full));
    else if (entry.name === "route.ts" || entry.name === "route.tsx") found.push(full);
  }
  return found;
}

/** Strip comments so a marker named only in prose never counts as a real check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * A guard-shaped local helper, e.g. requireLaunchpadAccess / assertBusinessScope.
 * Routes often wrap the markers above in their own named guard, and naming it
 * this way is the established idiom in this codebase.
 */
const GUARD_SHAPED =
  /\b(?:require|assert|verify|reject)[A-Za-z]*(?:Access|Auth|Admin|Session|Internal|Scope|Guard|ReadOnly)[A-Za-z]*\b/;

function resolveFirstParty(fromFile: string, specifier: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith("@/")) base = path.join(process.cwd(), specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function enforcesDirectly(source: string): boolean {
  if (ENFORCERS.some((name) => source.includes(name))) return true;
  if (GUARD_SHAPED.test(source)) return true;
  // A hand-rolled check: read identity, then refuse on it.
  return IDENTITY_READS.some((name) => source.includes(name)) && REFUSAL.test(source);
}

const HTTP_METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

/**
 * Modules this route hands its whole HTTP handler to. Only these are followed.
 *
 * Ordinary utility imports are deliberately NOT followed: `auth/login` imports
 * `createSession` from lib/auth.ts, which also contains `getSessionFromRequest`,
 * and following it marked a route that checks nothing as authorised. Handler
 * delegation is a different thing — `export async function POST(...) { return
 * handleMetaAdStatusAction(...) }` really does move the decision elsewhere, and
 * the enforcement may sit several helpers deep in that module
 * (handleMetaAdStatusAction -> prepareAction -> requireBusinessAccess).
 */
function delegatedHandlerModules(routeFile: string, source: string): string[] {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    const module = resolveFirstParty(routeFile, match[2]);
    if (!module) continue;
    for (const part of match[1].split(",")) {
      const [imported, alias] = part.split(/\s+as\s+/).map((piece) => piece.trim());
      const local = (alias || imported).replace(/\btype\b\s*/, "").trim();
      if (local) imports.set(local, module);
    }
  }

  const modules = new Set<string>();

  // `export { handler as GET } from "…"` — the whole method is that module's.
  for (const match of source.matchAll(
    new RegExp(`export\\s*\\{[^}]*\\b(?:${HTTP_METHODS})\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`, "g"),
  )) {
    const module = resolveFirstParty(routeFile, match[1]);
    if (module) modules.add(module);
  }

  // `export async function POST(…) { return someImportedHandler(…) }`
  for (const match of source.matchAll(
    new RegExp(`export\\s+(?:async\\s+)?function\\s+(?:${HTTP_METHODS})\\b([\\s\\S]*?)\\n\\}`, "g"),
  )) {
    for (const call of match[1].matchAll(/return\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
      const module = imports.get(call[1]);
      if (module) modules.add(module);
    }
  }

  // `export const GET = someImportedFactory(…)`
  for (const match of source.matchAll(
    new RegExp(`export\\s+const\\s+(?:${HTTP_METHODS})\\s*=\\s*([A-Za-z_$][\\w$]*)`, "g"),
  )) {
    const module = imports.get(match[1]);
    if (module) modules.add(module);
  }

  return [...modules];
}

function hasAuthority(routeFile: string): boolean {
  const source = stripComments(fs.readFileSync(routeFile, "utf8"));
  if (enforcesDirectly(source)) return true;
  return delegatedHandlerModules(routeFile, source).some((module) =>
    enforcesDirectly(stripComments(fs.readFileSync(module, "utf8"))),
  );
}

function routeId(routeFile: string): string {
  return path.relative(API_ROOT, path.dirname(routeFile)).split(path.sep).join("/");
}

describe("every API route decides its own authority", () => {
  const routeFiles = listRouteFiles(API_ROOT);

  it("finds the API routes at all, so a broken walk cannot pass vacuously", () => {
    expect(routeFiles.length).toBeGreaterThan(50);
  });

  it("has no route relying on proxy.ts as its only gate", () => {
    const unguarded = routeFiles.filter((file) => !hasAuthority(file)).map(routeId).sort();
    const undeclared = unguarded.filter(
      (id) => !(id in INTENTIONALLY_PUBLIC) && !(id in DELEGATES_AUTHORITY),
    );

    expect(
      undeclared,
      "These routes perform no identity check, so a forged `omniads_session` cookie " +
        "is their only gate. Add a real check, or declare them in INTENTIONALLY_PUBLIC " +
        "/ DELEGATES_AUTHORITY with the reason.",
    ).toEqual([]);
  });

  it("keeps both allow-lists honest: no stale entries", () => {
    const unguarded = new Set(routeFiles.filter((file) => !hasAuthority(file)).map(routeId));
    const stale = [
      ...Object.keys(INTENTIONALLY_PUBLIC),
      ...Object.keys(DELEGATES_AUTHORITY),
    ]
      .filter((id) => !unguarded.has(id))
      .sort();

    expect(
      stale,
      "These are declared as needing no local check but now perform one (or no " +
        "longer exist). Remove them, so the lists keep meaning what they say.",
    ).toEqual([]);
  });

  it("never re-admits an unauthenticated database-DDL endpoint", () => {
    expect(
      fs.existsSync(path.join(API_ROOT, "db-test")),
      "/api/db-test ran CREATE TABLE and DROP TABLE on the production database " +
        "with no identity check. It must not come back.",
    ).toBe(false);
  });

  it("does not count a marker that appears only in a comment", () => {
    expect(stripComments("// requireAdmin protects this\nexport function GET() {}")).not.toContain(
      "requireAdmin",
    );
    expect(stripComments("/* requireAdmin */ export function GET() {}")).not.toContain(
      "requireAdmin",
    );
  });
});
