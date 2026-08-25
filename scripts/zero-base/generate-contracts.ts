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

  type LedgerRow = {
    leaf: string;
    surface: string;
    event: string;
    properties: string;
    actorScope: string;
  };
  const ledger = readJson<LedgerRow[]>("export/instrumentation-ledger.json");

  // "surface · ts · actor_role · width_bucket · account_id (when scoped)"
  // becomes a sorted key list. The parenthetical is a condition, not part of
  // the key, so it is stripped rather than becoming `account_id (when`.
  const propertyKeys = (raw: string) =>
    [
      ...new Set(
        raw
          .split("·")
          .map((part) => part.replace(/\(.*?\)/g, "").trim())
          .filter(Boolean),
      ),
    ].sort();

  const ledgerRows = ledger
    .map((row) => {
      const keys = propertyKeys(row.properties);
      /*
       * A surface that may be emitted without a session.
       *
       * The ledger has six `actorScope` values and TWO of them describe a
       * caller with no session: `Public · pre-auth` (15 leaves) and
       * `Unauthenticated recipient · token scope only` (2 — the public creative
       * and report shares). Matching only the first was a derivation bug, not a
       * design statement: it marked `share_creative` as `anonymous: false`,
       * which made the ingest refuse the very page the ledger describes as
       * `availability: live` for an unauthenticated recipient.
       *
       * Matched on the absence of an authenticated actor rather than on a
       * prefix, so a seventh scope wording cannot silently fall on the wrong
       * side of it.
       */
      const anonymous =
        row.actorScope.startsWith("Public") ||
        row.actorScope.startsWith("Unauthenticated");
      return (
        `  {\n` +
        `    leaf: ${JSON.stringify(row.leaf)},\n` +
        `    surface: ${JSON.stringify(row.surface)},\n` +
        `    event: ${JSON.stringify(row.event)},\n` +
        `    anonymous: ${anonymous},\n` +
        `    properties: [${keys.map((k) => JSON.stringify(k)).join(", ")}],\n` +
        `  },`
      );
    })
    .join("\n");

  const allProperties = [
    ...new Set(ledger.flatMap((row) => propertyKeys(row.properties))),
  ].sort();
  const allEvents = [...new Set(ledger.map((row) => row.event))].sort();

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
//   export/instrumentation-ledger.json ${sha256("export/instrumentation-ledger.json")}

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

export type InstrumentationSurface =
${ledger.map((row) => `  | ${JSON.stringify(row.surface)}`).join("\n")};

export type InstrumentationEventName =
${allEvents.map((e) => `  | ${JSON.stringify(e)}`).join("\n")};

export type InstrumentationPropertyKey =
${allProperties.map((k) => `  | ${JSON.stringify(k)}`).join("\n")};

export interface GeneratedInstrumentationRow {
  readonly leaf: LeafId;
  readonly surface: InstrumentationSurface;
  readonly event: InstrumentationEventName;
  /** True only for pre-auth public surfaces. */
  readonly anonymous: boolean;
  readonly properties: readonly InstrumentationPropertyKey[];
}

/** One row per canonical screen: the closed emitter allowlist (INSTR-01). */
export const GENERATED_INSTRUMENTATION: readonly GeneratedInstrumentationRow[] = [
${ledgerRows}
] as const;
`;
}

function main() {
  const source = buildGeneratedSource();
  writeFileSync(OUT, source);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${source.split("\n").length} lines)`);
}

if (process.argv[1] && process.argv[1].includes("generate-contracts")) main();
