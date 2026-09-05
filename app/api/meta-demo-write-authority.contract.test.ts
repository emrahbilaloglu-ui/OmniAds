import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every Meta-surface mutation must refuse a demo workspace on the SERVER,
 * fail-closed, and this pins it structurally.
 *
 * The canonical invariant is unconditional: "Demo businesses have zero Meta
 * write authority even if a presentation defect supplies an action." The master
 * plan states the same as a build instruction — §18, "Reviewer/demo mutation
 * guard — Tüm Meta server write route'larına ekle" — and §19 requires the
 * refusal to be proven on the server.
 *
 * It kept not being. Routes gained `requireBusinessAccess` and
 * `rejectIfReviewerReadOnly` and stopped there, because those two are what a
 * reviewer sees fail and a demo admin does not: `/api/auth/demo-login` opens a
 * session as an ADMIN of the demo business under a non-reviewer email, so it
 * clears the role floor and the reviewer floor and writes. Eleven boundaries
 * were found that way, one at a time, by reading routes. This test is what
 * stops the twelfth.
 *
 * ## Why structural, and what that costs
 *
 * The defect is the ABSENCE of code, and no runtime test asserts an absence it
 * does not know to look for. So this walks the filesystem: a NEW route file
 * needs no edit here to be covered, and a route that loses its authority fails
 * even if every behavioural test still passes.
 *
 * What it cannot see is ORDER. That a demo refusal sits before the first
 * durable write is a behavioural claim, and it is asserted per route in the
 * colocated `route.test.ts` files — each proving zero store calls, zero
 * telemetry, zero cooldown stamps and zero token mints for both a confirmed
 * demo workspace and an unreadable demo flag. This test proves the authority is
 * REACHABLE; those prove it is EARLY. Neither is sufficient alone, and the
 * comment is here so a future reader does not delete one believing the other
 * covers it.
 *
 * ## Fail-closed, specifically
 *
 * Two instruments answer "is this a demo workspace" and only one is admissible:
 *
 *   - `readLaunchpadWriteAuthority` (and the three wrappers over it) reads
 *     `businesses.is_demo_business` and answers `unverified` for a missing row,
 *     an unreadable table or any thrown error. Every non-`live` answer refuses.
 *   - `lib/business-mode.server.isDemoBusiness` swallows its own errors and
 *     degrades to a comparison against one hard-coded id, and
 *     `lib/demo-business.isDemoBusinessId` is only that comparison. Both answer
 *     "not a demo workspace" for a database outage, which is the wrong
 *     direction for a write.
 *
 * So the second pair is not merely absent from the enforcer list — using either
 * one as a route's demo gate is a FAILURE below, with the reason named.
 */

const API_ROOT = path.join(process.cwd(), "app/api");

/**
 * The Meta surfaces, by the plan's own decomposition: Decisions, Intelligence,
 * Automation, Launchpad, History, Creative Studio / Public Share, and the
 * commercial truth the engine reads its anchors from.
 */
const META_SURFACE_PREFIXES = [
  "meta/",
  "launchpad/meta/",
  "creatives/share/",
  "business-commercial-settings/",
];

/** A fail-closed demo authority, or a wrapper over one. */
const FAIL_CLOSED_AUTHORITY = [
  "readLaunchpadWriteAuthority",
  "rejectIfLaunchpadDemoWrite",
  "rejectIfAutomationDemoWrite",
  "rejectIfMetaOperatorDemoWrite",
  // The shared provider-write choke point. `getMetaWriteBlockState` refuses a
  // confirmed demo business AND returns `control_state_unavailable` when the
  // control state cannot be read, so it satisfies both halves.
  "rejectIfMetaWritesBlocked",
  "getMetaWriteBlockState",
  /*
    The same choke point, read for its whole answer.

    `readMetaWritePosture` calls `getMetaWriteBlockState` and returns both the
    block verdict AND whether the business is rehearsing. Routes moved to it so
    the server, not the request body, decides whether a write reaches Meta —
    the demo refusal is unchanged and still the first thing it reports.
  */
  "readMetaWritePosture",
];

/**
 * Instruments that answer "not a demo workspace" when they cannot tell.
 * Naming one of these in a route is a defect, not a pass.
 */
const FAIL_OPEN_INSTRUMENTS = [
  { name: "isDemoBusiness", why: "swallows an unreadable flag into false (lib/business-mode.server.ts)" },
  { name: "isDemoBusinessId", why: "compares one hard-coded id and never reads businesses.is_demo_business" },
];

/**
 * Routes on a Meta surface that mutate nothing and authorize nothing.
 *
 * Each entry is a claim that has to stay true, and the test checks it: a file
 * listed here that starts writing fails, so the exemption cannot rot into a
 * hole. A read-only route may still need role and reviewer floors — that is a
 * different contract, in `route-authority.test.ts`.
 */
const NO_SIDE_EFFECT: Record<string, string> = {
  "meta/history/export":
    "renders the journal the caller can already read; no table is written and no artifact is issued",
  "meta/reports/preview":
    "renders a report body from data the caller can already read; nothing is persisted",
  "meta/campaign-labels":
    "D074 tombstone: both GET and PUT return a static 410 (campaign_labels_retired) with no DB import, no session read, and no store call; the manual-label write surface no longer exists",
};

/**
 * Routes that DO write, and enforce the authority somewhere other than a guard
 * call in the route file. Each names where, and the test checks that the named
 * place still says so.
 *
 * This exists for exactly one shape: a deliberately unauthenticated endpoint
 * with no session and no `businessId` to gate on, where a 403 would be a token
 * oracle in a surface whose every response is deliberately identical.
 */
const ENFORCED_IN_STORE: Record<string, { module: string; why: string }> = {
  "creatives/share/[token]/messages": {
    module: "lib/creative-share-store.ts",
    why:
      "public share thread: no session, no businessId, and every response is the same neutral shape by design. " +
      "The demo refusal is a predicate on the UPDATE in appendCreativeShareMessage, so a demo workspace's row is never appended.",
  },
};

/** Writes that reach no store, mint no artifact and touch no provider. */
const WRITE_MARKERS =
  /\b(?:INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|upsert[A-Z]\w*|write[A-Z]\w*|create[A-Z]\w*|persist[A-Z]\w*|record[A-Z]\w*|mint[A-Z]\w*|rotate[A-Z]\w*|revoke[A-Z]\w*|delete[A-Z]\w*|requestMetaSnapshotRefresh)\b/;

const HTTP_MUTATORS = "POST|PUT|PATCH|DELETE";

function listRouteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listRouteFiles(full));
    else if (entry.name === "route.ts" || entry.name === "route.tsx") found.push(full);
  }
  return found;
}

/** Strip comments so a name mentioned only in prose never counts as a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

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

/**
 * Modules a route hands its whole handler to.
 *
 * Only handler delegation is followed, never ordinary utility imports — the
 * same rule `route-authority.test.ts` arrived at, and for the same reason:
 * following every import marks a route as guarded because some unrelated module
 * it borrowed a formatter from happens to contain the word.
 *
 * This matters here because the ad/campaign/ad-set action routes really are
 * three-line wrappers: `export async function POST(...) { return
 * handleMetaAdStatusAction(...) }`, and the demo refusal lives inside
 * `lib/meta/ads-action-routes.ts` several helpers deep. Requiring those
 * wrappers to add their own gate would be a redundant second authority over the
 * same fact.
 */
function delegatedHandlerModules(routeFile: string, source: string): string[] {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const module = resolveFirstParty(routeFile, match[2]!);
    if (!module) continue;
    for (const part of match[1]!.split(",")) {
      const [imported, alias] = part.split(/\s+as\s+/).map((piece) => piece.trim());
      const local = (alias || imported || "").replace(/\btype\b\s*/, "").trim();
      if (local) imports.set(local, module);
    }
  }

  const modules = new Set<string>();
  for (const match of source.matchAll(
    new RegExp(`export\\s*\\{[^}]*\\b(?:${HTTP_MUTATORS})\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`, "g"),
  )) {
    const module = resolveFirstParty(routeFile, match[1]!);
    if (module) modules.add(module);
  }
  for (const match of source.matchAll(
    new RegExp(`export\\s+(?:async\\s+)?function\\s+(?:${HTTP_MUTATORS})\\b([\\s\\S]*?)\\n\\}`, "g"),
  )) {
    for (const call of match[1]!.matchAll(/return\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
      const module = imports.get(call[1]!);
      if (module) modules.add(module);
    }
  }
  for (const match of source.matchAll(
    new RegExp(`export\\s+const\\s+(?:${HTTP_MUTATORS})\\s*=\\s*([A-Za-z_$][\\w$]*)`, "g"),
  )) {
    const module = imports.get(match[1]!);
    if (module) modules.add(module);
  }
  return [...modules];
}

function reachesAuthority(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const source = stripComments(fs.readFileSync(file, "utf8"));
  if (FAIL_CLOSED_AUTHORITY.some((name) => source.includes(name))) return true;
  // Bounded: a handler delegates at most a few levels before it writes.
  if (seen.size > 12) return false;
  return delegatedHandlerModules(file, source).some((module) =>
    reachesAuthority(module, seen),
  );
}

function surfaceKey(file: string): string {
  return path.relative(API_ROOT, path.dirname(file)).split(path.sep).join("/") + "/";
}

function isMetaSurface(file: string): boolean {
  const key = surfaceKey(file);
  return META_SURFACE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function mutatingMethods(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(
    new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+(${HTTP_MUTATORS})\\b`, "g"),
  )) {
    found.add(match[1]!);
  }
  for (const match of source.matchAll(
    new RegExp(`export\\s*\\{[^}]*\\b(?:as\\s+)?(${HTTP_MUTATORS})\\b`, "g"),
  )) {
    found.add(match[1]!);
  }
  return [...found];
}

const META_MUTATORS = listRouteFiles(API_ROOT)
  .filter(isMetaSurface)
  .map((file) => ({
    file,
    key: surfaceKey(file).replace(/\/$/, ""),
    source: stripComments(fs.readFileSync(file, "utf8")),
  }))
  .filter((entry) => mutatingMethods(entry.source).length > 0);

describe("every Meta-surface mutation reaches a fail-closed demo authority", () => {
  it("finds the Meta mutation surface at all", () => {
    // A walker that silently matches nothing would make every case below pass.
    expect(META_MUTATORS.length).toBeGreaterThan(15);
  });

  for (const entry of META_MUTATORS) {
    const enforcedInStore = ENFORCED_IN_STORE[entry.key];
    if (enforcedInStore) {
      it(`${entry.key} enforces the authority in ${enforcedInStore.module}`, () => {
        expect(enforcedInStore.why.length).toBeGreaterThan(60);
        const store = stripComments(
          fs.readFileSync(path.join(process.cwd(), enforcedInStore.module), "utf8"),
        );
        // The claim is checked, not trusted: the named module must still carry
        // a demo predicate, or this entry is a hole with a paragraph attached.
        expect(
          /is_demo_business/.test(store),
          `${entry.key} delegates its demo refusal to ${enforcedInStore.module}, which no longer mentions is_demo_business.`,
        ).toBe(true);
      });
      continue;
    }

    const exempt = NO_SIDE_EFFECT[entry.key];
    if (exempt) {
      it(`${entry.key} is exempt, and still writes nothing`, () => {
        expect(exempt.length, `${entry.key}: exemption with no reason`).toBeGreaterThan(40);
        // The exemption is a claim, and it is checked. A file listed here that
        // starts writing fails, so the list cannot rot into a hole.
        expect(
          WRITE_MARKERS.test(entry.source),
          `${entry.key} is on the no-side-effect list but now looks like it writes. Remove the exemption and gate it.`,
        ).toBe(false);
      });
      continue;
    }

    it(`${entry.key} (${mutatingMethods(entry.source).join(", ")}) refuses a demo workspace`, () => {
      expect(
        reachesAuthority(entry.file),
        `${entry.key} exports a mutating method and reaches no fail-closed demo authority. ` +
          `Call rejectIfMetaOperatorDemoWrite (or the Launchpad/Automation wrapper) after the reviewer guard ` +
          `and before the first durable write. If it genuinely writes nothing, add it to NO_SIDE_EFFECT with a reason.`,
      ).toBe(true);
    });
  }

  for (const entry of META_MUTATORS) {
    for (const instrument of FAIL_OPEN_INSTRUMENTS) {
      it(`${entry.key} does not gate on ${instrument.name}`, () => {
        // Not merely "not an enforcer": naming one of these as the demo gate is
        // a defect, because it answers "live" when it cannot tell.
        expect(
          entry.source.includes(instrument.name),
          `${entry.key} references ${instrument.name}, which ${instrument.why}. ` +
            `Use readLaunchpadWriteAuthority, which refuses on an unreadable flag.`,
        ).toBe(false);
      });
    }
  }
});
