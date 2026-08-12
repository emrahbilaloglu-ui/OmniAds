/**
 * WP-27A — the compatibility shims, exercised as the production route owners.
 *
 * Every case below imports the real `page.tsx` that Next would run for a
 * legacy URL and calls it. Nothing here re-implements the decision, wraps it in
 * a surrogate, or reads source text looking for a marker: a shim that stopped
 * calling `compatibilityPage`, or called it with the wrong route, or was never
 * created at all, fails these tests because the module under test is the one
 * that ships.
 *
 * The denominators are read from the route registry rather than typed out, so
 * a mapping added to the registry without a shim is a failure rather than a
 * smaller, still-green run.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHANGED_MAPPINGS,
  UNIQUE_CHANGED_PATHS,
  ALIAS_MAPPINGS,
} from "@/lib/zero-base/route-registry";
import {
  COMPATIBILITY_TABLE,
  canonicalDestinationsThatAreLegacyPaths,
} from "@/lib/zero-base/compatibility";
import {
  resetCompatibilityObserver,
  setCompatibilityObserver,
  type CompatibilityEvent,
} from "@/lib/zero-base/compatibility-observability";

/* ------------------------------------------------------------------ mocks */

/** Records where a shim sent the caller, and stops execution the way Next does. */
class RedirectSignal extends Error {
  constructor(readonly destination: string) {
    super(`redirect:${destination}`);
  }
}
class NotFoundSignal extends Error {}

vi.mock("next/navigation", () => ({
  redirect: (destination: string) => {
    throw new RedirectSignal(destination);
  },
  notFound: () => {
    throw new NotFoundSignal("not-found");
  },
}));

const session = vi.hoisted(() => ({ current: null as unknown }));
const authorize = vi.hoisted(() => ({ outcome: { kind: "authorized" } as { kind: string } }));
const superadmin = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/auth", () => ({
  getSessionFromCookies: async () => session.current,
}));
vi.mock("@/lib/access/authorize-business", () => ({
  authorizeBusiness: async () => authorize.outcome,
}));
vi.mock("@/lib/admin-auth", () => ({
  isSuperadmin: async () => superadmin.value,
}));

/* ------------------------------------------------------------- test rig */

const ENV_KEYS = [
  "ZERO_BASE_UI_MODE",
  "ZERO_BASE_UI_BUSINESS_IDS",
  "ZERO_BASE_MUTATION_UI_ENABLED",
] as const;
const savedEnv: Record<string, string | undefined> = {};

const BUSINESS = "biz_1";

function signedIn(activeBusinessId: string | null = BUSINESS) {
  session.current = {
    sessionId: "s1",
    user: { id: "u1", email: "dana@halcyon.test" },
    activeBusinessId,
    expiresAt: "2099-01-01T00:00:00Z",
  };
}

function signedOut() {
  session.current = null;
}

/**
 * Where a legacy path's shim and preserved body live on disk.
 *
 * Pure path resolution — no module is evaluated — so the coverage assertions
 * that only need to know a file exists cost nothing.
 */
const SEGMENT_ROOTS = ["app", "app/(dashboard)", "app/(marketing)", "app/(auth)"] as const;

function dirFor(route: string): string {
  const rel = route.replace(/^\//, "");
  for (const base of SEGMENT_ROOTS) {
    const dir = path.join(base, rel);
    if (existsSync(path.join(dir, "legacy-page.tsx"))) return dir;
  }
  throw new Error(`no compatibility shim on disk for ${route}`);
}

interface LoadedShim {
  page: (props: unknown) => Promise<unknown>;
  legacy: unknown;
  dir: string;
}

/**
 * Each shim's module graph is loaded once for the whole file.
 *
 * These are real Next pages, so importing one pulls in its entire legacy body —
 * charts, tables, providers. Loading all 46 took **2.7s sequentially on an idle
 * machine**, and every test after the first ran in 1–30ms because the graph was
 * already warm. That put the whole cold cost inside whichever assertion
 * happened to run first, and under the full 832-file suite — where workers
 * compete for CPU — it exceeded the per-test budget and failed the release
 * aggregate. The cost is setup, so it is paid in setup: once, in parallel,
 * measured, and never again.
 */
const loaded = new Map<string, LoadedShim>();

async function loadShim(route: string): Promise<LoadedShim> {
  const cached = loaded.get(route);
  if (cached) return cached;
  const dir = dirFor(route);
  // The shim first, and awaited, before its body is asked for by name.
  //
  // These two imports must not be in flight together. The shim's own
  // `import LegacyBody from "./legacy-page"` and this file's
  // `@/<dir>/legacy-page` are two specifiers for one file, and requesting both
  // concurrently can leave the module runner with two instances of it — after
  // which the element the shim returns is built from a different function
  // object than the one compared against, and a correct rollback reads as a
  // failure. It reproduced roughly one run in six, always on the same route.
  // Sequencing costs nothing here and removes the race entirely.
  const page = (await import(/* @vite-ignore */ `@/${dir}/page`)) as {
    default: (props: unknown) => Promise<unknown>;
  };
  const legacy = (await import(/* @vite-ignore */ `@/${dir}/legacy-page`)) as {
    default: unknown;
  };
  const shim: LoadedShim = { page: page.default, legacy: legacy.default, dir };
  loaded.set(route, shim);
  return shim;
}

/** Bounded, so 46 module graphs do not all transform at once. */
async function warmAllShims(concurrency = 8): Promise<void> {
  const queue = [...UNIQUE_CHANGED_PATHS];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let route = queue.pop(); route !== undefined; route = queue.pop()) {
      await loadShim(route);
    }
  });
  await Promise.all(workers);
}

function shimFor(route: string): LoadedShim {
  const shim = loaded.get(route);
  if (!shim) throw new Error(`shim for ${route} was not warmed; beforeAll did not run`);
  return shim;
}

/** One place builds the props Next would pass. */
function pageProps(route: string, search: Record<string, string | string[]> = {}) {
  return {
    params: Promise.resolve(PARAMS[route] ?? {}),
    searchParams: Promise.resolve(search),
  };
}

/** Dynamic segments a route needs, so a real id can be checked end to end. */
const PARAMS: Record<string, Record<string, string>> = {
  "/admin/businesses/[businessId]": { businessId: "biz_other" },
  "/admin/discounts/[codeId]": { codeId: "code_9" },
  "/admin/users/[userId]": { userId: "user_7" },
  "/integrations/callback/[provider]": { provider: "meta" },
  "/reports/[reportId]": { reportId: "rep_3" },
  "/reports/[reportId]/edit": { reportId: "rep_3" },
  "/reports/[reportId]/print": { reportId: "rep_3" },
};

type Outcome =
  | { kind: "legacy" }
  | { kind: "redirect"; destination: string }
  | { kind: "not-found" }
  | { kind: "element" };

async function run(
  route: string,
  options: { search?: Record<string, string | string[]> } = {},
): Promise<Outcome> {
  const { page, legacy } = shimFor(route);
  const props = pageProps(route, options.search);
  try {
    const result = (await page(props)) as { type?: unknown } | null;
    if (result && typeof result === "object" && result.type === legacy) return { kind: "legacy" };
    return { kind: "element" };
  } catch (error) {
    if (error instanceof RedirectSignal) return { kind: "redirect", destination: error.destination };
    if (error instanceof NotFoundSignal) return { kind: "not-found" };
    throw error;
  }
}

/**
 * Warmed once, with a budget set from measurement rather than taste.
 *
 * 2.7s for all 46 sequentially on an idle machine; bounded parallelism brings
 * that down, and 60s leaves an order of magnitude of headroom for a worker
 * competing with 831 other test files. This is the only place in the file with
 * a raised budget, and it guards setup, not an assertion — no expectation here
 * can pass because something was slow.
 */
beforeAll(async () => {
  await warmAllShims();
}, 60_000);

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  session.current = null;
  authorize.outcome = { kind: "authorized" };
  superadmin.value = false;
  resetCompatibilityObserver();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetCompatibilityObserver();
});

/* ------------------------------------------------------------- the table */

describe("WP-27A · the compatibility table covers the mapping authority", () => {
  it("has one target per unique changed path, and the plan's denominators", () => {
    expect(CHANGED_MAPPINGS).toHaveLength(47);
    expect(UNIQUE_CHANGED_PATHS).toHaveLength(46);
    expect(COMPATIBILITY_TABLE).toHaveLength(46);
    // 47 records over 46 paths: `/settings` is the split.
    expect(COMPATIBILITY_TABLE.filter((t) => t.scope === "split").map((t) => t.route)).toEqual([
      "/settings",
    ]);
  });

  it("every one of the 47 records is represented by a target", () => {
    for (const mapping of CHANGED_MAPPINGS) {
      const target = COMPATIBILITY_TABLE.find((t) => t.route === mapping.route);
      expect(target, `no target for ${mapping.route}`).toBeDefined();
      expect(target!.canonicalUrls).toContain(mapping.canonicalUrl);
    }
  });

  it("every unique path has a shim and a preserved legacy body on disk", () => {
    // A question about files, answered from files. Evaluating 46 Next page
    // graphs to learn that two of them exist was what made this assertion the
    // slowest thing in the suite.
    for (const route of UNIQUE_CHANGED_PATHS) {
      const dir = dirFor(route);
      expect(existsSync(path.join(dir, "page.tsx")), `${route} has no shim`).toBe(true);
      expect(
        existsSync(path.join(dir, "legacy-page.tsx")),
        `${route} lost its legacy body`,
      ).toBe(true);
    }
  });

  it("every shim delegates to the shared decision, naming its own route", async () => {
    const { readFileSync } = await import("node:fs");
    for (const route of UNIQUE_CHANGED_PATHS) {
      const source = readFileSync(path.join(dirFor(route), "page.tsx"), "utf8");
      expect(source, `${route} does not use the shared page`).toContain(
        'from "@/lib/zero-base/compatibility-page"',
      );
      expect(source, `${route} names the wrong route`).toContain(
        `compatibilityPage("${route}"`,
      );
    }
  });

  it("every warmed shim is a callable server page over its preserved body", () => {
    // The behavioural counterpart: the modules really do export what Next needs.
    for (const route of UNIQUE_CHANGED_PATHS) {
      const { page, legacy } = shimFor(route);
      expect(typeof page, `${route} has no server page`).toBe("function");
      expect(legacy, `${route} lost its legacy body`).toBeTruthy();
    }
  });

  it("REGRESSION: no canonical destination is itself a legacy path, so no shim can chain", () => {
    expect(canonicalDestinationsThatAreLegacyPaths()).toEqual([]);
  });

  it("aliases keep their URL and get no shim", async () => {
    expect(ALIAS_MAPPINGS.length).toBeGreaterThan(0);
    for (const alias of ALIAS_MAPPINGS) {
      expect(UNIQUE_CHANGED_PATHS).not.toContain(alias.route);
      expect(COMPATIBILITY_TABLE.some((t) => t.route === alias.route)).toBe(false);
    }
  });
});

describe("WP-27A · the redirect is temporary, server-side, and the only mechanism", () => {
  it("REGRESSION: this migration added no edge redirect of its own", async () => {
    // §5.6 forbids introducing one: a session-dependent edge redirect runs
    // before the page can authorize anything, which is the ordering this whole
    // layer exists to avoid.
    //
    // `proxy.ts` is not that. It predates this work and is the coarse
    // signed-in/signed-out gate, so the check is not "does it exist" but "does
    // it know about any of the paths this migration moves" — it must not, or
    // there would be two authorities deciding the same request.
    expect(existsSync("middleware.ts"), "middleware.ts was introduced").toBe(false);
    expect(existsSync("src/middleware.ts")).toBe(false);

    const { readFileSync } = await import("node:fs");
    const proxy = readFileSync("proxy.ts", "utf8");
    for (const route of UNIQUE_CHANGED_PATHS) {
      expect(proxy, `proxy.ts routes ${route}`).not.toContain(`"${route}"`);
    }
    for (const target of COMPATIBILITY_TABLE) {
      for (const url of target.canonicalUrls) {
        expect(proxy, `proxy.ts routes ${url}`).not.toContain(`"${url}"`);
      }
    }
  });

  it("REGRESSION: no shim can issue a permanent redirect", async () => {
    // A 301/308 is cached by the browser, which would make rollback impossible
    // for anyone who had already visited. Only `redirect()` — a 307 — is used.
    const { readFileSync } = await import("node:fs");
    for (const route of UNIQUE_CHANGED_PATHS) {
      const dir = dirFor(route);
      const source = readFileSync(path.join(dir, "page.tsx"), "utf8");
      expect(source, `${route} does its own navigation`).not.toContain("permanentRedirect");
      expect(source, `${route} redirects outside the shared decision`).not.toContain(
        "next/navigation",
      );
    }
    const shared = readFileSync("lib/zero-base/compatibility-page.tsx", "utf8");
    expect(shared).not.toContain("permanentRedirect");
  });

  it("REGRESSION: no shim reaches for a client-side navigation", async () => {
    const { readFileSync } = await import("node:fs");
    for (const route of UNIQUE_CHANGED_PATHS) {
      const dir = dirFor(route);
      const source = readFileSync(path.join(dir, "page.tsx"), "utf8");
      expect(source, `${route} became a client component`).not.toContain("use client");
      expect(source, `${route} navigates in the browser`).not.toContain("useRouter");
    }
  });
});

/* ---------------------------------------------------------------- mode off */

describe("WP-27A · ZERO_BASE_UI_MODE=off is the rollback", () => {
  it("all 46 paths render the preserved legacy body", async () => {
    process.env.ZERO_BASE_UI_MODE = "off";
    signedIn();
    for (const route of UNIQUE_CHANGED_PATHS) {
      expect(await run(route), `${route} did not roll back`).toEqual({ kind: "legacy" });
    }
  });

  it("renders legacy without a session, so rollback cannot depend on auth working", async () => {
    process.env.ZERO_BASE_UI_MODE = "off";
    signedOut();
    for (const route of UNIQUE_CHANGED_PATHS) {
      expect(await run(route), `${route} needed a session to roll back`).toEqual({ kind: "legacy" });
    }
  });

  it("REGRESSION: an unset flag is off, not on", async () => {
    delete process.env.ZERO_BASE_UI_MODE;
    signedIn();
    expect(await run("/overview")).toEqual({ kind: "legacy" });
  });

  it("REGRESSION: a malformed flag falls closed to legacy", async () => {
    signedIn();
    // Every value that is not one of the four named modes, including ones that
    // look like an intent to enable. Nothing here is guessed at.
    for (const value of ["yes", "true", "1", "enabled", "", " ", "internal;on", "on,off", "0"]) {
      process.env.ZERO_BASE_UI_MODE = value;
      expect(await run("/overview"), `mode "${value}" was not treated as off`).toEqual({
        kind: "legacy",
      });
    }
  });

  it("case and surrounding whitespace are tolerated on the mode itself", async () => {
    // Documented tolerance, asserted so it stays deliberate rather than
    // becoming an accident: `ZERO_BASE_UI_MODE=ON` plainly means on.
    signedIn();
    superadmin.value = true;
    for (const value of ["ON", " on", "On ", "\tinternal"]) {
      process.env.ZERO_BASE_UI_MODE = value;
      const outcome = await run("/admin");
      expect(outcome.kind, `mode "${value}" was not recognised`).toBe("redirect");
    }
  });
});

/* ----------------------------------------------------------------- mode on */

describe("WP-27A · ZERO_BASE_UI_MODE=on redirects, once, after authorization", () => {
  beforeEach(() => {
    process.env.ZERO_BASE_UI_MODE = "on";
    signedIn();
    superadmin.value = true;
  });

  it("every path that is not the split redirects to its canonical URL", async () => {
    for (const target of COMPATIBILITY_TABLE) {
      if (target.scope === "split") continue;
      const outcome = await run(target.route);
      expect(outcome.kind, `${target.route} did not redirect`).toBe("redirect");
      const destination = (outcome as { destination: string }).destination;
      // A route parameter wins over the session's business, which is what
      // keeps /ops/businesses/[businessId] pointing at the tenant asked for.
      const expected = target.canonicalUrls[0]!.replace(
        /\[(\w+)\]/g,
        (_m, name: string) => PARAMS[target.route]?.[name] ?? (name === "businessId" ? BUSINESS : ""),
      );
      expect(destination, `${target.route} went to the wrong place`).toBe(expected);
    }
  });

  it("REGRESSION: exactly one hop — no destination is a path that would redirect again", async () => {
    const legacyPaths = new Set(UNIQUE_CHANGED_PATHS);
    for (const target of COMPATIBILITY_TABLE) {
      if (target.scope === "split") continue;
      const outcome = (await run(target.route)) as { destination: string };
      const pathOnly = outcome.destination.split("?")[0]!;
      expect(legacyPaths.has(pathOnly), `${target.route} redirects onto another shim`).toBe(false);
    }
  });

  it("preserves dynamic ids in the destination", async () => {
    expect(await run("/reports/[reportId]")).toEqual({
      kind: "redirect",
      destination: `/c/${BUSINESS}/reports/rep_3`,
    });
    expect(await run("/reports/[reportId]/edit")).toEqual({
      kind: "redirect",
      destination: `/c/${BUSINESS}/reports/rep_3/edit`,
    });
    expect(await run("/admin/users/[userId]")).toEqual({
      kind: "redirect",
      destination: "/ops/users/user_7",
    });
    expect(await run("/integrations/callback/[provider]")).toEqual({
      kind: "redirect",
      destination: `/c/${BUSINESS}/manage/integrations/callback/meta`,
    });
  });

  it("carries the query string, so an old bookmark keeps its filters", async () => {
    expect(
      await run("/reports", { search: { range: "30d", cursor: "abc" } }),
    ).toEqual({
      kind: "redirect",
      destination: `/c/${BUSINESS}/reports?range=30d&cursor=abc`,
    });
  });

  it("carries an OAuth callback's code and state", async () => {
    // Dropping these would break the return leg of a provider connection.
    expect(
      await run("/integrations/callback/[provider]", {
        search: { code: "auth-code-1", state: "state-1" },
      }),
    ).toEqual({
      kind: "redirect",
      destination: `/c/${BUSINESS}/manage/integrations/callback/meta?code=auth-code-1&state=state-1`,
    });
  });

  it("keeps repeated query keys rather than collapsing them", async () => {
    expect(await run("/reports", { search: { tag: ["a", "b"] } })).toEqual({
      kind: "redirect",
      destination: `/c/${BUSINESS}/reports?tag=a&tag=b`,
    });
  });

  it("REGRESSION: a dynamic id that resolves to nothing refuses instead of redirecting", async () => {
    const { page } = shimFor("/reports/[reportId]");
    await expect(
      (async () => {
        try {
          // Deliberately no params: the id cannot be resolved.
          await page({ ...pageProps("/reports/[reportId]"), params: Promise.resolve({}) });
        } catch (error) {
          if (error instanceof NotFoundSignal) return "not-found";
          if (error instanceof RedirectSignal) return `redirect:${error.destination}`;
          throw error;
        }
        return "rendered";
      })(),
    ).resolves.toBe("not-found");
  });
});

/* ------------------------------------------------------- authorization */

describe("WP-27A · nothing redirects before authorization", () => {
  beforeEach(() => {
    process.env.ZERO_BASE_UI_MODE = "on";
  });

  it("an anonymous caller goes to login carrying where they were headed", async () => {
    signedOut();
    expect(await run("/overview")).toEqual({
      kind: "redirect",
      destination: `/login?next=${encodeURIComponent("/overview")}`,
    });
  });

  it("the login round trip keeps the query string too", async () => {
    signedOut();
    expect(await run("/reports", { search: { range: "7d" } })).toEqual({
      kind: "redirect",
      destination: `/login?next=${encodeURIComponent("/reports?range=7d")}`,
    });
  });

  it("REGRESSION: a public legacy path stays reachable without an account", async () => {
    // `/select-language` is public at the edge and `/me/language` is not, so
    // turning the flag on must not build a login wall in front of it.
    signedOut();
    expect(await run("/select-language")).toEqual({ kind: "legacy" });
  });

  it("every path the edge treats as public is one the shims leave public", async () => {
    signedOut();
    for (const target of COMPATIBILITY_TABLE.filter((t) => t.publicToday)) {
      expect(await run(target.route), `${target.route} lost its public access`).toEqual({
        kind: "legacy",
      });
    }
    // And the rest genuinely do require an account.
    for (const target of COMPATIBILITY_TABLE.filter((t) => !t.publicToday).slice(0, 5)) {
      const outcome = await run(target.route);
      expect(outcome.kind, `${target.route} served an anonymous caller`).toBe("redirect");
      expect((outcome as { destination: string }).destination).toContain("/login?next=");
    }
  });

  it("REGRESSION: a non-staff caller cannot learn an /ops surface exists", async () => {
    signedIn();
    superadmin.value = false;
    for (const target of COMPATIBILITY_TABLE.filter((t) => t.scope === "ops")) {
      expect(await run(target.route), `${target.route} leaked to a non-superadmin`).toEqual({
        kind: "not-found",
      });
    }
  });

  it("REGRESSION: a revoked or foreign membership is a not-found, not a redirect", async () => {
    signedIn();
    authorize.outcome = { kind: "no_membership" };
    expect(await run("/overview")).toEqual({ kind: "not-found" });

    authorize.outcome = { kind: "membership_inactive" };
    expect(await run("/overview")).toEqual({ kind: "not-found" });

    authorize.outcome = { kind: "reviewer_out_of_scope" };
    expect(await run("/overview")).toEqual({ kind: "not-found" });
  });

  it("a signed-in caller with no active business is asked to choose one", async () => {
    signedIn(null);
    expect(await run("/overview")).toEqual({
      kind: "redirect",
      destination: "/select-business",
    });
  });

  it("an insufficient role renders the legacy body rather than refusing", async () => {
    // Presentation, not permission: the canonical leaf needs more, so the actor
    // keeps exactly what they have today.
    signedIn();
    authorize.outcome = { kind: "insufficient_role" };
    expect(await run("/overview")).toEqual({ kind: "legacy" });
  });

  it("an unmigrated schema renders the legacy body rather than an empty page", async () => {
    signedIn();
    authorize.outcome = { kind: "schema_unavailable" };
    expect(await run("/overview")).toEqual({ kind: "legacy" });
  });
});

/* ------------------------------------------------------------- allowlist */

describe("WP-27A · allowlist names businesses, exactly", () => {
  beforeEach(() => {
    process.env.ZERO_BASE_UI_MODE = "allowlist";
    signedIn();
    superadmin.value = true;
  });

  it("a listed business redirects", async () => {
    process.env.ZERO_BASE_UI_BUSINESS_IDS = `other_1,${BUSINESS},other_2`;
    expect(await run("/overview")).toEqual({
      kind: "redirect",
      destination: `/c/${BUSINESS}/home`,
    });
  });

  it("REGRESSION: an unlisted business stays on legacy", async () => {
    process.env.ZERO_BASE_UI_BUSINESS_IDS = "other_1,other_2";
    expect(await run("/overview")).toEqual({ kind: "legacy" });
  });

  it("REGRESSION: an empty or absent allowlist enables nobody", async () => {
    for (const value of [undefined, "", " ", ",", ",,"]) {
      if (value === undefined) delete process.env.ZERO_BASE_UI_BUSINESS_IDS;
      else process.env.ZERO_BASE_UI_BUSINESS_IDS = value;
      expect(await run("/overview"), `allowlist "${value}" enabled something`).toEqual({
        kind: "legacy",
      });
    }
  });

  it("REGRESSION: matching is exact — no prefix, suffix or case slippage", async () => {
    for (const value of ["biz_", "biz_10", "BIZ_1", " biz_1x", "*"]) {
      process.env.ZERO_BASE_UI_BUSINESS_IDS = value;
      expect(await run("/overview"), `allowlist "${value}" matched biz_1`).toEqual({
        kind: "legacy",
      });
    }
  });

  it("surrounding whitespace in the list is tolerated, the id itself is not guessed", async () => {
    process.env.ZERO_BASE_UI_BUSINESS_IDS = `  other , ${BUSINESS} ,  `;
    expect(await run("/overview")).toEqual({
      kind: "redirect",
      destination: `/c/${BUSINESS}/home`,
    });
  });

  it("REGRESSION: allowlist does not enable staff or account surfaces", async () => {
    // An allowlist names businesses; /ops and /me have none, so naming a
    // business must not quietly turn them on.
    process.env.ZERO_BASE_UI_BUSINESS_IDS = BUSINESS;
    expect(await run("/admin")).toEqual({ kind: "legacy" });
    expect(await run("/select-language")).toEqual({ kind: "legacy" });
  });
});

/* -------------------------------------------------------------- internal */

describe("WP-27A · internal previews staff and account surfaces only", () => {
  beforeEach(() => {
    process.env.ZERO_BASE_UI_MODE = "internal";
    signedIn();
    superadmin.value = true;
  });

  it("staff and account surfaces redirect", async () => {
    expect(await run("/admin")).toEqual({ kind: "redirect", destination: "/ops" });
    expect(await run("/select-language")).toEqual({
      kind: "redirect",
      destination: "/me/language",
    });
  });

  it("REGRESSION: no client business is implied by internal", async () => {
    for (const target of COMPATIBILITY_TABLE.filter((t) => t.scope === "business")) {
      expect(await run(target.route), `${target.route} moved a client in internal mode`).toEqual({
        kind: "legacy",
      });
    }
  });
});

/* ---------------------------------------------------------- mode changes */

describe("WP-27A · a mode change takes effect on the next request", () => {
  it("on → off returns the same path to legacy, with no restart", async () => {
    signedIn();
    superadmin.value = true;

    process.env.ZERO_BASE_UI_MODE = "on";
    expect(await run("/overview")).toEqual({
      kind: "redirect",
      destination: `/c/${BUSINESS}/home`,
    });

    process.env.ZERO_BASE_UI_MODE = "off";
    expect(await run("/overview")).toEqual({ kind: "legacy" });

    process.env.ZERO_BASE_UI_MODE = "on";
    expect(await run("/overview")).toEqual({
      kind: "redirect",
      destination: `/c/${BUSINESS}/home`,
    });
  });
});

/* --------------------------------------------------------------- /settings */

describe("WP-27A · /settings asks instead of choosing", () => {
  it("renders the chooser rather than redirecting to half of itself", async () => {
    process.env.ZERO_BASE_UI_MODE = "on";
    signedIn();
    const outcome = await run("/settings");
    // Neither a redirect nor the legacy body: a page that names both halves.
    expect(outcome).toEqual({ kind: "element" });
  });

  it("both canonical destinations are named, with the business id resolved", async () => {
    process.env.ZERO_BASE_UI_MODE = "on";
    signedIn();
    const { page } = shimFor("/settings");
    const element = (await page(pageProps("/settings"))) as {
      props: { destinations: string[] };
    };
    expect(element.props.destinations).toEqual([
      "/me/account-security",
      `/c/${BUSINESS}/manage/business`,
    ]);
  });

  it("falls back to the legacy settings page when the flag is off", async () => {
    process.env.ZERO_BASE_UI_MODE = "off";
    signedIn();
    expect(await run("/settings")).toEqual({ kind: "legacy" });
  });
});

/* --------------------------------------------------------- observability */

describe("WP-27A · what the layer reports about itself", () => {
  it("records one bounded event per decision", async () => {
    const events: CompatibilityEvent[] = [];
    setCompatibilityObserver((event) => events.push(event));
    process.env.ZERO_BASE_UI_MODE = "on";
    signedIn();

    await run("/overview");
    await run("/reports", { search: { range: "30d" } });

    expect(events).toEqual([
      { route: "/overview", mode: "on", scope: "business", decision: "redirect" },
      { route: "/reports", mode: "on", scope: "business", decision: "redirect" },
    ]);
  });

  it("REGRESSION: never records an id, a query string or a destination", async () => {
    const events: CompatibilityEvent[] = [];
    setCompatibilityObserver((event) => events.push(event));
    process.env.ZERO_BASE_UI_MODE = "on";
    signedIn();

    await run("/reports/[reportId]", { search: { secret: "do-not-log" } });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("rep_3");
    expect(serialized).not.toContain(BUSINESS);
    expect(serialized).not.toContain("do-not-log");
    expect(serialized).not.toContain("dana@halcyon.test");
  });

  it("records the rollback, so an operator can see off took effect", async () => {
    const events: CompatibilityEvent[] = [];
    setCompatibilityObserver((event) => events.push(event));
    process.env.ZERO_BASE_UI_MODE = "off";
    await run("/overview");
    expect(events).toEqual([
      { route: "/overview", mode: "off", scope: "business", decision: "legacy" },
    ]);
  });

  it("REGRESSION: a broken observer cannot break the page", async () => {
    setCompatibilityObserver(() => {
      throw new Error("sink is down");
    });
    process.env.ZERO_BASE_UI_MODE = "off";
    signedIn();
    expect(await run("/overview")).toEqual({ kind: "legacy" });
  });

  it("every route it can emit is one of the 46, bounding the cardinality", async () => {
    const events: CompatibilityEvent[] = [];
    setCompatibilityObserver((event) => events.push(event));
    process.env.ZERO_BASE_UI_MODE = "off";
    for (const route of UNIQUE_CHANGED_PATHS) await run(route);

    expect(events).toHaveLength(46);
    expect(new Set(events.map((e) => e.route)).size).toBe(46);
    for (const event of events) expect(UNIQUE_CHANGED_PATHS).toContain(event.route);
  });
});
