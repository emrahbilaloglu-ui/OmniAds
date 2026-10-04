import { createHash } from "node:crypto";
import type { NativeArchiveGeneration } from "./native-evidence-archive";
import { assessNativeEvaluationContextUnit, NATIVE_EVALUATION_UNIT_CONTRACT,
  type NativeEvaluationContextMeasurement } from "./native-evaluation-context-unit";

export const NATIVE_RETAINED_READER_CONTRACT = "native-retained-reader-source-ledger.v1" as const;
export const NATIVE_RETAINED_LEDGER_PATH = "docs/architecture/native-retained-reader-ledger.json";
export const NATIVE_RETAINED_CONSUMER_ROLES = ["serving-and-history", "outcomes-and-stability",
  "original-generation-and-reuse", "operator-lineage", "storage-and-pin-reader", "immutable-writer",
  "schema", "offline-operator", "owned-fixture", "provenance-only", "comment-only",
  "offline-lifecycle-guard"] as const;
type Role = typeof NATIVE_RETAINED_CONSUMER_ROLES[number];
export interface NativeRetainedReaderLedger {
  contract: typeof NATIVE_RETAINED_READER_CONTRACT;
  baselineRevision: string;
  sourceInventorySha256: string;
  entries: { path: string; role: Role; sha256: string; retention: string }[];
}
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const hash = (value: string) => /^[a-f0-9]{64}$/.test(value);
/** Literal tables, central aliases and split-prefix SQL are all review triggers.
 * This is a fail-closed SOURCE ledger, not an AST proof of arbitrary dynamic SQL,
 * third-party consumers, production deployment or transitive reader closure. */
export function mentionsNativeRetainedTables(source: string): boolean {
  return /engine_v3_ad_decision_(?:evaluations|snapshots_daily|evaluation_contexts|input_evidence|events)\b|\bAD_(?:EVALUATIONS|SNAPSHOTS|EVENTS)_TABLE\b|engine_v3_(?:ad_(?:decision_)?)?(?=["'`])/i.test(source);
}
export function nativeRetainedLedgerDigest(ledger: Omit<NativeRetainedReaderLedger, "sourceInventorySha256">): string {
  return sha(JSON.stringify(ledger));
}
export function validateNativeRetainedReaderLedger(actual: ReadonlyMap<string, string>, ledger: NativeRetainedReaderLedger) {
  const { sourceInventorySha256, ...body } = ledger;
  const issues: string[] = [];
  if (ledger.contract !== NATIVE_RETAINED_READER_CONTRACT || !/^[a-f0-9]{40}$/.test(ledger.baselineRevision) ||
      !hash(sourceInventorySha256) || nativeRetainedLedgerDigest(body) !== sourceInventorySha256 ||
      !Array.isArray(ledger.entries) || ledger.entries.length === 0)
    issues.push("ledger identity/digest mismatch");
  const declared = new Map<string, NativeRetainedReaderLedger["entries"][number]>();
  for (const entry of Array.isArray(ledger.entries) ? ledger.entries : []) {
    if (declared.has(entry.path) || !/^(?:app|components|lib|scripts)\/[a-zA-Z0-9_./[\]-]+\.(?:tsx?|mts|cts|mjs|cjs|js|sql|py)$/.test(entry.path) ||
        entry.path.startsWith("lib/archive/") || entry.path.split("/").some(p => p === ".." || p === "__tests__") ||
        !NATIVE_RETAINED_CONSUMER_ROLES.includes(entry.role) || !hash(entry.sha256) || !entry.retention.trim())
      issues.push(`${entry.path}: invalid or duplicate declaration`);
    declared.set(entry.path, entry);
    const source = actual.get(entry.path);
    if (source === undefined) issues.push(`${entry.path}: declared source missing`);
    else if (sha(source) !== entry.sha256) issues.push(`${entry.path}: source changed; review selection and retention before repinning`);
    else if (!mentionsNativeRetainedTables(source)) issues.push(`${entry.path}: obsolete declaration`);
  }
  for (const [path, source] of actual) if (mentionsNativeRetainedTables(source) && !declared.has(path))
    issues.push(`${path}: unclassified retained-table consumer`);
  return { sourceMatches: issues.length === 0, issues, sourceInventorySha256,
    productionConsumerClosureProved: false as const, providerAuthority: false as const, reclaimEligible: false as const };
}

/** Closed-day PREPARATION only. Never a delete executor, scheduler, retention
 * permission or provider authority. Keep EVERY retained snapshot and its complete
 * evaluation/context lineage regardless of age/current epoch/serving winner.
 * Original jobs, calibration parents, shared input/objects and provider roots stay
 * live. All FK and known/unknown non-FK checks remain the actual v2 measurement.
 */
export function assessNativeRetainedGenerationLifecycle(input: {
  generation: NativeArchiveGeneration;
  measurement: NativeEvaluationContextMeasurement;
  ledger: NativeRetainedReaderLedger;
  actualSources: ReadonlyMap<string, string>;
  unknownOperationalConsumers: string[];
}) {
  const source = validateNativeRetainedReaderLedger(input.actualSources, input.ledger);
  if (!source.sourceMatches) throw new Error("Native retained lifecycle refused: source ledger drift");
  if (input.measurement.contract !== NATIVE_EVALUATION_UNIT_CONTRACT ||
      input.measurement.consumerInventorySha256 !== source.sourceInventorySha256 ||
      !Array.isArray(input.unknownOperationalConsumers) ||
      input.unknownOperationalConsumers.some(x => typeof x !== "string" || !x.trim()))
    throw new Error("Native retained lifecycle refused: current measurement/inventory required");
  const measured = assessNativeEvaluationContextUnit(input.measurement, input.generation);
  const day = input.generation.asOfDate;
  const clock = Date.parse(input.measurement.observedAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ||
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)
    throw new Error("Native retained lifecycle refused: invalid exact UTC day");
  const closedDay = day < new Date(clock).toISOString().slice(0, 10);
  const unknown = input.unknownOperationalConsumers.length > 0 || input.measurement.unknownReferences.length > 0;
  return { contract: "native-retained-generation-lifecycle-preparation.v1" as const,
    closedDay, sourceInventorySha256: source.sourceInventorySha256,
    eligibleForBoundedArchivePreparation: closedDay && !unknown && measured.pinFreeWithinMeasuredScope,
    reason: unknown ? "unknown_consumer" : !closedDay ? "current_or_future_day" : measured.reason,
    measured, retainedRoots: input.measurement.retainedRoots,
    snapshotAgePruningAllowed: false as const, productionConsumerClosureProved: false as const,
    removalAuthorized: false as const, providerAuthority: false as const,
    reclaimEligible: false as const, physicalBytesReclaimed: "0" as const };
}
