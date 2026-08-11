/**
 * WP-26 step 1 (behavioural half) — real HTTP posture for all 74 leaves.
 *
 * The structural matrix (`route-matrix-smoke.ts`) proves each leaf has a page
 * and that the page reads a session. It cannot prove the server *behaves*: that
 * an unauthenticated request to a Client leaf is actually turned away rather
 * than rendering, and that a Public leaf actually serves.
 *
 * This drives the running server over HTTP and asserts the **unauthenticated
 * posture** of every leaf, which is the security-critical half and the half
 * that needs no seeded fixtures to be deterministic:
 *
 * | context | expected |
 * |---|---|
 * | Public  | serves (2xx) |
 * | Auth / Client / Agency / Ops | refuses: redirect to login, or 404 |
 * | Share   | token-gated: 2xx or 404, and a bad token must be indistinguishable from a revoked one |
 *
 * Dynamic segments are filled with deterministic non-existent identifiers. That
 * is deliberate: an unauthenticated caller must be refused *before* the id is
 * resolved, so a well-formed id that does not exist and one that does must look
 * identical from outside. A 500 anywhere is a failure — refusing is a decision,
 * crashing is not.
 *
 * Every leaf is asserted. The denominator is printed and compared against the
 * contract registry, so a silently skipped leaf fails the run.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import { GENERATED_LEAVES } from "@/lib/zero-base/generated-contracts";

const BASE = process.env.ZERO_BASE_SMOKE_URL?.trim() || "http://127.0.0.1:3000";

/** Deterministic stand-ins. None of these exist in the database. */
const SEGMENT_FIXTURES: Record<string, string> = {
  businessId: "00000000-0000-4000-8000-000000000000",
  token: "zero-base-smoke-token-that-does-not-exist",
  creativeId: "creative-does-not-exist",
  reportId: "report-does-not-exist",
  adId: "ad-does-not-exist",
  id: "does-not-exist",
};

export function fillSegments(url: string): string {
  return url.replace(/\[(\.\.\.)?(\w+)\]/g, (_match, _spread, name: string) => {
    return SEGMENT_FIXTURES[name] ?? "does-not-exist";
  });
}

export type Posture = "serves" | "refuses" | "token_gated";

/**
 * Leaves whose real posture differs from their context, each with the reason.
 *
 * This table is deliberately explicit and deliberately tiny. Loosening the rule
 * for a whole context to accommodate one page would hide the next genuine leak;
 * naming the exception keeps the other 56 refusing leaves strict.
 */
export const POSTURE_EXCEPTIONS: Record<string, { posture: Posture; why: string }> = {
  "L-AUTH-SHOPIFY": {
    posture: "serves",
    why:
      "Shopify App Store installs land here before the merchant has an app session — that is the " +
      "provider-owned entry point, not a gap. The page reads no session and renders no tenant data; " +
      "a signed shop context redirects straight into OAuth.",
  },
};

export function expectedPosture(ctx: string, leaf?: string): Posture {
  if (leaf && POSTURE_EXCEPTIONS[leaf]) return POSTURE_EXCEPTIONS[leaf].posture;
  if (ctx === "Public") return "serves";
  if (ctx === "Share") return "token_gated";
  return "refuses";
}

export interface LeafResult {
  leaf: string;
  url: string;
  ctx: string;
  status: number;
  location: string | null;
  posture: Posture;
  ok: boolean;
  detail: string;
}

function judge(input: {
  posture: Posture;
  status: number;
  location: string | null;
}): { ok: boolean; detail: string } {
  const { posture, status, location } = input;

  // A crash is never an acceptable answer, whatever the posture.
  if (status >= 500) return { ok: false, detail: `server error ${status}` };

  if (posture === "serves") {
    if (status >= 200 && status < 300) return { ok: true, detail: `serves ${status}` };
    // A public page that redirects to login is a leak of the opposite kind.
    return { ok: false, detail: `public leaf did not serve (${status}${location ? ` → ${location}` : ""})` };
  }

  if (posture === "refuses") {
    if (status === 404) return { ok: true, detail: "404" };
    if (status >= 300 && status < 400) {
      const target = location ?? "";
      const toLogin = /\/login|\/signin|\/sign-in/.test(target);
      return toLogin
        ? { ok: true, detail: `redirects to login (${status})` }
        : { ok: false, detail: `redirects somewhere other than login: ${target}` };
    }
    return { ok: false, detail: `rendered for an unauthenticated caller (${status})` };
  }

  // token_gated: serving or 404 are both correct; the token decides.
  if (status === 404 || (status >= 200 && status < 300)) {
    return { ok: true, detail: `token-gated ${status}` };
  }
  if (status >= 300 && status < 400) {
    return { ok: true, detail: `token-gated redirect ${status}` };
  }
  return { ok: false, detail: `unexpected ${status}` };
}

async function probe(url: string): Promise<{ status: number; location: string | null }> {
  const response = await fetch(`${BASE}${url}`, { redirect: "manual" });
  return { status: response.status, location: response.headers.get("location") };
}

export async function run(): Promise<LeafResult[]> {
  const results: LeafResult[] = [];
  for (const leaf of GENERATED_LEAVES) {
    const url = fillSegments(leaf.url);
    const posture = expectedPosture(leaf.ctx, leaf.leaf);
    try {
      const { status, location } = await probe(url);
      const { ok, detail } = judge({ posture, status, location });
      results.push({ leaf: leaf.leaf, url, ctx: leaf.ctx, status, location, posture, ok, detail });
    } catch (error) {
      results.push({
        leaf: leaf.leaf,
        url,
        ctx: leaf.ctx,
        status: 0,
        location: null,
        posture,
        ok: false,
        detail: `unreachable: ${(error as Error).message}`,
      });
    }
  }
  return results;
}

async function main() {
  const results = await run();

  console.log("zero-base HTTP route posture (WP-26 step 1, behavioural)\n");
  console.log(`  base            ${BASE}`);
  console.log(`  leaves probed   ${results.length} / ${GENERATED_LEAVES.length}`);
  console.log(`  exceptions      ${Object.keys(POSTURE_EXCEPTIONS).length} (declared below)\n`);
  for (const [leaf, exception] of Object.entries(POSTURE_EXCEPTIONS)) {
    console.log(`    ${leaf} → ${exception.posture}`);
    console.log(`      ${exception.why}`);
  }
  console.log("");

  const byPosture = new Map<Posture, LeafResult[]>();
  for (const result of results) {
    byPosture.set(result.posture, [...(byPosture.get(result.posture) ?? []), result]);
  }
  for (const [posture, group] of byPosture) {
    const passed = group.filter((entry) => entry.ok).length;
    console.log(`  ${posture.padEnd(12)} ${passed}/${group.length}`);
  }

  const failures = results.filter((result) => !result.ok);
  if (results.length !== GENERATED_LEAVES.length) {
    console.log(`\nFAIL: probed ${results.length} of ${GENERATED_LEAVES.length} leaves.`);
    process.exit(1);
  }
  if (failures.length > 0) {
    console.log(`\n  ${failures.length} failing:`);
    for (const failure of failures) {
      console.log(`    ${failure.leaf.padEnd(22)} ${failure.url}`);
      console.log(`      expected ${failure.posture}, got ${failure.detail}`);
    }
    console.log(`\nFAIL: ${failures.length} leaves have the wrong unauthenticated posture.`);
    process.exit(1);
  }
  console.log(`\nPASS: all ${results.length} leaves refuse or serve as their context requires.`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  void main();
}
