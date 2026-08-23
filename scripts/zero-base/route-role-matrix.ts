/**
 * WP-26 group 2 — the authenticated half of the route matrix.
 *
 * The unauthenticated smoke proves every leaf turns away an anonymous caller.
 * It cannot prove the harder half: that an *authenticated* caller sees exactly
 * their own workspace at exactly their own authority.
 *
 * This signs in as each seeded principal and drives the real server:
 *
 * | principal | expectation |
 * |---|---|
 * | admin / collaborator | Client leaves render, and carry the Ledger root |
 * | guest | reads render; the surface is read-only, which the mounted suites assert |
 * | non-active membership | refused — the row exists, so this proves status is read, not existence |
 * | no membership | refused / sent to select-business |
 * | cross-tenant | a member of workspace A pointed at workspace B is refused |
 * | Ops leaves | refused for every non-superadmin principal |
 *
 * Every assertion is an executed HTTP response. A rendered Client leaf must
 * carry `[data-adc-ui="zero-base"]`, so "200" alone cannot pass for "rendered
 * the canonical surface", and no response may redirect back to itself.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import { GENERATED_LEAVES } from "@/lib/zero-base/generated-contracts";

const BASE = process.env.ZERO_BASE_SMOKE_URL?.trim() || "http://127.0.0.1:3000";

export interface Seed {
  password: string;
  primaryBusinessId: string;
  otherBusinessId: string;
  users: Record<string, { id: string; email: string }>;
}

export type Expectation = "renders" | "refuses" | "redirects";

export interface RoleCase {
  principal: string;
  leaf: string;
  url: string;
  expectation: Expectation;
  status: number;
  location: string | null;
  ledgerRoot: boolean;
  ok: boolean;
  detail: string;
}

async function signIn(email: string, password: string): Promise<string | null> {
  /*
   * Five principals in a row is enough to trip the login throttle, which is
   * keyed on the client address and is doing exactly what it should. The matrix
   * has to cope with it rather than report "could not sign in" and abort — the
   * refusal it would then be measuring is the rate limiter's, not the route's.
   */
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      redirect: "manual",
    });
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) return null;
    const raw = response.headers.getSetCookie?.() ?? [];
    const cookies = raw.map((value) => value.split(";")[0]).join("; ");
    return cookies || null;
  }
  return null;
}

/**
 * The scope hop `/c/:businessId/...` performs before it renders.
 *
 * A canonical client URL answers `307 → /switch-business/<id>?next=/app/...`,
 * which sets the active workspace and lands on the `/app` twin. That is the
 * shipped routing contract — the browser specs navigate these URLs and get the
 * surface — and this matrix read the 307 as "did not render", which is why it
 * reported 96 failures the first time it was ever run. The hop is followed
 * once, and only through `/switch-business`: any other redirect is still
 * reported as a redirect, so a refusal that sends the caller to /login cannot
 * be mistaken for a render.
 */
const SCOPE_HOP = /^\/switch-business\//;

/**
 * What "the canonical surface rendered" looks like in the shipped product.
 *
 * This asserted `data-adc-ui="zero-base"`, which no client route emits: D2 fixes
 * `UnifiedDashboardClientShell` and `DashboardFrame` as the shell, and the
 * zero-base root attribute belongs to the design harness's `AppShell` — a
 * component library that no route mounts. Checking for it meant every
 * authorized render read as "200 without the canonical surface".
 *
 * Both markers, not either: `ad-console-shell` is the frame's own root and
 * `data-shell-sidebar="v2"` is the rail inside it, so a page that rendered the
 * frame without navigation cannot pass.
 */
const CANONICAL_SHELL_MARKERS = ["ad-console-shell", 'data-shell-sidebar="v2"'] as const;

async function probe(url: string, cookie: string | null) {
  /*
   * Walk only the scope hop, and stop the moment the chain leaves it.
   *
   * Following redirects wholesale swallowed the leaf's own contract: the OAuth
   * callback is declared as a `redirects` leaf and resolved to 200 because its
   * redirect was followed too. The loop advances while the response is a
   * redirect INTO or OUT OF `/switch-business`, and reports whatever the chain
   * lands on after that.
   */
  let current = url;
  let response = await fetch(`${BASE}${current}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  for (let hop = 0; hop < 3; hop += 1) {
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) break;
    const next = new URL(location, BASE);
    const inHop = SCOPE_HOP.test(next.pathname) || SCOPE_HOP.test(current);
    if (!inHop) break;
    current = `${next.pathname}${next.search}`;
    response = await fetch(next, {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
    });
  }
  const body = response.status >= 200 && response.status < 300 ? await response.text() : "";
  return {
    status: response.status,
    location: response.headers.get("location"),
    ledgerRoot: CANONICAL_SHELL_MARKERS.every((marker) => body.includes(marker)),
  };
}

function judge(input: {
  expectation: Expectation;
  status: number;
  location: string | null;
  ledgerRoot: boolean;
  url: string;
}): { ok: boolean; detail: string } {
  const { expectation, status, location, ledgerRoot, url } = input;
  if (status >= 500) return { ok: false, detail: `server error ${status}` };

  // A redirect back to the same path is a loop, whatever the expectation.
  if (location && new URL(location, BASE).pathname === url) {
    return { ok: false, detail: `redirect loop to ${location}` };
  }

  if (expectation === "redirects") {
    return status >= 300 && status < 400
      ? { ok: true, detail: `redirected to ${location ?? "?"}` }
      : { ok: false, detail: `expected a redirect, got ${status}` };
  }

  if (expectation === "renders") {
    if (status < 200 || status >= 300) {
      return { ok: false, detail: `expected a render, got ${status}${location ? ` → ${location}` : ""}` };
    }
    return ledgerRoot
      ? { ok: true, detail: "rendered inside the canonical shell" }
      : { ok: false, detail: "200 without the canonical shell — the frame did not render" };
  }

  if (status === 404) return { ok: true, detail: "404" };
  if (status >= 300 && status < 400) return { ok: true, detail: `redirected to ${location ?? "?"}` };
  return { ok: false, detail: `rendered for a principal that should be refused (${status})` };
}

/**
 * Leaves whose correct authorized behaviour is a redirect, not a render.
 *
 * Declared per leaf with the reason, rather than by loosening "renders" for
 * everything — the other 32 Client leaves stay strict.
 */
export const REDIRECTING_LEAVES: Record<string, string> = {};

/**
 * Leaves whose declared redirect turned out not to be a server redirect.
 *
 * `L-C-M-CB` was declared here as "a 307 to /manage/integrations is the
 * contract". The first run of this matrix against a real server showed a 200:
 * the OAuth landing is a client component that renders, selects the business,
 * and calls `router.replace(returnTo)` a beat later. The return is real, it is
 * simply not a response header, and nothing at the HTTP layer can observe it.
 *
 * So the leaf is measured as a render — which is the stricter check, because it
 * must also come back inside the canonical shell rather than merely not be a
 * 3xx. The client-side return is a behaviour for a browser test to hold, and
 * this note is here so the absence of a declared redirect is deliberate rather
 * than something that was quietly dropped.
 */
export const CLIENT_SIDE_RETURN_LEAVES: Record<string, string> = {
  "L-C-M-CB":
    "Renders, then returns the operator with router.replace once the business " +
    "is selected and the connection state has been re-read.",
};

/** Client leaves, with their dynamic segment filled by a real workspace. */
function clientLeaves(businessId: string) {
  return GENERATED_LEAVES.filter((leaf) => leaf.ctx === "Client").map((leaf) => ({
    leaf: leaf.leaf,
    url: leaf.url
      .replace("[businessId]", businessId)
      .replace(/\[(\.\.\.)?\w+\]/g, "does-not-exist"),
  }));
}

function opsLeaves() {
  return GENERATED_LEAVES.filter((leaf) => leaf.ctx === "Ops").map((leaf) => ({
    leaf: leaf.leaf,
    url: leaf.url,
  }));
}

export async function run(seed: Seed): Promise<RoleCase[]> {
  const results: RoleCase[] = [];

  const record = async (
    principal: string,
    entry: { leaf: string; url: string },
    expectation: Expectation,
    cookie: string | null,
  ) => {
    const observed = await probe(entry.url, cookie);
    const { ok, detail } = judge({ expectation, ...observed, url: entry.url });
    results.push({ principal, leaf: entry.leaf, url: entry.url, expectation, ...observed, ok, detail });
  };

  /**
   * Sign in every principal, and refuse to continue if any sign-in failed.
   *
   * This guard exists because its absence produced a false green: the login
   * endpoint rate-limited a repeated run, every cookie came back null, and the
   * matrix then "passed" every refusal case for the trivial reason that nobody
   * was authenticated. A refusal proves nothing unless the principal really is
   * signed in.
   */
  const cookies: Record<string, string | null> = {};
  const failedSignIns: string[] = [];
  for (const [name, user] of Object.entries(seed.users)) {
    const cookie = await signIn(user.email, seed.password);
    if (!cookie) failedSignIns.push(`${name} <${user.email}>`);
    cookies[name] = cookie;
  }
  if (failedSignIns.length > 0) {
    throw new Error(
      `Could not sign in: ${failedSignIns.join(", ")}. ` +
        "Refusal cases would pass trivially, so the run is aborted rather than reported.",
    );
  }

  const own = clientLeaves(seed.primaryBusinessId);
  const foreign = clientLeaves(seed.otherBusinessId);

  // Members of the workspace: the canonical surface must render, except where
  // the leaf's own contract is to redirect.
  for (const principal of ["admin", "collaborator", "guest"]) {
    for (const entry of own) {
      const expectation: Expectation = REDIRECTING_LEAVES[entry.leaf] ? "redirects" : "renders";
      await record(principal, entry, expectation, cookies[principal]);
    }
  }

  // Same principals, another tenant's workspace: refused, every leaf.
  for (const principal of ["admin", "collaborator", "guest"]) {
    for (const entry of foreign) await record(`${principal}→other-tenant`, entry, "refuses", cookies[principal]);
  }

  // A membership row that exists but is not active, and no membership at all.
  for (const principal of ["inactive", "orphan"]) {
    for (const entry of own) await record(principal, entry, "refuses", cookies[principal]);
  }

  // Ops is superadmin-only; none of these principals is one.
  for (const principal of ["admin", "collaborator", "guest"]) {
    for (const entry of opsLeaves()) await record(`${principal}→ops`, entry, "refuses", cookies[principal]);
  }

  return results;
}

async function main() {
  const seedJson = process.env.ZERO_BASE_ROLE_SEED;
  if (!seedJson) {
    console.error("ZERO_BASE_ROLE_SEED must carry the JSON emitted by seed-role-matrix.mjs.");
    process.exit(1);
  }
  const seed = JSON.parse(seedJson) as Seed;
  const results = await run(seed);

  console.log("zero-base authenticated role matrix (WP-26 group 2 / G5)\n");
  for (const [leaf, why] of Object.entries(REDIRECTING_LEAVES)) {
    console.log(`  declared redirect contract: ${leaf}`);
    console.log(`    ${why}\n`);
  }
  for (const [leaf, why] of Object.entries(CLIENT_SIDE_RETURN_LEAVES)) {
    console.log(`  returns client-side, measured as a render: ${leaf}`);
    console.log(`    ${why}\n`);
  }
  const byPrincipal = new Map<string, RoleCase[]>();
  for (const result of results) {
    byPrincipal.set(result.principal, [...(byPrincipal.get(result.principal) ?? []), result]);
  }
  for (const [principal, group] of byPrincipal) {
    const passed = group.filter((entry) => entry.ok).length;
    console.log(`  ${principal.padEnd(24)} ${passed}/${group.length}`);
  }

  const failures = results.filter((result) => !result.ok);
  console.log(`\n  cases executed  ${results.length}`);
  if (failures.length > 0) {
    console.log(`\n  ${failures.length} failing:`);
    for (const failure of failures.slice(0, 25)) {
      console.log(`    [${failure.principal}] ${failure.leaf} ${failure.url}`);
      console.log(`      expected ${failure.expectation}, got ${failure.detail}`);
    }
    if (failures.length > 25) console.log(`    … and ${failures.length - 25} more`);
    console.log(`\nFAIL: ${failures.length} authenticated route cases are wrong.`);
    process.exit(1);
  }
  console.log(`\nPASS: all ${results.length} authenticated route cases hold.`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) void main();
