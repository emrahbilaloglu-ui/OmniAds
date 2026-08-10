/**
 * Generates lib/zero-base/generated-contracts.ts from the vendored design
 * contract. The output is never edited by hand: `zero-base:contracts:check`
 * regenerates into memory and fails if the committed file differs, so changing
 * a vendored tuple without regenerating and reviewing breaks the build.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const V3 = path.join(ROOT, "docs", "zero-base-design", "v3");
const OUT = path.join(ROOT, "lib", "zero-base", "generated-contracts.ts");

type LegacyRecord = { route: string; mode: string };
type Leaf = {
  leaf: string;
  label: string;
  url: string;
  ctx: string;
  role: string;
  availability: string;
  surface: string;
  event: string;
  legacy?: LegacyRecord[];
  note?: string;
};

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(path.join(V3, rel), "utf8")) as T;
}
function sha256(rel: string) {
  return createHash("sha256")
    .update(readFileSync(path.join(V3, rel)))
    .digest("hex");
}
const list = (values: readonly string[]) =>
  values.map((v) => `  ${JSON.stringify(v)},`).join("\n");

export function buildGeneratedSource(): string {
  const sitemapRaw = readJson<Leaf[] | { leaves?: Leaf[]; rows?: Leaf[] }>(
    "export/sitemap.json",
  );
  const leaves: Leaf[] = Array.isArray(sitemapRaw)
    ? sitemapRaw
    : (sitemapRaw.leaves ?? sitemapRaw.rows ?? []);

  const manifestRaw = readJson<
    Array<{ k: string; ev: string }> | { contracts?: Array<{ k: string; ev: string }> }
  >("export/interaction-manifest.json");
  const contracts = Array.isArray(manifestRaw)
    ? manifestRaw
    : (manifestRaw.contracts ?? []);

  const catalogRaw = readJson<
    Array<{ id: string; kind: string }> | { sources?: Array<{ id: string; kind: string }> }
  >("export/report-catalog.json");
  const sources = Array.isArray(catalogRaw) ? catalogRaw : (catalogRaw.sources ?? []);

  const audit = readJson<{ packageHash: string; ruleVersion: string }>(
    "export/audit.json",
  );

  const availabilities = [...new Set(leaves.map((l) => l.availability))].sort();
  const legacyModes = [
    ...new Set(leaves.flatMap((l) => (l.legacy ?? []).map((r) => r.mode))),
  ].sort();
  const contexts = [...new Set(leaves.map((l) => l.ctx))].sort();

  const leafRows = leaves
    .map((l) => {
      const legacy = (l.legacy ?? [])
        .map((r) => `{ route: ${JSON.stringify(r.route)}, mode: ${JSON.stringify(r.mode)} }`)
        .join(", ");
      return (
        `  {\n` +
        `    leaf: ${JSON.stringify(l.leaf)},\n` +
        `    label: ${JSON.stringify(l.label)},\n` +
        `    url: ${JSON.stringify(l.url)},\n` +
        `    ctx: ${JSON.stringify(l.ctx)},\n` +
        `    role: ${JSON.stringify(l.role)},\n` +
        `    availability: ${JSON.stringify(l.availability)},\n` +
        `    surface: ${JSON.stringify(l.surface)},\n` +
        `    event: ${JSON.stringify(l.event)},\n` +
        `    legacy: [${legacy}],\n` +
        `  },`
      );
    })
    .join("\n");

  const sourceRows = sources
    .map((s) => `  { id: ${JSON.stringify(s.id)}, kind: ${JSON.stringify(s.kind)} },`)
    .join("\n");

  return `// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run zero-base:contracts:generate
// Verify with:     npm run zero-base:contracts:check
//
// Source: docs/zero-base-design/v3 (archive
// 0695ae452469ba3efe2615efe3ffd30fcdb88f5847db53d569042fb864c09b9d)
// Active-manifest fingerprint: ${audit.packageHash}
// Rule version: ${audit.ruleVersion}
// Vendored input digests:
//   export/sitemap.json              ${sha256("export/sitemap.json")}
//   export/interaction-manifest.json ${sha256("export/interaction-manifest.json")}
//   export/report-catalog.json       ${sha256("export/report-catalog.json")}

export const DESIGN_FINGERPRINT = ${JSON.stringify(audit.packageHash)} as const;
export const DESIGN_RULE_VERSION = ${JSON.stringify(audit.ruleVersion)} as const;

export type LeafId =
${leaves.map((l) => `  | ${JSON.stringify(l.leaf)}`).join("\n")};

export type CanonicalPathPattern =
${[...new Set(leaves.map((l) => l.url))].map((u) => `  | ${JSON.stringify(u)}`).join("\n")};

export type SurfaceToken =
${leaves.map((l) => `  | ${JSON.stringify(l.surface)}`).join("\n")};

export type InteractionContractKey =
${contracts.map((c) => `  | ${JSON.stringify(c.k)}`).join("\n")};

export type ReportSourceId =
${sources.map((s) => `  | ${JSON.stringify(s.id)}`).join("\n")};

export type LeafAvailability =
${availabilities.map((a) => `  | ${JSON.stringify(a)}`).join("\n")};

export type LegacyMappingMode =
${legacyModes.map((m) => `  | ${JSON.stringify(m)}`).join("\n")};

export type LeafContext =
${contexts.map((c) => `  | ${JSON.stringify(c)}`).join("\n")};

export interface GeneratedLeaf {
  readonly leaf: LeafId;
  readonly label: string;
  readonly url: CanonicalPathPattern;
  readonly ctx: LeafContext;
  readonly role: string;
  readonly availability: LeafAvailability;
  readonly surface: SurfaceToken;
  readonly event: string;
  readonly legacy: ReadonlyArray<{ readonly route: string; readonly mode: LegacyMappingMode }>;
}

export const GENERATED_LEAVES: readonly GeneratedLeaf[] = [
${leafRows}
] as const;

export const GENERATED_CONTRACT_KEYS: readonly InteractionContractKey[] = [
${list(contracts.map((c) => c.k))}
] as const;

export const GENERATED_CONTRACT_EVENTS: readonly string[] = [
${list(contracts.map((c) => c.ev))}
] as const;

export const GENERATED_REPORT_SOURCES: readonly {
  readonly id: ReportSourceId;
  readonly kind: string;
}[] = [
${sourceRows}
] as const;
`;
}

function main() {
  const source = buildGeneratedSource();
  writeFileSync(OUT, source);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${source.split("\n").length} lines)`);
}

if (process.argv[1] && process.argv[1].includes("generate-contracts")) main();
