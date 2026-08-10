/**
 * WP-01 verifier — the vendored design contract is exactly the hash-verified package.
 *
 * This proves provenance and shape only. It deliberately does NOT compute a
 * readiness verdict: the design package's own audit says NOT READY, and this
 * script must never launder that into a green application signal.
 *
 * Every expectation below is an independent literal from the master plan, not a
 * value read back out of the artifact it is checking.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const V3 = path.join(ROOT, "docs", "zero-base-design", "v3");

/** Master-plan §2.1 literals. Never derived from the files under test. */
const EXPECTED = {
  zipSha256:
    "0695ae452469ba3efe2615efe3ffd30fcdb88f5847db53d569042fb864c09b9d",
  fingerprint:
    "f27bf51b31ddffe20b5c6404f5b7c1758ba5087342cd84941bf6c2d937befe4a",
  ruleVersion: "3.1.0",
  leaves: 74,
  contracts: 142,
  reportSources: 9,
  renderableSources: 5,
  comingSoonSources: 4,
  flows: 13,
  matrices: 9,
  capabilities: 277,
  invariants: 24,
  routes: 296,
  failingRequirements: ["REQ-27", "REQ-28", "REQ-41"],
  failingMutation: "M11",
} as const;

const failures: string[] = [];
const notes: string[] = [];
function check(label: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    console.log(`  ok    ${label}: ${String(actual)}`);
  } else {
    failures.push(`${label}: expected ${String(expected)}, got ${String(actual)}`);
    console.log(`  FAIL  ${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function sha256(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function main() {
  console.log("zero-base design contract verifier");

  // 1 · The source archive still hashes to the adjudicated identity.
  const zip = process.env.ZERO_BASE_DESIGN_ZIP
    ?? "/Users/harmelek/Downloads/Adsecute Zero-Base Design.zip";
  if (existsSync(zip)) {
    check("source ZIP sha256", sha256(zip), EXPECTED.zipSha256);
  } else {
    notes.push(
      `source ZIP not present at ${zip}; vendored-hash manifest still verified`,
    );
    console.log(`  note  source ZIP absent (${zip}) — manifest check still runs`);
  }

  // 2 · Every vendored file matches the manifest recorded at vendor time.
  const manifestPath = path.join(V3, "SOURCE.md");
  const manifest = readFileSync(manifestPath, "utf8");
  const rows = [...manifest.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|/gm)];
  if (rows.length === 0) failures.push("SOURCE.md contains no hash manifest rows");
  for (const [, rel, want] of rows) {
    const abs = path.join(V3, rel);
    if (!existsSync(abs)) {
      failures.push(`vendored file missing: ${rel}`);
      continue;
    }
    const got = sha256(abs);
    if (got !== want) failures.push(`vendored hash drift: ${rel}`);
  }
  check("vendored files verified", failures.length === 0 ? rows.length : -1, rows.length);

  // 3 · Nothing outside the named contract/spec set was vendored.
  const exportFiles = readdirSync(path.join(V3, "export")).sort();
  const specFiles = readdirSync(path.join(V3, "spec")).sort();
  check("export file count", exportFiles.length, 10);
  check("spec file count", specFiles.length, 5);
  for (const f of [...exportFiles, ...specFiles]) {
    if (/\.(woff2|min\.js)$/.test(f)) {
      failures.push(`vendor binary must not be copied: ${f}`);
    }
  }

  // 4 · Shape of the contract itself.
  const audit = JSON.parse(readFileSync(path.join(V3, "export", "audit.json"), "utf8"));
  check("audit rule version", audit.ruleVersion, EXPECTED.ruleVersion);
  check("active-manifest fingerprint", audit.packageHash, EXPECTED.fingerprint);
  check("capabilities", audit.counts.caps, EXPECTED.capabilities);
  check("invariants", audit.counts.invs, EXPECTED.invariants);
  check("routes", audit.counts.routes, EXPECTED.routes);
  check("interaction contracts", audit.counts.contracts, EXPECTED.contracts);
  check("sitemap leaves", audit.counts.leaves, EXPECTED.leaves);

  const sitemap = JSON.parse(readFileSync(path.join(V3, "export", "sitemap.json"), "utf8"));
  const leaves = Array.isArray(sitemap) ? sitemap : (sitemap.leaves ?? sitemap.rows);
  check("sitemap.json leaves", leaves.length, EXPECTED.leaves);

  const manifestJson = JSON.parse(
    readFileSync(path.join(V3, "export", "interaction-manifest.json"), "utf8"),
  );
  const contracts = Array.isArray(manifestJson)
    ? manifestJson
    : (manifestJson.contracts ?? manifestJson.rows);
  check("interaction-manifest.json contracts", contracts.length, EXPECTED.contracts);

  const catalog = JSON.parse(
    readFileSync(path.join(V3, "export", "report-catalog.json"), "utf8"),
  );
  const sources = Array.isArray(catalog) ? catalog : (catalog.sources ?? catalog.rows);
  check("report sources", sources.length, EXPECTED.reportSources);
  check(
    "renderable sources",
    sources.filter((s: { kind: string }) => s.kind === "renderable").length,
    EXPECTED.renderableSources,
  );
  check(
    "coming-soon sources",
    sources.filter((s: { kind: string }) => s.kind === "coming_soon").length,
    EXPECTED.comingSoonSources,
  );

  const flows = await import(path.join(V3, "spec", "flows.js"));
  check("flows", flows.FLOWS.length, EXPECTED.flows);
  check("matrices", flows.MATRICES.length, EXPECTED.matrices);

  const caps = await import(path.join(V3, "spec", "capabilities.js"));
  check("capability rows", caps.CAPS.length, EXPECTED.capabilities);
  const invs = await import(path.join(V3, "spec", "invariants.js"));
  check("invariant rows", invs.INVARIANTS.length, EXPECTED.invariants);

  // 5 · Residual honesty. The package is NOT READY and must be reported so.
  check("audit verdict is reported honestly", audit.verdict, "NOT READY");
  const nonPass = (audit.reqs as Array<{ id: string; state: string }>)
    .filter((r) => r.state !== "PASS")
    .map((r) => r.id)
    .sort();
  check("failing requirements", nonPass.join(","), EXPECTED.failingRequirements.join(","));

  const residuals = readFileSync(path.join(V3, "ACCEPTED_RESIDUALS.md"), "utf8");
  for (const id of [...EXPECTED.failingRequirements, EXPECTED.failingMutation]) {
    if (!residuals.includes(id)) failures.push(`ACCEPTED_RESIDUALS.md does not record ${id}`);
  }
  if (/\bREADY\b/.test(residuals) && !/NOT READY/.test(residuals)) {
    failures.push("ACCEPTED_RESIDUALS.md must not claim READY");
  }
  console.log(`  ok    residuals recorded: ${EXPECTED.failingRequirements.join(", ")}, ${EXPECTED.failingMutation}`);

  for (const n of notes) console.log(`  note  ${n}`);
  if (failures.length) {
    console.error(`\nFAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    "\nPASS: vendored contract matches the hash-verified package. " +
      "The design package itself remains NOT READY (REQ-27/28/41, M11); " +
      "this script makes no readiness claim.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
