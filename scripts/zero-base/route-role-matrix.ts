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
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  if (!response.ok) return null;
  const raw = response.headers.getSetCookie?.() ?? [];
  const cookies = raw.map((value) => value.split(";")[0]).join("; ");
  return cookies || null;
}

async function probe(url: string, cookie: string | null) {
  const response = await fetch(`${BASE}${url}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  const body = response.status >= 200 && response.status < 300 ? await response.text() : "";
  return {
    status: response.status,
    location: response.headers.get("location"),
    ledgerRoot: body.includes('data-adc-ui="zero-base"'),
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
      ? { ok: true, detail: "rendered with the Ledger root" }
      : { ok: false, detail: "200 without the Ledger root — not the canonical surface" };
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
export const REDIRECTING_LEAVES: Record<string, string> = {
  "L-C-M-CB":
    "The OAuth landing performs no exchange of its own. It authorizes the business and returns the " +
    "operator to Integrations, where connection state is read fresh rather than assumed from the " +
    "redirect having happened. A 307 to /manage/integrations is the contract, not a failure.",
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
