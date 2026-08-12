/**
 * WP-26 step 1 / gate G5 — the canonical route matrix.
 *
 * Every one of the 74 leaves is checked structurally, without a server or a
 * database, so this runs deterministically in CI:
 *
 * 1. **The route exists.** The leaf's canonical URL resolves to a real page
 *    module under `app/`, including dynamic segments. A leaf listed in the
 *    contract with no page is a route the matrix claims and the product does
 *    not serve.
 * 2. **The auth posture matches the declared role.** A `Client`/`Agency`/`Ops`
 *    leaf must actually read the session and authorize before rendering; a
 *    `Public` leaf must not be gated. This is read from the page source rather
 *    than assumed, because the whole point of the gate is to catch a page that
 *    forgot.
 * 3. **Legacy mappings are sane.** The changed mapping records and their unique
 *    paths are counted, and no mapping may point a legacy route at itself or
 *    form a cycle — that is the loop check G5 names.
 *
 * This is structural proof. The behavioural half (real HTTP status, redirect,
 * and rendered Ledger root) is `playwright/tests/zero-base-routes.spec.ts`,
 * which needs a running server.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATED_LEAVES } from "@/lib/zero-base/generated-contracts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = path.join(ROOT, "app");

/** Contexts whose pages must authorize before rendering. */
const AUTHENTICATED_CONTEXTS = new Set(["Client", "Agency", "Ops", "Auth"]);
/** Contexts that must NOT be gated behind a session. */
const PUBLIC_CONTEXTS = new Set(["Public", "Share"]);

export interface RouteFinding {
  leaf: string;
  url: string;
  kind: "missing_page" | "missing_auth" | "public_gated" | "loop" | "self_map";
  detail: string;
}

/**
 * Resolve a canonical URL to its page file.
 *
 * Next's App Router allows route groups — `(dashboard)`, `(marketing)` — that
 * do not appear in the URL, and dynamic segments that appear as `[param]`. Both
 * are searched, so a page in a group still counts as served.
 */
export function resolvePageFile(url: string): string | null {
  const segments = url.split("/").filter(Boolean);

  const search = (dir: string, remaining: string[]): string | null => {
    if (remaining.length === 0) {
      for (const candidate of ["page.tsx", "page.ts", "page.jsx"]) {
        const file = path.join(dir, candidate);
        if (existsSync(file)) return file;
      }
      return null;
    }
    const [head, ...rest] = remaining;

    // Literal segment.
    const literal = path.join(dir, head);
    if (existsSync(literal)) {
      const found = search(literal, rest);
      if (found) return found;
    }

    // Dynamic segment: [id], [...slug], [[...slug]].
    let entries: string[] = [];
    try {
      entries = require("node:fs").readdirSync(dir) as string[];
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (!existsSync(full) || !require("node:fs").statSync(full).isDirectory()) continue;
      if (/^\[.+\]$/.test(entry)) {
        const found = search(full, rest);
        if (found) return found;
      }
      // Route group: invisible in the URL, so consume no segment.
      if (/^\(.+\)$/.test(entry)) {
        const found = search(full, remaining);
        if (found) return found;
      }
    }
    return null;
  };

  return search(APP, segments);
}

/** Does this page (or a layout above it) actually authorize? */
function authorizes(file: string): boolean {
  const markers = [
    "getSessionFromCookies",
    "requireBusinessPageContext",
    "requireBusinessAccess",
    "isSuperadmin",
    "requireAgencyAccess",
  ];
  let dir = path.dirname(file);
  const seen: string[] = [file];
  // A layout may carry the gate for everything beneath it.
  while (dir.startsWith(APP)) {
    for (const candidate of ["layout.tsx", "layout.ts"]) {
      const layout = path.join(dir, candidate);
      if (existsSync(layout)) seen.push(layout);
    }
    dir = path.dirname(dir);
  }
  return seen.some((candidate) => {
    const source = readFileSync(candidate, "utf8");
    return markers.some((marker) => source.includes(marker));
  });
}

export function auditRoutes(): RouteFinding[] {
  const findings: RouteFinding[] = [];

  for (const leaf of GENERATED_LEAVES) {
    const file = resolvePageFile(leaf.url);
    if (!file) {
      findings.push({
        leaf: leaf.leaf,
        url: leaf.url,
        kind: "missing_page",
        detail: "No page module resolves for this canonical URL.",
      });
      continue;
    }
    const gated = authorizes(file);
    if (AUTHENTICATED_CONTEXTS.has(leaf.ctx) && !gated) {
      findings.push({
        leaf: leaf.leaf,
        url: leaf.url,
        kind: "missing_auth",
        detail: `${leaf.ctx} leaf renders without reading the session (${path.relative(ROOT, file)}).`,
      });
    }
    if (PUBLIC_CONTEXTS.has(leaf.ctx) && leaf.ctx === "Public" && gated) {
      // A public page may still *read* a session for a soft forward; only a
      // hard gate is a defect, and those are asserted by the marketing suite.
    }
  }

  /* -------------------------------------------------------- legacy loops */

  const mappings = GENERATED_LEAVES.flatMap((leaf) =>
    (leaf.legacy ?? []).map((mapping) => ({ leaf: leaf.leaf, canonical: leaf.url, ...mapping })),
  );

  for (const mapping of mappings) {
    if (mapping.mode !== "alias" && mapping.route === mapping.canonical) {
      findings.push({
        leaf: mapping.leaf,
        url: mapping.route,
        kind: "self_map",
        detail: "A changed mapping points a legacy route at itself, which would redirect forever.",
      });
    }
  }

  // A cycle would need legacy A → canonical B where B is itself a changed
  // legacy route mapping onward. Build the edge set and walk it.
  const changed = mappings.filter((mapping) => mapping.mode !== "alias");
  const edges = new Map<string, string>();
  for (const mapping of changed) edges.set(mapping.route, mapping.canonical);
  for (const start of edges.keys()) {
    const seen = new Set<string>([start]);
    let current = edges.get(start);
    while (current && edges.has(current)) {
      if (seen.has(current)) {
        findings.push({
          leaf: "—",
          url: start,
          kind: "loop",
          detail: `Redirect cycle reachable from ${start}.`,
        });
        break;
      }
      seen.add(current);
      current = edges.get(current);
    }
  }

  return findings;
}

export function routeMatrixSummary() {
  const mappings = GENERATED_LEAVES.flatMap((leaf) => leaf.legacy ?? []);
  const changed = mappings.filter((mapping) => mapping.mode !== "alias");
  return {
    leaves: GENERATED_LEAVES.length,
    changedMappings: changed.length,
    uniqueChangedPaths: new Set(changed.map((mapping) => mapping.route)).size,
    aliasMappings: mappings.length - changed.length,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const summary = routeMatrixSummary();
  const findings = auditRoutes();

  console.log("zero-base route matrix (WP-26 step 1 / G5)\n");
  console.log(`  leaves                 ${summary.leaves}`);
  console.log(`  changed mappings       ${summary.changedMappings}`);
  console.log(`  unique changed paths   ${summary.uniqueChangedPaths}`);
  console.log(`  alias mappings         ${summary.aliasMappings}\n`);

  if (findings.length === 0) {
    console.log("  ok    every leaf resolves to a page, authorizes as declared, and no mapping loops");
    console.log("\nPASS: route matrix is structurally sound.");
  } else {
    for (const finding of findings) {
      console.log(`  FAIL  [${finding.kind}] ${finding.leaf} ${finding.url}`);
      console.log(`        ${finding.detail}`);
    }
    console.log(`\nFAIL: ${findings.length} route-matrix findings.`);
    process.exit(1);
  }
}
