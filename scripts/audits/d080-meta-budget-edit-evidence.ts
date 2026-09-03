/**
 * D080A — Meta budget-edit evidence generator (ANALYSIS ONLY). Correction 7.
 *
 * CLI phases:
 *   probe    — schema-contract discovery (DB).
 *   extract  — frozen pinned-scope evidence package (DB, SELECT-only).
 *   replay   — offline deterministic layered analysis over the frozen package.
 *   verify   — offline validation of the frozen artifact's internal hashes and
 *              scope/cutoff invariants.
 *
 * IMPORT SAFETY (R7)
 * This module has NO top-level side effects. It does not load configuration,
 * does not touch `process.env`, and does not import `@/lib/db`. Configuration
 * loading and the database client are reached only through `openDbBoundary()`,
 * which the CLI calls. Importing this module from a test is inert.
 *
 * Truthful statement of what the boundary does: `configureOperationalScriptRuntime`
 * loads `.env` files through `@next/env`, which POPULATES `process.env`, and it
 * assigns `ENABLE_RUNTIME_MIGRATIONS="0"` when that key is absent. The invariant
 * this script enforces is therefore NOT "sets no environment value" — that claim
 * was false and is withdrawn. The invariant is: **this script never grants or
 * masks execution authority.** A flag that is truthy before loading, or truthy
 * in the loaded configuration, refuses the run; it is never overwritten to pass.
 *
 * EVIDENCE HONESTY
 * Strict point-in-time reconstruction is claimed only where immutable
 * knowledge-time lineage exists. Where a source is a mutable UPSERT, or where
 * the connected schema lacks the columns the proven consumer requires, the
 * result is `not_pit_reconstructible` / `unavailable_schema_lag` and any
 * simulation over current finalized facts is labelled
 * `retrospective_finalized_counterfactual`. It is never called PIT, never
 * called observed policy performance, and never called causal lift.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { types as nodeTypes } from "node:util";

/**
 * v5 supersedes the REJECTED v4. Correction 6 materially expanded the contract
 * (result receipts, nested requirements, request provenance) while keeping the
 * v4 identifier; v4 semantics are not silently redefined — v4 is superseded.
 */
export const D080_EVIDENCE_CONTRACT =
  "adsecute.meta.d080-budget-edit-evidence.v6" as const;
export const D080_EVIDENCE_JSON_OUT =
  "docs/audits/generated/d080-meta-budget-edit-evidence-2026-08-31.json";

/** Accepted predecessor inputs this package is bound to. Unchanged. */
export const D080_PINNED_INPUTS = {
  d078BundlePath:
    "docs/audits/generated/d078-six-business-evidence-bundle-2026-08-30.json",
  d078BundleSha256:
    "9c0d83aa4541849b43096056b95f686c9673169c461d8ebb97ebb3dd86db7b47",
} as const;

// ---------------------------------------------------------------------------
// R5 — the pinned business -> provider-account matrix
// ---------------------------------------------------------------------------

export interface PinnedBinding {
  business: string;
  businessId: string;
  providerAccountId: string;
  /** Scope metadata from `business_provider_accounts`, never a filter. */
  isSelected: boolean;
}

/**
 * The seven D078-pinned bindings. TheSwaf holds two; the second is NOT
 * selected. Both are kept because the accepted D078 scope pins them, and they
 * are reported as separate strata — a business-level aggregate would let the
 * stale non-selected account hide behind the fresh one.
 */
export const D080_PINNED_BINDINGS: readonly PinnedBinding[] = [
  { business: "IwaStore", businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", providerAccountId: "act_1087566732415606", isSelected: true },
  { business: "Grandmix", businessId: "5dbc7147-f051-4681-a4d6-20617170074f", providerAccountId: "act_805150454596350", isSelected: true },
  { business: "Bilsem Zeka", businessId: "6c690fa4-6395-40b5-9755-e99b34d69bc3", providerAccountId: "act_840779107261785", isSelected: true },
  { business: "TheSwaf", businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3", providerAccountId: "act_822913786458311", isSelected: true },
  { business: "TheSwaf", businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3", providerAccountId: "act_921275999286619", isSelected: false },
  { business: "IwaTR", businessId: "b79683b4-6f87-48c0-a3ca-44d4356fef51", providerAccountId: "act_2335220976649516", isSelected: true },
  { business: "ColorFullWorldsTR", businessId: "bc0c6178-7853-4f6f-b026-ef0222a4b9e7", providerAccountId: "act_3554615364751964", isSelected: true },
] as const;

export function bindingKey(businessId: string, providerAccountId: string): string {
  return `${businessId}|${providerAccountId}`;
}

const PINNED_KEYS = new Set(
  D080_PINNED_BINDINGS.map((b) => bindingKey(b.businessId, b.providerAccountId)),
);

/** True only for a (business, account) pair the accepted D078 scope pins. */
export function isPinnedBinding(
  businessId: string | null | undefined,
  providerAccountId: string | null | undefined,
): boolean {
  if (!businessId || !providerAccountId) return false;
  return PINNED_KEYS.has(bindingKey(businessId, providerAccountId));
}

const STATEMENT_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
export const BUDGET_SERIES_LOOKBACK_DAYS = 120;
/** Row-level ownership lineage is kept for this many days before the cutoff. */
export const OWNERSHIP_LINEAGE_DAYS = 14;
/** Cap on materialised non-routine config transition identities per cell. */
export const CONFIG_IDENTITY_LIMIT = 20_000;

// ---------------------------------------------------------------------------
// R7 — execution-authority guard, with no import-time side effect
// ---------------------------------------------------------------------------

export const D080_FORBIDDEN_TRUTHY_FLAGS = [
  "ENABLE_RUNTIME_MIGRATIONS",
  "META_AUTOMATION_ENABLED",
  "META_AUTOMATION_LIVE_WRITES",
  "META_EXECUTION_APPLY_ENABLED",
  "COMMAND_CENTER_EXECUTION_V1",
  "META_LAUNCHPAD_EXECUTION",
  "META_GUARDED_EXECUTION_ENABLED",
  "META_ADS_WRITE_ENABLED",
] as const;

export function isTruthyFlagValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export interface ExecutionAuthorityVerdict {
  ok: boolean;
  truthyBefore: string[];
  truthyAfter: string[];
  /** Flags the config loader introduced or changed, reported either way. */
  changedByLoader: Array<{ flag: string; before: string | null; after: string | null }>;
}

/**
 * Refuses the run when execution authority is present either BEFORE config
 * loading or in the loaded configuration.
 *
 * Checking only the post-load snapshot would let a pre-existing truthy value be
 * silently normalised away by a loader default; checking only the pre-load
 * snapshot would miss a truthy value that arrives from a `.env` file. Both are
 * checked, and neither is ever overwritten to make the guard pass.
 */
export function evaluateExecutionAuthority(
  before: Record<string, string | undefined>,
  after: Record<string, string | undefined>,
): ExecutionAuthorityVerdict {
  const truthyBefore = D080_FORBIDDEN_TRUTHY_FLAGS.filter((f) => isTruthyFlagValue(before[f]));
  const truthyAfter = D080_FORBIDDEN_TRUTHY_FLAGS.filter((f) => isTruthyFlagValue(after[f]));
  const changedByLoader = D080_FORBIDDEN_TRUTHY_FLAGS.filter(
    (f) => (before[f] ?? null) !== (after[f] ?? null),
  ).map((flag) => ({ flag, before: before[flag] ?? null, after: after[flag] ?? null }));
  return {
    ok: truthyBefore.length === 0 && truthyAfter.length === 0,
    truthyBefore,
    truthyAfter,
    changedByLoader,
  };
}

export function assertNoExecutionAuthority(
  before: Record<string, string | undefined>,
  after: Record<string, string | undefined>,
): ExecutionAuthorityVerdict {
  const verdict = evaluateExecutionAuthority(before, after);
  if (!verdict.ok) {
    const flags = [...new Set([...verdict.truthyBefore, ...verdict.truthyAfter])];
    throw new Error(
      `D080 refuses to read the database: execution authority is present (${flags.join(", ")}). This guard never overrides a truthy flag to pass.`,
    );
  }
  return verdict;
}

function snapshotFlags(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(D080_FORBIDDEN_TRUTHY_FLAGS.map((f) => [f, env[f]]));
}

type DbModule = typeof import("@/lib/db");

/**
 * The single place configuration is loaded and the DB client is imported.
 * Never called at import time.
 */
async function openDbBoundary(): Promise<{ db: DbModule; authority: ExecutionAuthorityVerdict }> {
  const before = snapshotFlags(process.env);
  const runtime = await import("@/scripts/_operational-runtime");
  runtime.configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const after = snapshotFlags(process.env);
  const authority = assertNoExecutionAuthority(before, after);
  const db = await import("@/lib/db");
  return { db, authority };
}

// ---------------------------------------------------------------------------
// Canonical helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * The canonical replacer: plain objects are reordered by key, everything else
 * passes through. `canonicalJson` and `canonicalDigest` both go through this
 * one function so the two can never drift apart.
 */
function canonicalReplacer(entry: unknown): unknown {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return entry;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => canonicalReplacer(entry));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * A subtree with at most this many nodes may be serialised whole by
 * `canonicalJson`; anything larger is streamed. The bound decides peak memory,
 * never the result.
 *
 * Counting nodes rather than entries matters. An earlier form asked only how
 * many entries a container had at its own level, so the five-key root
 * `{window, origins, entityUniverse, measurements, proposals}` looked small and
 * was serialised whole — with all 247,050 proposals inside it.
 */
const CANONICAL_SUBTREE_NODES = 512;

/** Guards the prototype walk against a pathological chain. */
const CANONICAL_PROTOTYPE_DEPTH = 64;

/**
 * The deepest nesting this will serialise.
 *
 * Ancestor tracking proves termination for data that repeats an object, but a
 * `toJSON` can manufacture a *fresh* container at every level, so nothing
 * repeats and nothing terminates. A depth bound is the only way to keep the
 * promise that this refuses in bounded time rather than by exhausting the
 * stack. It is a named exclusion, not a silent truncation: exceeding it throws.
 *
 * The frozen packages nest fewer than 20 levels — `canonical-digest.test.ts`
 * measures the real artifact and asserts it — so production is far inside this.
 */
const CANONICAL_MAX_DEPTH = 512;

/**
 * The digest of `canonicalJson(value)`, computed without ever holding that
 * string.
 *
 * ## Supported domain, stated before any claim about it
 *
 * A value is **inside the domain** when nothing reachable from the root is a
 * `Proxy`, the value is acyclic, and it nests no deeper than
 * `CANONICAL_MAX_DEPTH`. Accessors, inherited accessors, array-index accessors,
 * a `toJSON` that is itself a getter, callable objects carrying `toJSON`,
 * key-dependent `toJSON`, and a `toJSON` that synchronously re-enters this
 * function are all inside it.
 *
 * **Inside the domain** this returns exactly `sha256Canonical(value)`, refuses
 * exactly the same values with the same error, and performs the same observable
 * operations: one read per property, one `toJSON` invocation per position, with
 * the same key.
 *
 * **Outside the domain** nothing silently disagrees; each case fails closed
 * with its own accurate error:
 *
 *   - a `Proxy`, whether reached directly or returned by a `toJSON`, is refused
 *     before any trap fires, because the descriptor probe would otherwise
 *     observe traps that plain serialisation never fires;
 *   - a cycle is refused with `TypeError: Converting circular structure to JSON`
 *     in bounded time;
 *   - nesting past `CANONICAL_MAX_DEPTH` is refused with a `RangeError` that
 *     names depth.
 *
 * `canonicalJson` also fails on cyclic data, but by exhausting the stack — its
 * replacer copies every object level, so `JSON.stringify` never recognises the
 * repeat. That is **not** a bounded refusal, and this deliberately does not
 * imitate it. Where the two differ in *how* they refuse, that difference is
 * asserted in `canonical-digest.test.ts` rather than described as sameness.
 *
 * ## Why this is not simply `canonicalJson`
 *
 * `verifyArtifact` re-derives large structures and hashes them. Doing that as
 * `sha256Canonical(x)` materialises one complete canonical string — for the
 * analysis hash, a single string over 247,050 proposals, which was most of why
 * a D080B verification peaked at 1,769 MiB and the 116-test suite crossed the
 * 2 GiB ceiling.
 *
 * ## What each correction had to fix
 *
 * Correction 5 delegated every leaf and small subtree to `canonicalJson` and
 * claimed the semantics were therefore inherited. Correction 6 disproved that
 * for `toJSON` below a streamed parent and split serialisation at each
 * position. Correction 8 fixed a `Proxy` returned by `toJSON`, a repeat
 * mistaken for a cycle, and unbounded recursion. Correction 9 removed the last
 * module-global state, which a synchronous re-entry could corrupt. Correction 7
 * disproved:
 *
 *   - a **callable** object carrying `toJSON` was skipped, because the test
 *     asked for `typeof === "object"`; a function is an Object to
 *     `SerializeJSONProperty`, so its `toJSON` must run;
 *   - the root failure path re-serialised the raw value, invoking a root
 *     `toJSON` a **second** time before throwing;
 *   - the bounded probe **read** nested values, so a getter ran once for the
 *     probe and once for serialisation — two calls, and a different digest for
 *     any getter that does not return the same thing twice.
 *
 * The probe is now descriptor-based and executes no user code at all.
 */
export function canonicalDigest(value: unknown): string {
  const hash = createHash("sha256");
  // The root sits in the synthetic holder `{"": value}`, so its key is "".
  const ctx: DigestContext = { ancestors: new Set<object>(), usedToJson: false };
  const root = transformAt(value, "", ctx);
  const rootUsedToJson = ctx.usedToJson;
  if (serialisesToNothing(root)) {
    // `JSON.stringify` returns undefined here and `sha256Canonical` throws when
    // it feeds that to the hash. Reproduce that failure by feeding the hash the
    // same nothing — re-serialising the original would invoke `toJSON` twice.
    hash.update(undefined as unknown as string);
  } else {
    if (!rootUsedToJson && isWalkableContainer(value)) ctx.ancestors.add(value);
    streamValue(root, (chunk) => hash.update(chunk), ctx);
  }
  return hash.digest("hex");
}

/** Objects, callable objects and BigInt are what `toJSON` may be read from. */
function acceptsToJson(value: unknown): boolean {
  if (value === null) return false;
  const kind = typeof value;
  return kind === "object" || kind === "function" || kind === "bigint";
}

/**
 * `SerializeJSONProperty` steps 2 and 3: apply `toJSON(key)` if the value
 * carries one, then the replacer. The result is what actually gets serialised
 * at that position, and it must not be passed through `toJSON` again.
 */
/**
 * Per-digest state, created once per top-level `canonicalDigest` and threaded
 * through the streamer.
 *
 * Correction 8 used a module-level flag and argued that nothing interleaves
 * between writing and reading it. **That was wrong**, and in plain synchronous
 * JavaScript: `canonicalReplacer` calls `Object.entries`, an enumerable getter
 * can call `canonicalDigest` again, and the nested digest overwrote the flag
 * before the outer caller read it — turning a finite program into a false
 * "circular structure" refusal. One context per top-level call makes nested
 * re-entry independent by construction. It costs one object per digest, not one
 * per property, so the hot path allocates nothing extra.
 */
interface DigestContext {
  /** Raw containers open on the current path, for cycle detection. */
  ancestors: Set<object>;
  /** Did the most recent `transformAt` in *this* digest invoke a `toJSON`? */
  usedToJson: boolean;
}

function transformAt(raw: unknown, key: string, ctx: DigestContext): unknown {
  ctx.usedToJson = false;
  if (isProxy(raw)) refuseProxy();
  let value = raw;
  if (acceptsToJson(value)) {
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      value = (toJson as (k: string) => unknown).call(value, key);
      ctx.usedToJson = true;
      // Correction 8: `toJSON` can *return* a Proxy. Correction 7 checked only
      // the raw value and then handed the result straight to the replacer,
      // whose `Object.entries` fired `ownKeys`, `getOwnPropertyDescriptor` and
      // `get` traps — so the documented "refused before any trap fires" was
      // false for exactly this shape. The result is checked here, before the
      // replacer touches it.
      if (isProxy(value)) refuseProxy();
    }
  }
  return canonicalReplacer(value);
}

/** A container the streamer walks. Functions serialise to nothing instead. */
function isWalkableContainer(entry: unknown): entry is Record<string, unknown> | unknown[] {
  return entry !== null && typeof entry === "object";
}

/** Nothing is emitted for these, so a container decides what stands in. */
function serialisesToNothing(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function isProxy(value: unknown): boolean {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  )
    ? nodeTypes.isProxy(value)
    : false;
}

function refuseProxy(): never {
  throw new TypeError(
    "canonicalDigest does not support Proxy values: the bounded probe would fire traps that plain serialisation never fires, so the digest could differ silently. Use sha256Canonical for such a value.",
  );
}

/**
 * Does this value carry a callable `toJSON`, decided **without reading it**?
 *
 * `"unknown"` means the answer could only be had by running user code — a
 * `toJSON` accessor, or a proxy in the chain — which the probe must not do.
 */
function toJsonInChain(entry: object): "no" | "yes" | "unknown" {
  let cursor: object | null = entry;
  for (let depth = 0; cursor !== null && depth < CANONICAL_PROTOTYPE_DEPTH; depth += 1) {
    if (isProxy(cursor)) return "unknown";
    const descriptor = Object.getOwnPropertyDescriptor(cursor, "toJSON");
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) return "unknown";
      return typeof descriptor.value === "function" ? "yes" : "no";
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return cursor === null ? "no" : "unknown";
}

/**
 * Is this subtree small enough, and provably free of anything whose
 * serialisation could observe a second read, so that handing it whole to
 * `canonicalJson` is exactly equivalent?
 *
 * The walk reads **descriptors only**. It never gets a property value through
 * an accessor, never reads `toJSON`, and never touches a proxy's traps beyond
 * the `isProxy` test itself. Anything it cannot prove sends the value down the
 * streaming path, which reads each position exactly once.
 */
function provablyInertAndSmall(value: unknown, budget: number): boolean {
  let seen = 0;
  const walk = (entry: unknown): boolean => {
    seen += 1;
    if (seen > budget) return false;
    if (entry === null) return true;
    const kind = typeof entry;
    if (kind !== "object" && kind !== "function") return true; // primitive, incl. BigInt
    if (isProxy(entry)) return false;
    if (toJsonInChain(entry as object) !== "no") return false;
    // A function with no `toJSON` serialises to nothing, which `canonicalJson`
    // already does correctly.
    if (kind === "function") return true;
    if (Array.isArray(entry)) {
      if (entry.length > budget) return false;
      for (let i = 0; i < entry.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(i));
        // A hole becomes `null` either way; an index accessor is user code.
        if (descriptor === undefined) continue;
        if (!("value" in descriptor)) return false;
        if (!walk(descriptor.value)) return false;
      }
      return true;
    }
    const keys = Object.keys(entry as Record<string, unknown>);
    if (keys.length > budget) return false;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (descriptor === undefined || !("value" in descriptor)) return false;
      if (!walk(descriptor.value)) return false;
    }
    return true;
  };
  return walk(value);
}

/**
 * Serialise a value that has already been transformed for its position.
 *
 * `ancestors` holds the **raw** containers currently open on this path. It has
 * to be the raw ones: the canonical replacer hands back a fresh copy at every
 * object level, so tracking the transformed values would never see the same
 * object twice — which is also exactly why `canonicalJson` cannot detect a
 * cycle itself and dies of stack exhaustion instead. A repeated *sibling*
 * reference, the same child twice rather than inside itself, stays valid.
 */
function streamValue(
  value: unknown,
  emit: (chunk: string) => void,
  ctx: DigestContext,
  depth = 0,
): void {
  if (depth > CANONICAL_MAX_DEPTH) {
    throw new RangeError(
      `canonicalDigest exceeded the maximum serialisation depth of ${CANONICAL_MAX_DEPTH}. A toJSON that returns a new container at every level never terminates; this refuses in bounded time instead of exhausting the stack.`,
    );
  }
  if (!isWalkableContainer(value)) {
    // A primitive, including BigInt, which `canonicalJson` refuses exactly as
    // `JSON.stringify` does.
    emit(canonicalJson(value));
    return;
  }
  if (isProxy(value)) refuseProxy();
  if (provablyInertAndSmall(value, CANONICAL_SUBTREE_NODES)) {
    emit(canonicalJson(value));
    return;
  }
  if (Array.isArray(value)) {
    emit("[");
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) emit(",");
      // One read of this index, exactly as `JSON.stringify` performs one.
      streamChild(value[i], String(i), emit, ctx, depth, () => emit("null"));
    }
    emit("]");
    return;
  }
  // Canonical order is the same `localeCompare` the replacer applies. The
  // replacer has already sorted this object at its own position; sorting again
  // is a no-op that keeps the invariant local and obvious.
  const keys = Object.keys(value as Record<string, unknown>).sort((a, b) => a.localeCompare(b));
  emit("{");
  let wrote = 0;
  for (const key of keys) {
    const raw = (value as Record<string, unknown>)[key];
    const separator = wrote > 0 ? "," : "";
    const wroteThis = streamChild(
      raw,
      key,
      (chunk) => emit(chunk),
      ctx,
      depth,
      null,
      () => emit(`${separator}${JSON.stringify(key)}:`),
    );
    if (wroteThis) wrote += 1;
  }
  emit("}");
}

/**
 * Transform one child for its position and serialise it, refusing a cycle.
 *
 * Returns whether anything was written. `onNothing` is what an array puts in
 * the slot; an object passes none and the property is simply omitted.
 */
function streamChild(
  raw: unknown,
  key: string,
  emit: (chunk: string) => void,
  ctx: DigestContext,
  depth: number,
  onNothing: (() => void) | null,
  before?: () => void,
): boolean {
  const entry = transformAt(raw, key, ctx);
  // Read immediately, before any further transform in this context can run.
  const usedToJson = ctx.usedToJson;
  // `JSON.stringify` omits an object entry that serialises to nothing, and
  // writes `null` for such an array slot.
  if (serialisesToNothing(entry)) {
    if (onNothing) onNothing();
    return false;
  }
  if (before) before();
  // Ancestry proves a cycle only when no `toJSON` intervened.
  //
  // Correction 7 refused whenever a raw container reappeared on the open path.
  // That is not what recursion means. When a `toJSON` runs, the value actually
  // serialised is whatever that function returned — possibly a string, possibly
  // a fresh object with no link back — so a repeated *raw* object proves
  // nothing about termination, and C7 rejected finite programs with a false
  // "circular structure" error.
  //
  // When no `toJSON` runs, `entry` is either `raw` itself (an array) or a
  // shallow sorted copy of it (an object), so descending into `entry` really is
  // descending into `raw`'s own children and a repeat really is a cycle. That
  // is the only case where this can be decided, and it is decided here.
  // Everything else is bounded by `CANONICAL_MAX_DEPTH`.
  const provesCycle = !usedToJson && isWalkableContainer(entry) && isWalkableContainer(raw);
  if (provesCycle) {
    if (ctx.ancestors.has(raw)) throw new TypeError("Converting circular structure to JSON");
    ctx.ancestors.add(raw);
    streamValue(entry, emit, ctx, depth + 1);
    ctx.ancestors.delete(raw);
  } else {
    streamValue(entry, emit, ctx, depth + 1);
  }
  return true;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value === null || value === undefined) return null;
  return String(value);
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// R1 — source-schema compatibility contract
// ---------------------------------------------------------------------------

/**
 * Columns the PROVEN cutoff-safe state consumer requires.
 *
 * `lib/creative-decision-engine/data-source.ts` selects `run.last_captured_at`
 * and `run.manifest_kind` when it resolves a complete manifest, and
 * `lib/meta/entity-state-history.ts` writes both. A database that predates them
 * cannot answer the question that consumer answers: `last_seen_at` still proves
 * WHEN truth was last confirmed, but without `last_captured_at` there is no
 * knowledge-time for that confirmation, so a heartbeat cannot be placed on a
 * bitemporal axis. Reconstructing anyway would be an approximation presented as
 * a fact, so this fails closed instead.
 */
export const REQUIRED_RUN_COLUMNS_FOR_STRICT_PIT = [
  "last_captured_at",
  "manifest_kind",
  "base_run_id",
  "delta_stats_json",
] as const;

export type SchemaCompatibility =
  | "compatible"
  | "unavailable_schema_lag";

export interface SchemaContract {
  compatibility: SchemaCompatibility;
  observedRunColumns: string[];
  missingRunColumns: string[];
  strictPitOwnerReconstruction: "available" | "unavailable_schema_lag";
  basis: string;
}

export function evaluateSchemaContract(observedRunColumns: string[]): SchemaContract {
  const observed = new Set(observedRunColumns);
  const missing = REQUIRED_RUN_COLUMNS_FOR_STRICT_PIT.filter((c) => !observed.has(c));
  const compatible = missing.length === 0;
  return {
    compatibility: compatible ? "compatible" : "unavailable_schema_lag",
    observedRunColumns: [...observedRunColumns].sort(),
    missingRunColumns: missing,
    strictPitOwnerReconstruction: compatible ? "available" : "unavailable_schema_lag",
    basis: compatible
      ? "meta_entity_observation_runs carries every column the proven cutoff-safe consumer reads."
      : `meta_entity_observation_runs is missing ${missing.join(", ")}. The heartbeat's knowledge-time cannot be proven, so strict point-in-time owner reconstruction is refused rather than approximated.`,
  };
}

// ---------------------------------------------------------------------------
// R4 — per-source write semantics
// ---------------------------------------------------------------------------

export type WriteSemantics =
  | "mutable_upsert"
  | "append_only_effective_dated"
  | "append_only_with_compaction"
  | "append_only_bitemporal";

export interface SourceSemantics {
  source: string;
  writeSemantics: WriteSemantics;
  /** Can this source prove BOTH an effective time and a knowledge time? */
  pitReconstructible: boolean;
  evidence: string;
}

/**
 * Write semantics audited from the writers, not inferred from column names.
 * A table with an `updated_at` column is not bitemporal; an UPSERT overwrites
 * the very values an earlier origin would need.
 */
export const D080_SOURCE_SEMANTICS: readonly SourceSemantics[] = [
  {
    source: "meta_campaign_daily",
    writeSemantics: "mutable_upsert",
    pitReconstructible: false,
    evidence:
      "lib/meta/warehouse.ts INSERT ... ON CONFLICT (business_id, provider_account_id, date, campaign_id) DO UPDATE SET spend = EXCLUDED.spend, revenue = EXCLUDED.revenue, source_snapshot_id = EXCLUDED.source_snapshot_id, updated_at = now(); daily_budget = COALESCE(EXCLUDED.daily_budget, existing) carries a stale budget forward. The current row cannot prove its own earlier value, and updated_at is the LAST write, not the knowledge time of any earlier one.",
  },
  {
    source: "meta_adset_daily",
    writeSemantics: "mutable_upsert",
    pitReconstructible: false,
    evidence: "Same writer and same ON CONFLICT shape as meta_campaign_daily.",
  },
  {
    source: "engine_v3_ad_decision_snapshots_daily",
    writeSemantics: "mutable_upsert",
    pitReconstructible: false,
    evidence:
      "lib/creative-decision-engine/jobs/ad-decisions-job.ts INSERT ... ON CONFLICT DO UPDATE SET label, authorized_action, decision_hash, computed_at, updated_at = now(). It is the CURRENT snapshot for a day, not an immutable decision event log.",
  },
  {
    source: "engine_v3_campaign_context_daily",
    writeSemantics: "mutable_upsert",
    pitReconstructible: false,
    evidence: "Recomputed per as_of_date and overwritten; carries updated_at.",
  },
  {
    source: "meta_entity_state_history",
    writeSemantics: "append_only_with_compaction",
    pitReconstructible: false,
    evidence:
      "Rows are append-only, but identical truth is COALESCED: lib/meta/entity-state-history.ts advances the observation run heartbeat instead of writing state rows. Placing a heartbeat on a knowledge-time axis needs run columns this database does not have (see schemaContract), so strict PIT is refused here.",
  },
  {
    source: "meta_campaign_config_history",
    writeSemantics: "append_only_effective_dated",
    pitReconstructible: true,
    evidence: "effective_from/effective_to plus captured_at and created_at; rows are not overwritten in place.",
  },
  {
    source: "meta_adset_config_history",
    writeSemantics: "append_only_effective_dated",
    pitReconstructible: true,
    evidence: "Same shape as meta_campaign_config_history.",
  },
  {
    source: "business_target_pack_history",
    writeSemantics: "append_only_bitemporal",
    pitReconstructible: true,
    evidence: "Carries effective_at AND recorded_at per revision, with an explicit operation column.",
  },
] as const;

// ---------------------------------------------------------------------------
// R2 — canonical decision projection and budget vocabulary
// ---------------------------------------------------------------------------

/**
 * The selection rule the production read model actually uses.
 *
 * `lib/meta/assigned-account-states.ts` takes MAX(as_of_date) per (business,
 * provider_account) and reads the rows at that date. This constant names THAT
 * native-table diagnostic only. The decisions-workspace route does NOT share
 * it: it resolves a served end date from a union of three sources first (see
 * servedDateCandidates), so the two contracts must never be conflated.
 */
export const CANONICAL_DECISION_SELECTION =
  "latest_as_of_date_per_business_provider_account" as const;

/** Typed budget verbs, kept only to prove they cannot exist here. */
export const BUDGET_VERBS = ["scale_budget", "reduce_budget"] as const;

/** The creative vocabulary. A creative verdict is never a budget intent. */
export const CREATIVE_LABELS = [
  "scale", "keep", "refresh", "cut", "test_more", "diagnose", "out_of_scope",
] as const;

export function isBudgetVerb(value: string | null | undefined): boolean {
  return typeof value === "string" && (BUDGET_VERBS as readonly string[]).includes(value);
}

/**
 * A compact, deterministic, identity-preserving membership manifest.
 *
 * A `count(DISTINCT ...)` cannot prove WHICH identities a denominator contains.
 * This sorts the full identity tuple set, hashes it, and keeps the count plus a
 * deterministic boundary sample, so any recomputation over the same identities
 * reproduces the same hash and a reviewer can check membership.
 */
export interface MembershipManifest {
  count: number;
  groupHash: string;
  firstIdentity: string | null;
  lastIdentity: string | null;
}

export function buildMembershipManifest(identities: string[]): MembershipManifest {
  const sorted = [...identities].sort();
  return {
    count: sorted.length,
    groupHash: sha256Canonical(sorted),
    firstIdentity: sorted[0] ?? null,
    lastIdentity: sorted[sorted.length - 1] ?? null,
  };
}

/** The identity tuple bound for every canonical decision row. */
export function decisionIdentity(row: {
  businessId: string | null;
  providerAccountId: string | null;
  asOfDate: string | null;
  engineVersion: string | null;
  decisionEntityId: string | null;
  adId: string | null;
  scopeType: string | null;
  scopeId: string | null;
  inputHash: string | null;
  decisionHash: string | null;
  evaluationId: string | null;
  jobRunId: string | null;
  computedAt: string | null;
}): string {
  return [
    row.businessId, row.providerAccountId, row.asOfDate, row.engineVersion,
    row.decisionEntityId, row.adId, row.scopeType, row.scopeId,
    row.inputHash, row.decisionHash, row.evaluationId, row.jobRunId, row.computedAt,
  ]
    .map((v) => v ?? "")
    .join("|");
}

// ---------------------------------------------------------------------------
// R3 — campaign role authority
// ---------------------------------------------------------------------------

export const ALLOWED_CAMPAIGN_ROLES = ["main", "test", "mixed"] as const;
export const ACCEPTED_CONFIDENCE_CLASSES = ["high", "medium"] as const;

/**
 * Resolver versions accepted as ACTION authority.
 *
 * Deliberately empty. The only resolver present in this database is a
 * `-shadow` generation, and `lib/migrations.ts` records these legacy
 * business-wide normalized rows as migration evidence that is never action
 * authority. Adding a version here is a product decision, not an audit one.
 */
export const SUPPORTED_ROLE_RESOLVER_VERSIONS: readonly string[] = [];

/**
 * How a role row's SOURCE behaves in time. `engine_v3_campaign_context_daily`
 * is a mutable UPSERT, so a row read today describes the CURRENT recomputation
 * of a historical day, not what was known on that day. Such a row may inform a
 * retrospective candidate; it can never become historical action authority,
 * however good its confidence or resolver looks.
 */
export type RoleSourceTemporalStatus = "mutable_current_snapshot" | "immutable_knowledge_time";

export type RoleAuthorityStatus =
  | "authoritative"
  | "blocked_mutable_source_not_pit"
  | "retrospective_role_candidate"
  | "blocked_legacy_business_scope"
  | "blocked_account_scope_mismatch"
  | "blocked_role_unknown_or_conflict"
  | "blocked_unsupported_resolver"
  | "blocked_low_confidence"
  | "blocked_no_pit_row"
  | "blocked_stale";

export interface RoleRow {
  providerAccountId: string | null;
  /** True when updated_at moved past created_at: the row was recomputed. */
  overwrittenAfterInsert?: boolean;
  inferredKind: string | null;
  confidenceClass: string | null;
  confidenceScore: number | null;
  resolverVersion: string | null;
  asOfDate: string;
  recordedAt: string | null;
}

export interface RoleAuthorityVerdict {
  status: RoleAuthorityStatus;
  role: string | null;
  basis: string;
}

/**
 * Decides whether an automatically inferred campaign role may act as authority.
 *
 * Every gate is evaluated on the ROW's own fields. Correction 1 selected these
 * columns and then discarded them, treating any fresh row as available; that is
 * why a fleet of legacy NULL-account rows read as an operational role gate.
 *
 * No manual Test/Main/Mixed label, label table, label API, or name regex is
 * consulted anywhere. The distinction stays system-inferred.
 */
export function resolveRoleAuthorityAtOrigin(input: {
  origin: string;
  expectedProviderAccountId: string;
  staleAfterDays: number;
  /** How the source behaves in time. A mutable snapshot cannot be PIT authority. */
  sourceTemporalStatus: RoleSourceTemporalStatus;
  /**
   * C4.4 — injected seam, defaulting to the product constant (which is empty).
   * Without it the unsupported-resolver gate always fires first and the
   * temporal gate below can never be exercised by a test.
   */
  supportedResolverVersions?: readonly string[];
  rows: RoleRow[];
}): RoleAuthorityVerdict {
  const supportedResolvers = input.supportedResolverVersions ?? SUPPORTED_ROLE_RESOLVER_VERSIONS;
  // Account scope is part of the SELECTION key, not only a later check: a
  // later row for another account must never shadow a valid row for the
  // expected account.
  const visible = input.rows
    .filter((r) => r.providerAccountId === null || r.providerAccountId === input.expectedProviderAccountId)
    .filter((r) => r.asOfDate < input.origin && r.recordedAt !== null && r.recordedAt <= input.origin)
    .sort((a, b) => {
      const byDate = a.asOfDate.localeCompare(b.asOfDate);
      if (byDate !== 0) return byDate;
      return (a.recordedAt ?? "").localeCompare(b.recordedAt ?? "");
    });
  const row = visible[visible.length - 1];
  if (!row) {
    return { status: "blocked_no_pit_row", role: null, basis: "no role row was both effective and recorded before the origin" };
  }
  if (row.providerAccountId === null) {
    return {
      status: "blocked_legacy_business_scope",
      role: null,
      basis: "provider_account_id is NULL: a legacy business-wide normalized row, retained as migration evidence and never action authority",
    };
  }
  if (row.providerAccountId !== input.expectedProviderAccountId) {
    return { status: "blocked_account_scope_mismatch", role: null, basis: "role row belongs to a different provider account" };
  }
  const ageDays = Math.floor(
    (Date.parse(`${input.origin}T00:00:00.000Z`) - Date.parse(`${row.asOfDate}T00:00:00.000Z`)) / 86_400_000,
  );
  if (ageDays > input.staleAfterDays) {
    return { status: "blocked_stale", role: null, basis: `role evidence is ${ageDays} days old at the origin` };
  }
  if (row.inferredKind === null || !(ALLOWED_CAMPAIGN_ROLES as readonly string[]).includes(row.inferredKind)) {
    return { status: "blocked_role_unknown_or_conflict", role: row.inferredKind, basis: "inferred_kind is null or outside main|test|mixed" };
  }
  if (row.confidenceClass === null || !(ACCEPTED_CONFIDENCE_CLASSES as readonly string[]).includes(row.confidenceClass)) {
    return { status: "blocked_low_confidence", role: row.inferredKind, basis: `confidence_class ${row.confidenceClass ?? "null"} is not acceptable for action authority` };
  }
  if (!supportedResolvers.includes(row.resolverVersion ?? "")) {
    return { status: "blocked_unsupported_resolver", role: row.inferredKind, basis: `resolver_version ${row.resolverVersion ?? "null"} is not an accepted action-authority resolver` };
  }
  // Everything above passed. The final gate is temporal: a mutable current
  // snapshot cannot be historical authority even when it looks perfect, and a
  // row already recomputed since insert is definitely not what was known then.
  if (input.sourceTemporalStatus !== "immutable_knowledge_time") {
    return {
      status: "blocked_mutable_source_not_pit",
      role: row.inferredKind,
      basis: "engine_v3_campaign_context_daily is a mutable UPSERT: this row is the CURRENT recomputation of a historical day, not what was known at the origin",
    };
  }
  if (row.overwrittenAfterInsert === true) {
    return {
      status: "retrospective_role_candidate",
      role: row.inferredKind,
      basis: "updated_at moved past created_at, so this row was recomputed after it was first written",
    };
  }
  return { status: "authoritative", role: row.inferredKind, basis: "account-scoped, allowed role, accepted confidence, supported resolver, fresh, immutable knowledge time" };
}

// ---------------------------------------------------------------------------
// C1 — monetary unit contract (unchanged in substance)
// ---------------------------------------------------------------------------

export type UnitScaleStatus = "proven_common" | "unknown_unit_scale";

export interface MonetaryUnitContract {
  status: UnitScaleStatus;
  budgetToSpendDivisor: number | null;
  basis: string;
}

export const FACTUAL_UNIT_CONTRACT: MonetaryUnitContract = {
  status: "unknown_unit_scale",
  budgetToSpendDivisor: null,
  basis:
    "No per-currency exponent source exists in schema or code, and spend/revenue are written by a different ingestion path than budget. raw==stored proves equality only.",
};

export const SENSITIVITY_UNIT_CONTRACTS: readonly MonetaryUnitContract[] = [
  { status: "proven_common", budgetToSpendDivisor: 1, basis: "ASSUMED divisor 1 (budget already in the same unit as spend)." },
  { status: "proven_common", budgetToSpendDivisor: 100, basis: "ASSUMED divisor 100 (budget in minor units, spend in major units)." },
] as const;

export function utilisationUnderContract(input: {
  spend: number;
  budgetCapacity: number;
  contract: MonetaryUnitContract;
}): number | null {
  if (input.contract.status !== "proven_common") return null;
  const divisor = input.contract.budgetToSpendDivisor;
  if (divisor === null || !Number.isFinite(divisor) || divisor <= 0) return null;
  const capacity = input.budgetCapacity / divisor;
  if (!(capacity > 0)) return null;
  return input.spend / capacity;
}

// ---------------------------------------------------------------------------
// R8 — deterministic ownership arbitration
// ---------------------------------------------------------------------------

export interface OwnershipObservation {
  businessId: string;
  providerAccountId: string;
  entityType: string;
  entityId: string | null;
  campaignId: string | null;
  adsetId: string | null;
  budgetOrigin: string | null;
  presence: string | null;
  runCompleteness: string | null;
  endpoint: string | null;
  runId: string | null;
  stateHash: string | null;
  observedAt: string;
  capturedAt: string | null;
  createdAt: string | null;
  id: string | null;
  hasCampaignDaily: boolean;
  hasCampaignLifetime: boolean;
  hasAdsetDaily: boolean;
  hasAdsetLifetime: boolean;
}

export type OwnerStatus =
  | "resolved"
  | "unresolved_no_pit_observation"
  | "unresolved_owner_conflict"
  | "unresolved_same_clock_conflict"
  | "unresolved_not_present"
  | "unresolved_incomplete_run"
  | "unresolved_missing_parent_campaign"
  | "unresolved_schema_contract";

export interface OwnerResolution {
  status: OwnerStatus;
  owner: "campaign" | "adset" | null;
  ownerEntityId: string | null;
  basis: string;
}

/**
 * Deterministic arbitration, matching the proven consumer's tuple:
 * `observed_at DESC, captured_at DESC, created_at DESC, id DESC`.
 * Sorting on `observed_at` alone lets two same-clock competitors resolve in
 * whatever order the database happened to return, which is not a result.
 */
export function pickLatestObservation(
  observations: OwnershipObservation[],
  origin: string,
): { row: OwnershipObservation | null; sameClockConflict: boolean } {
  const visible = observations
    .filter((o) => o.observedAt < origin && o.capturedAt !== null && o.capturedAt <= origin)
    .sort((a, b) => {
      const byObserved = b.observedAt.localeCompare(a.observedAt);
      if (byObserved !== 0) return byObserved;
      const byCaptured = (b.capturedAt ?? "").localeCompare(a.capturedAt ?? "");
      if (byCaptured !== 0) return byCaptured;
      const byCreated = (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      if (byCreated !== 0) return byCreated;
      return (b.id ?? "").localeCompare(a.id ?? "");
    });
  const row = visible[0] ?? null;
  if (!row) return { row: null, sameClockConflict: false };
  // A competitor sharing the entire clock tuple but disagreeing on truth is a
  // conflict, not a tie to be broken by row id.
  const sameClockConflict = visible.some(
    (o) =>
      o !== row &&
      o.observedAt === row.observedAt &&
      o.capturedAt === row.capturedAt &&
      o.createdAt === row.createdAt &&
      (o.stateHash ?? "") !== (row.stateHash ?? ""),
  );
  return { row, sameClockConflict };
}

export function resolveBudgetOwnerAtOrigin(input: {
  origin: string;
  campaignId: string | null;
  adsetId: string | null;
  schemaContract: SchemaContract;
  observations: { campaign: OwnershipObservation[]; adset: OwnershipObservation[] };
}): OwnerResolution {
  // R1: never approximate past a schema-contract mismatch.
  if (input.schemaContract.strictPitOwnerReconstruction !== "available") {
    return {
      status: "unresolved_schema_contract",
      owner: null,
      ownerEntityId: null,
      basis: input.schemaContract.basis,
    };
  }

  const campaignPick = pickLatestObservation(input.observations.campaign, input.origin);
  const adsetPick = pickLatestObservation(input.observations.adset, input.origin);
  if (campaignPick.sameClockConflict || adsetPick.sameClockConflict) {
    return { status: "unresolved_same_clock_conflict", owner: null, ownerEntityId: null, basis: "two observations share the full clock tuple and disagree on state_hash" };
  }
  const campaignRow = campaignPick.row;
  if (!campaignRow) {
    return { status: "unresolved_no_pit_observation", owner: null, ownerEntityId: null, basis: "no campaign observation was both effective and recorded before the origin" };
  }
  if (campaignRow.presence !== "present") {
    return { status: "unresolved_not_present", owner: null, ownerEntityId: null, basis: `presence is ${campaignRow.presence ?? "null"}` };
  }
  if (campaignRow.runCompleteness !== "complete") {
    return { status: "unresolved_incomplete_run", owner: null, ownerEntityId: null, basis: `run_completeness is ${campaignRow.runCompleteness ?? "null"}` };
  }

  const adsetRow = adsetPick.row;
  const adsetUsable = adsetRow !== null && adsetRow.presence === "present" && adsetRow.runCompleteness === "complete";
  const campaignOwns =
    campaignRow.budgetOrigin === "campaign" || campaignRow.hasCampaignDaily || campaignRow.hasCampaignLifetime;
  const adsetOwns =
    adsetUsable && (adsetRow!.budgetOrigin === "adset" || adsetRow!.hasAdsetDaily || adsetRow!.hasAdsetLifetime);

  if (campaignOwns && adsetOwns) {
    return { status: "unresolved_owner_conflict", owner: null, ownerEntityId: null, basis: "the campaign and one of its ad sets both carry a budget at this origin" };
  }
  if (campaignOwns) {
    const ownerEntityId = campaignRow.campaignId ?? input.campaignId;
    if (!ownerEntityId) {
      return { status: "unresolved_missing_parent_campaign", owner: null, ownerEntityId: null, basis: "campaign-level budget observed but no campaign id is linked" };
    }
    return { status: "resolved", owner: "campaign", ownerEntityId, basis: "campaign budget optimisation: the campaign owns the budget" };
  }
  if (adsetOwns) {
    if (!input.campaignId) {
      return { status: "unresolved_missing_parent_campaign", owner: null, ownerEntityId: null, basis: "ad-set budget observed but the row has no parent campaign linkage" };
    }
    return { status: "resolved", owner: "adset", ownerEntityId: adsetRow!.adsetId ?? input.adsetId, basis: "ad-set level budgets: this ad set owns its own budget" };
  }
  if (input.adsetId === null) {
    return { status: "resolved", owner: "adset", ownerEntityId: null, basis: "the campaign carries no budget, so ownership sits at ad-set level" };
  }
  return { status: "unresolved_no_pit_observation", owner: null, ownerEntityId: null, basis: "neither the campaign nor this ad set carries an observed budget at this origin" };
}

// ---------------------------------------------------------------------------
// C5 — cutoff-safe commercial anchor
// ---------------------------------------------------------------------------

export interface TargetPackRevision {
  effectiveAt: string;
  recordedAt: string | null;
  operation: string | null;
  targetRoas: number | null;
  breakEvenRoas: number | null;
}

export type AnchorStatus = "resolved" | "no_revision_before_origin" | "revision_missing_roas_anchors";

export interface AnchorResolution {
  status: AnchorStatus;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  effectiveAt: string | null;
  recordedAt: string | null;
}

export function resolveAnchorAtOrigin(input: {
  origin: string;
  revisions: TargetPackRevision[];
}): AnchorResolution {
  const visible = input.revisions
    .filter((r) => r.effectiveAt <= input.origin && r.recordedAt !== null && r.recordedAt <= input.origin)
    .sort((a, b) => {
      const byEffective = a.effectiveAt.localeCompare(b.effectiveAt);
      if (byEffective !== 0) return byEffective;
      return (a.recordedAt ?? "").localeCompare(b.recordedAt ?? "");
    });
  const current = visible[visible.length - 1];
  if (!current || current.operation === "delete") {
    return { status: "no_revision_before_origin", targetRoas: null, breakEvenRoas: null, effectiveAt: null, recordedAt: null };
  }
  if (current.targetRoas === null || current.breakEvenRoas === null) {
    return { status: "revision_missing_roas_anchors", targetRoas: current.targetRoas, breakEvenRoas: current.breakEvenRoas, effectiveAt: current.effectiveAt, recordedAt: current.recordedAt };
  }
  return { status: "resolved", targetRoas: current.targetRoas, breakEvenRoas: current.breakEvenRoas, effectiveAt: current.effectiveAt, recordedAt: current.recordedAt };
}

// ---------------------------------------------------------------------------
// R6 — config-change quality
// ---------------------------------------------------------------------------

/**
 * The semantic class of one entity's budget configuration at one effective day.
 *
 * `both_fields_present` is DELIBERATELY not resolved. 2,376 grouped ad-set
 * states in the previous package carried a non-null daily AND lifetime budget,
 * and the old classifier silently picked `daily` for all of them. Until the
 * provider endpoint/field contract proves which field is authoritative when
 * both are set, that state is unresolved and may never be coerced.
 */
export type BudgetStateClass =
  | "daily_only"
  | "lifetime_only"
  | "both_fields_present"
  | "neither"
  | "mixed"
  | "conflicting_capture";

/** A state class that can seed a comparable transition. */
export const RESOLVED_STATE_CLASSES = ["daily_only", "lifetime_only"] as const;

export function isResolvedStateClass(value: string | null | undefined): boolean {
  return typeof value === "string" && (RESOLVED_STATE_CLASSES as readonly string[]).includes(value);
}

export interface BudgetConfigState {
  businessId: string;
  providerAccountId: string;
  grain: "campaign" | "adset";
  entityId: string;
  effectiveFrom: string;
  /** Deterministic winner's clocks and identity within the effective day. */
  capturedAt: string | null;
  createdAt: string | null;
  id: string | null;
  configFingerprint: string | null;
  stateClass: BudgetStateClass;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  rawCaptures: number;
  distinctFingerprints: number;
}

/** Account and grain are part of the key: two accounts can reuse an id. */
export function configStateKey(state: {
  businessId: string;
  providerAccountId: string;
  grain: string;
  entityId: string;
}): string {
  return `${state.businessId}|${state.providerAccountId}|${state.grain}|${state.entityId}`;
}

/** Deterministic within-day ordering: (effective_from, captured_at, id). */
export function compareConfigStates(a: BudgetConfigState, b: BudgetConfigState): number {
  const byEffective = a.effectiveFrom.localeCompare(b.effectiveFrom);
  if (byEffective !== 0) return byEffective;
  const byCaptured = (a.capturedAt ?? "").localeCompare(b.capturedAt ?? "");
  if (byCaptured !== 0) return byCaptured;
  return (a.id ?? "").localeCompare(b.id ?? "");
}

/**
 * C3.3 — which layer a capture belongs to.
 *
 * `knowledgeBound` is the binding cutoff for the point-in-time layer and null
 * for the retrospective layer. A row effective before the cutoff but RECORDED
 * after it is finalized evidence, not evidence available at the cutoff.
 */
export function isKnowledgeTimeVisible(
  capturedAt: string | null,
  knowledgeBound: string | null,
): boolean {
  if (knowledgeBound === null) return true;
  if (capturedAt === null) return false;
  return capturedAt.slice(0, 10) <= knowledgeBound;
}

export type BudgetTransitionClass =
  | "initial_observation"
  | "true_change"
  | "unchanged"
  | "budget_kind_change"
  | "unresolved_prior_state"
  | "unresolved_next_state";

/**
 * Classifies one transition between two deterministically ordered states.
 *
 * A transition is `true_change` only when BOTH sides are individually resolved
 * and single-kind. An unresolved prior state — mixed, conflicting, dual-field,
 * or empty — produces its own class and can seed neither `true_change` nor
 * `unchanged`; the previous model let 51 dual-field pairs and 7 conflicted
 * baselines flow straight into the headline count.
 */
export function classifyBudgetTransition(
  previous: BudgetConfigState | null,
  next: BudgetConfigState,
): BudgetTransitionClass {
  if (!previous) return "initial_observation";
  if (!isResolvedStateClass(previous.stateClass)) return "unresolved_prior_state";
  if (!isResolvedStateClass(next.stateClass)) return "unresolved_next_state";
  if (previous.stateClass !== next.stateClass) return "budget_kind_change";
  const value = (state: BudgetConfigState) =>
    state.stateClass === "daily_only" ? state.dailyBudget : state.lifetimeBudget;
  return value(previous) === value(next) ? "unchanged" : "true_change";
}

/** Identity of one transition, for the membership manifest. */
export function transitionIdentity(
  previous: BudgetConfigState | null,
  next: BudgetConfigState,
): string {
  return [
    next.businessId, next.providerAccountId, next.grain, next.entityId,
    previous?.effectiveFrom ?? "", previous?.configFingerprint ?? "", previous?.id ?? "",
    next.effectiveFrom, next.configFingerprint ?? "", next.id ?? "",
  ].join("|");
}

// ---------------------------------------------------------------------------
// Retrospective counterfactual policy — declared HYPOTHESES
// ---------------------------------------------------------------------------

/**
 * Every value below is a HYPOTHESIS used to probe the evidence. None is an
 * approved setting, a product default, or a recommendation. A retrospective
 * replay over finalized facts establishes NO causal lift and no safe budget
 * step percentage.
 */
export const REPLAY_LOOKBACK_DAYS = [7, 14, 28, 56] as const;
export const REPLAY_BINDING_UTILISATION = 0.85;
export const REPLAY_MIN_CONVERSIONS = 5;
export const REPLAY_STALE_AFTER_DAYS = 3;

export interface ReplayPoint {
  effectiveDate: string;
  status: string | null;
  currency: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  isBudgetMixed: boolean;
  spend: number | null;
  conversions: number | null;
  revenue: number | null;
  truthState: string | null;
}

export type ReplayOutcome =
  | "not_pit_reconstructible"
  | "blocked_owner_schema_contract"
  | "blocked_owner_unresolved"
  | "blocked_not_budget_owner"
  | "blocked_lifetime_budget_unsupported"
  | "blocked_ownership_conflict"
  | "blocked_inactive_entity"
  | "blocked_stale_series"
  | "blocked_insufficient_history"
  | "blocked_campaign_role_unavailable"
  | "blocked_no_commercial_anchor"
  | "blocked_unknown_unit_scale"
  | "blocked_not_binding"
  | "blocked_low_conversions"
  | "candidate_increase"
  | "candidate_decrease"
  | "no_action";

export interface ReplayVerdict {
  outcome: ReplayOutcome;
  utilisation: number | null;
  roas: number | null;
  currentBudget: number | null;
  windowDays: number;
  unitContractStatus: UnitScaleStatus;
}

/**
 * Evaluates one owner entity at one origin over CURRENT FINALIZED facts.
 *
 * This is deliberately NOT named a point-in-time evaluation. The daily tables
 * are mutable UPSERTs, so their present values cannot prove what was known at
 * an earlier origin; the outcomes below describe a retrospective finalized
 * counterfactual, and `candidate_*` is a candidate under a hypothesis, never an
 * offer the system would have made.
 */
export function evaluateEntityAtOrigin(input: {
  origin: string;
  lookbackDays: number;
  points: ReplayPoint[];
  contract: MonetaryUnitContract;
  ownership: OwnerResolution;
  isBudgetOwner: boolean;
  anchor: AnchorResolution;
  roleAuthority: RoleAuthorityVerdict;
}): ReplayVerdict {
  const base = {
    utilisation: null,
    roas: null,
    currentBudget: null,
    windowDays: input.lookbackDays,
    unitContractStatus: input.contract.status,
  } as const;

  const visible = input.points
    .filter((p) => p.effectiveDate < input.origin)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  if (visible.length === 0) return { ...base, outcome: "not_pit_reconstructible" };

  if (input.ownership.status !== "resolved") {
    // Each refusal keeps its own reason: a schema-contract refusal is a
    // different fact from a missing observation, and collapsing them would
    // hide why the reconstruction was impossible.
    if (input.ownership.status === "unresolved_schema_contract") {
      return { ...base, outcome: "blocked_owner_schema_contract" };
    }
    return {
      ...base,
      outcome:
        input.ownership.status === "unresolved_owner_conflict" ||
        input.ownership.status === "unresolved_same_clock_conflict"
          ? "blocked_ownership_conflict"
          : "blocked_owner_unresolved",
    };
  }
  if (!input.isBudgetOwner) return { ...base, outcome: "blocked_not_budget_owner" };

  const latest = visible[visible.length - 1]!;
  if (latest.isBudgetMixed) return { ...base, outcome: "blocked_ownership_conflict" };
  if (latest.dailyBudget !== null && latest.lifetimeBudget !== null) return { ...base, outcome: "blocked_ownership_conflict" };
  if (latest.dailyBudget === null && latest.lifetimeBudget !== null) return { ...base, outcome: "blocked_lifetime_budget_unsupported" };
  const currentBudget = latest.dailyBudget;
  if (currentBudget === null) return { ...base, outcome: "blocked_owner_unresolved" };
  const withBudget = { ...base, currentBudget };

  if ((latest.status ?? "").toUpperCase() !== "ACTIVE") return { ...withBudget, outcome: "blocked_inactive_entity" };

  const originMs = Date.parse(`${input.origin}T00:00:00.000Z`);
  const staleDays = Math.floor((originMs - Date.parse(`${latest.effectiveDate}T00:00:00.000Z`)) / 86_400_000);
  if (staleDays > REPLAY_STALE_AFTER_DAYS) return { ...withBudget, outcome: "blocked_stale_series" };

  const windowStartMs = originMs - input.lookbackDays * 86_400_000;
  const window = visible.filter((p) => Date.parse(`${p.effectiveDate}T00:00:00.000Z`) >= windowStartMs);
  if (window.length < input.lookbackDays) return { ...withBudget, outcome: "blocked_insufficient_history" };

  if (input.roleAuthority.status !== "authoritative") return { ...withBudget, outcome: "blocked_campaign_role_unavailable" };
  if (input.anchor.status !== "resolved") return { ...withBudget, outcome: "blocked_no_commercial_anchor" };

  const spend = window.reduce((s, p) => s + (p.spend ?? 0), 0);
  const revenue = window.reduce((s, p) => s + (p.revenue ?? 0), 0);
  const conversions = window.reduce((s, p) => s + (p.conversions ?? 0), 0);
  const roas = spend > 0 ? revenue / spend : null;

  const budgetDays = window.filter((p) => p.dailyBudget !== null).length;
  const capacity = window.reduce((s, p) => s + (p.dailyBudget ?? 0), 0);
  const utilisation =
    budgetDays === window.length
      ? utilisationUnderContract({ spend, budgetCapacity: capacity, contract: input.contract })
      : null;
  if (utilisation === null) {
    return {
      ...withBudget,
      roas,
      outcome: input.contract.status === "proven_common" ? "blocked_owner_unresolved" : "blocked_unknown_unit_scale",
    };
  }

  const resolved = { ...withBudget, roas, utilisation };
  if (roas !== null && roas < input.anchor.breakEvenRoas!) return { ...resolved, outcome: "candidate_decrease" };
  if (utilisation < REPLAY_BINDING_UTILISATION) return { ...resolved, outcome: "blocked_not_binding" };
  if (conversions < REPLAY_MIN_CONVERSIONS) return { ...resolved, outcome: "blocked_low_conversions" };
  if (roas !== null && roas >= input.anchor.targetRoas!) return { ...resolved, outcome: "candidate_increase" };
  return { ...resolved, outcome: "no_action" };
}

// ---------------------------------------------------------------------------
// Artifact hashing and invariants
// ---------------------------------------------------------------------------

const HASH_META_KEYS = new Set(["sectionHashes", "artifactHash"]);

export const D080_CAPABILITY_MATRIX = {
  budgetWritePath: {
    status: "absent",
    evidence:
      "lib/meta/ads-write.ts owns every entity-level POST and contains the string 'budget' zero times. daily_budget/lifetime_budget appear only in lib/meta/launch-write.ts:475-476 and :524-525, inside creation bodies POSTed to collection endpoints. No budget field reaches POST /{campaignId} or POST /{adsetId} anywhere in non-archive, non-test code.",
  },
  nearestPrecedent: {
    status: "present_but_unsafe_to_copy",
    evidence:
      "lib/meta/entity-action-routes.ts:812-830 writes an ad-set bid change as action='launch_adset' with the adset id in the ad_id column and the amount in payload_request.",
  },
  actionLogGrain: {
    status: "ad_only",
    evidence:
      "meta_ads_action_log.ad_id is TEXT NOT NULL with no entity-grain discriminator; the action CHECK admits only pause/resume/duplicate/launch_campaign/launch_adset/launch_ad.",
  },
  reconciliationPath: {
    status: "structurally_unavailable_for_budgets",
    evidence:
      "meta_ads_action_mutation_attempt_events and meta_ads_action_reconciliation_events both require creative_id NOT NULL and action IN ('pause','resume'); the geometry compares ACTIVE/PAUSED statuses with no representation for an observed amount.",
  },
  manualIdempotency: {
    status: "absent",
    evidence:
      "the only idempotency index on meta_ads_action_log is partial: WHERE source='decision_origin'. Manual operator writes are excluded.",
  },
  decisionVocabulary: {
    status: "creative_only_and_ad_grain_only",
    evidence:
      "engine_v3_ad_decision_snapshots_daily constrains decision_entity_type to 'ad', label to scale|keep|refresh|cut|test_more|diagnose|out_of_scope, and authorized_action/blocked_action_type to scale|cut|refresh.",
  },
  currencyExponent: {
    status: "absent",
    evidence:
      "no per-currency exponent source exists in schema or code. Zero-decimal (JPY/KRW) and three-decimal (KWD/BHD) currencies would be wrong by 100x and 1000x.",
  },
  graphApiVersions: {
    countingScope:
      "git grep over tracked files, excluding lib/archive/** and all test/spec files; a hit is a version literal adjacent to graph.facebook.com or on a line naming GRAPH*VERSION / API_VERSION.",
    productionCounts: { "v25.0": 44, "v22.0": 3, "v21.0": 2, "v19.0": 1 },
    productionFiles: 20,
    withdrawnClaim:
      "The Correction 1 figure of '~70 inline v25.0 literals' is WITHDRAWN: it matches no principled scope. The production figure is 44.",
    writePaths: [
      "lib/meta/ads-write.ts:240 — GRAPH_API_VERSION = 'v22.0'",
      "lib/meta/launch-write.ts:12 — GRAPH_API_VERSION = 'v22.0'",
    ],
    reclassified:
      "lib/launchpad/meta-validation.ts:19 was listed as a write path in Correction 1. It is a READ path (method GET at :227). Reclassified.",
    oauth: [
      "lib/oauth/meta-config.ts:26-28 — three v21.0 literals",
      "app/api/oauth/sign-with-facebook/start/route.ts:39 — www.facebook.com/v19.0",
      "app/api/oauth/sign-with-facebook/callback/route.ts:92 — graph.facebook.com/v19.0",
      "app/api/oauth/sign-with-facebook/callback/route.ts:115 — UNVERSIONED graph.facebook.com/me",
    ],
    sdk: "absent — zero matches for facebook-nodejs-business-sdk in package.json and both lockfiles. SDK release notes are therefore not evidence about this codebase's Graph contract.",
    /**
     * C3.10 — every external claim carries an inspectable receipt.
     *
     * A blanket "VERIFIED" hid the fact that no Meta page could be byte-verified:
     * developers.facebook.com answers direct curl with an HTTP 400 bot shell, so
     * every Meta fact reached us through a rendering fetcher. The status now
     * carries that limitation instead of a prose footnote.
     */
    receiptStatusMeanings: {
      primary_render_verified_not_byte_verified:
        "The official first-party page was retrieved through a rendering fetcher and states the claim. Raw bytes could not be obtained, so this is not byte-level confirmation.",
      official_sdk_release_verified:
        "Supported by the Meta-owned SDK release notes. This is evidence about the SDK, NOT about the Graph API contract, and this repo has no SDK dependency.",
      unverified:
        "No primary source was captured. The claim is not asserted.",
    },
    primarySourceVerification: [
      {
        claim: "Graph v24.0 raises daily budget flexibility from 25% to 75%.",
        url: "https://developers.facebook.com/docs/graph-api/changelog/version24.0",
        retrievedAt: "2026-08-31", retrievedAtPrecision: "date_only",
        method: "rendering_fetcher (direct curl returns HTTP 400 bot shell)",
        excerpt: "flexibility \u201cincreasing from 25% to 75%\u201d (Budgeting section)",
        status: "primary_render_verified_not_byte_verified",
        alsoSupportedBy: "official_sdk_release_verified (SDK v24.0.0 notes)",
      },
      {
        claim: "Graph v24.0 makes is_adset_budget_sharing_enabled required when setting an ad-set-level budget.",
        url: "https://developers.facebook.com/docs/graph-api/changelog/version24.0",
        retrievedAt: "2026-08-31", retrievedAtPrecision: "date_only",
        method: "rendering_fetcher, re-queried with an explicit not-present escape that was not taken",
        excerpt: "field \u201cis now required if you are planning to set a budget at the ad set level\u201d (Budgeting section)",
        status: "primary_render_verified_not_byte_verified",
        sdkNote: "The SDK release notes do NOT contain this requirement; they are not evidence for it and were not used.",
      },
      {
        claim: "Graph v25.0 restricts Advantage+ shopping/app create, duplicate and update, extending to all versions by 2026-05-19.",
        url: "https://developers.facebook.com/docs/graph-api/changelog/version25.0",
        retrievedAt: "2026-08-31", retrievedAtPrecision: "date_only",
        method: "rendering_fetcher",
        excerpt: "restriction plus \u201cWill apply to all versions May 19, 2026\u201d",
        status: "primary_render_verified_not_byte_verified",
        alsoSupportedBy: "official_sdk_release_verified (SDK v25.0.0 notes carry the ASC/AAC timing)",
      },
      {
        claim: "Graph v26.0 was released 2026-07-29.",
        url: "https://developers.facebook.com/docs/graph-api/changelog",
        retrievedAt: "2026-08-31", retrievedAtPrecision: "date_only",
        method: "rendering_fetcher",
        excerpt: "v26.0 released July 29, 2026",
        status: "primary_render_verified_not_byte_verified",
        sdkNote: "SDK v26.0.0 was published 2026-08-06 and states only that it follows Graph v26; it does NOT establish the Graph release date and was not used for it.",
      },
      {
        claim: "Graph v22.0 expires 2027-05-20; v21.0 expires 2027-01-21; v19.0 expired 2026-05-21.",
        url: "https://developers.facebook.com/docs/graph-api/changelog",
        retrievedAt: "2026-08-31", retrievedAtPrecision: "date_only",
        method: "rendering_fetcher",
        excerpt: "version table rows for v22.0, v21.0 and v19.0",
        status: "primary_render_verified_not_byte_verified",
      },
      {
        claim: "The campaign vs ad-set budget endpoint, field, body and amount contract.",
        url: "https://www.postman.com/meta/facebook-marketing-api/request/mjscwl2/updating-campaign-details-l3",
        retrievedAt: "2026-08-31", retrievedAtPrecision: "date_only",
        method: "curl (HTTP 200) and rendering fetcher",
        excerpt: "client-rendered SPA shell; zero occurrences of daily_budget in the response body",
        status: "unverified",
        consequence: "Not asserted. Gate G1 must establish this contract empirically before any budget POST.",
      },
    ],
    retrievalCaveat:
      "developers.facebook.com returns HTTP 400 to direct curl (bot-detection shell), so no Meta page could be byte-verified and no source capture is archived. This limitation is carried in each receipt's status, not only here.",
    retrievalTimestampCaveat:
      "retrievedAt is DATE-ONLY (retrievedAtPrecision: 'date_only'). The exact retrieval instants were not captured, and an earlier precise time is not invented to look better than the record.",
    urgentFindingOutOfScope:
      "app/api/oauth/sign-with-facebook/* is pinned to v19.0, which EXPIRED 2026-05-21, and contains one unversioned Graph call. Reported, not changed.",
  },
} as const;

export const D080B_CONTRACT = {
  recommendation: "new_typed_generic_execution_ledger",
  rejectedAlternative: "additive_extension_of_meta_ads_action_log",
  whyRejected:
    "ad_id NOT NULL survives any additive extension; the terminalization trigger enumerates its mutable columns by name; the reconciliation family cannot accept the row; and a widened action CHECK cannot be narrowed once budget rows exist.",
  ledgerRecommendationAfterCorrection2:
    "The recommendation stands, on a stronger basis. Correction 1 rested on the reconciliation family being unable to accept the row, which remains true. Correction 2 adds that the decision vocabulary is creative-only and ad-grain-only, so no typed path for a campaign- or ad-set-grain budget intent exists anywhere in the decision system, not merely in the action log.",
  columnSemantics: {
    amount: "amount_minor BIGINT NOT NULL CHECK (amount_minor > 0)",
    priorAmount: "prior_amount_minor BIGINT NOT NULL — required for rollback",
    currency: "currency TEXT NOT NULL, from the verified account profile only, never the client",
    field: "field TEXT NOT NULL CHECK (field IN ('daily_budget','lifetime_budget'))",
    owner: "entity_type and budget_owner both CHECK IN ('campaign','adset') plus CHECK (budget_owner = entity_type)",
    approvalHash: "approval_preview_hash CHAR(64) NOT NULL, recomputed at dispatch; a mismatch aborts before the POST",
    idempotency: "UNIQUE (business_id, provider_account_id, entity_type, entity_id, field, idempotency_key) — total, not partial",
  },
  automationProposalsUntouched:
    "meta_automation_proposals is NOT widened in slice 1. Adding 'budget' without changing isExecutable would create a proposal that can be raised and approved but never executed.",
  rollbackPlan: {
    beforeAnyUse:
      "While no row has been written and no route reads the tables, rollback is DROP TABLE x3 plus DROP FUNCTION xN, with no effect on any existing reader.",
    afterUse:
      "CORRECTED: once written to, rollback is NOT zero-impact and DROP is not the procedure. It requires, in order: disable the write route; drain and settle every in-flight attempt so no provider mutation is left unreconciled; stop every reader extended by UNION; and RETAIN the audit history, because a budget change that reached the provider must remain auditable after the feature is withdrawn. Dropping a used ledger destroys the record of live money movements.",
  },
  blockers: [
    "Strict point-in-time owner reconstruction is unavailable on this schema, so a budget write cannot prove which node owned the money at a historical origin.",
    "The monetary unit contract is unproven and no per-currency exponent source exists.",
    "There is no reconciliation path a budget write could settle through.",
    "Manual writes have no idempotency key.",
    "Campaign role has no account-scoped action authority in this data.",
    "The campaign-vs-ad-set budget endpoint contract is unverified from a primary reference.",
  ],
} as const;

export const D080_CORRECTION_LEDGER = [
  { id: "R1", withdrawn: "That ownership recording 'stopped writing 4-59 days before performance ended', and that distinct state-row days are a hard ceiling on ownership observability.", correction: "State rows are change/checkpoint payloads; identical truth advances the observation-run heartbeat instead. Observation was CONFIRMED through 2026-08-21/22 for every pinned account, with repeat counts up to 280. Four concepts are now separated, and the connected schema's missing run columns make strict PIT a refusal, not an approximation." },
  { id: "R2", withdrawn: "That the replay was bound to canonical decisions, and the 316,200-row denominator.", correction: "Canonical is the LATEST generation per (business, provider_account) — the projection the read model serves: 8,237 rows, identity-bound by a membership manifest hash. The old figure summed five overlapping engine versions across every day. The budget-verb census now uses the full population (307,963) as denominator with typed verbs as FILTERs." },
  { id: "R3", withdrawn: "That an automatic campaign-role gate was operationally available.", correction: "Every historical role row has provider_account_id NULL — a legacy business-wide row migrations record as never action authority — from a shadow resolver. The gate now evaluates account scope, role value, confidence, resolver and freshness, failing closed with distinct blockers. No manual label is read." },
  { id: "R4", withdrawn: "That C3 made the replay genuinely bitemporal.", correction: "Four sources are mutable UPSERTs whose current values overwrite what an earlier origin needs. Strict PIT and retrospective-finalized counterfactual are now separate layers with separate denominators." },
  { id: "R5", withdrawn: "The business-level clocks and the declared-but-unenforced 2026-08-10 cutoff.", correction: "Clocks and cutoffs are per pinned binding; every extract query is two-sided; and a verify-time invariant scans every row for pinned membership and cutoff compliance." },
  { id: "R6", withdrawn: "The campaign-only budget-change count that was presented as a six-business total.", correction: "Campaign and ad-set config history are now read separately per pinned binding, in two knowledge-time layers, with counts aggregated in SQL. Run-dependent totals are NOT restated here: they live in analysis.configChangeQuality, and claimability is derived from the read ledger. See D080_LEDGER_DERIVED_KEYS." },
  { id: "R7", withdrawn: "That the script sets no environment value.", correction: "False: the runtime loader populates process.env. The module now has no top-level side effect, and the enforced invariant is that execution authority is never granted or masked." },
  { id: "R8", withdrawn: "The nondeterministic ownership arbitration.", correction: "Arbitration uses the proven (observed_at, captured_at, created_at, id) tuple with explicit same-clock conflict detection, carrying presence, completeness, endpoint, run id and state hash, keyed by provider account." },
  { id: "R9", withdrawn: "The '~70 inline v25.0 literals' count and the write-path classification of lib/launchpad/meta-validation.ts.", correction: "The production count is 44 under a stated scope; meta-validation.ts is a read path. The is_adset_budget_sharing_enabled requirement and the v26.0 release date were re-verified against the Graph changelog and RETAINED. The Postman endpoint contract stays unverified." },
  { id: "R10", withdrawn: "Nothing is preserved by retaining false evidence.", correction: "The verdict was recomputed and remains NO-GO on corrected grounds: strict PIT owner reconstruction is unavailable on this schema, the decision vocabulary cannot express a budget intent, role authority is not account-scoped, and the endpoint contract is unverified." },
] as const;

/**
 * C3.1 — where run-dependent correction facts must be read from.
 *
 * The previous package hard-coded "54 true changes ... no total claimable" into
 * the static ledger while the analysis said 63 and claimable. A static ledger
 * may describe WHAT changed; it may never restate a count. Anything listed here
 * is derived from the sealed analysis at read time, and a test fails if the
 * ledger text reintroduces a digit.
 */
export const D080_LEDGER_DERIVED_KEYS = [
  "analysis.configChangeQuality.pointInTime",
  "analysis.configChangeQuality.retrospective",
  "analysis.configChangeQuality.cleanTrueChangeByLayerAndGrain",
  "analysis.configChangeQuality.totalClaimable",
  "analysis.configChangeQuality.unknownCells",
] as const;

/** Ledger entries whose text must stay count-free. */
export const COUNT_FREE_LEDGER_IDS = ["R6"] as const;

export const D080_DERIVED_SECTIONS = [
  "analysis",
  "invocationResults",
  "correctionLedger",
  "capabilityMatrix",
  "d080bContract",
] as const;

export function computeSectionHashes(artifact: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(artifact)
      .filter((k) => !HASH_META_KEYS.has(k))
      .sort()
      .map((k) => [k, sha256Canonical(artifact[k])]),
  );
}

export function sealArtifact(artifact: Record<string, unknown>): Record<string, unknown> {
  const body = Object.fromEntries(Object.entries(artifact).filter(([k]) => !HASH_META_KEYS.has(k)));
  const sectionHashes = computeSectionHashes(body);
  return { ...body, sectionHashes, artifactHash: sha256Canonical(sectionHashes) };
}

/** A columnar table: identity-preserving, but without repeating key names. */
export interface ColumnarTable {
  columns: string[];
  rows: unknown[][];
}

export function toColumnar(rows: Row[], columns: string[]): ColumnarTable {
  return { columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)) };
}

export function fromColumnar(table: ColumnarTable): Row[] {
  return table.rows.map((values) =>
    Object.fromEntries(table.columns.map((c, i) => [c, values[i] ?? null])),
  );
}

// ---------------------------------------------------------------------------
// C4.2 — executed read plan (distinct from the SQL template manifest)
// ---------------------------------------------------------------------------

export type PlanCardinality = "once" | "per_binding" | "per_binding_grain" | "per_business";

export interface ReadPlanEntry {
  /** The SQL template this invocation shapes and runs. */
  template: keyof typeof D080_QUERIES;
  cardinality: PlanCardinality;
  scope: QueryScope;
  /** PIT status of THIS invocation, not of the template. */
  pitStatus: QueryPitStatus;
  /** Knowledge bound actually passed by this invocation. */
  knowledgeBounds: BoundKind;
  grain?: "campaign" | "adset";
  source?: string;
  why?: string;
}

/**
 * One entry per ledger query name that the extract actually issues.
 *
 * The template manifest describes SQL; this describes INVOCATIONS. The
 * previous package had a single `configSemanticStates` template entry marked
 * `pit_safe`, while the extract ran it twice — once with the cutoff as the
 * knowledge bound and once with NULL. One of those runs is retrospective, and
 * a template-level label could not say so.
 */
export const D080_READ_PLAN: Record<string, ReadPlanEntry> = {
  runSchema: { template: "runSchema", cardinality: "once", scope: "none", pitStatus: "not_applicable", knowledgeBounds: "none" },
  decisionVocabulary: { template: "decisionVocabulary", cardinality: "once", scope: "none", pitStatus: "not_applicable", knowledgeBounds: "none" },
  bindings: { template: "bindings", cardinality: "once", scope: "business", pitStatus: "current_state", knowledgeBounds: "none" },
  clockCampaignDaily: { template: "clockCampaignDaily", cardinality: "per_binding", scope: "binding", pitStatus: "current_state", knowledgeBounds: "none", grain: "campaign", source: "meta_campaign_daily" },
  clockAdsetDaily: { template: "clockAdsetDaily", cardinality: "per_binding", scope: "binding", pitStatus: "current_state", knowledgeBounds: "none", grain: "adset", source: "meta_adset_daily" },
  clockCampaignConfig: { template: "clockCampaignConfig", cardinality: "per_binding", scope: "binding", pitStatus: "current_state", knowledgeBounds: "none", grain: "campaign", source: "meta_campaign_config_history" },
  clockAdsetConfig: { template: "clockAdsetConfig", cardinality: "per_binding", scope: "binding", pitStatus: "current_state", knowledgeBounds: "none", grain: "adset", source: "meta_adset_config_history", why: "lower-bounded at a fixed floor to stay inside the statement timeout, so its earliest value is the floor, NOT the source's unbounded minimum." },
  observationCoverage: { template: "observationCoverage", cardinality: "per_binding_grain", scope: "binding", pitStatus: "current_state", knowledgeBounds: "none" },
  stateChangeDensity: { template: "stateChangeDensity", cardinality: "per_binding_grain", scope: "binding", pitStatus: "retrospective", knowledgeBounds: "none" },
  ownershipAggregate: { template: "ownershipAggregate", cardinality: "per_binding_grain", scope: "binding", pitStatus: "retrospective", knowledgeBounds: "none" },
  ownershipSameClockConflicts: { template: "ownershipSameClockConflicts", cardinality: "per_binding_grain", scope: "binding", pitStatus: "retrospective", knowledgeBounds: "none" },
  ownershipObservations: { template: "ownershipObservations", cardinality: "per_binding", scope: "binding", pitStatus: "pit_safe", knowledgeBounds: "upper_only" },
  seriesCampaign: { template: "seriesCampaign", cardinality: "per_binding", scope: "binding", pitStatus: "retrospective", knowledgeBounds: "none", grain: "campaign" },
  seriesAdset: { template: "seriesAdset", cardinality: "per_binding", scope: "binding", pitStatus: "retrospective", knowledgeBounds: "none", grain: "adset" },
  unitEvidenceCampaignDaily: { template: "unitEvidenceCampaignDaily", cardinality: "per_binding", scope: "binding", pitStatus: "retrospective", knowledgeBounds: "none", grain: "campaign" },
  unitEvidenceCampaignLifetime: { template: "unitEvidenceCampaignLifetime", cardinality: "per_binding", scope: "binding", pitStatus: "retrospective", knowledgeBounds: "none", grain: "campaign" },
  unitEvidenceAdsetDaily: { template: "unitEvidenceAdsetDaily", cardinality: "per_binding", scope: "binding", pitStatus: "retrospective", knowledgeBounds: "none", grain: "adset" },
  unitEvidenceAdsetLifetime: { template: "unitEvidenceAdsetLifetime", cardinality: "per_binding", scope: "binding", pitStatus: "retrospective", knowledgeBounds: "none", grain: "adset" },
  "configSemanticStates:pointInTime": { template: "configSemanticStates", cardinality: "per_binding_grain", scope: "binding", pitStatus: "pit_safe", knowledgeBounds: "upper_only", why: "invoked with the binding cutoff as the knowledge bound." },
  "configSemanticStates:retrospective": { template: "configSemanticStates", cardinality: "per_binding_grain", scope: "binding", pitStatus: "retrospective", knowledgeBounds: "none", why: "invoked with a NULL knowledge bound, so it admits capture recorded after the cutoff. NOT point-in-time." },
  configTransitionIdentities: { template: "configTransitionIdentities", cardinality: "per_binding_grain", scope: "binding", pitStatus: "pit_safe", knowledgeBounds: "upper_only" },
  servedDateCandidates: { template: "servedDateCandidates", cardinality: "per_binding", scope: "binding", pitStatus: "current_state", knowledgeBounds: "none" },
  canonicalLatestAsOf: { template: "canonicalLatestAsOf", cardinality: "per_binding", scope: "binding", pitStatus: "current_state", knowledgeBounds: "none" },
  canonicalIdentities: { template: "canonicalIdentities", cardinality: "per_binding", scope: "binding", pitStatus: "current_state", knowledgeBounds: "none" },
  budgetVerbCensus: { template: "budgetVerbCensus", cardinality: "per_binding", scope: "binding", pitStatus: "retrospective", knowledgeBounds: "none" },
  engineVersionOverlap: { template: "engineVersionOverlap", cardinality: "per_binding", scope: "binding", pitStatus: "retrospective", knowledgeBounds: "none" },
  campaignRole: { template: "campaignRole", cardinality: "per_business", scope: "business", pitStatus: "retrospective", knowledgeBounds: "none" },
  campaignRoleCensus: { template: "campaignRoleCensus", cardinality: "per_business", scope: "business", pitStatus: "current_state", knowledgeBounds: "none" },
  targetPackHistory: { template: "targetPackHistory", cardinality: "once", scope: "business", pitStatus: "pit_safe", knowledgeBounds: "none", why: "the whole revision history is read once; BOTH bitemporal bounds are applied per origin in resolveAnchorAtOrigin, in code rather than SQL." },
};

/**
 * C5.2 — an EXACT expected invocation set.
 *
 * 28 SQL templates, 29 plan definitions, and — for the fixed current scope of
 * seven bindings, six businesses and two grains — exactly 226 expected
 * execution instances. Correction 4 only checked that each of the 29 plan keys
 * appeared at least once, so collapsing 226 real reads to 29 arbitrary rows
 * still verified. Cardinality, identity and caller parameters are now all
 * generated up front and compared one-to-one.
 */
export interface InvocationDescriptor {
  invocationKey: string;
  planKey: string;
  template: string;
  cardinality: PlanCardinality;
  businessId: string | null;
  providerAccountId: string | null;
  grain: "campaign" | "adset" | null;
  source: string | null;
  /** PIT status of this specific invocation. */
  pitStatus: QueryPitStatus;
  knowledgeBounds: BoundKind;
}

/** Grain-specific templates and the source table each grain reads. */
const GRAIN_SOURCES: Record<string, Record<"campaign" | "adset", string>> = {
  observationCoverage: { campaign: "meta_entity_observation_runs", adset: "meta_entity_observation_runs" },
  stateChangeDensity: { campaign: "meta_entity_state_history", adset: "meta_entity_state_history" },
  ownershipAggregate: { campaign: "meta_entity_state_history", adset: "meta_entity_state_history" },
  ownershipSameClockConflicts: { campaign: "meta_entity_state_history", adset: "meta_entity_state_history" },
  "configSemanticStates:pointInTime": { campaign: "meta_campaign_config_history", adset: "meta_adset_config_history" },
  "configSemanticStates:retrospective": { campaign: "meta_campaign_config_history", adset: "meta_adset_config_history" },
  configTransitionIdentities: { campaign: "meta_campaign_config_history", adset: "meta_adset_config_history" },
};

export function invocationKeyFor(planKey: string, scopeToken: string): string {
  return `${planKey}#${scopeToken}`;
}

/** Deterministically generates every invocation the extract must issue. */
export function buildExpectedInvocations(
  bindings: readonly PinnedBinding[] = D080_PINNED_BINDINGS,
): InvocationDescriptor[] {
  const businesses = [...new Set(bindings.map((b) => b.businessId))].sort();
  const out: InvocationDescriptor[] = [];
  for (const [planKey, plan] of Object.entries(D080_READ_PLAN)) {
    const base = {
      planKey, template: plan.template, cardinality: plan.cardinality,
      pitStatus: plan.pitStatus, knowledgeBounds: plan.knowledgeBounds,
    };
    if (plan.cardinality === "once") {
      out.push({ ...base, invocationKey: invocationKeyFor(planKey, "global"), businessId: null, providerAccountId: null, grain: null, source: plan.source ?? null });
      continue;
    }
    if (plan.cardinality === "per_business") {
      for (const businessId of businesses) {
        out.push({ ...base, invocationKey: invocationKeyFor(planKey, businessId), businessId, providerAccountId: null, grain: null, source: plan.source ?? null });
      }
      continue;
    }
    for (const b of bindings) {
      if (plan.cardinality === "per_binding") {
        out.push({
          ...base,
          invocationKey: invocationKeyFor(planKey, bindingKey(b.businessId, b.providerAccountId)),
          businessId: b.businessId, providerAccountId: b.providerAccountId,
          grain: plan.grain ?? null, source: plan.source ?? null,
        });
      } else {
        for (const grain of ["campaign", "adset"] as const) {
          out.push({
            ...base,
            invocationKey: invocationKeyFor(planKey, `${bindingKey(b.businessId, b.providerAccountId)}|${grain}`),
            businessId: b.businessId, providerAccountId: b.providerAccountId,
            grain, source: GRAIN_SOURCES[planKey]?.[grain] ?? plan.source ?? null,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.invocationKey.localeCompare(b.invocationKey));
}

/** The expected count for the current pinned scope. Asserted by a test. */
export const D080_EXPECTED_INVOCATION_COUNT = buildExpectedInvocations().length;

export type InvocationReconcileReason =
  | "missing_invocation"
  | "duplicate_invocation"
  | "unexpected_invocation"
  | "grain_mismatch"
  | "source_mismatch"
  | "binding_mismatch"
  | "pit_layer_mismatch"
  | "knowledge_bound_mismatch";

export interface InvocationMismatch {
  reason: InvocationReconcileReason;
  invocationKey: string;
  detail: string;
}

/**
 * Compares the ledger to the generated expectation as an exact multiset, on
 * identity AND on the caller parameters each row claims to have used.
 */
export function reconcileInvocations(
  ledger: Row[],
  expected: InvocationDescriptor[] = buildExpectedInvocations(),
): InvocationMismatch[] {
  const mismatches: InvocationMismatch[] = [];
  const expectedByKey = new Map(expected.map((e) => [e.invocationKey, e]));
  const seen = new Map<string, number>();

  for (const row of ledger) {
    const key = text(row.invocationKey);
    if (!key) {
      mismatches.push({ reason: "unexpected_invocation", invocationKey: text(row.query) ?? "?", detail: "ledger row carries no invocationKey" });
      continue;
    }
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const want = expectedByKey.get(key);
    if (!want) {
      mismatches.push({ reason: "unexpected_invocation", invocationKey: key, detail: "not in the expected invocation set" });
      continue;
    }
    if ((rowBusinessId(row) ?? null) !== want.businessId || (rowProviderAccountId(row) ?? null) !== want.providerAccountId) {
      mismatches.push({ reason: "binding_mismatch", invocationKey: key, detail: `ledger ${rowBusinessId(row) ?? "-"}|${rowProviderAccountId(row) ?? "-"} vs expected ${want.businessId ?? "-"}|${want.providerAccountId ?? "-"}` });
    }
    // C5.2 — the recorded name must be the exact plan key, with no suffix and
    // no rename. Correction 4's key extractor discarded suffixes silently.
    if (text(row.planKey) !== want.planKey) {
      mismatches.push({ reason: "unexpected_invocation", invocationKey: key, detail: `planKey ${String(text(row.planKey))} != ${want.planKey}` });
    }
    if (text(row.query) !== want.planKey) {
      mismatches.push({ reason: "unexpected_invocation", invocationKey: key, detail: `query ${String(text(row.query))} is not the exact plan key ${want.planKey}` });
    }
    if ((text(row.grain) ?? null) !== want.grain) {
      mismatches.push({ reason: "grain_mismatch", invocationKey: key, detail: `ledger ${text(row.grain) ?? "-"} vs expected ${want.grain ?? "-"}` });
    }
    if (want.source !== null && (text(row.source) ?? null) !== want.source) {
      mismatches.push({ reason: "source_mismatch", invocationKey: key, detail: `ledger ${text(row.source) ?? "-"} vs expected ${want.source}` });
    }
    if ((text(row.pitStatus) ?? null) !== want.pitStatus) {
      mismatches.push({ reason: "pit_layer_mismatch", invocationKey: key, detail: `ledger ${text(row.pitStatus) ?? "-"} vs expected ${want.pitStatus}` });
    }
    if ((text(row.knowledgeBounds) ?? null) !== want.knowledgeBounds) {
      mismatches.push({ reason: "knowledge_bound_mismatch", invocationKey: key, detail: `ledger ${text(row.knowledgeBounds) ?? "-"} vs expected ${want.knowledgeBounds}` });
    }
  }

  for (const [key, count] of seen) {
    if (count > 1) mismatches.push({ reason: "duplicate_invocation", invocationKey: key, detail: `${count} ledger rows share this invocation` });
  }
  for (const want of expected) {
    if (!seen.has(want.invocationKey)) {
      mismatches.push({ reason: "missing_invocation", invocationKey: want.invocationKey, detail: "expected invocation has no ledger record" });
    }
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// C6.1 — the canonical request: SQL and params ARE the ledger's provenance
// ---------------------------------------------------------------------------

/** Grain-specific table and entity column for the templated config reads. */
export const GRAIN_TABLE: Record<"campaign" | "adset", { table: string; entityCol: string }> = {
  campaign: { table: "meta_campaign_config_history", entityCol: "campaign_id" },
  adset: { table: "meta_adset_config_history", entityCol: "adset_id" },
};

/** Templates that carry SOURCE_TABLE / ENTITY_COL / GRAIN_LABEL placeholders. */
export const SHAPED_TEMPLATES = new Set(["configSemanticStates", "configTransitionIdentities"]);

/** Deterministically shapes a template. Pure, so verify can recompute it. */
export function shapeStatement(templateKey: string, grain: "campaign" | "adset" | null): string {
  const raw = (D080_QUERIES as Record<string, string>)[templateKey];
  if (raw === undefined) throw new Error(`unknown template ${templateKey}`);
  if (!SHAPED_TEMPLATES.has(templateKey) || grain === null) return raw;
  const { table, entityCol } = GRAIN_TABLE[grain];
  return raw.replaceAll("SOURCE_TABLE", table).replaceAll("ENTITY_COL", entityCol).replaceAll("GRAIN_LABEL", grain);
}

/** Normalises a parameter list so its hash is stable and carries no secret. */
export function normaliseParams(params: readonly unknown[]): unknown[] {
  return params.map((p) => {
    if (Array.isArray(p)) return [...p].map((x) => (x === null || x === undefined ? null : String(x))).sort();
    if (p === null || p === undefined) return null;
    if (typeof p === "number" || typeof p === "boolean") return p;
    return String(p);
  });
}

/**
 * One inseparable object describing the call. The ledger record is DERIVED from
 * it, so provenance cannot be authored independently of the statement and
 * parameters actually executed.
 */
export interface CanonicalRequest {
  invocationKey: string;
  planKey: string;
  templateKey: string;
  statement: string;
  params: unknown[];
  statementSha256: string;
  paramsSha256: string;
  businessId: string | null;
  providerAccountId: string | null;
  businessListHash: string | null;
  grain: "campaign" | "adset" | null;
  source: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  knowledgeTo: string | null;
  asOfDate: string | null;
  limit: number | null;
  pitStatus: QueryPitStatus;
  knowledgeBounds: BoundKind;
}

export interface RequestContext {
  businessId?: string | null;
  providerAccountId?: string | null;
  businessList?: readonly string[] | null;
  grain?: "campaign" | "adset" | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  knowledgeTo?: string | null;
  asOfDate?: string | null;
  limit?: number | null;
  params: readonly unknown[];
}

function scopeTokenFor(planKey: string, ctx: RequestContext): string {
  const plan = D080_READ_PLAN[planKey];
  if (!plan) return "unknown";
  if (plan.cardinality === "once") return "global";
  if (plan.cardinality === "per_business") return String(ctx.businessId ?? "");
  const key = bindingKey(String(ctx.businessId ?? ""), String(ctx.providerAccountId ?? ""));
  return plan.cardinality === "per_binding_grain" ? `${key}|${ctx.grain ?? ""}` : key;
}

/**
 * Builds the canonical request. The SAME function runs in the extract and in
 * the verifier, so a recorded statement/params hash that does not match what
 * the plan and frozen prerequisites imply is detectable offline.
 */
export function buildCanonicalRequest(planKey: string, ctx: RequestContext): CanonicalRequest {
  const plan = D080_READ_PLAN[planKey];
  if (!plan) throw new Error(`unknown plan key ${planKey}`);
  const grain = ctx.grain ?? plan.grain ?? null;
  const statement = shapeStatement(plan.template, grain);
  const params = normaliseParams(ctx.params);
  return {
    invocationKey: invocationKeyFor(planKey, scopeTokenFor(planKey, ctx)),
    planKey,
    templateKey: plan.template,
    statement,
    params,
    statementSha256: createHash("sha256").update(statement).digest("hex"),
    paramsSha256: sha256Canonical(params),
    businessId: ctx.businessId ?? null,
    providerAccountId: ctx.providerAccountId ?? null,
    businessListHash: ctx.businessList ? sha256Canonical([...ctx.businessList].sort()) : null,
    grain,
    source: D080_PLAN_SOURCE[planKey]?.(grain) ?? plan.source ?? null,
    effectiveFrom: ctx.effectiveFrom ?? null,
    effectiveTo: ctx.effectiveTo ?? null,
    knowledgeTo: ctx.knowledgeTo ?? null,
    asOfDate: ctx.asOfDate ?? null,
    limit: ctx.limit ?? null,
    pitStatus: plan.pitStatus,
    knowledgeBounds: plan.knowledgeBounds,
  };
}

/**
 * C6.1 — EVERY plan definition has an exact source expectation, including the
 * binding-level entries whose plan definition omitted one. Correction 5 only
 * compared source when the plan happened to declare it, so `seriesCampaign` and
 * `ownershipObservations` could record `totally_wrong`.
 */
export const D080_PLAN_SOURCE: Record<string, (grain: "campaign" | "adset" | null) => string> = {
  runSchema: () => "information_schema.columns",
  decisionVocabulary: () => "pg_constraint",
  bindings: () => "business_provider_accounts",
  clockCampaignDaily: () => "meta_campaign_daily",
  clockAdsetDaily: () => "meta_adset_daily",
  clockCampaignConfig: () => "meta_campaign_config_history",
  clockAdsetConfig: () => "meta_adset_config_history",
  observationCoverage: () => "meta_entity_observation_runs",
  stateChangeDensity: () => "meta_entity_state_history",
  ownershipAggregate: () => "meta_entity_state_history",
  ownershipSameClockConflicts: () => "meta_entity_state_history",
  ownershipObservations: () => "meta_entity_state_history",
  seriesCampaign: () => "meta_campaign_daily",
  seriesAdset: () => "meta_adset_daily",
  unitEvidenceCampaignDaily: () => "meta_campaign_daily",
  unitEvidenceCampaignLifetime: () => "meta_campaign_daily",
  unitEvidenceAdsetDaily: () => "meta_adset_daily",
  unitEvidenceAdsetLifetime: () => "meta_adset_daily",
  "configSemanticStates:pointInTime": (g) => GRAIN_TABLE[g ?? "campaign"].table,
  "configSemanticStates:retrospective": (g) => GRAIN_TABLE[g ?? "campaign"].table,
  configTransitionIdentities: (g) => GRAIN_TABLE[g ?? "campaign"].table,
  servedDateCandidates: () => "engine_v3_ad_decision_snapshots_daily",
  canonicalLatestAsOf: () => "engine_v3_ad_decision_snapshots_daily",
  canonicalIdentities: () => "engine_v3_ad_decision_snapshots_daily",
  budgetVerbCensus: () => "engine_v3_ad_decision_snapshots_daily",
  engineVersionOverlap: () => "engine_v3_ad_decision_snapshots_daily",
  campaignRole: () => "engine_v3_campaign_context_daily",
  campaignRoleCensus: () => "engine_v3_campaign_context_daily",
  targetPackHistory: () => "business_target_pack_history",
};

/** Ledger names carry a per-binding suffix; this recovers the plan key. */
export function planKeyForLedgerQuery(query: string): string {
  if (query.startsWith("configSemanticStates:")) {
    return query.split(":").slice(0, 2).join(":");
  }
  return query.split(":")[0]!;
}

/**
 * C4.2/C4.5 — every ledger row must resolve to exactly one plan entry, every
 * required plan entry must appear, and `readFailures` must be exactly the
 * failed subset of `readLedger` rather than a second field written nearby.
 */
export function reconcileLedgerAndPlan(artifact: Record<string, unknown>): ScopeCutoffViolation[] {
  const violations: ScopeCutoffViolation[] = [];
  const provenance = artifact.provenance as { readLedger?: Row[]; readFailures?: Row[] } | undefined;
  const ledger = provenance?.readLedger;
  if (!Array.isArray(ledger)) return violations;

  const seen = new Set<string>();
  for (const entry of ledger) {
    const query = text(entry.query);
    if (!query) {
      violations.push({ section: "provenance.readLedger", reason: "ledger_plan_mismatch", detail: "ledger row has no query name" });
      continue;
    }
    const key = planKeyForLedgerQuery(query);
    if (!D080_READ_PLAN[key]) {
      violations.push({ section: "provenance.readLedger", reason: "ledger_plan_mismatch", detail: `ledger query ${query} resolves to plan key ${key}, which is not in the read plan` });
      continue;
    }
    seen.add(key);
  }
  for (const key of Object.keys(D080_READ_PLAN)) {
    if (!seen.has(key)) {
      violations.push({ section: "provenance.readLedger", reason: "ledger_plan_mismatch", detail: `plan entry ${key} never executed` });
    }
  }

  const failures = provenance?.readFailures;
  if (Array.isArray(failures)) {
    const derived = ledger.filter((e) => text(e.status) !== "ok");
    if (derived.length !== failures.length) {
      violations.push({ section: "provenance.readFailures", reason: "ledger_plan_mismatch", detail: `readFailures has ${failures.length} rows but the ledger contains ${derived.length} non-ok reads` });
    } else {
      const key = (e: Row) => `${text(e.query)}|${rowProviderAccountId(e) ?? ""}|${text(e.grain) ?? ""}`;
      const derivedKeys = new Set(derived.map(key));
      for (const failure of failures) {
        if (!derivedKeys.has(key(failure))) {
          violations.push({ section: "provenance.readFailures", reason: "ledger_plan_mismatch", detail: `readFailures row ${key(failure)} is not a non-ok ledger row` });
        }
      }
    }
  }
  return violations;
}

/**
 * C4.5 — the artifact may not contradict itself. A re-sealed package whose
 * ledger failures, coverage statuses and analysis claims disagree must fail.
 */
export function reconcileClaims(artifact: Record<string, unknown>): ScopeCutoffViolation[] {
  const violations: ScopeCutoffViolation[] = [];
  const analysis = artifact.analysis as Record<string, unknown> | undefined;
  if (!analysis) return violations;
  const config = analysis.configChangeQuality as
    | { unknownCells?: string[]; semanticCountsClaimable?: boolean; identityManifestComplete?: boolean; identityTruncatedFor?: string[] }
    | undefined;
  const coverage = readPath(artifact, ["configStates", "coverage"]) as Row[] | undefined;

  if (config && Array.isArray(coverage)) {
    const failedCells = coverage.filter((c) => text(c.status) !== "ok");
    const declared = new Set(config.unknownCells ?? []);
    if (failedCells.length !== declared.size) {
      violations.push({ section: "analysis.configChangeQuality", reason: "claim_contradiction", detail: `${failedCells.length} coverage cells are not ok but ${declared.size} unknown cells are declared` });
    }
    if (config.semanticCountsClaimable === true && failedCells.some((c) => text(c.cellKind) === "semantic")) {
      violations.push({ section: "analysis.configChangeQuality", reason: "claim_contradiction", detail: "semanticCountsClaimable is true while a semantic coverage cell failed" });
    }
    if (config.identityManifestComplete === true) {
      if (failedCells.some((c) => text(c.cellKind) === "identity")) {
        violations.push({ section: "analysis.configChangeQuality", reason: "claim_contradiction", detail: "identityManifestComplete is true while an identity coverage cell failed" });
      }
      if ((config.identityTruncatedFor ?? []).length > 0) {
        violations.push({ section: "analysis.configChangeQuality", reason: "claim_contradiction", detail: "identityManifestComplete is true while at least one identity cell hit the cap" });
      }
    }
  }

  const served = analysis.servedDateContract as
    | { perBinding?: Row[]; coverage?: Row[]; allServedEqualNativeMax?: boolean | null; fleetComparisonClaimable?: boolean }
    | undefined;
  if (served && Array.isArray(served.coverage)) {
    const notOk = served.coverage.filter((c) => text(c.status) !== "ok");
    if (served.fleetComparisonClaimable === true && notOk.length > 0) {
      violations.push({ section: "analysis.servedDateContract", reason: "claim_contradiction", detail: `fleetComparisonClaimable is true while ${notOk.length} served-date cells are not ok` });
    }
    if (served.allServedEqualNativeMax !== null && served.fleetComparisonClaimable === false) {
      violations.push({ section: "analysis.servedDateContract", reason: "claim_contradiction", detail: "allServedEqualNativeMax must be null when the fleet comparison is unclaimable" });
    }
  }
  return violations;
}

/**
 * C4.5 — an exact expected-key audit: missing, duplicate and unexpected keys
 * are all failures. Counting matches alone would let an extra cell hide.
 */
export interface KeyAudit {
  ok: boolean;
  expected: number;
  observed: number;
  missing: string[];
  duplicates: string[];
  unexpected: string[];
}

export function auditExpectedKeys(expected: string[], observed: string[]): KeyAudit {
  const expectedSet = new Set(expected);
  const counts = new Map<string, number>();
  for (const key of observed) counts.set(key, (counts.get(key) ?? 0) + 1);
  return {
    ok:
      expected.every((k) => counts.get(k) === 1) &&
      observed.every((k) => expectedSet.has(k)) &&
      [...counts.values()].every((n) => n === 1),
    expected: expected.length,
    observed: observed.length,
    missing: expected.filter((k) => !counts.has(k)).sort(),
    duplicates: [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort(),
    unexpected: [...counts.keys()].filter((k) => !expectedSet.has(k)).sort(),
  };
}

// ---------------------------------------------------------------------------
// C5.1 — the full artifact shape and provenance contract
// ---------------------------------------------------------------------------

/**
 * A required D080 evidence package cannot shrink to a set of empty arrays and
 * still verify. Correction 4 checked only that 23 row sections EXISTED; the
 * whole `analysis`, `capabilityMatrix`, `schemaContract` and `correctionLedger`
 * objects could be deleted, the contract string could be wrong, and the
 * transaction could claim `read_only = off`, all while verifying `ok`.
 */
export const D080_REQUIRED_OBJECTS = [
  "provenance", "schemaContract", "sourceSemantics", "scope", "clocks",
  "observationCoverage", "unitEvidence", "ownershipCoverage", "configStates",
  "canonicalDecisions", "campaignRole", "capabilityMatrix", "d080bContract",
  "analysis",
] as const;

/** Scalar-list sections that must exist even when empty. */
/** C6.3 — required NESTED contracts the report depends on. */
export const D080_REQUIRED_NESTED_OBJECTS = [
  "analysis.layer1Creative", "analysis.layer1Budget", "analysis.layer2StrictPit",
  "analysis.layer3", "analysis.layer3Sensitivity", "analysis.configChangeQuality",
  "analysis.servedDateContract", "analysis.unitCoverage", "analysis.canonicalKeyAudit",
  "analysis.configChangeQuality.pointInTime", "analysis.configChangeQuality.retrospective",
  "analysis.configChangeQuality.identityManifest",
  "capabilityMatrix.graphApiVersions", "d080bContract.rollbackPlan",
  "schemaContract", "scope.pinnedInputs", "provenance.executionAuthority",
  "clocks", "unitEvidence", "configStates", "canonicalDecisions", "campaignRole",
] as const;

/** C6.3 — allowed value domains. An unknown status string must fail. */
/** C7.1 — deterministic dependency codes. */
export const D080_DEPENDENCY_CODES = [
  "binding_cutoff_unavailable",
  "business_cutoff_unavailable",
  "canonical_latest_as_of_unavailable",
] as const;
export type DependencyCode = (typeof D080_DEPENDENCY_CODES)[number];

export const D080_STATUS_DOMAINS: Record<string, readonly string[]> = {
  "unitEvidence.coverageMatrix": ["rows_returned", "zero_rows_returned", "unknown/source_read_failed", "not_run_dependency_failed"],
  "configStates.coverage": ["ok", "unknown/source_read_failed", "not_run_dependency_failed"],
  "canonicalDecisions.servedDateCoverage": ["ok", "unknown/source_read_failed", "no_candidate", "not_run_dependency_failed"],
  "analysis.servedDateContract.coverage": ["ok", "unknown/source_read_failed", "no_candidate", "not_run_dependency_failed"],
  "dependencyCoverage.cells": ["not_run_dependency_failed"],
  "provenance.readLedger": ["ok", "unknown/source_read_failed", "not_run_dependency_failed"],
  "provenance.readFailures": ["unknown/source_read_failed", "not_run_dependency_failed"],
  "invocationResults.receipts": ["ok", "unknown/source_read_failed", "not_run_dependency_failed"],
};

/**
 * C7.4 — path-specific domains for fields OTHER than `status`. A single generic
 * domain must never be applied to unrelated statuses such as campaign delivery.
 */
export const D080_FIELD_DOMAINS: Array<{ path: string; field: string; allowed: readonly string[]; nullable?: boolean }> = [
  { path: "clocks.perBinding", field: "cutoff_status", allowed: ["resolved", "unknown/source_read_failed:clockCampaignDaily", "unknown/source_read_failed:clockAdsetDaily"] },
  { path: "canonicalDecisions.perBinding", field: "latest_status", allowed: ["ok", "no_latest_candidate", "not_run_dependency_failed"] },
  { path: "dependencyCoverage.cells", field: "dependencyCode", allowed: [...D080_DEPENDENCY_CODES] },
  { path: "dependencyCoverage.cells", field: "family", allowed: ["observation", "state_change", "series", "ownership", "unit", "config", "served_date", "canonical", "budget_verb", "engine_version", "campaign_role"] },
  { path: "canonicalDecisions.perBinding", field: "identity_status", allowed: ["ok_populated", "ok_zero_identities", "unknown/source_read_failed", "not_run_dependency_failed"] },
  { path: "provenance.readLedger", field: "disposition", allowed: ["execute", "dependency_skip"] },
  { path: "provenance.readLedger", field: "dependencyCode", allowed: [...D080_DEPENDENCY_CODES], nullable: true },
  { path: "invocationResults.receipts", field: "outcomeKind", allowed: ["materialised_slice", "source_query_receipt", "dependency_skip"] },
];

/**
 * C8.4 — the COMPLETE census of report-critical explicit values, validated at
 * their actual paths. Correction 7 covered six row fields; unit contracts,
 * capability rows, the query manifest, role kinds and the D080B recommendation
 * were all open, so `"made_up"` verified clean in each.
 *
 * Deliberately NOT applied to Meta delivery statuses (`campaign_status`,
 * `effective_status`, `presence`), which are provider vocabulary, not ours.
 */
export interface ObjectDomain {
  /** Dotted path to a single object, or to a map whose VALUES are checked. */
  path: string;
  mapValues?: boolean;
  field: string;
  allowed: readonly string[];
  nullable?: boolean;
}

export const D080_OBJECT_DOMAINS: ObjectDomain[] = [
  { path: "schemaContract", field: "compatibility", allowed: ["compatible", "unavailable_schema_lag"] },
  { path: "schemaContract", field: "strictPitOwnerReconstruction", allowed: ["available", "unavailable_schema_lag"] },
  { path: "unitEvidence.factualContract", field: "status", allowed: ["proven_common", "unknown_unit_scale"] },
  { path: "analysis.layer3.unitContract", field: "status", allowed: ["proven_common", "unknown_unit_scale"] },
  { path: "d080bContract", field: "recommendation", allowed: ["new_typed_generic_execution_ledger", "additive_extension_of_meta_ads_action_log"] },
  // Capability rows: each is a named finding whose status vocabulary is ours.
  { path: "capabilityMatrix.budgetWritePath", field: "status", allowed: ["absent", "present", "present_but_unsafe_to_copy"] },
  { path: "capabilityMatrix.nearestPrecedent", field: "status", allowed: ["absent", "present", "present_but_unsafe_to_copy"] },
  { path: "capabilityMatrix.actionLogGrain", field: "status", allowed: ["ad_only", "multi_grain"] },
  { path: "capabilityMatrix.reconciliationPath", field: "status", allowed: ["structurally_unavailable_for_budgets", "available"] },
  { path: "capabilityMatrix.manualIdempotency", field: "status", allowed: ["absent", "present"] },
  { path: "capabilityMatrix.decisionVocabulary", field: "status", allowed: ["creative_only_and_ad_grain_only", "supports_budget_intent"] },
  { path: "capabilityMatrix.currencyExponent", field: "status", allowed: ["absent", "present"] },
  // The query manifest is a map keyed by plan name; every VALUE is checked.
  { path: "provenance.queryManifest", mapValues: true, field: "kind", allowed: ["static_schema", "binding_discovery", "time_varying"] },
  { path: "provenance.queryManifest", mapValues: true, field: "scope", allowed: ["binding", "business", "none"] },
  { path: "provenance.queryManifest", mapValues: true, field: "effectiveBounds", allowed: ["two_sided", "upper_only", "lower_only", "pinned_single_date", "none"] },
  { path: "provenance.queryManifest", mapValues: true, field: "knowledgeBounds", allowed: ["two_sided", "upper_only", "lower_only", "pinned_single_date", "none"] },
  { path: "provenance.queryManifest", mapValues: true, field: "pitStatus", allowed: ["pit_safe", "retrospective", "current_state", "not_applicable"] },
];

/** Row-array fields beyond `status`, checked at their actual paths. */
export const D080_ROW_VALUE_DOMAINS: Array<{ path: string; field: string; allowed: readonly string[]; nullable?: boolean }> = [
  { path: "campaignRole.rows", field: "inferred_kind", allowed: ["main", "test", "mixed", "unknown", "conflict"], nullable: true },
  { path: "campaignRole.rows", field: "confidence_class", allowed: ["high", "medium", "low", "unknown", "conflict"], nullable: true },
  { path: "sourceSemantics.sources", field: "writeSemantics", allowed: ["mutable_upsert", "append_only_effective_dated", "append_only_with_compaction", "append_only_bitemporal"] },
  { path: "capabilityMatrix.graphApiVersions.primarySourceVerification", field: "status", allowed: ["primary_render_verified_not_byte_verified", "official_sdk_release_verified", "unverified"] },
  { path: "capabilityMatrix.graphApiVersions.claimMetadataHashes", field: "status", allowed: ["primary_render_verified_not_byte_verified", "official_sdk_release_verified", "unverified"] },
];

/** C7.4 — report-critical numbers that must be finite, non-negative integers. */
export const D080_REQUIRED_COUNT_PATHS = [
  "analysis.layer1Creative.denominator",
  "analysis.layer1Budget.denominator",
  "analysis.layer1Budget.scannedHistoricalSnapshotRows",
  "analysis.layer2StrictPit.denominator",
  "analysis.layer3.denominator",
  "analysis.configChangeQuality.expectedCells",
  "analysis.configChangeQuality.identitiesMaterialised",
  "analysis.unitCoverage.expectedCells",
  "analysis.unitCoverage.totalCompared",
  "analysis.servedDateContract.expectedCells",
  "provenance.sqlTemplateCount",
  "provenance.planDefinitionCount",
  "provenance.expectedInvocationCount",
] as const;

/** Row-level count fields that must be finite non-negative integers. */
export const D080_ROW_COUNT_FIELDS: Array<{ path: string; fields: string[] }> = [
  { path: "unitEvidence.coverageMatrix", fields: ["rows"] },
  { path: "dependencyCoverage.cells", fields: ["rows"] },
  { path: "provenance.readLedger", fields: ["rows", "ms"] },
  { path: "invocationResults.receipts", fields: ["ledgerRows"] },
];

// Postgres renders the offset as `+00`; ISO also allows `+00:00`, `+0000`, `Z`.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimestampWithZone(value: unknown): boolean {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return false;
  // Normalise a bare two-digit offset so Date.parse accepts it.
  const normalised = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  return Number.isFinite(Date.parse(normalised));
}

export function isValidCalendarDate(value: unknown): boolean {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function isSha256(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Statuses that count as a SUCCESSFUL read for unit coverage. */
export const UNIT_READ_STATUSES = ["rows_returned", "zero_rows_returned"] as const;

export const D080_REQUIRED_SCALAR_LISTS = [
  "scope.expectedMissing", "scope.unexpectedExtra",
  "schemaContract.observedRunColumns", "schemaContract.missingRunColumns",
  "configStates.identityTruncatedFor",
  "provenance.executionAuthority.truthyBefore",
  "provenance.executionAuthority.truthyAfter",
] as const;

export interface ShapeViolation {
  path: string;
  reason: string;
  detail: string;
}

function at(artifact: Record<string, unknown>, path: string): unknown {
  let node: unknown = artifact;
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Validates structure AND truth: the contract string, the transaction proof,
 * execution authority, the pinned matrix, the query-contract and read-plan
 * hashes, and the D078 pin. None of these were checked before.
 */
export function validateArtifactShape(artifact: Record<string, unknown>): ShapeViolation[] {
  const v: ShapeViolation[] = [];
  const fail = (path: string, reason: string, detail: string) => v.push({ path, reason, detail });

  if (artifact.contract !== D080_EVIDENCE_CONTRACT) {
    fail("contract", "contract_mismatch", `expected ${D080_EVIDENCE_CONTRACT}, found ${String(artifact.contract)}`);
  }
  for (const key of D080_REQUIRED_OBJECTS) {
    const node = artifact[key];
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      fail(key, "required_object_missing", "a required top-level evidence object is absent or not an object");
    }
  }
  if (!Array.isArray(artifact.correctionLedger) || (artifact.correctionLedger as unknown[]).length === 0) {
    fail("correctionLedger", "required_object_missing", "the correction ledger is absent or empty");
  }
  for (const path of D080_REQUIRED_SCALAR_LISTS) {
    if (!Array.isArray(at(artifact, path))) fail(path, "required_list_missing", "required scalar list is absent or not an array");
  }
  // C6.3 — the nested contracts the report actually depends on.
  for (const path of D080_REQUIRED_NESTED_OBJECTS) {
    const node = at(artifact, path);
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      fail(path, "required_nested_missing", "a required nested evidence contract is absent or not an object");
    }
  }
  // C6.3 — enumerated status domains; an unknown string is a failure.
  for (const [path, allowed] of Object.entries(D080_STATUS_DOMAINS)) {
    for (const row of (at(artifact, path) as Row[] | undefined) ?? []) {
      const status = text(row.status);
      if (status === null || !allowed.includes(status)) {
        fail(path, "status_domain", `status ${String(status)} is outside ${JSON.stringify(allowed)}`);
      }
    }
  }
  // C6.3 — execution-authority self-consistency.
  const authorityChanged = (at(artifact, "provenance.executionAuthority.changedByLoader") as Row[] | undefined) ?? [];
  for (const change of authorityChanged) {
    const flag = text(change.flag);
    if (!flag || !(D080_FORBIDDEN_TRUTHY_FLAGS as readonly string[]).includes(flag)) {
      fail("provenance.executionAuthority.changedByLoader", "execution_authority", `unknown flag ${String(flag)}`);
    }
    for (const side of ["before", "after"] as const) {
      if (isTruthyFlagValue(text(change[side]) ?? undefined)) {
        fail("provenance.executionAuthority.changedByLoader", "execution_authority", `${flag} ${side} is truthy`);
      }
    }
  }

  // --- provenance truth ---------------------------------------------------
  const isolation = text(at(artifact, "provenance.transactionIsolation"));
  if (isolation !== "repeatable read") fail("provenance.transactionIsolation", "provenance_untrue", `expected 'repeatable read', found ${String(isolation)}`);
  const readOnly = text(at(artifact, "provenance.transactionReadOnly"));
  if (readOnly !== "on") fail("provenance.transactionReadOnly", "provenance_untrue", `expected 'on', found ${String(readOnly)}`);
  for (const [path, expected] of [
    ["provenance.statementTimeout", `${STATEMENT_TIMEOUT_MS / 1000}s`],
    ["provenance.lockTimeout", `${LOCK_TIMEOUT_MS / 1000}s`],
  ] as const) {
    const found = text(at(artifact, path));
    if (found !== expected) fail(path, "provenance_untrue", `expected ${expected}, found ${String(found)}`);
  }
  // C7.4 — the retrieval timestamp must PARSE and carry a timezone.
  if (!isValidTimestampWithZone(at(artifact, "provenance.retrievedAt"))) {
    fail("provenance.retrievedAt", "invalid_timestamp", `not a timezone-qualified timestamp: ${JSON.stringify(at(artifact, "provenance.retrievedAt"))}`);
  }
  // C7.4 — field-level status domains beyond `status`.
  for (const domain of D080_FIELD_DOMAINS) {
    for (const row of (at(artifact, domain.path) as Row[] | undefined) ?? []) {
      const value = row[domain.field];
      if (value === null || value === undefined) {
        if (!domain.nullable) fail(domain.path, "status_domain", `${domain.field} is required`);
        continue;
      }
      if (typeof value !== "string" || !domain.allowed.includes(value)) {
        fail(domain.path, "status_domain", `${domain.field} ${JSON.stringify(value)} is outside ${JSON.stringify(domain.allowed)}`);
      }
    }
  }
  // C8.4 — object and map-valued domains at their actual paths.
  for (const domain of D080_OBJECT_DOMAINS) {
    const node = at(artifact, domain.path);
    if (!node || typeof node !== "object") continue;
    const targets = domain.mapValues ? Object.entries(node as Record<string, unknown>) : [[domain.path, node] as const];
    for (const [label, target] of targets) {
      if (!target || typeof target !== "object") continue;
      const value = (target as Record<string, unknown>)[domain.field];
      if (value === null || value === undefined) {
        if (!domain.nullable) fail(`${domain.path}.${label}`, "status_domain", `${domain.field} is required`);
        continue;
      }
      if (typeof value !== "string" || !domain.allowed.includes(value)) {
        fail(`${domain.path}${domain.mapValues ? "." + label : ""}`, "status_domain", `${domain.field} ${JSON.stringify(value)} is outside ${JSON.stringify(domain.allowed)}`);
      }
    }
  }
  for (const domain of D080_ROW_VALUE_DOMAINS) {
    for (const row of (at(artifact, domain.path) as Row[] | undefined) ?? []) {
      const value = row[domain.field];
      if (value === null || value === undefined) {
        if (!domain.nullable) fail(domain.path, "status_domain", `${domain.field} is required`);
        continue;
      }
      if (typeof value !== "string" || !domain.allowed.includes(value)) {
        fail(domain.path, "status_domain", `${domain.field} ${JSON.stringify(value)} is outside ${JSON.stringify(domain.allowed)}`);
      }
    }
  }
  // C7.4 — report-critical counts must be finite non-negative integers.
  for (const path of D080_REQUIRED_COUNT_PATHS) {
    const value = at(artifact, path);
    if (!isCount(value)) fail(path, "invalid_count", `expected a finite non-negative integer, found ${JSON.stringify(value)}`);
  }
  for (const spec of D080_ROW_COUNT_FIELDS) {
    for (const row of (at(artifact, spec.path) as Row[] | undefined) ?? []) {
      for (const field of spec.fields) {
        if (!isCount(row[field])) fail(spec.path, "invalid_count", `${field} = ${JSON.stringify(row[field])} is not a finite non-negative integer`);
      }
    }
  }
  // C7.4 — declared dates must be valid calendar dates.
  for (const row of (at(artifact, "clocks.perBinding") as Row[] | undefined) ?? []) {
    for (const field of ["cutoff", "series_from"]) {
      const value = row[field];
      if (value !== null && value !== undefined && !isValidCalendarDate(value)) {
        fail("clocks.perBinding", "invalid_date", `${field} ${JSON.stringify(value)} is not a valid calendar date`);
      }
    }
  }

  const authority = at(artifact, "provenance.executionAuthority") as Record<string, unknown> | undefined;
  if (authority?.ok !== true) fail("provenance.executionAuthority.ok", "execution_authority", "execution authority was not clean");
  for (const key of ["truthyBefore", "truthyAfter"] as const) {
    const list = authority?.[key];
    if (Array.isArray(list) && list.length > 0) {
      fail(`provenance.executionAuthority.${key}`, "execution_authority", `${list.length} truthy execution flag(s): ${list.join(", ")}`);
    }
  }

  const queryHash = text(at(artifact, "provenance.queryContractSha256"));
  if (queryHash !== sha256Canonical(D080_QUERIES)) {
    fail("provenance.queryContractSha256", "contract_hash_mismatch", "stored query-contract hash does not match the current query contract");
  }
  const planHash = text(at(artifact, "provenance.readPlanSha256"));
  if (planHash !== sha256Canonical(D080_READ_PLAN)) {
    fail("provenance.readPlanSha256", "contract_hash_mismatch", "stored read-plan hash does not match the current read plan");
  }
  const manifestHash = text(at(artifact, "provenance.queryManifestSha256"));
  if (manifestHash !== sha256Canonical(D080_QUERY_MANIFEST)) {
    fail("provenance.queryManifestSha256", "contract_hash_mismatch", "stored query-manifest hash does not match the current manifest");
  }

  const d078 = text(at(artifact, "scope.pinnedInputs.d078BundleObserved"));
  if (d078 !== D080_PINNED_INPUTS.d078BundleSha256) {
    fail("scope.pinnedInputs.d078BundleObserved", "predecessor_pin", `observed ${String(d078)} != pinned ${D080_PINNED_INPUTS.d078BundleSha256}`);
  }

  // --- the pinned matrix, recomputed rather than trusted -------------------
  const pinned = at(artifact, "scope.pinnedBindings");
  if (canonicalJson(pinned) !== canonicalJson(D080_PINNED_BINDINGS)) {
    fail("scope.pinnedBindings", "pinned_matrix_mismatch", "stored pinned matrix is not the constant seven-entry matrix");
  }
  const observed = (at(artifact, "scope.observedBindings") as Row[] | undefined) ?? [];
  const observedKeys = new Set(observed.map((r) => bindingKey(String(rowBusinessId(r) ?? ""), String(rowProviderAccountId(r) ?? ""))));
  const recomputedMissing = D080_PINNED_BINDINGS
    .filter((b) => !observedKeys.has(bindingKey(b.businessId, b.providerAccountId)))
    .map((b) => bindingKey(b.businessId, b.providerAccountId))
    .sort();
  const recomputedExtra = [...observedKeys].filter((k) => !isPinnedBinding(k.split("|")[0], k.split("|")[1])).sort();
  const storedMissing = [...(((at(artifact, "scope.expectedMissing") as string[]) ?? []))].sort();
  const storedExtra = [...(((at(artifact, "scope.unexpectedExtra") as string[]) ?? []))].sort();
  if (canonicalJson(storedMissing) !== canonicalJson(recomputedMissing)) {
    fail("scope.expectedMissing", "scope_reconciliation", `stored ${JSON.stringify(storedMissing)} != recomputed ${JSON.stringify(recomputedMissing)}`);
  }
  if (canonicalJson(storedExtra) !== canonicalJson(recomputedExtra)) {
    fail("scope.unexpectedExtra", "scope_reconciliation", `stored ${JSON.stringify(storedExtra)} != recomputed ${JSON.stringify(recomputedExtra)}`);
  }
  if (recomputedExtra.length > 0) {
    fail("scope.observedBindings", "scope_reconciliation", `${recomputedExtra.length} observed account(s) outside the pinned matrix`);
  }

  // --- clocks: exact cardinality, and a usable cutoff ----------------------
  const perBinding = (at(artifact, "clocks.perBinding") as Row[] | undefined) ?? [];
  const dependencyCells = (at(artifact, "dependencyCoverage.cells") as Row[] | undefined) ?? [];
  const clockAudit = auditExpectedKeys(
    D080_PINNED_BINDINGS.map((b) => bindingKey(b.businessId, b.providerAccountId)),
    perBinding.map((r) => bindingKey(String(rowBusinessId(r) ?? ""), String(rowProviderAccountId(r) ?? ""))),
  );
  if (!clockAudit.ok) {
    fail("clocks.perBinding", "coverage_matrix", `expected exactly one cell per pinned binding; missing ${JSON.stringify(clockAudit.missing)}, duplicates ${JSON.stringify(clockAudit.duplicates)}, unexpected ${JSON.stringify(clockAudit.unexpected)}`);
  }
  // C6.4 — exactly one row per (business, account, source, grain), by KEY.
  const perSource = (at(artifact, "clocks.perSource") as Row[] | undefined) ?? [];
  const expectedSourceKeys = D080_PINNED_BINDINGS.flatMap((b) =>
    ([
      ["meta_campaign_daily", "campaign"], ["meta_adset_daily", "adset"],
      ["meta_campaign_config_history", "campaign"], ["meta_adset_config_history", "adset"],
    ] as const).map(([src, grain]) => `${bindingKey(b.businessId, b.providerAccountId)}|${src}|${grain}`),
  );
  const sourceAudit = auditExpectedKeys(
    expectedSourceKeys,
    perSource.map((r) => `${bindingKey(String(rowBusinessId(r) ?? ""), String(rowProviderAccountId(r) ?? ""))}|${text(r.source) ?? ""}|${text(r.grain) ?? ""}`),
  );
  if (!sourceAudit.ok) {
    fail("clocks.perSource", "coverage_matrix", `missing ${JSON.stringify(sourceAudit.missing)}, duplicates ${JSON.stringify(sourceAudit.duplicates)}, unexpected ${JSON.stringify(sourceAudit.unexpected)}`);
  }
  // C6.4 — raw clock rows must agree with the derived per_source snapshot.
  const planForSource: Record<string, string> = {
    meta_campaign_daily: "clockCampaignDaily", meta_adset_daily: "clockAdsetDaily",
    meta_campaign_config_history: "clockCampaignConfig", meta_adset_config_history: "clockAdsetConfig",
  };
  const derived = new Map<string, Record<string, string | null>>();
  for (const row of (at(artifact, "clocks.perBinding") as Row[] | undefined) ?? []) {
    const b = rowBusinessId(row); const a2 = rowProviderAccountId(row);
    if (b && a2) derived.set(bindingKey(b, a2), (row.per_source ?? {}) as Record<string, string | null>);
  }
  for (const row of perSource) {
    const b = rowBusinessId(row); const a2 = rowProviderAccountId(row);
    const src = text(row.source);
    if (!b || !a2 || !src) continue;
    const planKey = planForSource[src];
    if (!planKey) {
      fail("clocks.perSource", "coverage_matrix", `unknown clock source ${src}`);
      continue;
    }
    const want = derived.get(bindingKey(b, a2))?.[planKey] ?? null;
    const got = text(row.latest_effective);
    if (canonicalJson(got) !== canonicalJson(want)) {
      fail("clocks.perSource", "clock_disagreement", `${a2}/${src}: raw latest_effective ${String(got)} != derived per_source ${String(want)}`);
    }
  }
  // C6.4 — observedBindings must be the exact seven-row result with parity.
  const observedRows = (at(artifact, "scope.observedBindings") as Row[] | undefined) ?? [];
  const observedAudit = auditExpectedKeys(
    D080_PINNED_BINDINGS.map((b) => bindingKey(b.businessId, b.providerAccountId)),
    observedRows.map((r) => bindingKey(String(rowBusinessId(r) ?? ""), String(rowProviderAccountId(r) ?? ""))),
  );
  if (!observedAudit.ok) {
    fail("scope.observedBindings", "scope_reconciliation", `this is a FULL package: expected exactly one row per pinned binding; missing ${JSON.stringify(observedAudit.missing)}, duplicates ${JSON.stringify(observedAudit.duplicates)}, unexpected ${JSON.stringify(observedAudit.unexpected)}`);
  }
  for (const row of observedRows) {
    const b = rowBusinessId(row); const a2 = rowProviderAccountId(row);
    const pinnedRow = D080_PINNED_BINDINGS.find((x) => x.businessId === b && x.providerAccountId === a2);
    if (pinnedRow && row.is_selected !== pinnedRow.isSelected) {
      fail("scope.observedBindings", "scope_reconciliation", `${a2}: observed is_selected ${String(row.is_selected)} != pinned ${pinnedRow.isSelected}`);
    }
  }
  for (const row of perBinding) {
    const cutoff = text(row.cutoff);
    const status = text(row.cutoff_status) ?? "";
    if (!cutoff && !status.startsWith("unknown/")) {
      fail("clocks.perBinding", "cutoff_unusable", `${rowProviderAccountId(row) ?? "?"} has no cutoff and no unknown status`);
    }
    // Recompute the cutoff from the required daily clocks it claims to derive from.
    const perSourceValues = (row.per_source ?? {}) as Record<string, string | null>;
    const required = [perSourceValues.clockCampaignDaily, perSourceValues.clockAdsetDaily];
    if (required.every((x) => typeof x === "string" && x)) {
      const recomputed = required.map((x) => String(x).slice(0, 10)).sort()[0]!;
      if (cutoff !== recomputed) {
        fail("clocks.perBinding", "cutoff_unusable", `${rowProviderAccountId(row) ?? "?"} stored cutoff ${String(cutoff)} != recomputed ${recomputed}`);
      }
      const expectedFrom = new Date(Date.parse(`${recomputed}T00:00:00.000Z`) - BUDGET_SERIES_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
      // C9.1 — series_from is either the recomputed bound, or explicitly
      // unavailable. "Unavailable" is only believable when this binding also
      // carries dependency-coverage cells naming the same failure, so a null
      // can neither be invented nor quietly repaired.
      const storedFrom = text(row.series_from);
      if (storedFrom === null) {
        const declared = dependencyCells.some(
          (c) =>
            text(c.provider_account_id) === rowProviderAccountId(row) &&
            text(c.dependencyCode) === "binding_cutoff_unavailable" &&
            Array.isArray(c.missingPrerequisites) &&
            (c.missingPrerequisites as unknown[]).includes("series_from"),
        );
        if (!declared) {
          fail("clocks.perBinding", "cutoff_unusable", `${rowProviderAccountId(row) ?? "?"} has a null series_from with no dependency-coverage cell declaring it unavailable`);
        }
      } else if (storedFrom !== expectedFrom) {
        fail("clocks.perBinding", "cutoff_unusable", `${rowProviderAccountId(row) ?? "?"} stored series_from ${String(storedFrom)} != recomputed ${expectedFrom}`);
      }
    } else if (cutoff) {
      fail("clocks.perBinding", "cutoff_unusable", `${rowProviderAccountId(row) ?? "?"} declares a cutoff without both required daily clocks`);
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// C5.3/C5.4/C5.5 — recomputed coverage, claim derivation, cross-section checks
// ---------------------------------------------------------------------------

/** The exact expected key set for every claim-dependent coverage matrix. */
export function expectedCoverageKeys(): Record<string, string[]> {
  const bindings = D080_PINNED_BINDINGS.map((b) => bindingKey(b.businessId, b.providerAccountId));
  const accounts = D080_PINNED_BINDINGS.map((b) => b.providerAccountId);
  return {
    clockBinding: bindings,
    configCoverage: accounts.flatMap((a) =>
      ["campaign", "adset"].flatMap((g) => ["pointInTime", "retrospective", "identities"].map((l) => `${a}/${g}/${l}`)),
    ),
    unitCoverage: accounts.flatMap((a) => ["campaign", "adset"].flatMap((g) => ["daily", "lifetime"].map((f) => `${a}/${g}/${f}`))),
    canonicalPerBinding: bindings,
    servedDateCoverage: bindings,
    servedAnalysisCoverage: bindings,
  };
}

export interface DerivedClaims {
  semanticCountsClaimable: boolean;
  identityManifestComplete: boolean;
  servedFleetClaimable: boolean;
  unitAllCellsRead: boolean;
  configUnknownCells: string[];
}

/**
 * C5.4 — derives every claim from the frozen coverage rows. Replay and verify
 * call the SAME function, so `verify` recomputes the claims instead of trusting
 * self-authored booleans.
 */
export function deriveClaims(input: {
  configCoverage: Row[];
  unitCoverage: Row[];
  servedCoverage: Row[];
  identityTruncatedFor: string[];
}): DerivedClaims {
  const expected = expectedCoverageKeys();
  const cfgKey = (c: Row) => `${text(c.provider_account_id)}/${text(c.grain)}/${text(c.layer)}`;
  const cfgAudit = auditExpectedKeys(expected.configCoverage, input.configCoverage.map(cfgKey));
  const okCfg = new Set(input.configCoverage.filter((c) => text(c.status) === "ok").map(cfgKey));
  const unknownCells = expected.configCoverage.filter((c) => !okCfg.has(c));
  const semanticCells = expected.configCoverage.filter((c) => !c.endsWith("/identities"));
  const identityCells = expected.configCoverage.filter((c) => c.endsWith("/identities"));

  const unitKey = (c: Row) => `${text(c.provider_account_id)}/${text(c.grain)}/${text(c.budget_field)}`;
  const unitAudit = auditExpectedKeys(expected.unitCoverage, input.unitCoverage.map(unitKey));

  const servedKey = (c: Row) => bindingKey(String(rowBusinessId(c) ?? ""), String(rowProviderAccountId(c) ?? ""));
  const servedAudit = auditExpectedKeys(expected.servedDateCoverage, input.servedCoverage.map(servedKey));
  const servedOk = new Set(input.servedCoverage.filter((c) => text(c.status) === "ok").map(servedKey));

  return {
    semanticCountsClaimable: cfgAudit.ok && semanticCells.every((c) => okCfg.has(c)),
    identityManifestComplete:
      cfgAudit.ok && identityCells.every((c) => okCfg.has(c)) && input.identityTruncatedFor.length === 0,
    servedFleetClaimable: servedAudit.ok && servedOk.size === expected.servedDateCoverage.length,
    // C6.3 — a dependency skip or an unknown status is NOT a successful read.
    unitAllCellsRead:
      unitAudit.ok &&
      input.unitCoverage.every((c) => (UNIT_READ_STATUSES as readonly string[]).includes(text(c.status) ?? "")),
    configUnknownCells: unknownCells,
  };
}

export interface MatrixAuditRecord {
  name: string;
  expected: number;
  observed: number;
  missing: number;
  duplicates: number;
  unexpected: number;
  passed: boolean;
}

export interface ReconciliationResult {
  violations: ScopeCutoffViolation[];
  matrixAudits: MatrixAuditRecord[];
  /** Comparisons that actually compared two independent things. */
  crossSectionReconciliations: number;
  /** Rows carrying a DB aggregate that cannot be recomputed offline. */
  sourceAggregateRows: number;
}

/**
 * C5.3/C5.4/C5.5 — recomputes every coverage matrix and derived claim from the
 * frozen rows, reconciles the read ledger to its coverage cells, and counts
 * only comparisons that actually happened.
 */
export function reconcileCoverageAndClaims(artifact: Record<string, unknown>): ReconciliationResult {
  const violations: ScopeCutoffViolation[] = [];
  let crossSectionReconciliations = 0;
  let sourceAggregateRows = 0;
  const expected = expectedCoverageKeys();

  const configCoverage = (at(artifact, "configStates.coverage") as Row[] | undefined) ?? [];
  const unitCoverage = (at(artifact, "unitEvidence.coverageMatrix") as Row[] | undefined) ?? [];
  const servedCoverage = (at(artifact, "canonicalDecisions.servedDateCoverage") as Row[] | undefined) ?? [];
  const servedAnalysis = (at(artifact, "analysis.servedDateContract.coverage") as Row[] | undefined) ?? [];
  const canonicalPerBinding = (at(artifact, "canonicalDecisions.perBinding") as Row[] | undefined) ?? [];
  const ledger = (at(artifact, "provenance.readLedger") as Row[] | undefined) ?? [];

  // --- exact matrices, recomputed here rather than trusted ----------------
  // C8.6 — matrix audits are structured OUTCOMES that each actually ran. The
  // counter is derived from these records, never from a named offset.
  const matrixAudits: MatrixAuditRecord[] = [];
  const runMatrix = (name: string, want: string[], got: string[]) => {
    const audit = auditExpectedKeys(want, got);
    matrixAudits.push({
      name, expected: audit.expected, observed: audit.observed,
      missing: audit.missing.length, duplicates: audit.duplicates.length,
      unexpected: audit.unexpected.length, passed: audit.ok,
    });
    return audit;
  };
  // The three matrices validateArtifactShape enforces are re-run here as
  // records so the counter reflects audits that demonstrably executed.
  runMatrix("clocks.perBinding", D080_PINNED_BINDINGS.map((b) => bindingKey(b.businessId, b.providerAccountId)),
    ((at(artifact, "clocks.perBinding") as Row[] | undefined) ?? []).map((r) => bindingKey(String(rowBusinessId(r) ?? ""), String(rowProviderAccountId(r) ?? ""))));
  runMatrix("clocks.perSource",
    D080_PINNED_BINDINGS.flatMap((b) => ([["meta_campaign_daily", "campaign"], ["meta_adset_daily", "adset"], ["meta_campaign_config_history", "campaign"], ["meta_adset_config_history", "adset"]] as const)
      .map(([src, g]) => `${bindingKey(b.businessId, b.providerAccountId)}|${src}|${g}`)),
    ((at(artifact, "clocks.perSource") as Row[] | undefined) ?? []).map((r) => `${bindingKey(String(rowBusinessId(r) ?? ""), String(rowProviderAccountId(r) ?? ""))}|${text(r.source) ?? ""}|${text(r.grain) ?? ""}`));
  runMatrix("scope.observedBindings", D080_PINNED_BINDINGS.map((b) => bindingKey(b.businessId, b.providerAccountId)),
    ((at(artifact, "scope.observedBindings") as Row[] | undefined) ?? []).map((r) => bindingKey(String(rowBusinessId(r) ?? ""), String(rowProviderAccountId(r) ?? ""))));
  const matrices: Array<[string, string[], string[]]> = [
    ["configStates.coverage", expected.configCoverage, configCoverage.map((c) => `${text(c.provider_account_id)}/${text(c.grain)}/${text(c.layer)}`)],
    ["unitEvidence.coverageMatrix", expected.unitCoverage, unitCoverage.map((c) => `${text(c.provider_account_id)}/${text(c.grain)}/${text(c.budget_field)}`)],
    ["canonicalDecisions.servedDateCoverage", expected.servedDateCoverage, servedCoverage.map((c) => bindingKey(String(rowBusinessId(c) ?? ""), String(rowProviderAccountId(c) ?? "")))],
    ["analysis.servedDateContract.coverage", expected.servedAnalysisCoverage, servedAnalysis.map((c) => bindingKey(String(rowBusinessId(c) ?? ""), String(rowProviderAccountId(c) ?? "")))],
    ["canonicalDecisions.perBinding", expected.canonicalPerBinding, canonicalPerBinding.map((c) => bindingKey(String(rowBusinessId(c) ?? ""), String(rowProviderAccountId(c) ?? "")))],
  ];
  for (const [section, want, got] of matrices) {
    const audit = runMatrix(section, want, got);
    if (!audit.ok) {
      violations.push({ section, reason: "coverage_key_mismatch", detail: `missing ${JSON.stringify(audit.missing)}, duplicates ${JSON.stringify(audit.duplicates)}, unexpected ${JSON.stringify(audit.unexpected)}` });
    }
  }

  // --- ledger status -> coverage cell -------------------------------------
  const statusOf = (planKey: string, account: string | null, grain: string | null): string | null => {
    const row = ledger.find(
      (l) => text(l.planKey) === planKey && (rowProviderAccountId(l) ?? null) === account && (text(l.grain) ?? null) === grain,
    );
    return row ? (text(row.status) ?? null) : null;
  };
  const expectOk = (section: string, cellOk: boolean, ledgerStatus: string | null, label: string) => {
    crossSectionReconciliations += 1;
    if (ledgerStatus === null) return;
    const ledgerOk = ledgerStatus === "ok";
    if (ledgerOk !== cellOk) {
      violations.push({ section, reason: "claim_contradiction", detail: `${label}: ledger status ${ledgerStatus} but coverage ${cellOk ? "ok" : "not ok"}` });
    }
  };
  for (const cell of configCoverage) {
    const layer = text(cell.layer);
    const planKey = layer === "identities" ? "configTransitionIdentities" : `configSemanticStates:${layer}`;
    expectOk("configStates.coverage", text(cell.status) === "ok", statusOf(planKey, rowProviderAccountId(cell), text(cell.grain)), `${rowProviderAccountId(cell)}/${text(cell.grain)}/${layer}`);
  }
  /**
   * C9.1 — a cell "succeeded" only if it was actually read. `!== source_read_failed`
   * used to admit `not_run_dependency_failed`, so a dependency-blocked cell
   * reconciled against a skipped ledger row as though the read had happened.
   */
  const cellSucceeded = (status: string | null) =>
    status !== "unknown/source_read_failed" && status !== "not_run_dependency_failed";
  for (const cell of unitCoverage) {
    const grain = text(cell.grain) === "campaign" ? "Campaign" : "Adset";
    const field = text(cell.budget_field) === "daily" ? "Daily" : "Lifetime";
    expectOk("unitEvidence.coverageMatrix", cellSucceeded(text(cell.status)), statusOf(`unitEvidence${grain}${field}`, rowProviderAccountId(cell), text(cell.grain)), `${rowProviderAccountId(cell)}/${text(cell.grain)}/${text(cell.budget_field)}`);
  }
  for (const cell of servedCoverage) {
    expectOk("canonicalDecisions.servedDateCoverage", cellSucceeded(text(cell.status)), statusOf("servedDateCandidates", rowProviderAccountId(cell), null), String(rowProviderAccountId(cell)));
  }
  // Canonical identity: a failed or skipped read must never present as a clean
  // empty membership.
  for (const row of canonicalPerBinding) {
    crossSectionReconciliations += 1;
    const identityStatus = statusOf("canonicalIdentities", rowProviderAccountId(row), null);
    const membership = row.membership as { count?: number } | undefined;
    const declared = text(row.identity_status);
    const expectedDeclared =
      identityStatus === null
        ? "not_run_dependency_failed"
        : identityStatus !== "ok"
          ? identityStatus
          : (membership?.count ?? 0) > 0
            ? "ok_populated"
            : "ok_zero_identities";
    if (declared !== expectedDeclared) {
      violations.push({ section: "canonicalDecisions.perBinding", reason: "claim_contradiction", detail: `${rowProviderAccountId(row)}: identity_status ${String(declared)} but the ledger and membership imply ${expectedDeclared}` });
    }
  }

  // --- claims recomputed from coverage ------------------------------------
  const derived = deriveClaims({
    configCoverage, unitCoverage, servedCoverage,
    identityTruncatedFor: (at(artifact, "configStates.identityTruncatedFor") as string[] | undefined) ?? [],
  });
  const cfg = at(artifact, "analysis.configChangeQuality") as Record<string, unknown> | undefined;
  const served = at(artifact, "analysis.servedDateContract") as Record<string, unknown> | undefined;
  const unit = at(artifact, "analysis.unitCoverage") as Record<string, unknown> | undefined;
  const compare = (section: string, label: string, stored: unknown, recomputed: unknown) => {
    crossSectionReconciliations += 1;
    if (canonicalJson(stored) !== canonicalJson(recomputed)) {
      violations.push({ section, reason: "claim_contradiction", detail: `${label}: stored ${JSON.stringify(stored)} != recomputed ${JSON.stringify(recomputed)}` });
    }
  };
  if (cfg) {
    compare("analysis.configChangeQuality", "semanticCountsClaimable", cfg.semanticCountsClaimable, derived.semanticCountsClaimable);
    compare("analysis.configChangeQuality", "identityManifestComplete", cfg.identityManifestComplete, derived.identityManifestComplete);
    compare("analysis.configChangeQuality", "totalClaimable", cfg.totalClaimable, derived.semanticCountsClaimable && derived.identityManifestComplete);
    compare("analysis.configChangeQuality", "unknownCells", [...((cfg.unknownCells as string[]) ?? [])].sort(), [...derived.configUnknownCells].sort());
  }
  if (served) {
    compare("analysis.servedDateContract", "fleetComparisonClaimable", served.fleetComparisonClaimable, derived.servedFleetClaimable);
    const perBinding = (served.perBinding as Row[] | undefined) ?? [];
    const recomputedEqual = derived.servedFleetClaimable ? perBinding.every((r) => r.equalsNativeMax === true) : null;
    compare("analysis.servedDateContract", "allServedEqualNativeMax", served.allServedEqualNativeMax ?? null, recomputedEqual);
  }
  if (unit) compare("analysis.unitCoverage", "allCellsRead", unit.allCellsRead, derived.unitAllCellsRead);

  // --- cross-section arithmetic -------------------------------------------
  const layer3 = at(artifact, "analysis.layer3") as { denominator?: number; windows?: Record<string, { entityDays?: number; outcomes?: Record<string, number> }> } | undefined;
  if (layer3?.windows) {
    for (const [window, data] of Object.entries(layer3.windows)) {
      crossSectionReconciliations += 1;
      const sum = Object.values(data.outcomes ?? {}).reduce((a, b) => a + b, 0);
      if (sum !== data.entityDays) {
        violations.push({ section: "analysis.layer3", reason: "claim_contradiction", detail: `window ${window}: outcome sum ${sum} != entityDays ${data.entityDays}` });
      }
      if (data.entityDays !== layer3.denominator) {
        violations.push({ section: "analysis.layer3", reason: "claim_contradiction", detail: `window ${window}: entityDays ${data.entityDays} != denominator ${layer3.denominator}` });
      }
    }
  }
  const l1 = at(artifact, "analysis.layer1Creative") as { denominator?: number; perBinding?: Row[] } | undefined;
  if (l1?.perBinding) {
    crossSectionReconciliations += 1;
    const sum = l1.perBinding.reduce((acc, r) => acc + Number((r.membership as { count?: number } | undefined)?.count ?? 0), 0);
    if (sum !== l1.denominator) {
      violations.push({ section: "analysis.layer1Creative", reason: "claim_contradiction", detail: `membership sum ${sum} != denominator ${l1.denominator}` });
    }
  }
  // Config semantic totals must equal the per-grain sums of the frozen rows.
  for (const [layerName, path] of [["pointInTime", "configStates.pointInTime"], ["retrospective", "configStates.retrospective"]] as const) {
    const rows = (at(artifact, path) as Row[] | undefined) ?? [];
    const analysisLayer = at(artifact, `analysis.configChangeQuality.${layerName}.perGrain`) as Record<string, { transitions?: Record<string, number> }> | undefined;
    if (!analysisLayer) continue;
    for (const [grain, bucket] of Object.entries(analysisLayer)) {
      crossSectionReconciliations += 1;
      const recomputed = rows
        .filter((r) => text(r.grain) === grain)
        .reduce<Record<string, number>>((acc, r) => {
          const cls = text(r.transition_class) ?? "unknown";
          acc[cls] = (acc[cls] ?? 0) + (num(r.transitions) ?? 0);
          return acc;
        }, {});
      if (canonicalJson(recomputed) !== canonicalJson(bucket.transitions ?? {})) {
        violations.push({ section: `analysis.configChangeQuality.${layerName}`, reason: "claim_contradiction", detail: `${grain} transitions do not sum from ${path}` });
      }
    }
  }

  // C5.5 — sums that CAN be reconciled against a frozen analysis field become
  // real comparisons rather than unverifiable source aggregates.
  const unitRows = (at(artifact, "unitEvidence.rows") as Row[] | undefined) ?? [];
  const unitAnalysis = at(artifact, "analysis.unitCoverage") as Record<string, unknown> | undefined;
  if (unitAnalysis && unitAnalysis.totalCompared !== undefined) {
    crossSectionReconciliations += 1;
    const recomputed = unitRows.reduce((acc, r) => acc + (num(r.compared) ?? 0), 0);
    if (recomputed !== num(unitAnalysis.totalCompared)) {
      violations.push({ section: "analysis.unitCoverage", reason: "claim_contradiction", detail: `totalCompared stored ${String(unitAnalysis.totalCompared)} != recomputed ${recomputed}` });
    }
  }
  for (const row of unitRows) {
    crossSectionReconciliations += 1;
    const compared = num(row.compared) ?? 0;
    for (const field of ["raw_equals_stored", "raw_over_100", "raw_times_100", "zero_valued"]) {
      if ((num(row[field]) ?? 0) > compared) {
        violations.push({ section: "unitEvidence.rows", reason: "claim_contradiction", detail: `${field} exceeds compared on ${rowProviderAccountId(row)}/${text(row.grain)}/${text(row.budget_field)}` });
      }
    }
  }
  const censusRows = (at(artifact, "canonicalDecisions.budgetVerbCensus") as Row[] | undefined) ?? [];
  const scannedStored = num(at(artifact, "analysis.layer1Budget.scannedHistoricalSnapshotRows"));
  if (scannedStored !== null) {
    crossSectionReconciliations += 1;
    const recomputed = censusRows.reduce((acc, r) => acc + (num(r.scanned_rows) ?? 0), 0);
    if (recomputed !== scannedStored) {
      violations.push({ section: "analysis.layer1Budget", reason: "claim_contradiction", detail: `scannedHistoricalSnapshotRows stored ${scannedStored} != recomputed ${recomputed}` });
    }
  }

  // --- honest accounting of what CANNOT be recomputed offline -------------
  for (const path of ["observationCoverage.providerObservationFreshness", "observationCoverage.stateChangeCheckpointDensity", "ownershipCoverage.aggregate", "ownershipCoverage.sameClockConflicts", "campaignRole.census"]) {
    sourceAggregateRows += ((at(artifact, path) as Row[] | undefined) ?? []).length;
  }

  return { violations, crossSectionReconciliations, sourceAggregateRows, matrixAudits };
}

// ---------------------------------------------------------------------------
// C5.6 — a pure model of the route's served-date contract, for behavioural tests
// ---------------------------------------------------------------------------

export interface CreativeOwnershipRow {
  source: "meta_creative_dimensions" | "meta_creative_daily";
  providerAccountId: string;
  creativeId: string;
}

/**
 * The route's `creative_account_scope`: union both ownership tables, then keep
 * only creatives seen under exactly ONE account, and only when that account is
 * the one being resolved. A regex that both table names appear proves none of
 * this, which is why the behaviour is modelled here and tested directly.
 */
export function resolveCreativeAccountScope(
  rows: CreativeOwnershipRow[],
  providerAccountId: string,
): string[] {
  const accountsByCreative = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = accountsByCreative.get(row.creativeId) ?? new Set<string>();
    set.add(row.providerAccountId);
    accountsByCreative.set(row.creativeId, set);
  }
  return [...accountsByCreative.entries()]
    .filter(([, accounts]) => accounts.size === 1 && accounts.has(providerAccountId))
    .map(([creativeId]) => creativeId)
    .sort();
}

export type ServedDateStatus = "ok" | "unknown/source_read_failed" | "no_candidate";

export interface ServedDateResolution {
  status: ServedDateStatus;
  servedDate: string | null;
  equalsNativeMax: boolean | null;
  divergenceReason: string | null;
}

/** MAX over the three candidates, with failure and no-candidate kept distinct. */
export function resolveServedDate(input: {
  readFailed?: boolean;
  nativeAdMax: string | null;
  legacyCreativeMax: string | null;
  nativeJobRunMax: string | null;
}): ServedDateResolution {
  if (input.readFailed) {
    return { status: "unknown/source_read_failed", servedDate: null, equalsNativeMax: null, divergenceReason: "read_failed" };
  }
  const candidates = [input.nativeAdMax, input.legacyCreativeMax, input.nativeJobRunMax].filter(
    (v): v is string => Boolean(v),
  );
  if (candidates.length === 0) {
    return { status: "no_candidate", servedDate: null, equalsNativeMax: null, divergenceReason: "no_candidate_resolved" };
  }
  const served = candidates.sort()[candidates.length - 1]!;
  const native = input.nativeAdMax;
  return {
    status: "ok",
    servedDate: served,
    equalsNativeMax: native === null ? null : served === native,
    divergenceReason: native === null ? "native_max_missing" : served === native ? null : "later_non_native_candidate",
  };
}

/** The fleet comparison is claimable only when every binding produced an ok cell. */
export function resolveFleetComparison(
  resolutions: ServedDateResolution[],
  expectedBindings: number,
): { claimable: boolean; allEqual: boolean | null } {
  const ok = resolutions.filter((r) => r.status === "ok");
  const claimable = ok.length === expectedBindings && resolutions.length === expectedBindings;
  return { claimable, allEqual: claimable ? ok.every((r) => r.equalsNativeMax === true) : null };
}

// ---------------------------------------------------------------------------
// C6.1/C6.2 — expected requests and invocation result receipts
// ---------------------------------------------------------------------------

/** Prerequisites the verifier reads from the frozen package to rebuild requests. */
interface FrozenPrereqs {
  businessIds: string[];
  cutoff: Map<string, string>;
  seriesFrom: Map<string, string>;
  latestAsOf: Map<string, string | null>;
  businessCutoff: Map<string, string>;
}

function readPrereqs(artifact: Record<string, unknown>): FrozenPrereqs {
  const cutoff = new Map<string, string>();
  const seriesFrom = new Map<string, string>();
  const businessCutoff = new Map<string, string>();
  for (const row of (at(artifact, "clocks.perBinding") as Row[] | undefined) ?? []) {
    const b = rowBusinessId(row);
    const a2 = rowProviderAccountId(row);
    const c = text(row.cutoff);
    if (!b || !a2 || !c) continue;
    cutoff.set(bindingKey(b, a2), c);
    const sf = text(row.series_from);
    if (sf) seriesFrom.set(bindingKey(b, a2), sf);
    const cur = businessCutoff.get(b);
    if (!cur || c > cur) businessCutoff.set(b, c);
  }
  const latestAsOf = new Map<string, string | null>();
  for (const row of (at(artifact, "canonicalDecisions.perBinding") as Row[] | undefined) ?? []) {
    const b = rowBusinessId(row);
    const a2 = rowProviderAccountId(row);
    if (b && a2) latestAsOf.set(bindingKey(b, a2), text(row.latest_as_of));
  }
  return {
    businessIds: [...new Set(D080_PINNED_BINDINGS.map((x) => x.businessId))],
    cutoff, seriesFrom, latestAsOf, businessCutoff,
  };
}

const CLOCK_ADSET_CONFIG_FLOOR = "2026-01-01";

/**
 * C6.1 — rebuilds the exact request every invocation should have executed,
 * from the static plan plus the FROZEN prerequisites. A self-authored ledger
 * value is never its own expectation.
 */
export function buildExpectedDispositions(artifact: Record<string, unknown>): Map<string, ExpectedInvocation> {
  const pre = readPrereqs(artifact);
  const out = new Map<string, ExpectedInvocation>();
  const add = (r: CanonicalRequest) => out.set(r.invocationKey, { disposition: "execute", request: r });
  const addSkip = (r: CanonicalRequest, code: DependencyCode, missing: string[]) => out.set(r.invocationKey, expectedSkip(r, code, missing));

  add(buildCanonicalRequest("runSchema", { params: [] }));
  add(buildCanonicalRequest("decisionVocabulary", { params: [VOCABULARY_CONSTRAINTS] }));
  add(buildCanonicalRequest("bindings", { businessList: pre.businessIds, params: [pre.businessIds] }));
  add(buildCanonicalRequest("targetPackHistory", { businessList: pre.businessIds, params: [pre.businessIds] }));

  for (const b of D080_PINNED_BINDINGS) {
    const key = bindingKey(b.businessId, b.providerAccountId);
    const scope = { businessId: b.businessId, providerAccountId: b.providerAccountId };
    const cutoff = pre.cutoff.get(key) ?? null;
    const seriesFrom = pre.seriesFrom.get(key) ?? null;
    const lineageFrom = cutoff
      ? new Date(Date.parse(`${cutoff}T00:00:00.000Z`) - OWNERSHIP_LINEAGE_DAYS * 86_400_000).toISOString().slice(0, 10)
      : null;

    for (const cell of [
      { planKey: "clockCampaignDaily", grain: "campaign" as const, extra: [] as unknown[] },
      { planKey: "clockAdsetDaily", grain: "adset" as const, extra: [] },
      { planKey: "clockCampaignConfig", grain: "campaign" as const, extra: [] },
      { planKey: "clockAdsetConfig", grain: "adset" as const, extra: [CLOCK_ADSET_CONFIG_FLOOR] },
    ]) {
      add(buildCanonicalRequest(cell.planKey, {
        ...scope, grain: cell.grain,
        effectiveFrom: cell.extra.length ? String(cell.extra[0]) : null,
        params: [b.businessId, b.providerAccountId, ...cell.extra],
      }));
    }

    const skipParams = { ...scope, params: [] as unknown[] };
    if (!cutoff || !seriesFrom) {
      // C8.3 — the EXACT missing set, not a fixed pair. Correction 7 computed
      // it and then discarded it, always reporting ["cutoff","series_from"].
      const missing = [!cutoff ? "cutoff" : null, !seriesFrom ? "series_from" : null].filter((x): x is string => x !== null);
      for (const [planKey, plan] of Object.entries(D080_READ_PLAN)) {
        if (plan.cardinality === "per_binding" && !planKey.startsWith("clock")) {
          addSkip(buildCanonicalRequest(planKey, { ...skipParams, grain: plan.grain ?? null }), "binding_cutoff_unavailable", missing);
        } else if (plan.cardinality === "per_binding_grain") {
          for (const grain of ["campaign", "adset"] as const) {
            addSkip(buildCanonicalRequest(planKey, { ...skipParams, grain }), "binding_cutoff_unavailable", missing);
          }
        }
      }
      continue;
    }

    for (const grain of ["campaign", "adset"] as const) {
      const args = [b.businessId, b.providerAccountId, grain, seriesFrom, cutoff];
      add(buildCanonicalRequest("observationCoverage", { ...scope, grain, effectiveFrom: seriesFrom, effectiveTo: cutoff, params: args }));
      add(buildCanonicalRequest("stateChangeDensity", { ...scope, grain, effectiveFrom: seriesFrom, effectiveTo: cutoff, params: args }));
      add(buildCanonicalRequest("ownershipAggregate", { ...scope, grain, effectiveFrom: seriesFrom, effectiveTo: cutoff, params: args }));
      add(buildCanonicalRequest("ownershipSameClockConflicts", { ...scope, grain, effectiveFrom: seriesFrom, effectiveTo: cutoff, params: args }));
      for (const layer of [{ name: "pointInTime", kb: cutoff }, { name: "retrospective", kb: null }] as const) {
        add(buildCanonicalRequest(`configSemanticStates:${layer.name}`, {
          ...scope, grain, effectiveFrom: seriesFrom, effectiveTo: cutoff, knowledgeTo: layer.kb,
          params: [b.businessId, b.providerAccountId, seriesFrom, cutoff, layer.kb],
        }));
      }
      add(buildCanonicalRequest("configTransitionIdentities", {
        ...scope, grain, effectiveFrom: seriesFrom, effectiveTo: cutoff, knowledgeTo: cutoff, limit: CONFIG_IDENTITY_LIMIT,
        params: [b.businessId, b.providerAccountId, seriesFrom, cutoff, cutoff, CONFIG_IDENTITY_LIMIT],
      }));
    }

    const bounds = [b.businessId, b.providerAccountId, seriesFrom, cutoff];
    add(buildCanonicalRequest("seriesCampaign", { ...scope, grain: "campaign", effectiveFrom: seriesFrom, effectiveTo: cutoff, params: bounds }));
    add(buildCanonicalRequest("seriesAdset", { ...scope, grain: "adset", effectiveFrom: seriesFrom, effectiveTo: cutoff, params: bounds }));
    add(buildCanonicalRequest("ownershipObservations", {
      ...scope, effectiveFrom: lineageFrom, effectiveTo: cutoff, knowledgeTo: cutoff,
      params: [b.businessId, b.providerAccountId, lineageFrom, cutoff],
    }));
    for (const cell of [
      { planKey: "unitEvidenceCampaignDaily", grain: "campaign" as const },
      { planKey: "unitEvidenceCampaignLifetime", grain: "campaign" as const },
      { planKey: "unitEvidenceAdsetDaily", grain: "adset" as const },
      { planKey: "unitEvidenceAdsetLifetime", grain: "adset" as const },
    ]) {
      add(buildCanonicalRequest(cell.planKey, { ...scope, grain: cell.grain, effectiveFrom: seriesFrom, effectiveTo: cutoff, params: bounds }));
    }
    add(buildCanonicalRequest("servedDateCandidates", { ...scope, params: [b.businessId, b.providerAccountId] }));
    add(buildCanonicalRequest("canonicalLatestAsOf", { ...scope, params: [b.businessId, b.providerAccountId] }));
    const latest = pre.latestAsOf.get(key) ?? null;
    if (latest) {
      add(buildCanonicalRequest("canonicalIdentities", { ...scope, asOfDate: latest, params: [b.businessId, b.providerAccountId, latest] }));
    } else {
      addSkip(buildCanonicalRequest("canonicalIdentities", { ...scope, params: [] }), "canonical_latest_as_of_unavailable", ["latest_as_of"]);
    }
    add(buildCanonicalRequest("budgetVerbCensus", { ...scope, effectiveTo: cutoff, params: [b.businessId, b.providerAccountId, [...BUDGET_VERBS], cutoff] }));
    add(buildCanonicalRequest("engineVersionOverlap", { ...scope, effectiveTo: cutoff, params: [b.businessId, b.providerAccountId, cutoff] }));
  }

  for (const businessId of pre.businessIds) {
    const cutoff = pre.businessCutoff.get(businessId) ?? null;
    if (cutoff) {
      const from = new Date(Date.parse(`${cutoff}T00:00:00.000Z`) - BUDGET_SERIES_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
      add(buildCanonicalRequest("campaignRole", { businessId, effectiveFrom: from, effectiveTo: cutoff, params: [businessId, from, cutoff] }));
    } else {
      addSkip(buildCanonicalRequest("campaignRole", { businessId, params: [] }), "business_cutoff_unavailable", ["business_cutoff"]);
    }
    add(buildCanonicalRequest("campaignRoleCensus", { businessId, params: [businessId] }));
  }
  return out;
}

/**
 * C7.1 — the expected disposition of an invocation: it either executes a
 * complete canonical request, or it is an explicit dependency skip carrying
 * identity, a deterministic code, the exact missing prerequisites and an
 * outcome hash. Correction 6 waived almost every field on a skip, so a skip row
 * could forge its hashes, business, account and bounds and still verify.
 */
export type ExpectedInvocation =
  | { disposition: "execute"; request: CanonicalRequest }
  | {
      disposition: "dependency_skip";
      request: CanonicalRequest;
      dependencyCode: DependencyCode;
      missingPrerequisites: string[];
      reason: string;
      skipOutcomeHash: string;
    };

export function expectedSkip(
  request: CanonicalRequest,
  code: DependencyCode,
  missing: string[],
): ExpectedInvocation {
  return {
    disposition: "dependency_skip",
    request,
    dependencyCode: code,
    missingPrerequisites: [...missing].sort(),
    reason: skipReason(code, missing),
    skipOutcomeHash: sha256Canonical(skipEnvelope(request, code, missing)),
  };
}

/** Fields compared between the recorded ledger row and the rebuilt request. */
const REQUEST_PROOF_FIELDS = [
  "templateKey", "statementSha256", "paramsSha256", "businessId", "providerAccountId",
  "businessListHash", "grain", "source", "effectiveFrom", "effectiveTo", "knowledgeTo",
  "asOfDate", "limit", "pitStatus", "knowledgeBounds",
] as const;

export const D080_LEDGER_STATUSES = ["ok", "unknown/source_read_failed", "not_run_dependency_failed"] as const;

/**
 * C6.2 — where each invocation's rows landed, and how to slice them back out.
 * `recomputable: false` marks a source-query aggregate whose raw rows are not
 * materialised; it gets an explicit receipt, never a silent pass.
 */
/**
 * C8.5 — how the materialised slice relates to the rows the query returned.
 *
 * `identity` and `columnar_roundtrip` both preserve every value, so the
 * boundary-captured source hash MUST equal the recomputed slice hash. Merely
 * copying the same unverified hash into both the ledger and the receipt is
 * circular and is not evidence, which is what Correction 7 did.
 */
export type SliceTransform = "identity" | "columnar_roundtrip" | "not_materialised";

interface ResultBinding {
  path: string;
  transform: SliceTransform;
  /** Selects the rows this invocation produced. Null means not materialised. */
  select: ((rows: Row[], req: CanonicalRequest) => Row[]) | null;
}

const byBinding = (rows: Row[], req: CanonicalRequest) =>
  rows.filter((r) => rowBusinessId(r) === req.businessId && rowProviderAccountId(r) === req.providerAccountId);
const byBindingGrain = (rows: Row[], req: CanonicalRequest) =>
  byBinding(rows, req).filter((r) => text(r.grain) === req.grain || text(r.entity_type) === req.grain);

export const D080_RESULT_BINDING: Record<string, ResultBinding> = {
  runSchema: { path: "schemaContract.observedRunColumns", transform: "not_materialised", select: null },
  decisionVocabulary: { path: "canonicalDecisions.vocabularyConstraints", transform: "identity", select: (r) => r },
  bindings: { path: "scope.observedBindings", transform: "identity", select: (r) => r },
  targetPackHistory: { path: "targetPackHistory", transform: "identity", select: (r) => r },
  clockCampaignDaily: { path: "clocks.perSource", transform: "identity", select: (r, q) => byBinding(r, q).filter((x) => text(x.source) === q.source && text(x.grain) === q.grain) },
  clockAdsetDaily: { path: "clocks.perSource", transform: "identity", select: (r, q) => byBinding(r, q).filter((x) => text(x.source) === q.source && text(x.grain) === q.grain) },
  clockCampaignConfig: { path: "clocks.perSource", transform: "identity", select: (r, q) => byBinding(r, q).filter((x) => text(x.source) === q.source && text(x.grain) === q.grain) },
  clockAdsetConfig: { path: "clocks.perSource", transform: "identity", select: (r, q) => byBinding(r, q).filter((x) => text(x.source) === q.source && text(x.grain) === q.grain) },
  observationCoverage: { path: "observationCoverage.providerObservationFreshness", transform: "identity", select: byBindingGrain },
  stateChangeDensity: { path: "observationCoverage.stateChangeCheckpointDensity", transform: "identity", select: byBindingGrain },
  ownershipAggregate: { path: "ownershipCoverage.aggregate", transform: "identity", select: byBindingGrain },
  ownershipSameClockConflicts: { path: "ownershipCoverage.sameClockConflicts", transform: "identity", select: byBindingGrain },
  ownershipObservations: { path: "ownershipObservations", transform: "columnar_roundtrip", select: byBinding },
  seriesCampaign: { path: "series", transform: "columnar_roundtrip", select: byBindingGrain },
  seriesAdset: { path: "series", transform: "columnar_roundtrip", select: byBindingGrain },
  unitEvidenceCampaignDaily: { path: "unitEvidence.rows", transform: "identity", select: (r, q) => byBindingGrain(r, q).filter((x) => text(x.budget_field) === "daily") },
  unitEvidenceCampaignLifetime: { path: "unitEvidence.rows", transform: "identity", select: (r, q) => byBindingGrain(r, q).filter((x) => text(x.budget_field) === "lifetime") },
  unitEvidenceAdsetDaily: { path: "unitEvidence.rows", transform: "identity", select: (r, q) => byBindingGrain(r, q).filter((x) => text(x.budget_field) === "daily") },
  unitEvidenceAdsetLifetime: { path: "unitEvidence.rows", transform: "identity", select: (r, q) => byBindingGrain(r, q).filter((x) => text(x.budget_field) === "lifetime") },
  "configSemanticStates:pointInTime": { path: "configStates.pointInTime", transform: "identity", select: byBindingGrain },
  "configSemanticStates:retrospective": { path: "configStates.retrospective", transform: "identity", select: byBindingGrain },
  configTransitionIdentities: { path: "configStates.identities", transform: "identity", select: byBindingGrain },
  servedDateCandidates: { path: "canonicalDecisions.servedDate", transform: "identity", select: byBinding },
  canonicalLatestAsOf: { path: "canonicalDecisions.perBinding", transform: "not_materialised", select: null },
  canonicalIdentities: { path: "canonicalDecisions.perBinding", transform: "not_materialised", select: null },
  budgetVerbCensus: { path: "canonicalDecisions.budgetVerbCensus", transform: "identity", select: byBinding },
  engineVersionOverlap: { path: "canonicalDecisions.engineVersionOverlap", transform: "identity", select: byBinding },
  campaignRole: { path: "campaignRole.rows", transform: "identity", select: (r, q) => r.filter((x) => rowBusinessId(x) === q.businessId) },
  campaignRoleCensus: { path: "campaignRole.census", transform: "identity", select: (r, q) => r.filter((x) => rowBusinessId(x) === q.businessId) },
};

/**
 * C7.3 — three explicitly distinct outcome kinds. `source_query_receipt` names
 * the case where raw rows are deliberately not materialised: its raw hash comes
 * from the read boundary and cannot be recomputed offline, but its transformed
 * SUMMARY is bound and recomputed, so it is never a silent null proof.
 */
export type OutcomeKind = "materialised_slice" | "source_query_receipt" | "dependency_skip";

export interface ResultReceipt {
  invocationKey: string;
  path: string;
  status: string;
  outcomeKind: OutcomeKind;
  ledgerRows: number;
  /** Actual query result captured at the boundary. Null only for a skip. */
  sourceRowCount: number | null;
  sourceRowHash: string | null;
  /** Offline-recomputable slice of the frozen artifact. */
  materialisedRows: number | null;
  rowHash: string | null;
  /** Deterministic hash of the no-query envelope. Null unless a skip. */
  skipOutcomeHash: string | null;
  /** Hash of the transformed summary this invocation produced. */
  summaryHash: string | null;
  recomputable: boolean;
}

/**
 * C7.3 — for the invocations whose raw rows are not materialised, the
 * TRANSFORMED summary is recomputed from the artifact and hashed, so the
 * receipt still carries real proof.
 */
export function summaryBindingFor(
  artifact: Record<string, unknown>,
  req: CanonicalRequest,
): Record<string, unknown> | null {
  if (req.planKey === "runSchema") {
    return {
      observedRunColumns: [...(((at(artifact, "schemaContract.observedRunColumns") as string[]) ?? []))].sort(),
      missingRunColumns: [...(((at(artifact, "schemaContract.missingRunColumns") as string[]) ?? []))].sort(),
      compatibility: text(at(artifact, "schemaContract.compatibility")),
    };
  }
  const perBinding = ((at(artifact, "canonicalDecisions.perBinding") as Row[] | undefined) ?? []).find(
    (r) => rowBusinessId(r) === req.businessId && rowProviderAccountId(r) === req.providerAccountId,
  );
  if (!perBinding) return null;
  if (req.planKey === "canonicalLatestAsOf") {
    return { latestAsOf: text(perBinding.latest_as_of), latestStatus: text(perBinding.latest_status) };
  }
  if (req.planKey === "canonicalIdentities") {
    return {
      identityStatus: text(perBinding.identity_status),
      membership: perBinding.membership ?? null,
      labelCensus: perBinding.label_census ?? null,
      authorizedCensus: perBinding.authorized_census ?? null,
      engineVersionsAtLatest: num(perBinding.engine_versions_at_latest),
    };
  }
  return null;
}

/**
 * C6.2 — recomputes each invocation's materialised slice and compares it to the
 * ledger. A successful row count with an absent slice, or a failed/skipped read
 * with rows present, is a contradiction.
 */
export function reconcileInvocationResults(artifact: Record<string, unknown>): {
  violations: ScopeCutoffViolation[];
  receipts: ResultReceipt[];
} {
  const violations: ScopeCutoffViolation[] = [];
  const receipts: ResultReceipt[] = [];
  const dispositions = buildExpectedDispositions(artifact);
  const ledger = (at(artifact, "provenance.readLedger") as Row[] | undefined) ?? [];

  for (const row of ledger) {
    const key = text(row.invocationKey);
    if (!key) continue;
    const disposition = dispositions.get(key);
    if (!disposition) continue;
    const req = disposition.request;
    const binding = D080_RESULT_BINDING[req.planKey];
    const status = text(row.status) ?? "";
    const ledgerRows = num(row.rows) ?? 0;
    if (!binding) {
      violations.push({ section: "provenance.readLedger", reason: "result_binding_missing", detail: `${key} has no result binding` });
      continue;
    }
    if (disposition.disposition === "dependency_skip") {
      receipts.push({
        invocationKey: key, path: binding.path, status, ledgerRows,
        materialisedRows: null, rowHash: null, recomputable: false,
        outcomeKind: "dependency_skip",
        sourceRowCount: null, sourceRowHash: null,
        skipOutcomeHash: text(row.skipOutcomeHash),
        summaryHash: null,
      });
      continue;
    }
    const summary = summaryBindingFor(artifact, req);
    if (binding.select === null) {
      // C7.3 — a source-query receipt: raw rows are not materialised, so the
      // raw hash comes from the boundary and the transformed summary is bound.
      receipts.push({
        invocationKey: key, path: binding.path, status, outcomeKind: "source_query_receipt",
        ledgerRows, sourceRowCount: num(row.sourceRowCount), sourceRowHash: text(row.sourceRowHash),
        materialisedRows: null, rowHash: null, skipOutcomeHash: null,
        summaryHash: summary === null ? null : sha256Canonical(summary),
        recomputable: false,
      });
      if (status === "ok" && summary === null) {
        violations.push({ section: "invocationResults.receipts", reason: "result_count_mismatch", detail: `${key}: a source-query receipt must bind a transformed summary` });
      }
      continue;
    }
    const all = materialiseRows(at(artifact, binding.path)) ?? [];
    const slice = binding.select(all, req);
    const materialisedRows = slice.length;
    receipts.push({
      invocationKey: key, path: binding.path, status, outcomeKind: "materialised_slice",
      ledgerRows, sourceRowCount: num(row.sourceRowCount), sourceRowHash: text(row.sourceRowHash),
      materialisedRows, rowHash: sha256Canonical(slice), skipOutcomeHash: null,
      summaryHash: summary === null ? null : sha256Canonical(summary),
      recomputable: true,
    });
    if (status === "ok") {
      if (ledgerRows !== materialisedRows) {
        violations.push({ section: "provenance.readLedger", reason: "result_count_mismatch", detail: `${key}: ledger says ${ledgerRows} rows, ${binding.path} holds ${materialisedRows}` });
      }
      // C8.5 — a value-preserving transform must reproduce the boundary hash
      // EXACTLY. Otherwise the source-to-materialisation link is circular.
      if (binding.transform === "identity" || binding.transform === "columnar_roundtrip") {
        const recomputed = sha256Canonical(slice);
        if (text(row.sourceRowHash) !== recomputed) {
          violations.push({
            section: "provenance.readLedger",
            reason: "source_materialisation_mismatch",
            detail: `${key}: boundary sourceRowHash ${String(text(row.sourceRowHash)).slice(0, 12)}… != recomputed ${binding.transform} slice hash ${recomputed.slice(0, 12)}…`,
          });
        }
      }
    } else if (materialisedRows > 0) {
      violations.push({ section: "provenance.readLedger", reason: "result_count_mismatch", detail: `${key}: status ${status} but ${materialisedRows} rows are materialised` });
    }
  }
  return { violations, receipts };
}

/**
 * C6.1/C7.1 — compares the recorded ledger to the rebuilt expected disposition.
 * Nothing is waived because a row is a skip: a skip must carry the exact
 * identity, explicit nulls, the deterministic code, the missing-prerequisite
 * set, the reason and the outcome hash.
 */
export function reconcileRequestProvenance(artifact: Record<string, unknown>): ScopeCutoffViolation[] {
  const violations: ScopeCutoffViolation[] = [];
  const expected = buildExpectedDispositions(artifact);
  const ledger = (at(artifact, "provenance.readLedger") as Row[] | undefined) ?? [];
  const bad = (key: string, detail: string) =>
    violations.push({ section: "provenance.readLedger", reason: "request_provenance_mismatch", detail: `${key}: ${detail}` });

  for (const row of ledger) {
    const key = text(row.invocationKey);
    if (!key) continue;
    const want = expected.get(key);
    if (!want) continue;
    const status = text(row.status) ?? "";
    if (!(D080_LEDGER_STATUSES as readonly string[]).includes(status)) {
      violations.push({ section: "provenance.readLedger", reason: "invocation_mismatch", detail: `${key}: status ${status} is not an allowed ledger status` });
    }
    const disposition = text(row.disposition);
    if (disposition !== want.disposition) {
      bad(key, `disposition ${String(disposition)} != expected ${want.disposition}`);
      continue;
    }
    const req = want.request as unknown as Record<string, unknown>;

    if (want.disposition === "dependency_skip") {
      // Identity must match exactly; everything a query would have carried
      // must be explicitly null; and the skip contract must match.
      for (const field of ["templateKey", "source", "businessId", "providerAccountId", "businessListHash", "grain"] as const) {
        if (canonicalJson((row as Record<string, unknown>)[field] ?? null) !== canonicalJson(req[field] ?? null)) {
          bad(key, `${field}: recorded ${JSON.stringify((row as Record<string, unknown>)[field] ?? null)} != rebuilt ${JSON.stringify(req[field] ?? null)}`);
        }
      }
      for (const field of ["statementSha256", "paramsSha256", "effectiveFrom", "effectiveTo", "knowledgeTo", "asOfDate", "limit"] as const) {
        if ((row as Record<string, unknown>)[field] !== null) {
          bad(key, `${field} must be explicitly null on a dependency skip, found ${JSON.stringify((row as Record<string, unknown>)[field])}`);
        }
      }
      if (text(row.dependencyCode) !== want.dependencyCode) bad(key, `dependencyCode ${String(text(row.dependencyCode))} != ${want.dependencyCode}`);
      if (canonicalJson([...((row.missingPrerequisites as string[] | null) ?? [])].sort()) !== canonicalJson(want.missingPrerequisites)) {
        bad(key, `missingPrerequisites ${JSON.stringify(row.missingPrerequisites)} != ${JSON.stringify(want.missingPrerequisites)}`);
      }
      if (text(row.reason) !== want.reason) bad(key, `reason ${String(text(row.reason))} != ${want.reason}`);
      if (text(row.skipOutcomeHash) !== want.skipOutcomeHash) bad(key, "skipOutcomeHash does not match the rebuilt skip envelope");
      if (status !== "not_run_dependency_failed") bad(key, `a dependency skip must carry status not_run_dependency_failed, found ${status}`);
      if ((num(row.rows) ?? 0) !== 0 || row.sourceRowCount !== null || row.sourceRowHash !== null) {
        bad(key, "a dependency skip must not claim any source result");
      }
      continue;
    }

    for (const field of REQUEST_PROOF_FIELDS) {
      const got = (row as Record<string, unknown>)[field] ?? null;
      const wantValue = req[field] ?? null;
      if (canonicalJson(got) !== canonicalJson(wantValue)) {
        bad(key, `${field}: recorded ${JSON.stringify(got)} != rebuilt ${JSON.stringify(wantValue)}`);
      }
    }
    if (row.dependencyCode !== null || row.missingPrerequisites !== null || row.skipOutcomeHash !== null) {
      bad(key, "an executed invocation must not carry skip fields");
    }
    // C7.3 — an executed invocation must carry an ACTUAL source result.
    if (typeof row.sourceRowCount !== "number" || typeof row.sourceRowHash !== "string") {
      bad(key, "an executed invocation must carry a source row count and hash");
    } else if (status === "ok" && row.sourceRowCount !== (num(row.rows) ?? -1)) {
      bad(key, `sourceRowCount ${row.sourceRowCount} != rows ${String(row.rows)}`);
    }
  }
  return violations;
}

/**
 * C7.5 — the canonical STABLE non-secret projection of a ledger row.
 *
 * `ms` is the only excluded field, because wall-clock duration is genuinely
 * nondeterministic between runs. Everything else is compared, so a failure row
 * with a forged source, statement hash or params hash can no longer pass a
 * four-field projection.
 */
export const LEDGER_NONDETERMINISTIC_FIELDS = ["ms"] as const;

export function stableLedgerProjection(row: Row): string {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if ((LEDGER_NONDETERMINISTIC_FIELDS as readonly string[]).includes(key)) continue;
    projected[key] = value ?? null;
  }
  return canonicalJson(projected);
}

/** C6.1/C7.5 — readFailures must be the exact canonical multiset of non-ok rows. */
export function reconcileFailureMultiset(artifact: Record<string, unknown>): ScopeCutoffViolation[] {
  const violations: ScopeCutoffViolation[] = [];
  const ledger = (at(artifact, "provenance.readLedger") as Row[] | undefined) ?? [];
  const failures = at(artifact, "provenance.readFailures") as Row[] | undefined;
  if (!Array.isArray(failures)) return violations;
  const expected = ledger.filter((r) => text(r.status) !== "ok").map(stableLedgerProjection).sort();
  const got = failures.map(stableLedgerProjection).sort();
  if (canonicalJson(expected) !== canonicalJson(got)) {
    const expectedKeys = new Set(expected);
    const forged = got.filter((g) => !expectedKeys.has(g)).length;
    violations.push({
      section: "provenance.readFailures",
      reason: "failure_multiset_mismatch",
      detail: `readFailures is not the exact non-ok ledger multiset over the complete stable projection (expected ${expected.length}, got ${got.length}, ${forged} row(s) with no matching ledger row)`,
    });
  }
  return violations;
}

/**
 * C8.1 — the SHARED prerequisite resolution. Extraction and the orchestration
 * test both consume this shape, so a test can inject a binding whose cutoff is
 * valid while `seriesFrom` is missing and exercise the real dependent-skip path.
 */
export interface BindingPrereq {
  businessId: string;
  providerAccountId: string;
  cutoff: string | null;
  seriesFrom: string | null;
  cutoffStatus: string;
  perSource: Record<string, string | null>;
}

export function seriesFromForCutoff(cutoff: string | null): string | null {
  if (!cutoff) return null;
  return new Date(Date.parse(`${cutoff}T00:00:00.000Z`) - BUDGET_SERIES_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The exact missing-prerequisite set for a binding. Never a fixed pair. */
export function missingPrereqsFor(prereq: { cutoff: string | null; seriesFrom: string | null }): string[] {
  return [prereq.cutoff ? null : "cutoff", prereq.seriesFrom ? null : "series_from"].filter(
    (x): x is string => x !== null,
  );
}

export type ScopeCutoffReason =
  | "unpinned_binding"
  | "unpinned_business"
  | "missing_identity"
  | "effective_after_cutoff"
  | "knowledge_after_cutoff"
  | "unhandled_row_bearing_section"
  // C9.1 — dependency-coverage reasons.
  | "dependency_coverage_mismatch"
  | "dependency_code_mismatch"
  | "dependency_missing_set_mismatch"
  | "dependency_plan_mismatch"
  | "dependency_family_mismatch"
  | "dependency_matrix_hole"
  | "dependency_state_not_stated"
  // C10.1 — full stable-projection reasons.
  | "dependency_cell_unexpected_field"
  | "dependency_cell_field_missing"
  | "dependency_cell_field_mismatch"
  | "dependency_cell_identity_mismatch"
  | "dependency_cell_grain_mismatch"
  | "dependency_cell_rows_invalid"
  | "dependency_cell_projection_mismatch"
  | "required_section_missing"
  | "ledger_plan_mismatch"
  | "coverage_key_mismatch"
  | "claim_contradiction"
  | "artifact_shape"
  | "invocation_mismatch"
  | "request_provenance_mismatch"
  | "result_count_mismatch"
  | "result_binding_missing"
  | "failure_multiset_mismatch"
  | "source_materialisation_mismatch";

export interface ScopeCutoffViolation {
  section: string;
  reason: ScopeCutoffReason;
  detail: string;
}

export interface SectionCoverage {
  section: string;
  handler: SectionHandlerKind;
  rows: number;
  scopeChecked: number;
  effectiveChecked: number;
  knowledgeChecked: number;
  aggregateChecked: number;
  exemptedFields: string[];
}

/** Counters that say exactly what was checked, and how. */
export interface InvariantCounters {
  discoveredRowSets: number;
  registeredSections: number;
  requiredSectionsExpected: number;
  requiredSectionsPresent: number;
  totalRows: number;
  scopeCheckedRows: number;
  effectiveTimeCheckedFields: number;
  knowledgeTimeCheckedFields: number;
  /** Comparisons that actually compared two independent things. */
  crossSectionReconciliations: number;
  /** Rows carrying a DB aggregate that cannot be recomputed offline. */
  sourceAggregateRows: number;
  exemptedClockFields: number;
  expectedInvocations: number;
  observedInvocations: number;
  /** Invocations whose materialised slice was recomputed and compared. */
  invocationResultReceipts: number;
  recomputableResultReceipts: number;
  /** Exact key matrices recomputed from their own rows. */
  matrixChecks: number;
}

function readPath(artifact: Record<string, unknown>, path: string[]): unknown {
  let node: unknown = artifact;
  for (const key of path) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Row arrays the registry must account for, including columnar tables. */
function materialiseRows(node: unknown): Row[] | null {
  // C5.1 — EVERY array is a section. Correction 4 treated a non-empty scalar
  // array as "not row-bearing", so populating truthyBefore or unexpectedExtra
  // made the section vanish from discovery entirely.
  if (Array.isArray(node)) return node as Row[];
  if (node && typeof node === "object") {
    const table = node as Partial<ColumnarTable>;
    if (Array.isArray(table.columns) && Array.isArray(table.rows)) {
      return fromColumnar(node as ColumnarTable);
    }
  }
  return null;
}

/**
 * C4.1 — EXHAUSTIVE discovery. There is no depth cap: the previous version
 * stopped at `path.length > 3`, so a row set at `a.b.c.rows` was invisible to
 * the completeness check. Traversal stops only when a row set is identified,
 * so we never walk inside the rows themselves.
 */
export function discoverRowBearingSections(artifact: Record<string, unknown>): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string[]) => {
    if (materialiseRows(node) !== null) {
      found.push(path.join("."));
      return;
    }
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (path.length === 0 && HASH_META_KEYS.has(key)) continue;
        walk(value, [...path, key]);
      }
    }
  };
  for (const [key, value] of Object.entries(artifact)) {
    if (HASH_META_KEYS.has(key)) continue;
    walk(value, [key]);
  }
  return found.sort();
}

/**
 * C4.1 — identity accessors that accept BOTH conventions.
 *
 * `provenance.readLedger` rows use camelCase (`businessId`), while database
 * rows use snake_case. The previous scan read only snake_case, so an unpinned
 * camelCase row passed while still incrementing the "checked" counter.
 */
export function rowBusinessId(row: Row): string | null {
  return text(row.business_id) ?? text(row.businessId) ?? null;
}
export function rowProviderAccountId(row: Row): string | null {
  return text(row.provider_account_id) ?? text(row.providerAccountId) ?? null;
}

/**
 * Sections the contract REQUIRES. A freshly sealed artifact that has dropped
 * one of these is not a smaller valid package — it is a missing evidence
 * package, and it must fail. An empty array is valid data; an absent section
 * is not.
 */
export const D080_REQUIRED_SECTIONS = [
  "dependencyCoverage.cells",
  "provenance.readLedger",
  "provenance.readFailures",
  "scope.pinnedBindings",
  "clocks.perBinding",
  "clocks.perSource",
  "observationCoverage.providerObservationFreshness",
  "observationCoverage.stateChangeCheckpointDensity",
  "unitEvidence.rows",
  "unitEvidence.coverageMatrix",
  "series",
  "ownershipObservations",
  "ownershipCoverage.aggregate",
  "configStates.pointInTime",
  "configStates.retrospective",
  "configStates.identities",
  "configStates.coverage",
  "canonicalDecisions.perBinding",
  "canonicalDecisions.servedDate",
  "canonicalDecisions.servedDateCoverage",
  "invocationResults.receipts",
  "canonicalDecisions.budgetVerbCensus",
  "campaignRole.rows",
  "campaignRole.census",
  "targetPackHistory",
] as const;

/**
 * C4.1 — registry-driven invariant scan.
 *
 * Scope validation is now SEPARATE from clock exceptions: a
 * `source_clock_exception` waives only the named clock bound and never the
 * pinned business/account membership check. Every counter is reported
 * distinctly, because "the handler visited this row" is not "this row's bounds
 * were checked".
 */
export function scanScopeAndCutoff(artifact: Record<string, unknown>): {
  ok: boolean;
  counters: InvariantCounters;
  coverage: SectionCoverage[];
  matrixAudits: MatrixAuditRecord[];
  unhandledSections: string[];
  missingRequiredSections: string[];
  violations: ScopeCutoffViolation[];
} {
  const violations: ScopeCutoffViolation[] = [];
  const coverage: SectionCoverage[] = [];
  let matrixAuditRecords: MatrixAuditRecord[] = [];
  const counters: InvariantCounters = {
    discoveredRowSets: 0, registeredSections: 0,
    requiredSectionsExpected: D080_REQUIRED_SECTIONS.length, requiredSectionsPresent: 0,
    totalRows: 0, scopeCheckedRows: 0, effectiveTimeCheckedFields: 0,
    knowledgeTimeCheckedFields: 0, crossSectionReconciliations: 0, sourceAggregateRows: 0,
    exemptedClockFields: 0, expectedInvocations: 0, observedInvocations: 0,
    invocationResultReceipts: 0, recomputableResultReceipts: 0, matrixChecks: 0,
  };

  // Per-binding cutoffs, plus a per-business cutoff for business-scoped rows
  // that carry no account. A row effective after EVERY binding cutoff of its
  // business was knowable at none of them.
  const cutoffs = new Map<string, string>();
  const businessCutoffs = new Map<string, string>();
  for (const row of (readPath(artifact, ["clocks", "perBinding"]) as Row[] | undefined) ?? []) {
    const businessId = rowBusinessId(row);
    const account = rowProviderAccountId(row);
    const cutoff = text(row.cutoff);
    if (!cutoff || !businessId) continue;
    if (account) cutoffs.set(bindingKey(businessId, account), cutoff);
    const current = businessCutoffs.get(businessId);
    if (!current || cutoff > current) businessCutoffs.set(businessId, cutoff);
  }

  const present = discoverRowBearingSections(artifact);
  counters.discoveredRowSets = present.length;
  const handled = new Set(Object.keys(D080_SECTION_HANDLERS));
  const unhandledSections = present.filter((p) => !handled.has(p));
  for (const section of unhandledSections) {
    violations.push({ section, reason: "unhandled_row_bearing_section", detail: "row-bearing section has no entry in D080_SECTION_HANDLERS" });
  }

  const missingRequiredSections = D080_REQUIRED_SECTIONS.filter(
    (section) => materialiseRows(readPath(artifact, D080_SECTION_HANDLERS[section]?.path ?? section.split("."))) === null,
  );
  counters.requiredSectionsPresent = D080_REQUIRED_SECTIONS.length - missingRequiredSections.length;
  for (const section of missingRequiredSections) {
    violations.push({ section, reason: "required_section_missing", detail: "the contract requires this evidence section; an absent section is not an empty one" });
  }

  const checkTime = (
    section: string, row: Row, fields: string[], cutoff: string | undefined,
    reason: "effective_after_cutoff" | "knowledge_after_cutoff",
    handlerNullableFields: string[] = [],
  ): number => {
    let checked = 0;
    for (const field of fields) {
      const value = (text(row[field]) ?? "").slice(0, 10);
      // C5.1 — a declared field may not silently skip. A missing value or a
      // missing cutoff is a failure unless the handler marks the field
      // explicitly nullable, which is a decision, not an accident.
      const nullable = new Set(handlerNullableFields).has(field);
      if (!value) {
        if (!nullable) violations.push({ section, reason, detail: `${field} is absent and is not declared nullable` });
        continue;
      }
      if (!cutoff) {
        violations.push({ section, reason, detail: `${field} present but no cutoff is resolvable for this row` });
        continue;
      }
      checked += 1;
      if (value > cutoff) violations.push({ section, reason, detail: `${field} ${value} > ${cutoff}` });
    }
    return checked;
  };

  for (const [section, handler] of Object.entries(D080_SECTION_HANDLERS)) {
    const rows = materialiseRows(readPath(artifact, handler.path));
    if (rows === null) continue;
    counters.registeredSections += 1;
    counters.totalRows += rows.length;
    const tally = { scope: 0, effective: 0, knowledge: 0, aggregate: 0 };

    for (const row of rows) {
      const businessId = rowBusinessId(row);
      const account = rowProviderAccountId(row);
      const scopeKind: SectionScopeKind =
        handler.scope ??
        (handler.kind === "pinned_binding"
          ? "pinned_binding"
          : handler.kind === "pinned_business"
            ? "pinned_business"
            : handler.kind === "static_schema" || handler.kind === "scalar_list"
              ? "none"
              : "identity_optional");

      // --- scope, applied to EVERY handler kind that carries identity ------
      if (scopeKind === "pinned_binding") {
        tally.scope += 1;
        if (!isPinnedBinding(businessId, account)) {
          violations.push({ section, reason: "unpinned_binding", detail: `${businessId ?? "?"}|${account ?? "?"}` });
          continue;
        }
      } else if (scopeKind === "pinned_business") {
        tally.scope += 1;
        if (!isPinnedBusiness(businessId)) {
          violations.push({ section, reason: "unpinned_business", detail: String(businessId ?? "?") });
          continue;
        }
        if (account !== null && !isPinnedBinding(businessId, account)) {
          violations.push({ section, reason: "unpinned_binding", detail: `${businessId}|${account}` });
          continue;
        }
      } else if (scopeKind === "identity_optional") {
        // Aggregates and derived lists: scope is checked when identity exists.
        if (businessId !== null || account !== null) {
          tally.scope += 1;
          if (account !== null ? !isPinnedBinding(businessId, account) : !isPinnedBusiness(businessId)) {
            violations.push({ section, reason: account !== null ? "unpinned_binding" : "unpinned_business", detail: `${businessId ?? "?"}|${account ?? "-"}` });
            continue;
          }
        } else if (handler.requireIdentity) {
          tally.scope += 1;
          violations.push({ section, reason: "missing_identity", detail: "row carries neither a business nor an account and the handler requires one" });
          continue;
        }
      }

      // --- clocks: an exception waives ONLY the fields it names ------------
      const cutoff = account ? cutoffs.get(bindingKey(businessId!, account)) : businessId ? businessCutoffs.get(businessId) : undefined;
      const exempt = new Set(handler.exemptClockFields ?? []);
      const effectiveFields = (handler.effectiveFields ?? []).filter((f) => !exempt.has(f));
      const knowledgeFields = (handler.knowledgeFields ?? []).filter((f) => !exempt.has(f));
      counters.exemptedClockFields += (handler.effectiveFields ?? []).length + (handler.knowledgeFields ?? []).length - effectiveFields.length - knowledgeFields.length;
      tally.effective += checkTime(section, row, effectiveFields, cutoff, "effective_after_cutoff", handler.nullableFields ?? []);
      tally.knowledge += checkTime(section, row, knowledgeFields, cutoff, "knowledge_after_cutoff", handler.nullableFields ?? []);
    }

    counters.scopeCheckedRows += tally.scope;
    counters.effectiveTimeCheckedFields += tally.effective;
    counters.knowledgeTimeCheckedFields += tally.knowledge;
    coverage.push({
      section, handler: handler.kind, rows: rows.length,
      scopeChecked: tally.scope, effectiveChecked: tally.effective,
      knowledgeChecked: tally.knowledge, aggregateChecked: tally.aggregate,
      exemptedFields: handler.exemptClockFields ?? [],
    });
  }

  // --- C5.1: full artifact shape and provenance truth ---------------------
  for (const shape of validateArtifactShape(artifact)) {
    violations.push({ section: shape.path, reason: "artifact_shape", detail: `${shape.reason}: ${shape.detail}` });
  }

  // --- C5.2: exact invocation reconciliation ------------------------------
  const ledgerRows = (readPath(artifact, ["provenance", "readLedger"]) as Row[] | undefined) ?? [];
  const expectedInvocations = buildExpectedInvocations();
  counters.expectedInvocations = expectedInvocations.length;
  counters.observedInvocations = ledgerRows.length;
  for (const mismatch of reconcileInvocations(ledgerRows, expectedInvocations)) {
    violations.push({ section: "provenance.readLedger", reason: "invocation_mismatch", detail: `${mismatch.reason}: ${mismatch.invocationKey} — ${mismatch.detail}` });
  }
  violations.push(...reconcileLedgerAndPlan(artifact));

  // --- C6.1: the recorded ledger must match the REBUILT canonical requests --
  violations.push(...reconcileRequestProvenance(artifact));
  violations.push(...reconcileFailureMultiset(artifact));
  violations.push(...reconcileDependencyCoverage(artifact));

  // --- C6.2: every invocation bound to its materialised result -------------
  const resultCheck = reconcileInvocationResults(artifact);
  violations.push(...resultCheck.violations);
  const storedReceipts = (at(artifact, "invocationResults.receipts") as Row[] | undefined) ?? [];
  if (storedReceipts.length > 0) {
    const recomputed = new Map(resultCheck.receipts.map((r) => [r.invocationKey, r]));
    const audit = auditExpectedKeys(
      resultCheck.receipts.map((r) => r.invocationKey),
      storedReceipts.map((r) => String(text(r.invocationKey) ?? "")),
    );
    if (!audit.ok) {
      violations.push({ section: "invocationResults.receipts", reason: "result_count_mismatch", detail: `receipt set mismatch: missing ${JSON.stringify(audit.missing.slice(0, 3))}, duplicates ${JSON.stringify(audit.duplicates.slice(0, 3))}, unexpected ${JSON.stringify(audit.unexpected.slice(0, 3))}` });
    }
    for (const stored of storedReceipts) {
      const key = text(stored.invocationKey) ?? "";
      const want = recomputed.get(key);
      if (!want) continue;
      for (const field of ["status", "outcomeKind", "ledgerRows", "sourceRowCount", "sourceRowHash", "materialisedRows", "rowHash", "skipOutcomeHash", "summaryHash", "recomputable", "path"] as const) {
        if (canonicalJson(stored[field] ?? null) !== canonicalJson((want as unknown as Record<string, unknown>)[field] ?? null)) {
          violations.push({ section: "invocationResults.receipts", reason: "result_count_mismatch", detail: `${key}.${field}: stored ${JSON.stringify(stored[field] ?? null)} != recomputed ${JSON.stringify((want as unknown as Record<string, unknown>)[field] ?? null)}` });
        }
      }
    }
  }
  counters.invocationResultReceipts = resultCheck.receipts.length;
  counters.recomputableResultReceipts = resultCheck.receipts.filter((r) => r.recomputable).length;

  // --- C5.3/C5.4/C5.5: recomputed coverage, claims, cross-section sums ----
  const reconciled = reconcileCoverageAndClaims(artifact);
  violations.push(...reconciled.violations);
  counters.crossSectionReconciliations = reconciled.crossSectionReconciliations;
  counters.sourceAggregateRows = reconciled.sourceAggregateRows;
  counters.matrixChecks = reconciled.matrixAudits.length;
  matrixAuditRecords = reconciled.matrixAudits;
  violations.push(...reconcileClaims(artifact));

  return {
    ok: violations.length === 0,
    counters,
    coverage: coverage.sort((a, b) => a.section.localeCompare(b.section)),
    matrixAudits: matrixAuditRecords,
    unhandledSections,
    missingRequiredSections,
    violations: violations.slice(0, 60),
  };
}

export function verifyArtifact(artifact: Record<string, unknown>): {
  ok: boolean;
  failures: string[];
  checkedSections: number;
  scope: ReturnType<typeof scanScopeAndCutoff>;
} {
  const failures: string[] = [];
  const stored = artifact.sectionHashes as Record<string, string> | undefined;
  const scope = scanScopeAndCutoff(artifact);
  if (!stored) {
    return { ok: false, failures: ["sectionHashes missing"], checkedSections: 0, scope };
  }
  const recomputed = computeSectionHashes(artifact);
  const storedKeys = Object.keys(stored).sort();
  const recomputedKeys = Object.keys(recomputed).sort();
  if (canonicalJson(storedKeys) !== canonicalJson(recomputedKeys)) {
    failures.push(`section manifest mismatch: stored [${storedKeys.join(",")}] vs present [${recomputedKeys.join(",")}]`);
  }
  for (const key of recomputedKeys) {
    if (stored[key] === undefined) failures.push(`section ${key} is not covered by a stored hash`);
    else if (stored[key] !== recomputed[key]) failures.push(`section ${key} hash stale`);
  }
  if (artifact.artifactHash !== sha256Canonical(stored)) failures.push("artifactHash stale");
  for (const violation of scope.violations) {
    failures.push(`${violation.section}: ${violation.reason} (${violation.detail})`);
  }
  return { ok: failures.length === 0, failures, checkedSections: recomputedKeys.length, scope };
}

// ---------------------------------------------------------------------------
// Query contract — every query is account-scoped and two-sided
// ---------------------------------------------------------------------------

export const D080_QUERIES = {
  /** R1: the schema contract must be probed before anything is reconstructed. */
  runSchema: `
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='meta_entity_observation_runs'
     ORDER BY column_name`,

  /** R2: the decision vocabulary, read from the constraint itself. */
  decisionVocabulary: `
    SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'engine_v3_ad_decision_snapshots_daily' AND c.contype = 'c'
       AND c.conname = ANY($1::text[])
     ORDER BY 1`,

  /** R5: prove the pinned matrix against the database. */
  bindings: `
    SELECT business_id, provider_account_id, is_selected
      FROM business_provider_accounts
     WHERE provider='meta' AND business_id = ANY($1::text[])
     ORDER BY business_id, provider_account_id`,

  /** R5: per-binding effective clocks. One row per (source, binding, grain). */
  clockCampaignDaily: `
    SELECT 'meta_campaign_daily' AS source, 'campaign' AS grain, $1::text AS business_id,
           $2::text AS provider_account_id, max(date)::text AS latest_effective,
           min(date)::text AS earliest_effective, count(*)::bigint AS rows
      FROM meta_campaign_daily WHERE business_id=$1::text AND provider_account_id=$2::text`,
  clockAdsetDaily: `
    SELECT 'meta_adset_daily' AS source, 'adset' AS grain, $1::text AS business_id,
           $2::text AS provider_account_id, max(date)::text AS latest_effective,
           min(date)::text AS earliest_effective, count(*)::bigint AS rows
      FROM meta_adset_daily WHERE business_id=$1::text AND provider_account_id=$2::text`,
  clockCampaignConfig: `
    SELECT 'meta_campaign_config_history' AS source, 'campaign' AS grain, $1::text AS business_id,
           $2::text AS provider_account_id, max(effective_from)::text AS latest_effective,
           min(effective_from)::text AS earliest_effective, count(*)::bigint AS rows
      FROM meta_campaign_config_history WHERE business_id=$1::text AND provider_account_id=$2::text`,
  clockAdsetConfig: `
    SELECT 'meta_adset_config_history' AS source, 'adset' AS grain, $1::text AS business_id,
           $2::text AS provider_account_id, max(effective_from)::text AS latest_effective,
           min(effective_from)::text AS earliest_effective, count(*)::bigint AS rows
      FROM meta_adset_config_history
     WHERE business_id=$1::text AND provider_account_id=$2::text AND effective_from >= $3::date`,

  /**
   * R1: the three DISTINCT coverage concepts, kept apart.
   * `state_change_days` is change/checkpoint density — how often stored truth
   * CHANGED. `heartbeat_*` is provider observation freshness — how recently
   * truth was CONFIRMED, including byte-identical re-observations that
   * coalesced into the run instead of rewriting state rows.
   */
  observationCoverage: `
    SELECT $1::text AS business_id, $2::text AS provider_account_id,
           $3::text AS entity_type, run.endpoint, run.completeness,
           count(*)::bigint AS runs,
           max(COALESCE(run.last_seen_at, run.observed_at))::text AS heartbeat_last_seen,
           max(run.observed_at)::text AS latest_run_observed,
           max(run.captured_at)::text AS latest_run_captured,
           -- last_seen_at is MONOTONIC and advances on byte-identical
           -- re-observation, so it can legitimately exceed the window's upper
           -- bound: that is precisely the confirmation the state rows omit.
           max(run.repeat_count)::bigint AS max_repeat_count,
           sum(run.repeat_count)::bigint AS total_repeats
      FROM meta_entity_observation_runs run
     WHERE run.business_id=$1::text AND run.provider_account_id=$2::text
       AND run.entity_type=$3::text
       AND run.observed_at >= $4::date AND run.observed_at < ($5::date + 1)
     GROUP BY run.endpoint, run.completeness
     ORDER BY run.endpoint, run.completeness`,
  stateChangeDensity: `
    SELECT $1::text AS business_id, $2::text AS provider_account_id, $3::text AS entity_type,
           count(DISTINCT observed_at::date)::bigint AS state_change_days,
           count(*)::bigint AS state_rows,
           count(DISTINCT COALESCE(campaign_id,''))::bigint AS distinct_campaigns,
           max(observed_at)::text AS latest_state_observed,
           min(observed_at)::text AS earliest_state_observed
      FROM meta_entity_state_history
     WHERE business_id=$1::text AND provider_account_id=$2::text AND entity_type=$3::text
       AND observed_at >= $4::date AND observed_at < ($5::date + 1)`,

  /**
   * R8: full-window ownership aggregate, per binding and grain.
   *
   * The row-level dump below is bounded to a recent lineage window: with strict
   * PIT refused by the schema contract, half a million raw state rows per
   * account would add no analytic power and would bloat the artifact. This
   * aggregate keeps the full-window shape — including the same-clock competitor
   * count that R8's arbitration must refuse — at bounded cost.
   */
  ownershipAggregate: `
    SELECT $1::text AS business_id, $2::text AS provider_account_id, $3::text AS entity_type,
           count(*)::bigint AS state_rows,
           count(DISTINCT entity_id)::bigint AS entities,
           count(*) FILTER (WHERE presence <> 'present')::bigint AS not_present,
           count(*) FILTER (WHERE run_completeness <> 'complete')::bigint AS incomplete_run,
           count(*) FILTER (WHERE budget_origin = 'campaign')::bigint AS origin_campaign,
           count(*) FILTER (WHERE budget_origin = 'adset')::bigint AS origin_adset,
           count(*) FILTER (WHERE budget_origin = 'not_applicable')::bigint AS origin_not_applicable,
           count(*) FILTER (WHERE budget_origin IS NULL)::bigint AS origin_null,
           min(observed_at)::text AS earliest_observed,
           max(observed_at)::text AS latest_observed
      FROM meta_entity_state_history
     WHERE business_id=$1::text AND provider_account_id=$2::text AND entity_type=$3::text
       AND observed_at >= $4::date AND observed_at < ($5::date + 1)`,
  /** R8: same-clock competitors that disagree on truth, across the window. */
  ownershipSameClockConflicts: `
    SELECT $1::text AS business_id, $2::text AS provider_account_id, $3::text AS entity_type,
           count(*)::bigint AS conflicting_groups
      FROM (
        SELECT entity_id, observed_at, captured_at, created_at
          FROM meta_entity_state_history
         WHERE business_id=$1::text AND provider_account_id=$2::text AND entity_type=$3::text
           AND observed_at >= $4::date AND observed_at < ($5::date + 1)
         GROUP BY entity_id, observed_at, captured_at, created_at
        HAVING count(DISTINCT state_hash) > 1
      ) competitors`,

  /** R8: full lineage and quality columns, deterministically ordered. */
  ownershipObservations: `
    SELECT state.business_id, state.provider_account_id, state.entity_type,
           state.entity_id, state.campaign_id, state.adset_id, state.budget_origin,
           state.presence, state.run_completeness, run.endpoint,
           state.run_id::text AS run_id, state.state_hash, state.id::text AS id,
           state.observed_at::text AS observed_at, state.captured_at::text AS captured_at,
           state.created_at::text AS created_at,
           (state.campaign_daily_budget_raw IS NOT NULL) AS has_campaign_daily,
           (state.campaign_lifetime_budget_raw IS NOT NULL) AS has_campaign_lifetime,
           (state.adset_daily_budget_raw IS NOT NULL) AS has_adset_daily,
           (state.adset_lifetime_budget_raw IS NOT NULL) AS has_adset_lifetime
      FROM meta_entity_state_history state
      LEFT JOIN meta_entity_observation_runs run ON run.id = state.run_id
     WHERE state.business_id=$1::text AND state.provider_account_id=$2::text
       AND state.entity_type IN ('campaign','adset')
       AND state.observed_at >= $3::date AND state.observed_at < ($4::date + 1)
       -- Knowledge-time bound as well: a row captured after the cutoff was not
       -- knowable at it, and the artifact's declared window must hold for the
       -- recorded clock, not only the effective one.
       AND state.captured_at < ($4::date + 1)
     ORDER BY state.entity_id, state.observed_at DESC, state.captured_at DESC,
              state.created_at DESC, state.id DESC`,

  /** Series for the retrospective counterfactual. Two-sided, account-scoped. */
  seriesCampaign: `
    SELECT business_id, provider_account_id, 'campaign' AS grain, campaign_id AS entity_id,
           campaign_id AS parent_campaign_id, date::text AS effective_date,
           campaign_status AS status, account_currency, daily_budget, lifetime_budget,
           COALESCE(is_budget_mixed,FALSE) AS is_budget_mixed, spend, conversions, revenue,
           truth_state
      FROM meta_campaign_daily
     WHERE business_id=$1::text AND provider_account_id=$2::text
       AND date >= $3::date AND date <= $4::date`,
  seriesAdset: `
    SELECT business_id, provider_account_id, 'adset' AS grain, adset_id AS entity_id,
           campaign_id AS parent_campaign_id, date::text AS effective_date,
           adset_status AS status, account_currency, daily_budget, lifetime_budget,
           COALESCE(is_budget_mixed,FALSE) AS is_budget_mixed, spend, conversions, revenue,
           truth_state
      FROM meta_adset_daily
     WHERE business_id=$1::text AND provider_account_id=$2::text
       AND date >= $3::date AND date <= $4::date`,

  /** C1/C6: unit evidence per grain and per budget field, never coalesced. */
  unitEvidenceCampaignDaily: `
    SELECT $1::text AS business_id, $2::text AS provider_account_id, 'campaign' AS grain,
           'daily' AS budget_field, d.account_currency, count(*)::bigint AS compared,
           count(*) FILTER (WHERE abs(h.raw_num - d.daily_budget) < 0.0001)::bigint AS raw_equals_stored,
           count(*) FILTER (WHERE abs(h.raw_num / 100.0 - d.daily_budget) < 0.0001)::bigint AS raw_over_100,
           count(*) FILTER (WHERE abs(h.raw_num * 100.0 - d.daily_budget) < 0.0001)::bigint AS raw_times_100,
           count(*) FILTER (WHERE d.daily_budget = 0)::bigint AS zero_valued
      FROM (SELECT campaign_id, observed_at::date AS d,
                   NULLIF(campaign_daily_budget_raw,'')::double precision AS raw_num
              FROM meta_entity_state_history
             WHERE business_id=$1::text AND provider_account_id=$2::text
               AND observed_at >= $3::date AND observed_at < ($4::date + 1)
               AND campaign_daily_budget_raw ~ '^[0-9]+(\\.[0-9]+)?$') h
      JOIN meta_campaign_daily d ON d.business_id=$1::text AND d.provider_account_id=$2::text
       AND d.campaign_id = h.campaign_id AND d.date = h.d AND d.daily_budget IS NOT NULL
     GROUP BY d.account_currency`,
  unitEvidenceAdsetDaily: `
    SELECT $1::text AS business_id, $2::text AS provider_account_id, 'adset' AS grain,
           'daily' AS budget_field, d.account_currency, count(*)::bigint AS compared,
           count(*) FILTER (WHERE abs(h.raw_num - d.daily_budget) < 0.0001)::bigint AS raw_equals_stored,
           count(*) FILTER (WHERE abs(h.raw_num / 100.0 - d.daily_budget) < 0.0001)::bigint AS raw_over_100,
           count(*) FILTER (WHERE abs(h.raw_num * 100.0 - d.daily_budget) < 0.0001)::bigint AS raw_times_100,
           count(*) FILTER (WHERE d.daily_budget = 0)::bigint AS zero_valued
      FROM (SELECT adset_id, observed_at::date AS d,
                   NULLIF(adset_daily_budget_raw,'')::double precision AS raw_num
              FROM meta_entity_state_history
             WHERE business_id=$1::text AND provider_account_id=$2::text
               AND observed_at >= $3::date AND observed_at < ($4::date + 1)
               AND adset_daily_budget_raw ~ '^[0-9]+(\\.[0-9]+)?$') h
      JOIN meta_adset_daily d ON d.business_id=$1::text AND d.provider_account_id=$2::text
       AND d.adset_id = h.adset_id AND d.date = h.d AND d.daily_budget IS NOT NULL
     GROUP BY d.account_currency`,
  unitEvidenceCampaignLifetime: `
    SELECT $1::text AS business_id, $2::text AS provider_account_id, 'campaign' AS grain,
           'lifetime' AS budget_field, d.account_currency, count(*)::bigint AS compared,
           count(*) FILTER (WHERE abs(h.raw_num - d.lifetime_budget) < 0.0001)::bigint AS raw_equals_stored,
           count(*) FILTER (WHERE abs(h.raw_num / 100.0 - d.lifetime_budget) < 0.0001)::bigint AS raw_over_100,
           count(*) FILTER (WHERE abs(h.raw_num * 100.0 - d.lifetime_budget) < 0.0001)::bigint AS raw_times_100,
           count(*) FILTER (WHERE d.lifetime_budget = 0)::bigint AS zero_valued
      FROM (SELECT campaign_id, observed_at::date AS d,
                   NULLIF(campaign_lifetime_budget_raw,'')::double precision AS raw_num
              FROM meta_entity_state_history
             WHERE business_id=$1::text AND provider_account_id=$2::text
               AND observed_at >= $3::date AND observed_at < ($4::date + 1)
               AND campaign_lifetime_budget_raw ~ '^[0-9]+(\\.[0-9]+)?$') h
      JOIN meta_campaign_daily d ON d.business_id=$1::text AND d.provider_account_id=$2::text
       AND d.campaign_id = h.campaign_id AND d.date = h.d AND d.lifetime_budget IS NOT NULL
     GROUP BY d.account_currency`,

  unitEvidenceAdsetLifetime: `
    SELECT $1::text AS business_id, $2::text AS provider_account_id, 'adset' AS grain,
           'lifetime' AS budget_field, d.account_currency, count(*)::bigint AS compared,
           count(*) FILTER (WHERE abs(h.raw_num - d.lifetime_budget) < 0.0001)::bigint AS raw_equals_stored,
           count(*) FILTER (WHERE abs(h.raw_num / 100.0 - d.lifetime_budget) < 0.0001)::bigint AS raw_over_100,
           count(*) FILTER (WHERE abs(h.raw_num * 100.0 - d.lifetime_budget) < 0.0001)::bigint AS raw_times_100,
           count(*) FILTER (WHERE d.lifetime_budget = 0)::bigint AS zero_valued
      FROM (SELECT adset_id, observed_at::date AS d,
                   NULLIF(adset_lifetime_budget_raw,'')::double precision AS raw_num
              FROM meta_entity_state_history
             WHERE business_id=$1::text AND provider_account_id=$2::text
               AND observed_at >= $3::date AND observed_at < ($4::date + 1)
               AND adset_lifetime_budget_raw ~ '^[0-9]+(\\.[0-9]+)?$') h
      JOIN meta_adset_daily d ON d.business_id=$1::text AND d.provider_account_id=$2::text
       AND d.adset_id = h.adset_id AND d.date = h.d AND d.lifetime_budget IS NOT NULL
     GROUP BY d.account_currency`,

  /**
   * C3.7/C4.3 — the UI served-date contract, reproduced EXACTLY.
   *
   * `app/api/meta/decisions-workspace/route.ts` `resolveWorkspaceEndDate`
   * builds `creative_account_keys` from `meta_creative_dimensions` UNION
   * `meta_creative_daily`, applies the account-exclusivity rule, then takes the
   * maximum of three candidates. Correction 3 reproduced only the
   * `meta_creative_daily` half, so it was not the contract it claimed to be.
   *
   * SCOPE: this reproduces the DEFAULT path only — no explicit end date and a
   * non-null provider account. The route short-circuits before this query when
   * `explicitEndDate` is supplied (it is returned verbatim) or when the
   * provider account is null (it returns the previous UTC date). Those
   * fallbacks are described, never synthesised as observed evidence.
   */
  servedDateCandidates: `
    WITH creative_account_keys AS (
      SELECT DISTINCT business_id, provider_account_id, creative_id
        FROM meta_creative_dimensions
       WHERE business_id = $1::text
      UNION
      SELECT DISTINCT business_id, provider_account_id, creative_id
        FROM meta_creative_daily
       WHERE business_id = $1::text
    ), creative_account_scope AS (
      SELECT creative_id
        FROM creative_account_keys
       GROUP BY creative_id
      HAVING count(DISTINCT provider_account_id) = 1
         AND min(provider_account_id) = $2::text
    )
    SELECT $1::text AS business_id, $2::text AS provider_account_id,
           (SELECT max(as_of_date)::text FROM engine_v3_ad_decision_snapshots_daily
             WHERE business_ref_id = $1::uuid AND business_id = $1::text
               AND provider_account_id = $2::text) AS native_ad_max,
           (SELECT max(snapshot.as_of_date)::text
              FROM engine_v3_decision_snapshots_daily snapshot
              INNER JOIN creative_account_scope account_scope
                ON account_scope.creative_id = snapshot.creative_id
             WHERE snapshot.business_id::text = $1::text) AS legacy_creative_max,
           (SELECT max(as_of_date)::text FROM engine_v3_job_runs
             WHERE business_ref_id = $1::uuid AND business_id = $1::text
               AND job_name = 'engine_v3_native_ad_decisions_shadow_job') AS native_job_run_max`,

  /** R2: the canonical projection — latest generation per pinned binding. */
  canonicalLatestAsOf: `
    SELECT max(as_of_date)::text AS latest_as_of
      FROM engine_v3_ad_decision_snapshots_daily
     WHERE business_id=$1::text AND provider_account_id=$2::text`,
  canonicalIdentities: `
    SELECT business_id, provider_account_id, as_of_date::text AS as_of_date, engine_version,
           decision_entity_id, ad_id, scope_type, scope_id, input_hash, decision_hash,
           COALESCE(evaluation_id::text,'') AS evaluation_id,
           COALESCE(job_run_id::text,'') AS job_run_id,
           computed_at::text AS computed_at, label, raw_label,
           COALESCE(authorized_action,'') AS authorized_action,
           COALESCE(blocked_action_type,'') AS blocked_action_type
      FROM engine_v3_ad_decision_snapshots_daily
     WHERE business_id=$1::text AND provider_account_id=$2::text AND as_of_date=$3::date`,
  /**
   * R2: the FULL in-scope population as the denominator, with typed-budget
   * counts as FILTERs. A WHERE that prefilters for impossible values reports a
   * denominator of zero and proves nothing.
   */
  budgetVerbCensus: `
    SELECT $1::text AS business_id, $2::text AS provider_account_id,
           count(*)::bigint AS scanned_rows,
           count(*) FILTER (WHERE label = ANY($3::text[]))::bigint AS typed_budget_label,
           count(*) FILTER (WHERE authorized_action = ANY($3::text[]))::bigint AS typed_budget_authorized,
           count(*) FILTER (WHERE blocked_action_type = ANY($3::text[]))::bigint AS typed_budget_blocked,
           count(*) FILTER (WHERE label IN ('scale','cut'))::bigint AS creative_scale_or_cut,
           count(DISTINCT engine_version)::bigint AS engine_versions,
           count(DISTINCT as_of_date)::bigint AS generations
      FROM engine_v3_ad_decision_snapshots_daily
     WHERE business_id=$1::text AND provider_account_id=$2::text AND as_of_date <= $4::date`,
  engineVersionOverlap: `
    SELECT $1::text AS business_id, $2::text AS provider_account_id,
           as_of_date::text AS as_of_date, count(DISTINCT engine_version)::bigint AS versions,
           count(*)::bigint AS rows
      FROM engine_v3_ad_decision_snapshots_daily
     WHERE business_id=$1::text AND provider_account_id=$2::text AND as_of_date <= $3::date
     GROUP BY as_of_date HAVING count(DISTINCT engine_version) > 1
     ORDER BY as_of_date`,

  /** R3: role rows with every authority column carried, not discarded. */
  campaignRole: `
    SELECT business_id, provider_account_id, campaign_id, as_of_date::text AS as_of_date,
           created_at::text AS recorded_at, updated_at::text AS updated_at,
           inferred_kind, confidence_class, confidence_score, resolver_version, kind_source,
           (updated_at > created_at) AS overwritten_after_insert
      FROM engine_v3_campaign_context_daily
     WHERE business_id=$1::text AND as_of_date >= $2::date AND as_of_date <= $3::date`,
  campaignRoleCensus: `
    SELECT $1::text AS business_id, count(*)::bigint AS rows,
           count(*) FILTER (WHERE provider_account_id IS NOT NULL)::bigint AS account_scoped,
           count(*) FILTER (WHERE inferred_kind IS NULL)::bigint AS null_kind,
           count(*) FILTER (WHERE confidence_class = 'conflict')::bigint AS conflict,
           count(*) FILTER (WHERE confidence_class = 'unknown')::bigint AS unknown_confidence,
           count(*) FILTER (WHERE confidence_class = 'low')::bigint AS low_confidence,
           count(*) FILTER (WHERE confidence_class IN ('high','medium'))::bigint AS acceptable_confidence,
           count(DISTINCT resolver_version)::bigint AS resolver_versions,
           min(resolver_version) AS a_resolver_version
      FROM engine_v3_campaign_context_daily WHERE business_id=$1::text`,

  /** C5: bitemporal target packs. */
  targetPackHistory: `
    SELECT business_id::text AS business_id, operation,
           effective_at::text AS effective_at, recorded_at::text AS recorded_at,
           target_roas, break_even_roas
      FROM business_target_pack_history WHERE business_id::text = ANY($1::text[])
     ORDER BY business_id, effective_at, recorded_at`,

  /** R6: campaign AND ad-set config states, per account, both bounds. */
  /**
   * R6/C3.2/C3.3 — semantic config states with deterministic within-day
   * ordering, computed IN SQL so the ~700k raw captures never leave Postgres.
   *
   * $6 is the knowledge-time bound. Passing the cutoff yields the
   * point-in-time layer (only captures recorded by the cutoff are visible);
   * passing NULL yields the retrospective-finalized layer, which admits
   * late-arriving capture and is therefore NOT point-in-time.
   */
  configSemanticStates: `
    WITH captures AS (
      SELECT ENTITY_COL AS entity_id, effective_from, captured_at, created_at,
             id::text AS id, config_fingerprint, daily_budget, lifetime_budget,
             COALESCE(is_budget_mixed, FALSE) AS is_budget_mixed
        FROM SOURCE_TABLE
       WHERE business_id=$1::text AND provider_account_id=$2::text
         AND effective_from >= $3::date AND effective_from <= $4::date
         AND ($5::date IS NULL OR captured_at < ($5::date + 1))
    ), agg AS (
      SELECT entity_id, effective_from,
             count(*)::bigint AS raw_captures,
             count(DISTINCT config_fingerprint)::bigint AS distinct_fingerprints,
             bool_or(is_budget_mixed) AS any_mixed,
             count(*) FILTER (
               WHERE (entity_id, effective_from, captured_at) IN (
                 SELECT entity_id, effective_from, captured_at FROM captures
                  GROUP BY 1,2,3 HAVING count(DISTINCT config_fingerprint) > 1))::bigint
               AS same_clock_rows
        FROM captures GROUP BY 1,2
    ), pick AS (
      SELECT DISTINCT ON (entity_id, effective_from)
             entity_id, effective_from, captured_at, created_at, id,
             config_fingerprint, daily_budget, lifetime_budget
        FROM captures
       ORDER BY entity_id, effective_from, captured_at DESC, created_at DESC, id DESC
    ), state AS (
      SELECT p.entity_id, p.effective_from, p.captured_at, p.created_at, p.id,
             p.config_fingerprint, p.daily_budget, p.lifetime_budget,
             a.raw_captures, a.distinct_fingerprints, a.same_clock_rows,
             CASE
               WHEN a.any_mixed THEN 'mixed'
               WHEN a.distinct_fingerprints > 1 THEN 'conflicting_capture'
               WHEN p.daily_budget IS NOT NULL AND p.lifetime_budget IS NOT NULL
                 THEN 'both_fields_present'
               WHEN p.daily_budget IS NOT NULL THEN 'daily_only'
               WHEN p.lifetime_budget IS NOT NULL THEN 'lifetime_only'
               ELSE 'neither'
             END AS state_class
        FROM pick p JOIN agg a
          ON a.entity_id = p.entity_id AND a.effective_from = p.effective_from
    ), seq AS (
      SELECT s.*,
             lag(s.state_class) OVER w AS prev_class,
             lag(s.daily_budget) OVER w AS prev_daily,
             lag(s.lifetime_budget) OVER w AS prev_lifetime,
             lag(s.effective_from) OVER w AS prev_effective_from,
             lag(s.config_fingerprint) OVER w AS prev_fingerprint,
             lag(s.id) OVER w AS prev_id,
             row_number() OVER w AS rn
        FROM state s
      WINDOW w AS (PARTITION BY s.entity_id
                   ORDER BY s.effective_from, s.captured_at, s.id)
    )
    SELECT $1::text AS business_id, $2::text AS provider_account_id,
           'GRAIN_LABEL' AS grain,
           CASE
             WHEN rn = 1 THEN 'initial_observation'
             WHEN prev_class NOT IN ('daily_only','lifetime_only') THEN 'unresolved_prior_state'
             WHEN state_class NOT IN ('daily_only','lifetime_only') THEN 'unresolved_next_state'
             WHEN prev_class <> state_class THEN 'budget_kind_change'
             WHEN COALESCE(
                    CASE WHEN prev_class='daily_only' THEN prev_daily ELSE prev_lifetime END, -1)
                = COALESCE(
                    CASE WHEN state_class='daily_only' THEN daily_budget ELSE lifetime_budget END, -1)
               THEN 'unchanged'
             ELSE 'true_change'
           END AS transition_class,
           state_class,
           count(*)::bigint AS transitions,
           sum(raw_captures)::bigint AS raw_captures,
           sum(GREATEST(raw_captures - 1, 0))::bigint AS duplicate_captures,
           sum(CASE WHEN same_clock_rows > 0 THEN 1 ELSE 0 END)::bigint AS same_clock_conflict_states
      FROM seq
     GROUP BY 4, 5
     ORDER BY 4, 5`,

  /**
   * The identity of every non-routine transition, bounded. Routine `unchanged`
   * rows are counted above and never listed; this returns only the rows a
   * reviewer must be able to audit, so the artifact stays compact.
   */
  configTransitionIdentities: `
    WITH captures AS (
      SELECT ENTITY_COL AS entity_id, effective_from, captured_at, created_at,
             id::text AS id, config_fingerprint, daily_budget, lifetime_budget,
             COALESCE(is_budget_mixed, FALSE) AS is_budget_mixed
        FROM SOURCE_TABLE
       WHERE business_id=$1::text AND provider_account_id=$2::text
         AND effective_from >= $3::date AND effective_from <= $4::date
         AND ($5::date IS NULL OR captured_at < ($5::date + 1))
    ), agg AS (
      SELECT entity_id, effective_from, count(DISTINCT config_fingerprint)::bigint AS df,
             bool_or(is_budget_mixed) AS any_mixed
        FROM captures GROUP BY 1,2
    ), pick AS (
      SELECT DISTINCT ON (entity_id, effective_from)
             entity_id, effective_from, captured_at, created_at, id,
             config_fingerprint, daily_budget, lifetime_budget
        FROM captures
       ORDER BY entity_id, effective_from, captured_at DESC, created_at DESC, id DESC
    ), state AS (
      SELECT p.*, CASE
               WHEN a.any_mixed THEN 'mixed'
               WHEN a.df > 1 THEN 'conflicting_capture'
               WHEN p.daily_budget IS NOT NULL AND p.lifetime_budget IS NOT NULL
                 THEN 'both_fields_present'
               WHEN p.daily_budget IS NOT NULL THEN 'daily_only'
               WHEN p.lifetime_budget IS NOT NULL THEN 'lifetime_only'
               ELSE 'neither' END AS state_class
        FROM pick p JOIN agg a
          ON a.entity_id = p.entity_id AND a.effective_from = p.effective_from
    ), seq AS (
      SELECT s.*, lag(s.state_class) OVER w AS prev_class,
             lag(s.daily_budget) OVER w AS prev_daily,
             lag(s.lifetime_budget) OVER w AS prev_lifetime,
             lag(s.effective_from) OVER w AS prev_effective_from,
             lag(s.config_fingerprint) OVER w AS prev_fingerprint,
             lag(s.id) OVER w AS prev_id,
             row_number() OVER w AS rn
        FROM state s
      WINDOW w AS (PARTITION BY s.entity_id ORDER BY s.effective_from, s.captured_at, s.id)
    )
    SELECT $1::text AS business_id, $2::text AS provider_account_id,
           'GRAIN_LABEL' AS grain, entity_id,
           prev_effective_from::text AS prev_effective_from, prev_fingerprint, prev_id,
           prev_class, effective_from::text AS effective_from, config_fingerprint,
           id, state_class, captured_at::text AS captured_at,
           CASE
             WHEN prev_class NOT IN ('daily_only','lifetime_only') THEN 'unresolved_prior_state'
             WHEN state_class NOT IN ('daily_only','lifetime_only') THEN 'unresolved_next_state'
             WHEN prev_class <> state_class THEN 'budget_kind_change'
             ELSE 'true_change'
           END AS transition_class
      FROM seq
     WHERE rn > 1
       AND NOT (
         prev_class IN ('daily_only','lifetime_only')
         AND state_class IN ('daily_only','lifetime_only')
         AND prev_class = state_class
         AND COALESCE(CASE WHEN prev_class='daily_only' THEN prev_daily ELSE prev_lifetime END, -1)
           = COALESCE(CASE WHEN state_class='daily_only' THEN daily_budget ELSE lifetime_budget END, -1)
       )
     ORDER BY entity_id, effective_from, captured_at, id
     LIMIT $6::int`,

} as const;

// ---------------------------------------------------------------------------
// C3.4 — query-scope manifest
// ---------------------------------------------------------------------------

/**
 * What each query in the contract actually is.
 *
 * Correction 2's provenance said "every read is account-scoped and two-sided".
 * That was false: the clocks, the canonical latest-as-of probe, the role census
 * and the target-pack read are none of those things, and a static schema probe
 * cannot be either. The blanket claim is withdrawn and replaced by this
 * manifest, which the tests iterate in full rather than by a hand-picked list.
 */
export type QueryKind = "static_schema" | "binding_discovery" | "time_varying";
export type QueryScope = "binding" | "business" | "none";
export type BoundKind = "two_sided" | "upper_only" | "lower_only" | "pinned_single_date" | "none";
export type QueryPitStatus = "pit_safe" | "retrospective" | "current_state" | "not_applicable";

export interface QueryManifestEntry {
  kind: QueryKind;
  scope: QueryScope;
  /** Bounds on the row's EFFECTIVE time. */
  effectiveBounds: BoundKind;
  /** Bounds on the row's KNOWLEDGE/recorded time, where the source has one. */
  knowledgeBounds: BoundKind;
  pitStatus: QueryPitStatus;
  why: string;
}

export const D080_QUERY_MANIFEST: Record<string, QueryManifestEntry> = {
  runSchema: { kind: "static_schema", scope: "none", effectiveBounds: "none", knowledgeBounds: "none", pitStatus: "not_applicable", why: "information_schema probe; a date predicate would be theatre." },
  decisionVocabulary: { kind: "static_schema", scope: "none", effectiveBounds: "none", knowledgeBounds: "none", pitStatus: "not_applicable", why: "pg_constraint probe of the decision vocabulary." },
  bindings: { kind: "binding_discovery", scope: "business", effectiveBounds: "none", knowledgeBounds: "none", pitStatus: "current_state", why: "deliberately business-scoped: its purpose is to DETECT an account outside the pinned matrix, which an account filter would hide." },
  clockCampaignDaily: { kind: "time_varying", scope: "binding", effectiveBounds: "none", knowledgeBounds: "none", pitStatus: "current_state", why: "a clock reports a source's own min/max; bounding it would make it report the bound instead of the clock." },
  clockAdsetDaily: { kind: "time_varying", scope: "binding", effectiveBounds: "none", knowledgeBounds: "none", pitStatus: "current_state", why: "a clock reports this source's own min/max; a bound would make it report the bound." },
  clockCampaignConfig: { kind: "time_varying", scope: "binding", effectiveBounds: "none", knowledgeBounds: "none", pitStatus: "current_state", why: "a clock reports this source's own min/max; a bound would make it report the bound." },
  clockAdsetConfig: { kind: "time_varying", scope: "binding", effectiveBounds: "lower_only", knowledgeBounds: "none", pitStatus: "current_state", why: "lower bound only, to keep the scan inside the statement timeout; the value reported is still this source's own clock." },
  observationCoverage: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "none", pitStatus: "current_state", why: "run rows are bounded by observed_at; last_seen_at is a monotonic confirmation clock that may exceed the window by design." },
  stateChangeDensity: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "none", pitStatus: "retrospective", why: "counts stored change/checkpoint rows inside the window." },
  ownershipAggregate: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "none", pitStatus: "retrospective", why: "full-window shape of the state stream." },
  ownershipSameClockConflicts: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "none", pitStatus: "retrospective", why: "competitor detection inside the window." },
  ownershipObservations: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "upper_only", pitStatus: "pit_safe", why: "row-level lineage bounded on BOTH observed_at and captured_at, so every row in the artifact was knowable at the declared cutoff." },
  seriesCampaign: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "none", pitStatus: "retrospective", why: "mutable UPSERT source: it has no usable knowledge time, which is why the layer that consumes it is labelled retrospective." },
  seriesAdset: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "none", pitStatus: "retrospective", why: "same mutable UPSERT source family as seriesCampaign, with no usable knowledge time of its own." },
  unitEvidenceCampaignDaily: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "none", pitStatus: "retrospective", why: "joins state raw values to the mutable daily table inside the window." },
  unitEvidenceCampaignLifetime: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "none", pitStatus: "retrospective", why: "joins state raw budget values to the mutable daily table inside the effective window." },
  unitEvidenceAdsetDaily: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "none", pitStatus: "retrospective", why: "joins state raw budget values to the mutable daily table inside the effective window." },
  unitEvidenceAdsetLifetime: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "none", pitStatus: "retrospective", why: "joins state raw budget values to the mutable daily table inside the effective window." },
  configSemanticStates: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "upper_only", pitStatus: "pit_safe", why: "run with the cutoff as the knowledge bound for the PIT layer and with NULL for the retrospective layer; the caller records which." },
  configTransitionIdentities: { kind: "time_varying", scope: "binding", effectiveBounds: "two_sided", knowledgeBounds: "upper_only", pitStatus: "pit_safe", why: "as configSemanticStates; bounded by LIMIT and reported when truncated." },
  servedDateCandidates: { kind: "time_varying", scope: "binding", effectiveBounds: "none", knowledgeBounds: "none", pitStatus: "current_state", why: "reproduces the UI's own served-date resolution, which is itself an unbounded MAX over three sources." },
  canonicalLatestAsOf: { kind: "time_varying", scope: "binding", effectiveBounds: "none", knowledgeBounds: "none", pitStatus: "current_state", why: "a MAX probe of the decision table's own clock; a bound would make it report the bound." },
  canonicalIdentities: { kind: "time_varying", scope: "binding", effectiveBounds: "pinned_single_date", knowledgeBounds: "none", pitStatus: "current_state", why: "pinned to exactly one as_of_date by equality, which is both bounds at once; the snapshot is mutable, hence current_state." },
  budgetVerbCensus: { kind: "time_varying", scope: "binding", effectiveBounds: "upper_only", knowledgeBounds: "none", pitStatus: "retrospective", why: "counts the bounded HISTORICAL snapshot population across days and engine versions, not the latest generation." },
  engineVersionOverlap: { kind: "time_varying", scope: "binding", effectiveBounds: "upper_only", knowledgeBounds: "none", pitStatus: "retrospective", why: "diagnostic over the same bounded historical population." },
  campaignRole: { kind: "time_varying", scope: "business", effectiveBounds: "two_sided", knowledgeBounds: "none", pitStatus: "retrospective", why: "business-scoped BECAUSE every historical row has provider_account_id NULL; any non-null account outside the pinned matrix is isolated by the reader, never admitted." },
  campaignRoleCensus: { kind: "time_varying", scope: "business", effectiveBounds: "none", knowledgeBounds: "none", pitStatus: "current_state", why: "deliberately FULL-HISTORY, reported as a separate scope from the in-window rows." },
  targetPackHistory: { kind: "time_varying", scope: "business", effectiveBounds: "none", knowledgeBounds: "none", pitStatus: "pit_safe", why: "bitemporal and small; the whole revision history is required so a per-origin resolver can pick the revision in force. Both bounds are applied per origin in code, not in SQL." },
};

/** Businesses the pinned matrix covers, for business-scoped reads. */
export const PINNED_BUSINESS_IDS = [...new Set(D080_PINNED_BINDINGS.map((b) => b.businessId))];

export function isPinnedBusiness(businessId: string | null | undefined): boolean {
  return typeof businessId === "string" && PINNED_BUSINESS_IDS.includes(businessId);
}

// ---------------------------------------------------------------------------
// C3.4 — artifact invariant registry
// ---------------------------------------------------------------------------

export type SectionHandlerKind =
  | "scalar_list"
  | "pinned_binding"
  | "pinned_business"
  | "static_schema"
  | "verified_aggregate"
  | "source_clock_exception";

export type SectionScopeKind = "pinned_binding" | "pinned_business" | "identity_optional" | "none";

export interface SectionHandler {
  kind: SectionHandlerKind;
  /** Path inside the artifact section to the row array. */
  path: string[];
  /**
   * Scope validation, INDEPENDENT of any clock exception. A source-clock
   * exception waives a time bound; it never waives membership.
   */
  scope?: SectionScopeKind;
  /** Effective-time fields checked against the applicable cutoff. */
  effectiveFields?: string[];
  /** Knowledge-time fields checked against the applicable cutoff. */
  knowledgeFields?: string[];
  /** Clock fields this section is explicitly exempt from, and only these. */
  exemptClockFields?: string[];
  /** Require at least a business id on every row (identity_optional only). */
  requireIdentity?: boolean;
  /** Declared-nullable clock fields; anything else must be present. */
  nullableFields?: string[];
  /** Why an exception applies, when the handler is an exception kind. */
  exception?: string;
}

/**
 * Every row-bearing material section must appear here. `verify` fails if the
 * artifact grows a row-bearing section with no handler, so a future section
 * cannot be silently exempted the way `__none__` exempted canonicalDecisions.
 */
export const D080_SECTION_HANDLERS: Record<string, SectionHandler> = {
  "clocks.perSource": { kind: "source_clock_exception", path: ["clocks", "perSource"], scope: "pinned_binding", effectiveFields: ["latest_effective", "earliest_effective"], exemptClockFields: ["latest_effective", "earliest_effective"], exception: "a clock row REPORTS a source's own min/max; checking it against the cutoff it helps compute is circular. Scope is still enforced." },
  "clocks.perBinding": { kind: "pinned_binding", path: ["clocks", "perBinding"] },
  "dependencyCoverage.cells": { kind: "verified_aggregate", path: ["dependencyCoverage", "cells"] },
  "observationCoverage.providerObservationFreshness": { kind: "source_clock_exception", path: ["observationCoverage", "providerObservationFreshness"], scope: "pinned_binding", effectiveFields: ["heartbeat_last_seen"], exemptClockFields: ["heartbeat_last_seen"], exception: "heartbeat last_seen_at is monotonic and advances on byte-identical re-observation, so it legitimately exceeds the effective window. Scope is still enforced." },
  "observationCoverage.stateChangeCheckpointDensity": { kind: "pinned_binding", path: ["observationCoverage", "stateChangeCheckpointDensity"], effectiveFields: ["latest_state_observed"] },
  "unitEvidence.rows": { kind: "verified_aggregate", path: ["unitEvidence", "rows"] },
  "unitEvidence.coverageMatrix": { kind: "pinned_binding", path: ["unitEvidence", "coverageMatrix"] },
  "series": { kind: "pinned_binding", path: ["series"], effectiveFields: ["effective_date"] },
  "ownershipObservations": { kind: "pinned_binding", path: ["ownershipObservations"], effectiveFields: ["observed_at"], knowledgeFields: ["captured_at"] },
  "ownershipCoverage.aggregate": { kind: "pinned_binding", path: ["ownershipCoverage", "aggregate"], effectiveFields: ["latest_observed"] },
  "ownershipCoverage.sameClockConflicts": { kind: "verified_aggregate", path: ["ownershipCoverage", "sameClockConflicts"] },
  "configStates.pointInTime": { kind: "pinned_binding", path: ["configStates", "pointInTime"] },
  "configStates.retrospective": { kind: "pinned_binding", path: ["configStates", "retrospective"] },
  "configStates.coverage": { kind: "pinned_binding", path: ["configStates", "coverage"] },
  "configStates.identities": { kind: "pinned_binding", path: ["configStates", "identities"], effectiveFields: ["effective_from", "prev_effective_from"], knowledgeFields: ["captured_at"] },
  "canonicalDecisions.perBinding": { kind: "source_clock_exception", path: ["canonicalDecisions", "perBinding"], scope: "pinned_binding", effectiveFields: ["latest_as_of"], exemptClockFields: ["latest_as_of"], exception: "the decision table has its own clock; its latest date legitimately diverges from the performance cutoff and the divergence is reported as a finding. Scope is still enforced." },
  "canonicalDecisions.budgetVerbCensus": { kind: "verified_aggregate", path: ["canonicalDecisions", "budgetVerbCensus"] },
  "canonicalDecisions.engineVersionOverlap": { kind: "pinned_binding", path: ["canonicalDecisions", "engineVersionOverlap"], effectiveFields: ["as_of_date"] },
  "canonicalDecisions.servedDateCoverage": { kind: "pinned_binding", path: ["canonicalDecisions", "servedDateCoverage"] },
  "canonicalDecisions.servedDate": { kind: "source_clock_exception", path: ["canonicalDecisions", "servedDate"], scope: "pinned_binding", effectiveFields: ["native_ad_max", "legacy_creative_max", "native_job_run_max"], exemptClockFields: ["native_ad_max", "legacy_creative_max", "native_job_run_max"], exception: "reproduces the UI's own unbounded served-date resolution across three source clocks. Scope is still enforced: an unpinned binding here is a violation." },
  "campaignRole.rows": { kind: "pinned_business", path: ["campaignRole", "rows"], effectiveFields: ["as_of_date"], knowledgeFields: ["recorded_at"] },
  "campaignRole.census": { kind: "pinned_business", path: ["campaignRole", "census"] },
  "targetPackHistory": { kind: "pinned_business", path: ["targetPackHistory"] },
  "provenance.readLedger": { kind: "verified_aggregate", path: ["provenance", "readLedger"], scope: "identity_optional" },
  "provenance.readFailures": { kind: "verified_aggregate", path: ["provenance", "readFailures"], scope: "identity_optional" },
  "scope.observedBindings": { kind: "pinned_business", path: ["scope", "observedBindings"] },
  "scope.pinnedBindings": { kind: "static_schema", path: ["scope", "pinnedBindings"] },
  "sourceSemantics.sources": { kind: "static_schema", path: ["sourceSemantics", "sources"] },
  "canonicalDecisions.vocabularyConstraints": { kind: "static_schema", path: ["canonicalDecisions", "vocabularyConstraints"] },
  "correctionLedger": { kind: "static_schema", path: ["correctionLedger"] },
  "invocationResults.receipts": { kind: "verified_aggregate", path: ["invocationResults", "receipts"], scope: "none" },
  // Scalar-list sections. They carry no per-row scope, but they are registered
  // explicitly so an EMPTY one cannot slip past the completeness check the way
  // an unregistered section would.
  "configStates.identityTruncatedFor": { kind: "verified_aggregate", path: ["configStates", "identityTruncatedFor"] },
  "schemaContract.observedRunColumns": { kind: "static_schema", path: ["schemaContract", "observedRunColumns"] },
  "schemaContract.missingRunColumns": { kind: "static_schema", path: ["schemaContract", "missingRunColumns"] },
  "scope.expectedMissing": { kind: "verified_aggregate", path: ["scope", "expectedMissing"] },
  "scope.unexpectedExtra": { kind: "verified_aggregate", path: ["scope", "unexpectedExtra"] },
  "capabilityMatrix.graphApiVersions.primarySourceVerification": { kind: "static_schema", path: ["capabilityMatrix", "graphApiVersions", "primarySourceVerification"] },
  "capabilityMatrix.graphApiVersions.claimMetadataHashes": { kind: "static_schema", path: ["capabilityMatrix", "graphApiVersions", "claimMetadataHashes"] },
  "d080bContract.blockers": { kind: "static_schema", path: ["d080bContract", "blockers"] },
  // C5.1 — non-empty scalar lists are sections too. Correction 4 discovered
  // them only while empty, so populating one made it vanish from the registry.
  "analysis.layer2StrictPit.unavailableBecause.mutableSources": { kind: "scalar_list", path: ["analysis", "layer2StrictPit", "unavailableBecause", "mutableSources"] },
  "capabilityMatrix.graphApiVersions.oauth": { kind: "scalar_list", path: ["capabilityMatrix", "graphApiVersions", "oauth"] },
  "capabilityMatrix.graphApiVersions.writePaths": { kind: "scalar_list", path: ["capabilityMatrix", "graphApiVersions", "writePaths"] },
  "capabilityMatrix.graphApiVersions.versionFacts": { kind: "scalar_list", path: ["capabilityMatrix", "graphApiVersions", "versionFacts"] },
  "d080bContract.migrationPlan": { kind: "scalar_list", path: ["d080bContract", "migrationPlan"] },
  "d080bContract.compatibilityGate": { kind: "scalar_list", path: ["d080bContract", "compatibilityGate"] },
  "d080bContract.tables": { kind: "scalar_list", path: ["d080bContract", "tables"] },
  "analysis.configChangeQuality.readFailuresList": { kind: "scalar_list", path: ["analysis", "configChangeQuality", "readFailuresList"] },
  // Key-audit result lists. Registered explicitly so an EMPTY one still
  // passes the completeness check instead of appearing as an unhandled section.
  "analysis.canonicalKeyAudit.missing": { kind: "static_schema", path: ["analysis", "canonicalKeyAudit", "missing"] },
  "analysis.canonicalKeyAudit.duplicates": { kind: "static_schema", path: ["analysis", "canonicalKeyAudit", "duplicates"] },
  "analysis.canonicalKeyAudit.unexpected": { kind: "static_schema", path: ["analysis", "canonicalKeyAudit", "unexpected"] },
  "analysis.configChangeQuality.keyAudit.missing": { kind: "static_schema", path: ["analysis", "configChangeQuality", "keyAudit", "missing"] },
  "analysis.configChangeQuality.keyAudit.duplicates": { kind: "static_schema", path: ["analysis", "configChangeQuality", "keyAudit", "duplicates"] },
  "analysis.configChangeQuality.keyAudit.unexpected": { kind: "static_schema", path: ["analysis", "configChangeQuality", "keyAudit", "unexpected"] },
  "analysis.servedDateContract.keyAudit.missing": { kind: "static_schema", path: ["analysis", "servedDateContract", "keyAudit", "missing"] },
  "analysis.servedDateContract.keyAudit.duplicates": { kind: "static_schema", path: ["analysis", "servedDateContract", "keyAudit", "duplicates"] },
  "analysis.servedDateContract.keyAudit.unexpected": { kind: "static_schema", path: ["analysis", "servedDateContract", "keyAudit", "unexpected"] },
  "analysis.unitCoverage.keyAudit.missing": { kind: "static_schema", path: ["analysis", "unitCoverage", "keyAudit", "missing"] },
  "analysis.unitCoverage.keyAudit.duplicates": { kind: "static_schema", path: ["analysis", "unitCoverage", "keyAudit", "duplicates"] },
  "analysis.unitCoverage.keyAudit.unexpected": { kind: "static_schema", path: ["analysis", "unitCoverage", "keyAudit", "unexpected"] },
  // Derived analysis sub-sections. Their source rows were verified by their own
  // handlers above; they are registered so a new derived list cannot appear
  // without an explicit decision about how it is checked.
  "analysis.configChangeQuality.identityTruncatedFor": { kind: "verified_aggregate", path: ["analysis", "configChangeQuality", "identityTruncatedFor"] },
  "analysis.configChangeQuality.readFailures": { kind: "verified_aggregate", path: ["analysis", "configChangeQuality", "readFailures"] },
  "analysis.configChangeQuality.unknownCells": { kind: "verified_aggregate", path: ["analysis", "configChangeQuality", "unknownCells"] },
  "analysis.layer1Budget.vocabularyConstraints": { kind: "static_schema", path: ["analysis", "layer1Budget", "vocabularyConstraints"] },
  "analysis.layer1Creative.perBinding": { kind: "source_clock_exception", path: ["analysis", "layer1Creative", "perBinding"], scope: "identity_optional", effectiveFields: ["latestAsOf"], exemptClockFields: ["latestAsOf"], exception: "carries the decision table's own latest-as-of clock, which legitimately diverges from the performance cutoff; the divergence is reported in crossSourceFreshness. Scope is enforced via providerAccountId." },
  "analysis.layer1Creative.crossSourceFreshness": { kind: "source_clock_exception", path: ["analysis", "layer1Creative", "crossSourceFreshness"], scope: "identity_optional", effectiveFields: ["decisionLatestAsOf"], exemptClockFields: ["decisionLatestAsOf"], exception: "this section EXISTS to report decision-clock versus performance-cutoff divergence; checking it against the performance cutoff would delete the finding. Scope is enforced." },
  "analysis.layer1Creative.overlappingGenerationDays": { kind: "pinned_binding", path: ["analysis", "layer1Creative", "overlappingGenerationDays"], effectiveFields: ["as_of_date"] },
  "analysis.layer3Sensitivity.sensitivity": { kind: "verified_aggregate", path: ["analysis", "layer3Sensitivity", "sensitivity"] },
  "analysis.servedDateContract.perBinding": { kind: "source_clock_exception", path: ["analysis", "servedDateContract", "perBinding"], scope: "identity_optional", effectiveFields: ["uiServedDate", "nativeAdMax"], exemptClockFields: ["uiServedDate", "nativeAdMax"], exception: "reproduces the UI's own unbounded served-date resolution across three source clocks; a performance-cutoff check would misreport the contract. Scope is enforced." },
  "analysis.servedDateContract.coverage": { kind: "pinned_binding", path: ["analysis", "servedDateContract", "coverage"] },
  "analysis.servedDateContract.divergentBindings": { kind: "source_clock_exception", path: ["analysis", "servedDateContract", "divergentBindings"], scope: "identity_optional", effectiveFields: ["uiServedDate", "nativeAdMax"], exemptClockFields: ["uiServedDate", "nativeAdMax"], exception: "the divergence subset of the section above. Scope is enforced." },
  "provenance.executionAuthority.truthyBefore": { kind: "verified_aggregate", path: ["provenance", "executionAuthority", "truthyBefore"] },
  "provenance.executionAuthority.truthyAfter": { kind: "verified_aggregate", path: ["provenance", "executionAuthority", "truthyAfter"] },
  "provenance.executionAuthority.changedByLoader": { kind: "verified_aggregate", path: ["provenance", "executionAuthority", "changedByLoader"] },
};

// ---------------------------------------------------------------------------
// Read-only transaction with a savepoint per optional read
// ---------------------------------------------------------------------------

export interface ReadLedgerEntry {
  /** Stable identity of THIS execution instance, matched against the plan. */
  invocationKey: string;
  planKey: string;
  query: string;
  businessId: string | null;
  providerAccountId: string | null;
  grain: string | null;
  source: string | null;
  /** Derived from the executed request, not authored beside it. */
  templateKey: string;
  statementSha256: string;
  paramsSha256: string;
  businessListHash: string | null;
  pitStatus: QueryPitStatus;
  knowledgeBounds: BoundKind;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  knowledgeTo: string | null;
  asOfDate: string | null;
  limit: number | null;
  /** C7.1 — execute or dependency_skip. Never inferred from status alone. */
  disposition: "execute" | "dependency_skip";
  /** C7.3 — the ACTUAL query result, captured at the boundary before transform. */
  sourceRowCount: number | null;
  sourceRowHash: string | null;
  /** C7.1 — deterministic skip contract. Null on an executed invocation. */
  dependencyCode: string | null;
  missingPrerequisites: string[] | null;
  skipOutcomeHash: string | null;
  ms: number;
  rows: number;
  status: "ok" | "unknown/source_read_failed" | "not_run_dependency_failed";
  reason?: string;
}

/** The exact skip envelope whose hash the verifier recomputes. */
export function skipEnvelope(request: CanonicalRequest, code: DependencyCode, missing: string[]): Record<string, unknown> {
  return {
    invocationKey: request.invocationKey,
    planKey: request.planKey,
    templateKey: request.templateKey,
    source: request.source,
    businessId: request.businessId,
    providerAccountId: request.providerAccountId,
    businessListHash: request.businessListHash,
    grain: request.grain,
    dependencyCode: code,
    missingPrerequisites: [...missing].sort(),
    queryExecuted: false,
    // Every request field that cannot apply to a skip is EXPLICITLY null and
    // is checked as null; nothing is merely omitted or waived.
    statementSha256: null,
    paramsSha256: null,
    effectiveFrom: null,
    effectiveTo: null,
    knowledgeTo: null,
    asOfDate: null,
    limit: null,
  };
}

export function skipReason(code: DependencyCode, missing: string[]): string {
  return `${code}: missing ${[...missing].sort().join(",")}`;
}

/** Sanitises a driver error so no connection string or credential can leak. */
function sanitizeReason(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error);
  return raw
    .replace(/postgres(ql)?:\/\/[^\s"']+/gi, "[redacted-dsn]")
    .replace(/password=[^\s"']+/gi, "password=[redacted]")
    .slice(0, 200);
}

/**
 * C7.2 — the EXACT integrity guard `safeQ` runs immediately before any DB call.
 * Exported so a test can drive it against a mock executor and prove the query
 * is refused before it is issued, rather than asserting an error string exists.
 */
/**
 * C8.3 — where each declared envelope field must appear in the ACTUAL params.
 *
 * Correction 7's guard checked two hashes only, so a request could keep an
 * honest statement and params while declaring a forged business, account or
 * effective bound, and still reach the executor. An envelope field is now
 * only believed when the parameter it claims to describe actually carries it.
 */
export const D080_PARAM_CONTRACT: Record<string, Partial<Record<
  "businessId" | "providerAccountId" | "businessList" | "grain" | "effectiveFrom" | "effectiveTo" | "knowledgeTo" | "asOfDate" | "limit",
  number
>>> = {
  bindings: { businessList: 0 },
  targetPackHistory: { businessList: 0 },
  clockCampaignDaily: { businessId: 0, providerAccountId: 1 },
  clockAdsetDaily: { businessId: 0, providerAccountId: 1 },
  clockCampaignConfig: { businessId: 0, providerAccountId: 1 },
  clockAdsetConfig: { businessId: 0, providerAccountId: 1, effectiveFrom: 2 },
  observationCoverage: { businessId: 0, providerAccountId: 1, grain: 2, effectiveFrom: 3, effectiveTo: 4 },
  stateChangeDensity: { businessId: 0, providerAccountId: 1, grain: 2, effectiveFrom: 3, effectiveTo: 4 },
  ownershipAggregate: { businessId: 0, providerAccountId: 1, grain: 2, effectiveFrom: 3, effectiveTo: 4 },
  ownershipSameClockConflicts: { businessId: 0, providerAccountId: 1, grain: 2, effectiveFrom: 3, effectiveTo: 4 },
  ownershipObservations: { businessId: 0, providerAccountId: 1, effectiveFrom: 2, effectiveTo: 3 },
  seriesCampaign: { businessId: 0, providerAccountId: 1, effectiveFrom: 2, effectiveTo: 3 },
  seriesAdset: { businessId: 0, providerAccountId: 1, effectiveFrom: 2, effectiveTo: 3 },
  unitEvidenceCampaignDaily: { businessId: 0, providerAccountId: 1, effectiveFrom: 2, effectiveTo: 3 },
  unitEvidenceCampaignLifetime: { businessId: 0, providerAccountId: 1, effectiveFrom: 2, effectiveTo: 3 },
  unitEvidenceAdsetDaily: { businessId: 0, providerAccountId: 1, effectiveFrom: 2, effectiveTo: 3 },
  unitEvidenceAdsetLifetime: { businessId: 0, providerAccountId: 1, effectiveFrom: 2, effectiveTo: 3 },
  "configSemanticStates:pointInTime": { businessId: 0, providerAccountId: 1, effectiveFrom: 2, effectiveTo: 3, knowledgeTo: 4 },
  "configSemanticStates:retrospective": { businessId: 0, providerAccountId: 1, effectiveFrom: 2, effectiveTo: 3, knowledgeTo: 4 },
  configTransitionIdentities: { businessId: 0, providerAccountId: 1, effectiveFrom: 2, effectiveTo: 3, knowledgeTo: 4, limit: 5 },
  servedDateCandidates: { businessId: 0, providerAccountId: 1 },
  canonicalLatestAsOf: { businessId: 0, providerAccountId: 1 },
  canonicalIdentities: { businessId: 0, providerAccountId: 1, asOfDate: 2 },
  budgetVerbCensus: { businessId: 0, providerAccountId: 1, effectiveTo: 3 },
  engineVersionOverlap: { businessId: 0, providerAccountId: 1, effectiveTo: 2 },
  campaignRole: { businessId: 0, effectiveFrom: 1, effectiveTo: 2 },
  campaignRoleCensus: { businessId: 0 },
  runSchema: {},
  decisionVocabulary: {},
};

/**
 * C9.3 — the exact `limit` each plan is allowed to carry. A plan not listed
 * here must carry no limit at all.
 */
export const D080_PLAN_LIMIT: Record<string, number> = {
  configTransitionIdentities: CONFIG_IDENTITY_LIMIT,
};

/**
 * C9.3 — how one envelope field is bound for one plan.
 *
 * `forbidden` is the part Correction 8 was missing: it only checked the fields a
 * plan *named*, so a `seriesCampaign` request could carry `knowledgeTo`,
 * `asOfDate` or `limit` with honest hashes and still reach the executor.
 */
export type EnvelopeRule =
  /** Must be non-null and equal to the normalized value at this parameter. */
  | { kind: "required_param"; index: number }
  /** Must be non-null; bound by a plan rule rather than by a parameter. */
  | { kind: "required_bound" }
  /** May be null, but must equal the normalized value at this parameter. */
  | { kind: "nullable_param"; index: number }
  /** Must be null. The plan has no use for this field. */
  | { kind: "forbidden" };

export type EnvelopeField =
  | "businessId" | "providerAccountId" | "businessList" | "grain"
  | "effectiveFrom" | "effectiveTo" | "knowledgeTo" | "asOfDate" | "limit";

export type EnvelopeContract = Record<EnvelopeField, EnvelopeRule>;

/**
 * The complete envelope contract for one plan, DERIVED from the read plan and
 * the parameter contract rather than hand-written a second time, so the two
 * cannot drift apart. Every one of the nine fields gets exactly one rule.
 */
export function envelopeContractFor(planKey: string): EnvelopeContract {
  const plan = D080_READ_PLAN[planKey];
  if (!plan) throw new Error(`unknown plan key ${planKey}`);
  const params = D080_PARAM_CONTRACT[planKey];
  if (!params) throw new Error(`no parameter contract for plan ${planKey}`);
  const at = (f: EnvelopeField): number | undefined => params[f];
  const fromParam = (f: EnvelopeField): EnvelopeRule => {
    const index = at(f);
    return index === undefined ? { kind: "forbidden" } : { kind: "required_param", index };
  };

  // Grain: a plan-declared grain is fixed; a per-grain plan must carry one even
  // when no parameter names it (the invocation key does); anything else must
  // carry none.
  const grainIndex = at("grain");
  const grain: EnvelopeRule =
    plan.grain !== undefined || plan.cardinality === "per_binding_grain"
      ? grainIndex === undefined
        ? { kind: "required_bound" }
        : { kind: "required_param", index: grainIndex }
      : { kind: "forbidden" };

  // Knowledge bound: required exactly when the plan declares an upper knowledge
  // bound. `configSemanticStates:retrospective` names the parameter but passes
  // NULL through it deliberately, so it is nullable-but-bound, not forbidden.
  const knowledgeIndex = at("knowledgeTo");
  const knowledgeTo: EnvelopeRule =
    plan.knowledgeBounds === "upper_only"
      ? knowledgeIndex === undefined
        ? { kind: "required_bound" }
        : { kind: "required_param", index: knowledgeIndex }
      : knowledgeIndex === undefined
        ? { kind: "forbidden" }
        : { kind: "nullable_param", index: knowledgeIndex };

  return {
    businessId: fromParam("businessId"),
    providerAccountId: fromParam("providerAccountId"),
    businessList: fromParam("businessList"),
    grain,
    effectiveFrom: fromParam("effectiveFrom"),
    effectiveTo: fromParam("effectiveTo"),
    knowledgeTo,
    asOfDate: fromParam("asOfDate"),
    limit: fromParam("limit"),
  };
}

/** The exact pinned business set every business-list plan must address. */
export const D080_PINNED_BUSINESS_IDS: readonly string[] = [
  ...new Set(D080_PINNED_BINDINGS.map((b) => b.businessId)),
];
const D080_PINNED_BUSINESS_SET = new Set(D080_PINNED_BUSINESS_IDS);
const D080_PINNED_BINDING_KEYS = new Set(
  D080_PINNED_BINDINGS.map((b) => `${b.businessId}|${b.providerAccountId}`),
);

/** A real calendar date in YYYY-MM-DD, not merely a well-shaped string. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
  );
}

/**
 * C8.3 — the COMPLETE guard `safeQ` runs immediately before any DB call.
 *
 * It rebuilds the request from immutable plan semantics and the request's own
 * declared scope, then requires the rebuilt object to be identical. That binds
 * invocation key, plan, template, source, grain, statement and params together,
 * and separately requires every declared envelope value to actually appear in
 * the parameter it claims to describe. A request for one plan cannot masquerade
 * as another, and no envelope field can be forged while the hashes stay honest.
 */
export function assertRequestIntegrity(request: CanonicalRequest): void {
  const refuse = (why: string): never => {
    throw new Error(`D080 refuses to execute ${request.invocationKey}: ${why}`);
  };
  const plan = D080_READ_PLAN[request.planKey];
  if (!plan) refuse("unknown plan key");

  const statementHash = createHash("sha256").update(request.statement).digest("hex");
  if (statementHash !== request.statementSha256) refuse("statement does not match its declared hash");
  if (sha256Canonical(request.params) !== request.paramsSha256) refuse("params do not match their declared hash");

  // The shaped statement must be the one this plan/template/grain produces.
  if (request.templateKey !== plan!.template) refuse("templateKey does not match the plan definition");
  if (shapeStatement(plan!.template, request.grain) !== request.statement) {
    refuse("statement is not the shaped template for this plan and grain");
  }

  // A plan that declares a fixed grain must not accept a foreign one. Without
  // this, `seriesCampaign` (whose invocation key carries no grain and whose
  // template does not interpolate one) would accept grain "adset" unchallenged.
  if (plan!.grain !== undefined && request.grain !== plan!.grain) {
    refuse(`grain ${JSON.stringify(request.grain)} is not this plan's fixed grain ${JSON.stringify(plan!.grain)}`);
  }
  if (plan!.grain === undefined && plan!.cardinality !== "per_binding_grain" && request.grain !== null) {
    refuse("plan declares no grain, so the request must not carry one");
  }

  // Rebuilding from the request's own declared scope must be identical: this
  // binds invocationKey, source, grain, PIT status and bound kinds at once.
  const rebuilt = buildCanonicalRequest(request.planKey, {
    businessId: request.businessId,
    providerAccountId: request.providerAccountId,
    businessList: null,
    grain: request.grain,
    effectiveFrom: request.effectiveFrom,
    effectiveTo: request.effectiveTo,
    knowledgeTo: request.knowledgeTo,
    asOfDate: request.asOfDate,
    limit: request.limit,
    params: request.params,
  });
  for (const field of ["invocationKey", "planKey", "templateKey", "source", "grain", "pitStatus", "knowledgeBounds", "statementSha256", "paramsSha256"] as const) {
    if (canonicalJson(rebuilt[field] ?? null) !== canonicalJson(request[field] ?? null)) {
      refuse(`${field} is not derivable from the plan and declared scope`);
    }
  }

  // C9.3 — EVERY envelope field is bound, applicable or not. Correction 8 only
  // checked the fields a plan named, so an extraneous knowledgeTo, asOfDate or
  // limit rode along untouched, and a self-consistent request for an unpinned
  // identity or an inverted date window reached the executor.
  const envelope = envelopeContractFor(request.planKey);
  // Compare both sides in one normal form: a numeric limit of 20000 and the
  // parameter 20000 are the same value.
  const norm = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const declared: Record<EnvelopeField, unknown> = {
    businessId: request.businessId,
    providerAccountId: request.providerAccountId,
    businessList: request.businessListHash,
    grain: request.grain,
    effectiveFrom: request.effectiveFrom,
    effectiveTo: request.effectiveTo,
    knowledgeTo: request.knowledgeTo,
    asOfDate: request.asOfDate,
    limit: request.limit,
  };

  for (const [field, rule] of Object.entries(envelope) as Array<[EnvelopeField, EnvelopeRule]>) {
    const value = declared[field] ?? null;
    if (rule.kind === "forbidden") {
      if (value !== null) {
        refuse(`${field} is not applicable to this plan but carries ${JSON.stringify(value)}`);
      }
      continue;
    }
    if ((rule.kind === "required_param" || rule.kind === "required_bound") && value === null) {
      refuse(`${field} is required by this plan but is null`);
    }
    if (rule.kind === "required_param" || rule.kind === "nullable_param") {
      const actual = request.params[rule.index] ?? null;
      if (field === "businessList") {
        if (!Array.isArray(actual)) refuse("businessList parameter is not a list");
        const listed = [...(actual as unknown[])].map((v) => String(v));
        if (new Set(listed).size !== listed.length) refuse("business list contains duplicates");
        if (listed.length !== D080_PINNED_BUSINESS_IDS.length ||
            listed.some((id) => !D080_PINNED_BUSINESS_SET.has(id))) {
          refuse("business list is not exactly the pinned business set");
        }
        // The hash is taken over the SORTED list and the statement binds the
        // list with `= ANY(...)`, so ordering carries no meaning; membership,
        // arity and the hash do.
        if (request.businessListHash !== sha256Canonical([...listed].sort())) {
          refuse("businessListHash does not describe the business-list parameter");
        }
        continue;
      }
      if (canonicalJson(norm(actual)) !== canonicalJson(norm(value))) {
        refuse(`declared ${field} ${JSON.stringify(value)} does not match params[${rule.index}] ${JSON.stringify(actual)}`);
      }
    }
  }

  // The identity must be one this audit actually pinned. A self-consistent
  // request for an unpinned or cross-paired business/account is still a request
  // for evidence outside the audited scope.
  if (request.businessId !== null && !D080_PINNED_BUSINESS_SET.has(request.businessId)) {
    refuse(`businessId ${JSON.stringify(request.businessId)} is not a pinned business`);
  }
  if (request.providerAccountId !== null) {
    if (request.businessId === null) refuse("a provider account is declared without a business");
    if (!D080_PINNED_BINDING_KEYS.has(`${request.businessId}|${request.providerAccountId}`)) {
      refuse(`${request.businessId}|${request.providerAccountId} is not a pinned binding`);
    }
  }
  if (request.grain !== null && request.grain !== "campaign" && request.grain !== "adset") {
    refuse(`grain ${JSON.stringify(request.grain)} is not a known grain`);
  }

  // Real calendar dates, and a window that runs forwards.
  for (const field of ["effectiveFrom", "effectiveTo", "knowledgeTo", "asOfDate"] as const) {
    const value = request[field];
    if (value !== null && !isCalendarDate(value)) {
      refuse(`${field} ${JSON.stringify(value)} is not a real calendar date`);
    }
  }
  if (request.effectiveFrom !== null && request.effectiveTo !== null &&
      request.effectiveFrom > request.effectiveTo) {
    refuse(`effective window runs backwards: ${request.effectiveFrom} > ${request.effectiveTo}`);
  }
  // Every upper knowledge bound this audit issues is the binding cutoff, which
  // is also the effective upper bound. Binding them makes a forged knowledge
  // bound impossible to hide behind an honest effective window.
  if (plan!.knowledgeBounds === "upper_only" && request.knowledgeTo !== request.effectiveTo) {
    refuse(`knowledgeTo ${JSON.stringify(request.knowledgeTo)} does not equal effectiveTo ${JSON.stringify(request.effectiveTo)}`);
  }
  if (request.asOfDate !== null && request.effectiveTo !== null && request.asOfDate > request.effectiveTo) {
    refuse(`asOfDate ${request.asOfDate} is after effectiveTo ${request.effectiveTo}`);
  }

  // A limit is the plan's exact limit, or there is no limit.
  const allowedLimit = D080_PLAN_LIMIT[request.planKey];
  if (request.limit !== null) {
    if (allowedLimit === undefined) refuse("this plan carries no limit");
    if (!Number.isInteger(request.limit) || request.limit <= 0) {
      refuse(`limit ${JSON.stringify(request.limit)} is not a positive integer`);
    }
    if (request.limit !== allowedLimit) {
      refuse(`limit ${request.limit} is not this plan's limit ${allowedLimit}`);
    }
  } else if (allowedLimit !== undefined) {
    refuse(`this plan requires limit ${allowedLimit}`);
  }
}

/**
 * C7.2 — the same execute-or-refuse path `safeQ` uses, over an injected
 * executor. A refusal must happen BEFORE the executor is called.
 */
export async function executeGuardedRequest(
  request: CanonicalRequest,
  executor: (statement: string, params: unknown[]) => Promise<Row[]>,
): Promise<Row[]> {
  assertRequestIntegrity(request);
  return executor(request.statement, request.params);
}

type SafeQ = (request: CanonicalRequest) => Promise<Row[]>;

async function withReadOnlyTransaction<T>(
  db: DbModule,
  run: (
    proof: Row,
    safeQ: SafeQ,
    ledger: ReadLedgerEntry[],
    skip: (request: CanonicalRequest, code: DependencyCode, missing: string[]) => void,
  ) => Promise<T>,
): Promise<T> {
  return db.runDbTransaction(async () => {
    const sql = db.getDb();
    await sql.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await sql.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await sql.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    const [proof] = await sql.query<Row>(
      `SELECT now()::text AS retrieved_at,
              current_setting('transaction_isolation') AS transaction_isolation,
              current_setting('transaction_read_only') AS transaction_read_only,
              current_setting('statement_timeout') AS statement_timeout,
              current_setting('lock_timeout') AS lock_timeout`,
    );
    if (text(proof?.transaction_read_only) !== "on") {
      throw new Error("D080 refuses to run outside a READ ONLY transaction");
    }
    if (text(proof?.transaction_isolation) !== "repeatable read") {
      throw new Error("D080 requires REPEATABLE READ isolation");
    }
    const ledger: ReadLedgerEntry[] = [];
    const ledgerEntry = (
      request: CanonicalRequest,
      status: ReadLedgerEntry["status"],
      ms: number,
      rows: number,
      reason?: string,
    ): ReadLedgerEntry => ({
      invocationKey: request.invocationKey,
      planKey: request.planKey,
      query: request.planKey,
      templateKey: request.templateKey,
      statementSha256: request.statementSha256,
      paramsSha256: request.paramsSha256,
      businessId: request.businessId,
      providerAccountId: request.providerAccountId,
      businessListHash: request.businessListHash,
      grain: request.grain,
      source: request.source,
      pitStatus: request.pitStatus,
      knowledgeBounds: request.knowledgeBounds,
      effectiveFrom: request.effectiveFrom,
      effectiveTo: request.effectiveTo,
      knowledgeTo: request.knowledgeTo,
      asOfDate: request.asOfDate,
      limit: request.limit,
      disposition: "execute",
      sourceRowCount: null,
      sourceRowHash: null,
      dependencyCode: null,
      missingPrerequisites: null,
      skipOutcomeHash: null,
      ms, rows, status,
      ...(reason ? { reason } : {}),
    });
    /**
     * C7.1/C7.3 — a skip is NOT a zero-row query result. It carries an explicit
     * no-query envelope with a deterministic hash, and every non-applicable
     * request field is explicitly null.
     */
    const skip = (request: CanonicalRequest, code: DependencyCode, missing: string[]) => {
      const envelope = skipEnvelope(request, code, missing);
      ledger.push({
        ...ledgerEntry(request, "not_run_dependency_failed", 0, 0, skipReason(code, missing)),
        disposition: "dependency_skip",
        statementSha256: null as unknown as string,
        paramsSha256: null as unknown as string,
        effectiveFrom: null,
        effectiveTo: null,
        knowledgeTo: null,
        asOfDate: null,
        limit: null,
        dependencyCode: code,
        missingPrerequisites: [...missing].sort(),
        skipOutcomeHash: sha256Canonical(envelope),
      });
    };
    /**
     * C6.1 — the request IS the call. There is no separate statement or params
     * argument that could describe a different query than the one executed, and
     * the ledger row is derived from the request rather than authored beside it.
     */
    const safeQ: SafeQ = async (request) => {
      const savepoint = `d080_sp_${ledger.length}`;
      const started = Date.now();
      assertRequestIntegrity(request);
      try {
        await sql.query(`SAVEPOINT ${savepoint}`);
        const rows = await sql.query<Row>(request.statement, request.params);
        await sql.query(`RELEASE SAVEPOINT ${savepoint}`);
        // C7.3 — the ACTUAL returned rows, hashed before any transformation.
        ledger.push({
          ...ledgerEntry(request, "ok", Date.now() - started, rows.length),
          sourceRowCount: rows.length,
          sourceRowHash: sha256Canonical(rows),
        });
        return rows;
      } catch (error) {
        const reason = sanitizeReason(error);
        try {
          await sql.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await sql.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          /* unrecoverable; later reads record their own failure honestly */
        }
        ledger.push({
          ...ledgerEntry(request, "unknown/source_read_failed", Date.now() - started, 0, reason),
          sourceRowCount: 0,
          sourceRowHash: sha256Canonical([]),
        });
        process.stderr.write(`[d080] READ_FAILED ${request.invocationKey} :: ${reason}\n`);
        return [];
      }
    };
    return run(proof ?? {}, safeQ, ledger, skip);
  });
}

const SERIES_COLUMNS = [
  "business_id", "provider_account_id", "grain", "entity_id", "parent_campaign_id",
  "effective_date", "status", "account_currency", "daily_budget", "lifetime_budget",
  "is_budget_mixed", "spend", "conversions", "revenue", "truth_state",
];
const OWNERSHIP_COLUMNS = [
  "business_id", "provider_account_id", "entity_type", "entity_id", "campaign_id",
  "adset_id", "budget_origin", "presence", "run_completeness", "endpoint", "run_id",
  "state_hash", "id", "observed_at", "captured_at", "created_at",
  "has_campaign_daily", "has_campaign_lifetime", "has_adset_daily", "has_adset_lifetime",
];

const VOCABULARY_CONSTRAINTS = [
  "engine_v3_ad_decision_snapshots_daily_label_check",
  "engine_v3_ad_decision_snapshots_daily_authorized_action_check",
  "engine_v3_ad_decision_snapshots_daily_blocked_action_type_check",
  "engine_v3_ad_decision_snapshots_dail_decision_entity_type_check",
];

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

export async function runProbe() {
  const { db } = await openDbBoundary();
  const out = await withReadOnlyTransaction(db, async (proof, safeQ) => {
    const runCols = await safeQ(buildCanonicalRequest("runSchema", { params: [] }));
    const vocab = await safeQ(buildCanonicalRequest("decisionVocabulary", { params: [VOCABULARY_CONSTRAINTS] }));
    return { proof, runCols, vocab };
  });
  const contract = evaluateSchemaContract(
    out.runCols.map((r) => text(r.column_name) ?? "").filter(Boolean),
  );
  console.log(JSON.stringify({ phase: "probe", retrievedAt: text(out.proof.retrieved_at), schemaContract: contract, vocabulary: out.vocab }, null, 1));
}

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

/**
 * C8.1 — the SHARED orchestration seam.
 *
 * Production extraction and the missing-prerequisite test call THIS function.
 * It takes the read boundary and the resolved prerequisites as inputs, so a
 * test can inject a binding whose cutoff is valid while `seriesFrom` is
 * missing, drive a fake executor, and obtain the same ledger dispositions,
 * coverage rows and result inputs real extraction produces.
 *
 * Correction 7's "end to end" test cloned a finished green artifact, mapped
 * every ledger row to itself, and verified the original. It never removed a
 * prerequisite and never ran this path.
 */
export async function orchestrateEvidence(deps: {
  safeQ: SafeQ;
  skip: (request: CanonicalRequest, code: DependencyCode, missing: string[]) => void;
  ledger: ReadLedgerEntry[];
  businessIds: string[];
  cutoffByBinding: Map<string, string | null>;
  seriesFromByBinding: Map<string, string | null>;
}) {
  const { safeQ, skip, ledger, businessIds, cutoffByBinding, seriesFromByBinding } = deps;

  /**
   * C8.1 — the four clock reads are issued BEFORE this orchestrator (they are
   * what resolves the cutoff in the first place), so it must not also account
   * for them. Everything else that is binding-scoped is owned here, and is
   * therefore either executed or explicitly skipped exactly once per binding.
   */
  const CLOCK_PLANS = new Set(["clockCampaignDaily", "clockAdsetDaily", "clockCampaignConfig", "clockAdsetConfig"]);
  const ownedBindingPlans = Object.entries(D080_READ_PLAN).filter(
    ([planKey, plan]) =>
      !CLOCK_PLANS.has(planKey) &&
      (plan.cardinality === "per_binding" || plan.cardinality === "per_binding_grain"),
  );

  // Resolve every binding's prerequisites ONCE, before any binding-scoped read,
  // so the coverage loop and the evidence loop cannot disagree about them.
  const prereqByBinding = new Map<string, BindingPrereq>();
  for (const b of D080_PINNED_BINDINGS) {
    const key = bindingKey(b.businessId, b.providerAccountId);
    if (!cutoffByBinding.has(key) || !seriesFromByBinding.has(key)) {
      throw new Error(`D080 has no resolved prerequisite record for binding ${key}`);
    }
    const cutoff = cutoffByBinding.get(key) ?? null;
    prereqByBinding.set(key, {
      businessId: b.businessId,
      providerAccountId: b.providerAccountId,
      cutoff,
      // A prerequisite RECORDED as unavailable is never recomputed from the
      // cutoff. The earlier `?? seriesFromForCutoff(cutoff)` fallback invented
      // one, so a missing series_from never reached the dependency gate.
      seriesFrom: seriesFromByBinding.get(key) ?? null,
      cutoffStatus: cutoff ? "resolved" : "unknown/source_read_failed:clockCampaignDaily",
      perSource: {},
    });
  }
  // --- R1: the three coverage concepts, per binding and grain. ---
  const observationCoverage: Row[] = [];
  const stateChangeDensity: Row[] = [];
  for (const b of D080_PINNED_BINDINGS) {
    const prereq = prereqByBinding.get(bindingKey(b.businessId, b.providerAccountId))!;
    // Both reads below are lower-bounded by series_from, so both depend on it.
    // The single gate further down emits their skips; leaving here keeps every
    // planned outcome represented exactly once.
    if (missingPrereqsFor(prereq).length > 0) continue;
    const cutoff = prereq.cutoff!;
    const from = prereq.seriesFrom!;
    for (const grain of ["campaign", "adset"] as const) {
      const args = [b.businessId, b.providerAccountId, grain, from, cutoff];
      const grainScope = {
        businessId: b.businessId, providerAccountId: b.providerAccountId,
        grain, effectiveFrom: from, effectiveTo: cutoff,
      } as const;
      observationCoverage.push(
        ...(await safeQ(buildCanonicalRequest("observationCoverage", { ...grainScope, params: args }))),
      );
      stateChangeDensity.push(
        ...(await safeQ(buildCanonicalRequest("stateChangeDensity", { ...grainScope, params: args }))),
      );
    }
  }

  /**
   * C9.1 — one row per invocation that a dependency prevented. `observation`
   * and `state_change` row contracts carry no status column, so their
   * unavailability is represented HERE rather than as an absent row; the
   * verifier requires this section to be a bijection with the ledger's
   * dependency skips, so a cell can be neither dropped nor invented.
   */
  const dependencyCoverage: Row[] = [];
  /**
   * Every skip goes through here, so a ledger skip and its coverage cell are
   * written together and cannot drift apart at one call site.
   */
  const skipWith = (
    request: CanonicalRequest,
    planKey: string,
    grain: "campaign" | "adset" | null,
    code: DependencyCode,
    missing: readonly string[],
    who: { business: string; businessId: string; providerAccountId: string | null },
  ) => {
    const sorted = [...missing].sort();
    skip(request, code, sorted);
    const family = D080_PLAN_FAMILY[planKey];
    if (!family) throw new Error(`no evidence family for plan ${planKey}`);
    dependencyCoverage.push({
      invocationKey: request.invocationKey,
      business: who.business, business_id: who.businessId, provider_account_id: who.providerAccountId,
      planKey, family, grain,
      status: "not_run_dependency_failed",
      dependencyCode: code, missingPrerequisites: sorted, rows: 0,
    });
  };

  // --- Bounded, two-sided evidence reads per binding. ---
  const seriesRows: Row[] = [];
  const ownershipRows: Row[] = [];
  const ownershipAggregate: Row[] = [];
  const ownershipConflicts: Row[] = [];
  const unitEvidence: Row[] = [];
  const unitCoverage: Row[] = [];
  const configLayers: { pointInTime: Row[]; retrospective: Row[] } = { pointInTime: [], retrospective: [] };
  const configIdentities: Row[] = [];
  const configCoverage: Row[] = [];
  const configIdentityTruncated: string[] = [];
  const canonicalPerBinding: Row[] = [];
  const servedDate: Row[] = [];
  const servedCoverage: Row[] = [];
  const canonicalIdentities = new Map<string, string[]>();
  const budgetVerbCensus: Row[] = [];
  const engineVersionOverlap: Row[] = [];

  for (const b of D080_PINNED_BINDINGS) {
    const key = bindingKey(b.businessId, b.providerAccountId);
    const prereq = prereqByBinding.get(key)!;
    const cutoff = prereq.cutoff;
    const scope = { businessId: b.businessId, providerAccountId: b.providerAccountId };
    const missing = missingPrereqsFor(prereq);
    if (missing.length > 0) {
      const code: DependencyCode = "binding_cutoff_unavailable";
      // C5.2 — every expected invocation for this binding is still RECORDED,
      // as an explicit dependency skip. Expected cardinality never shrinks.
      for (const [planKey, plan] of ownedBindingPlans) {
        if (plan.cardinality === "per_binding") {
          const request = buildCanonicalRequest(planKey, { businessId: b.businessId, providerAccountId: b.providerAccountId, grain: plan.grain ?? null, params: [] });
          skipWith(request, planKey, plan.grain ?? null, code, missing, { business: b.business, businessId: b.businessId, providerAccountId: b.providerAccountId });
        } else if (plan.cardinality === "per_binding_grain") {
          for (const grain of ["campaign", "adset"] as const) {
            const request = buildCanonicalRequest(planKey, { businessId: b.businessId, providerAccountId: b.providerAccountId, grain, params: [] });
            skipWith(request, planKey, grain, code, missing, { business: b.business, businessId: b.businessId, providerAccountId: b.providerAccountId });
          }
        }
      }
      // C9.1 — the coverage MATRICES keep their cells too. A binding whose
      // prerequisites are unavailable previously vanished from every matrix, so
      // an empty victim slice made `.every(...)` vacuously true and the fleet
      // comparison silently ran on six of seven bindings. Each cell now states
      // the dependency explicitly and can never read as a successful zero.
      const dep = { status: "not_run_dependency_failed" as const, dependency_code: code, missing_prerequisites: [...missing].sort() };
      for (const grain of ["campaign", "adset"] as const) {
        for (const field of ["daily", "lifetime"] as const) {
          unitCoverage.push({ business: b.business, business_id: b.businessId, provider_account_id: b.providerAccountId, grain, budget_field: field, rows: 0, ...dep });
        }
        for (const layer of ["pointInTime", "retrospective", "identities"] as const) {
          configCoverage.push({ business: b.business, business_id: b.businessId, provider_account_id: b.providerAccountId, grain, layer, cellKind: layer === "identities" ? "identity" : "semantic", truncated: false, ...dep });
        }
      }
      servedCoverage.push({ business: b.business, business_id: b.businessId, provider_account_id: b.providerAccountId, ...dep });
      canonicalPerBinding.push({
        business: b.business, business_id: b.businessId, provider_account_id: b.providerAccountId,
        is_selected: b.isSelected, latest_as_of: null, cutoff: prereq.cutoff,
        latest_status: "not_run_dependency_failed", identity_status: "not_run_dependency_failed",
        selection_rule: CANONICAL_DECISION_SELECTION, engine_versions_at_latest: 0,
        membership: [], label_census: {}, authorized_census: {},
        dependency_code: code, missing_prerequisites: [...missing].sort(),
      });
      continue;
    }
    const seriesFrom = prereq.seriesFrom;
    const bounds = [b.businessId, b.providerAccountId, seriesFrom, cutoff];

    seriesRows.push(...(await safeQ(buildCanonicalRequest("seriesCampaign", { ...scope, grain: "campaign", effectiveFrom: seriesFrom, effectiveTo: cutoff, params: bounds }))));
    seriesRows.push(...(await safeQ(buildCanonicalRequest("seriesAdset", { ...scope, grain: "adset", effectiveFrom: seriesFrom, effectiveTo: cutoff, params: bounds }))));
    const lineageFrom = new Date(
      Date.parse(`${cutoff}T00:00:00.000Z`) - OWNERSHIP_LINEAGE_DAYS * 86_400_000,
    ).toISOString().slice(0, 10);
    for (const grain of ["campaign", "adset"]) {
      const ownScope = { ...scope, grain: grain as "campaign" | "adset", source: "meta_entity_state_history", effectiveFrom: seriesFrom, effectiveTo: cutoff };
      ownershipAggregate.push(
        ...(await safeQ(buildCanonicalRequest("ownershipAggregate", { ...ownScope, params: [b.businessId, b.providerAccountId, grain, seriesFrom, cutoff] }))),
      );
      ownershipConflicts.push(
        ...(await safeQ(buildCanonicalRequest("ownershipSameClockConflicts", { ...ownScope, params: [b.businessId, b.providerAccountId, grain, seriesFrom, cutoff] }))),
      );
    }
    ownershipRows.push(
      ...(await safeQ(buildCanonicalRequest("ownershipObservations", { ...scope, effectiveFrom: lineageFrom, effectiveTo: cutoff, knowledgeTo: cutoff, params: [b.businessId, b.providerAccountId, lineageFrom, cutoff] }))),
    );
    // C3.6 — all FOUR grain/field unit cells, with an explicit coverage
    // verdict per cell. A zero-row successful read is zero evidence; a failed
    // read is unknown. Neither may be reported as "no comparable rows".
    for (const cell of [
      { name: "unitEvidenceCampaignDaily", grain: "campaign", field: "daily", sql: D080_QUERIES.unitEvidenceCampaignDaily },
      { name: "unitEvidenceCampaignLifetime", grain: "campaign", field: "lifetime", sql: D080_QUERIES.unitEvidenceCampaignLifetime },
      { name: "unitEvidenceAdsetDaily", grain: "adset", field: "daily", sql: D080_QUERIES.unitEvidenceAdsetDaily },
      { name: "unitEvidenceAdsetLifetime", grain: "adset", field: "lifetime", sql: D080_QUERIES.unitEvidenceAdsetLifetime },
    ] as const) {
      const before = ledger.length;
      const rows = await safeQ(buildCanonicalRequest(cell.name, { ...scope, grain: cell.grain as "campaign" | "adset", effectiveFrom: seriesFrom, effectiveTo: cutoff, params: bounds }));
      const failed = ledger.slice(before).some((e) => e.status !== "ok");
      unitEvidence.push(...rows);
      unitCoverage.push({
        business: b.business, business_id: b.businessId, provider_account_id: b.providerAccountId,
        grain: cell.grain, budget_field: cell.field,
        status: failed ? "unknown/source_read_failed" : rows.length > 0 ? "rows_returned" : "zero_rows_returned",
        rows: rows.length,
      });
    }

    // C3.2/C3.3 — two knowledge-time layers over the same effective window.
    for (const grain of ["campaign", "adset"] as const) {
      const table = grain === "campaign" ? "meta_campaign_config_history" : "meta_adset_config_history";
      const entityCol = grain === "campaign" ? "campaign_id" : "adset_id";
      const shape = (sql: string) =>
        sql.replaceAll("SOURCE_TABLE", table).replaceAll("ENTITY_COL", entityCol).replaceAll("GRAIN_LABEL", grain);
      for (const layer of [
        { name: "pointInTime", knowledgeBound: cutoff },
        { name: "retrospective", knowledgeBound: null },
      ] as const) {
        const before = ledger.length;
        const rows = await safeQ(buildCanonicalRequest(`configSemanticStates:${layer.name}`, {
          ...scope, grain: grain as "campaign" | "adset",
          effectiveFrom: seriesFrom, effectiveTo: cutoff, knowledgeTo: layer.knowledgeBound,
          params: [b.businessId, b.providerAccountId, seriesFrom, cutoff, layer.knowledgeBound],
        }));
        const failed = ledger.slice(before).some((e) => e.status !== "ok");
        for (const row of rows) configLayers[layer.name].push(row);
        configCoverage.push({
          business: b.business, business_id: b.businessId, provider_account_id: b.providerAccountId,
          grain, layer: layer.name, cellKind: "semantic",
          status: failed ? "unknown/source_read_failed" : "ok",
          truncated: false,
        });
      }
      const beforeIdentity = ledger.length;
      const identities = await safeQ(buildCanonicalRequest("configTransitionIdentities", {
        ...scope, grain,
        effectiveFrom: seriesFrom, effectiveTo: cutoff, knowledgeTo: cutoff, limit: CONFIG_IDENTITY_LIMIT,
        params: [b.businessId, b.providerAccountId, seriesFrom, cutoff, cutoff, CONFIG_IDENTITY_LIMIT],
      }));
      const identityFailed = ledger.slice(beforeIdentity).some((e) => e.status !== "ok");
      configIdentities.push(...identities);
      const truncated = identities.length >= CONFIG_IDENTITY_LIMIT;
      if (truncated) configIdentityTruncated.push(`${b.providerAccountId}/${grain}`);
      // C4.5 — the identity read is part of coverage. It could previously
      // fail while totalClaimable stayed true and the manifest went partial.
      configCoverage.push({
        business: b.business, business_id: b.businessId, provider_account_id: b.providerAccountId,
        grain, layer: "identities", cellKind: "identity",
        status: identityFailed ? "unknown/source_read_failed" : "ok",
        truncated,
      });
    }

    // C3.7 — reproduce the UI served-date resolution candidate by candidate,
    // so equality with the native max is proven rather than assumed.
    const beforeServed = ledger.length;
    const servedRows = await safeQ(buildCanonicalRequest("servedDateCandidates", { ...scope, params: [b.businessId, b.providerAccountId] }));
    const servedFailed = ledger.slice(beforeServed).some((e) => e.status !== "ok");
    servedDate.push(...servedRows);
    // C4.3 — exactly one coverage record per pinned binding, so a failed or
    // empty read cannot make the fleet comparison vacuously true.
    const servedRow = servedRows[0];
    const anyCandidate =
      servedRow !== undefined &&
      [servedRow.native_ad_max, servedRow.legacy_creative_max, servedRow.native_job_run_max].some((v) => text(v) !== null);
    servedCoverage.push({
      business: b.business, business_id: b.businessId, provider_account_id: b.providerAccountId,
      status: servedFailed ? "unknown/source_read_failed" : !anyCandidate ? "no_candidate" : "ok",
    });

    // R2: canonical = latest generation for THIS binding.
    const latestRows = await safeQ(buildCanonicalRequest("canonicalLatestAsOf", { ...scope, params: [b.businessId, b.providerAccountId] }));
    const latestAsOf = text(latestRows[0]?.latest_as_of);
    let manifest: MembershipManifest = { count: 0, groupHash: sha256Canonical([]), firstIdentity: null, lastIdentity: null };
    let labelCensus: Record<string, number> = {};
    let authorizedCensus: Record<string, number> = {};
    let versionsAtLatest = 0;
    let identityStatus: string = "not_run_dependency_failed";
    if (!latestAsOf) {
      skipWith(
        buildCanonicalRequest("canonicalIdentities", { businessId: b.businessId, providerAccountId: b.providerAccountId, params: [] }),
        "canonicalIdentities", null, "canonical_latest_as_of_unavailable", ["latest_as_of"],
        { business: b.business, businessId: b.businessId, providerAccountId: b.providerAccountId },
      );
    }
    if (latestAsOf) {
      const beforeIds = ledger.length;
      const ids = await safeQ(buildCanonicalRequest("canonicalIdentities", { ...scope, asOfDate: latestAsOf, params: [b.businessId, b.providerAccountId, latestAsOf] }));
      identityStatus = ledger.slice(beforeIds).some((e) => e.status !== "ok")
        ? "unknown/source_read_failed"
        : ids.length > 0
          ? "ok_populated"
          : "ok_zero_identities";
      const identities = ids.map((r) =>
        decisionIdentity({
          businessId: text(r.business_id), providerAccountId: text(r.provider_account_id),
          asOfDate: text(r.as_of_date), engineVersion: text(r.engine_version),
          decisionEntityId: text(r.decision_entity_id), adId: text(r.ad_id),
          scopeType: text(r.scope_type), scopeId: text(r.scope_id),
          inputHash: text(r.input_hash), decisionHash: text(r.decision_hash),
          evaluationId: text(r.evaluation_id), jobRunId: text(r.job_run_id),
          computedAt: text(r.computed_at),
        }),
      );
      manifest = buildMembershipManifest(identities);
      canonicalIdentities.set(key, identities);
      labelCensus = tally(ids.map((r) => text(r.label) ?? "null"));
      authorizedCensus = tally(ids.map((r) => text(r.authorized_action) || "none"));
      versionsAtLatest = new Set(ids.map((r) => text(r.engine_version))).size;
    }
    canonicalPerBinding.push({
      business: b.business, business_id: b.businessId, provider_account_id: b.providerAccountId,
      is_selected: b.isSelected, latest_as_of: latestAsOf, cutoff,
      // C5.3 — an explicit identity outcome. A default empty membership must
      // never hide a failed or skipped identity read.
      latest_status: latestAsOf ? "ok" : "no_latest_candidate",
      identity_status: identityStatus,
      selection_rule: CANONICAL_DECISION_SELECTION,
      engine_versions_at_latest: versionsAtLatest,
      membership: manifest, label_census: labelCensus, authorized_census: authorizedCensus,
    });

    budgetVerbCensus.push(
      ...(await safeQ(buildCanonicalRequest("budgetVerbCensus", { ...scope, effectiveTo: cutoff, params: [b.businessId, b.providerAccountId, [...BUDGET_VERBS], cutoff] }))),
    );
    engineVersionOverlap.push(
      ...(await safeQ(buildCanonicalRequest("engineVersionOverlap", { ...scope, effectiveTo: cutoff, params: [b.businessId, b.providerAccountId, cutoff] }))),
    );
  }

  // --- R3: campaign role. Business-scoped rows; every column carried. ---
  const roleRows: Row[] = [];
  const roleCensus: Row[] = [];
  for (const businessId of businessIds) {
    const cutoffs = D080_PINNED_BINDINGS.filter((b) => b.businessId === businessId)
      .map((b) => cutoffByBinding.get(bindingKey(b.businessId, b.providerAccountId)))
      .filter((c): c is string => Boolean(c))
      .sort();
    const cutoff = cutoffs[cutoffs.length - 1];
    if (!cutoff) {
      skipWith(
        buildCanonicalRequest("campaignRole", { businessId, params: [] }),
        "campaignRole", null, "business_cutoff_unavailable", ["business_cutoff"],
        { business: D080_PINNED_BINDINGS.find((x) => x.businessId === businessId)?.business ?? businessId, businessId, providerAccountId: null },
      );
    }
    if (cutoff) {
      const from = new Date(Date.parse(`${cutoff}T00:00:00.000Z`) - BUDGET_SERIES_LOOKBACK_DAYS * 86_400_000)
        .toISOString().slice(0, 10);
      roleRows.push(...(await safeQ(buildCanonicalRequest("campaignRole", { businessId, effectiveFrom: from, effectiveTo: cutoff, params: [businessId, from, cutoff] }))));
    }
    roleCensus.push(...(await safeQ(buildCanonicalRequest("campaignRoleCensus", { businessId, params: [businessId] }))));
  }

  const targetPackHistory = await safeQ(buildCanonicalRequest("targetPackHistory", { businessList: businessIds, params: [businessIds] }));
  return {
    observationCoverage, stateChangeDensity, seriesRows, ownershipRows,
    ownershipAggregate, ownershipConflicts, unitEvidence, unitCoverage,
    configLayers, configIdentities, configCoverage, configIdentityTruncated,
    canonicalPerBinding, servedDate, servedCoverage, canonicalIdentities,
    budgetVerbCensus, engineVersionOverlap, roleRows, roleCensus, targetPackHistory,
    dependencyCoverage,
  };
}

/**
 * C8.1 — artifact assembly, shared by production extraction and the
 * orchestration test so the test can seal a real package and run the full
 * verifier over it.
 */
export function assembleArtifact(frozen: {
  proof: Row; ledger: ReadLedgerEntry[]; schemaContract: SchemaContract; vocabulary: Row[];
  dbBindings: Row[]; matrixExpectedMissing: string[]; matrixUnexpectedExtra: string[];
  clockRows: Row[]; perBinding: Row[]; observationCoverage: Row[]; stateChangeDensity: Row[];
  seriesRows: Row[]; ownershipRows: Row[]; ownershipAggregate: Row[]; ownershipConflicts: Row[];
  unitEvidence: Row[]; unitCoverage: Row[]; configLayers: { pointInTime: Row[]; retrospective: Row[] };
  configIdentities: Row[]; configCoverage: Row[]; configIdentityTruncated: string[];
  canonicalPerBinding: Row[]; servedDate: Row[]; servedCoverage: Row[];
  dependencyCoverage: Row[];
  budgetVerbCensus: Row[]; engineVersionOverlap: Row[]; roleRows: Row[]; roleCensus: Row[];
  targetPackHistory: Row[]; d078Sha: string;
  authority: ExecutionAuthorityVerdict;
}): Record<string, unknown> {
  const readFailures = frozen.ledger.filter((e) => e.status !== "ok");
  const artifact = sealArtifact({
    contract: D080_EVIDENCE_CONTRACT,
    provenance: {
      retrievedAt: text(frozen.proof.retrieved_at),
      transactionIsolation: text(frozen.proof.transaction_isolation),
      transactionReadOnly: text(frozen.proof.transaction_read_only),
      statementTimeout: text(frozen.proof.statement_timeout),
      lockTimeout: text(frozen.proof.lock_timeout),
      queryContractSha256: sha256Canonical(D080_QUERIES),
      queryManifestSha256: sha256Canonical(D080_QUERY_MANIFEST),
      readPlanSha256: sha256Canonical(D080_READ_PLAN),
      sqlTemplateCount: Object.keys(D080_QUERIES).length,
      planDefinitionCount: Object.keys(D080_READ_PLAN).length,
      expectedInvocationCount: D080_EXPECTED_INVOCATION_COUNT,
      seriesLookbackDays: BUDGET_SERIES_LOOKBACK_DAYS,
      executionAuthority: {
        ...frozen.authority,
        note: "Loading configuration through @next/env POPULATES process.env and assigns ENABLE_RUNTIME_MIGRATIONS=0 when absent. The enforced invariant is that this script never grants or masks execution authority: a truthy flag before OR after loading refuses the run and is never overwritten.",
      },
      readLedger: frozen.ledger,
      // Derived here, never passed in, so it cannot drift from the ledger.
      readFailures: frozen.ledger.filter((entry) => entry.status !== "ok"),
      queryManifest: D080_QUERY_MANIFEST,
      note: "SELECT-only. One REPEATABLE READ READ ONLY transaction, savepoint per optional read. Scope and bounds are NOT uniform: see queryManifest, which classifies each query as static schema, binding discovery or time-varying and states its effective/knowledge bounds and PIT status. The earlier blanket claim that every read was account-scoped and two-sided is withdrawn. No provider call. No entity names, credentials or raw provider payloads.",
    },
    dependencyCoverage: {
      cells: frozen.dependencyCoverage,
      note: "One cell per invocation a dependency prevented, including the observation and state-change reads whose row contracts carry no status column. The verifier requires an exact one-to-one correspondence with the ledger's dependency skips: a cell can neither be dropped to make coverage look complete, nor invented to claim a skip that never happened.",
    },
    schemaContract: frozen.schemaContract,
    sourceSemantics: { sources: D080_SOURCE_SEMANTICS, note: "Audited from the writers, not inferred from column names." },
    scope: {
      pinnedBindings: D080_PINNED_BINDINGS,
      observedBindings: frozen.dbBindings,
      expectedMissing: frozen.matrixExpectedMissing,
      unexpectedExtra: frozen.matrixUnexpectedExtra,
      pinnedInputs: { ...D080_PINNED_INPUTS, d078BundleObserved: frozen.d078Sha },
    },
    clocks: { perSource: frozen.clockRows, perBinding: frozen.perBinding },
    observationCoverage: {
      providerObservationFreshness: frozen.observationCoverage,
      stateChangeCheckpointDensity: frozen.stateChangeDensity,
      note: "These are DIFFERENT measurements. state_change_days counts days on which stored truth CHANGED or a checkpoint was forced; heartbeat_last_seen is when truth was last CONFIRMED, including byte-identical re-observations that coalesced into the run instead of rewriting state rows. Neither is strict-PIT owner resolvability, which schemaContract governs.",
    },
    unitEvidence: {
      rows: frozen.unitEvidence,
      coverageMatrix: frozen.unitCoverage,
      factualContract: FACTUAL_UNIT_CONTRACT,
      note: "Four grain/field cells per binding. status distinguishes rows_returned, zero_rows_returned (a successful read that found nothing comparable — zero evidence, not absence of the field) and unknown/source_read_failed.",
    },
    series: toColumnar(frozen.seriesRows, SERIES_COLUMNS),
    ownershipObservations: toColumnar(frozen.ownershipRows, OWNERSHIP_COLUMNS),
    ownershipCoverage: {
      aggregate: frozen.ownershipAggregate,
      sameClockConflicts: frozen.ownershipConflicts,
      lineageWindowDays: OWNERSHIP_LINEAGE_DAYS,
      note: "The aggregate spans the full series window; ownershipObservations carries row-level lineage for the last OWNERSHIP_LINEAGE_DAYS before each binding's cutoff. With strict PIT refused by the schema contract, a full-window row dump would add no analytic power.",
    },
    configStates: {
      pointInTime: frozen.configLayers.pointInTime,
      retrospective: frozen.configLayers.retrospective,
      identities: frozen.configIdentities,
      coverage: frozen.configCoverage,
      identityTruncatedFor: frozen.configIdentityTruncated,
      identityLimit: CONFIG_IDENTITY_LIMIT,
      note: "pointInTime bounds captured_at by the binding cutoff and IS knowledge-time safe as of that cutoff. retrospective admits late-arriving capture for the same effective window and is NOT point-in-time. Counts are aggregated in SQL; only non-routine transition identities are materialised, capped at identityLimit.",
    },
    canonicalDecisions: {
      selectionRule: CANONICAL_DECISION_SELECTION,
      selectionEvidence:
        "CORRECTED: the two readers do NOT share a contract. lib/meta/assigned-account-states.ts takes the native MAX(as_of_date) per (business, provider_account) alone. app/api/meta/decisions-workspace/route.ts resolveWorkspaceEndDate first resolves a SERVED end date from a UNION of three candidates — native ad decisions, legacy creative snapshots scoped to account-exclusive creatives, and the native job-run date — with fallbacks, and then reads that exact served day. The servedDate section reproduces each candidate so equality is proven per binding rather than assumed.",
      vocabularyConstraints: frozen.vocabulary,
      perBinding: frozen.canonicalPerBinding,
      servedDate: frozen.servedDate,
      servedDateCoverage: frozen.servedCoverage,
      budgetVerbCensus: frozen.budgetVerbCensus,
      engineVersionOverlap: frozen.engineVersionOverlap,
    },
    campaignRole: { rows: frozen.roleRows, census: frozen.roleCensus },
    targetPackHistory: frozen.targetPackHistory,
  });
  return artifact;
}

/** C10.1 — the rejection reason each forged field produces. */
export const DEPENDENCY_FIELD_REASON: Record<string, ScopeCutoffReason> = {
  invocationKey: "dependency_coverage_mismatch",
  business: "dependency_cell_identity_mismatch",
  business_id: "dependency_cell_identity_mismatch",
  provider_account_id: "dependency_cell_identity_mismatch",
  planKey: "dependency_plan_mismatch",
  family: "dependency_family_mismatch",
  grain: "dependency_cell_grain_mismatch",
  status: "dependency_state_not_stated",
  dependencyCode: "dependency_code_mismatch",
  missingPrerequisites: "dependency_missing_set_mismatch",
};

/**
 * C10.1 — the EXACT stable shape a dependency cell may carry. Anything outside
 * this set is a smuggled field: Correction 9 compared five fields and let a
 * forged `business`, `business_id`, `provider_account_id`, `grain`, `status`
 * or `rows` ride along unchallenged.
 */
export const D080_DEPENDENCY_CELL_FIELDS = [
  "invocationKey", "business", "business_id", "provider_account_id",
  "planKey", "family", "grain", "status", "dependencyCode",
  "missingPrerequisites", "rows",
] as const;

export interface ExpectedDependencyCell {
  invocationKey: string;
  business: string;
  business_id: string;
  provider_account_id: string | null;
  planKey: string;
  family: string;
  grain: "campaign" | "adset" | null;
  status: "not_run_dependency_failed";
  dependencyCode: string;
  missingPrerequisites: string[];
  rows: 0;
}

/**
 * C10.1 — the canonical projection every dependency cell must equal.
 *
 * It is derived from three sources that are ALREADY verified independently of
 * the cell: the ledger's skip row (reconciled field-by-field against the
 * request rebuilt from the static plan and the frozen prerequisites), the
 * pinned binding matrix (for the display name and the exact identity pair), and
 * the static plan/family tables. The cell contributes nothing to its own
 * expectation, so matching it is a real check rather than a tautology.
 */
export function expectedDependencyCells(
  artifact: Record<string, unknown>,
): { cells: ExpectedDependencyCell[]; violations: ScopeCutoffViolation[] } {
  const section = "dependencyCoverage.cells";
  const violations: ScopeCutoffViolation[] = [];
  const ledger = (at(artifact, "provenance.readLedger") as Row[] | undefined) ?? [];
  const cells: ExpectedDependencyCell[] = [];

  for (const row of ledger) {
    if (text(row.disposition) !== "dependency_skip") continue;
    const invocationKey = String(text(row.invocationKey) ?? "");
    const planKey = String(text(row.planKey) ?? "");
    const plan = D080_READ_PLAN[planKey];
    const family = D080_PLAN_FAMILY[planKey];
    if (!plan || !family) {
      violations.push({ section, reason: "dependency_plan_mismatch", detail: `${invocationKey}: no plan or evidence family for ${JSON.stringify(planKey)}` });
      continue;
    }
    const businessId = text(row.businessId);
    const providerAccountId = text(row.providerAccountId);
    if (!businessId) {
      violations.push({ section, reason: "missing_identity", detail: `${invocationKey}: the skipped invocation names no business` });
      continue;
    }
    // The exact pinned row. A business-scoped skip carries no account, so it is
    // resolved by business alone; a binding-scoped skip must match the PAIR.
    const pinned = providerAccountId === null
      ? D080_PINNED_BINDINGS.find((b) => b.businessId === businessId)
      : D080_PINNED_BINDINGS.find((b) => b.businessId === businessId && b.providerAccountId === providerAccountId);
    if (!pinned) {
      violations.push({ section, reason: "unpinned_binding", detail: `${invocationKey}: ${businessId}|${providerAccountId ?? "-"} is not a pinned ${providerAccountId === null ? "business" : "binding"}` });
      continue;
    }
    // Grain comes from the static plan and the invocation's own cardinality,
    // exactly as `buildCanonicalRequest` derives it.
    const ledgerGrain = text(row.grain);
    const expectedGrain: "campaign" | "adset" | null =
      plan.grain !== undefined
        ? plan.grain
        : plan.cardinality === "per_binding_grain"
          ? (ledgerGrain === "adset" ? "adset" : "campaign")
          : null;
    if (plan.cardinality === "per_binding_grain" && ledgerGrain !== "campaign" && ledgerGrain !== "adset") {
      violations.push({ section, reason: "dependency_plan_mismatch", detail: `${invocationKey}: a per-grain plan skipped without a grain` });
      continue;
    }
    const missing = Array.isArray(row.missingPrerequisites)
      ? [...(row.missingPrerequisites as unknown[])].map(String).sort()
      : [];
    cells.push({
      invocationKey,
      business: pinned.business,
      business_id: pinned.businessId,
      provider_account_id: providerAccountId === null ? null : pinned.providerAccountId,
      planKey,
      family,
      grain: expectedGrain,
      status: "not_run_dependency_failed",
      dependencyCode: String(text(row.dependencyCode) ?? ""),
      missingPrerequisites: missing,
      rows: 0,
    });
  }
  return { cells, violations };
}

/**
 * C9.1 — `dependencyCoverage.cells` must be an exact bijection with the
 * ledger's `dependency_skip` rows: same invocation keys, same dependency code,
 * same missing-prerequisite set. Dropping a cell would let an unavailable
 * binding disappear from coverage again; inventing one would claim a skip that
 * never happened. Neither survives.
 */
export function reconcileDependencyCoverage(artifact: Record<string, unknown>): ScopeCutoffViolation[] {
  const violations: ScopeCutoffViolation[] = [];
  const section = "dependencyCoverage.cells";
  const cells = (at(artifact, section) as Row[] | undefined) ?? [];
  const ledger = (at(artifact, "provenance.readLedger") as Row[] | undefined) ?? [];
  const skips = ledger.filter((r) => text(r.disposition) === "dependency_skip");

  const audit = auditExpectedKeys(
    skips.map((r) => String(text(r.invocationKey) ?? "")),
    cells.map((r) => String(text(r.invocationKey) ?? "")),
  );
  if (!audit.ok) {
    violations.push({
      section, reason: "dependency_coverage_mismatch",
      detail: `missing ${JSON.stringify(audit.missing.slice(0, 3))}, duplicates ${JSON.stringify(audit.duplicates.slice(0, 3))}, unexpected ${JSON.stringify(audit.unexpected.slice(0, 3))}`,
    });
  }
  // C10.1 — the COMPLETE stable projection, field by field. Correction 9 stopped
  // at five fields, so a cell could name the wrong grain, the wrong account, a
  // forged display identity or a non-zero row count and still verify.
  const expected = expectedDependencyCells(artifact);
  violations.push(...expected.violations);
  const expectedByKey = new Map(expected.cells.map((c) => [c.invocationKey, c]));
  const allowedFields = new Set<string>(D080_DEPENDENCY_CELL_FIELDS);

  for (const cell of cells) {
    const key = String(text(cell.invocationKey) ?? "");
    // No field is trusted because the invocation key matched.
    const extras = Object.keys(cell).filter((f) => !allowedFields.has(f));
    if (extras.length > 0) {
      violations.push({ section, reason: "dependency_cell_unexpected_field", detail: `${key}: unexpected stable field(s) ${JSON.stringify(extras.sort())}. The permitted set is ${JSON.stringify([...D080_DEPENDENCY_CELL_FIELDS])}` });
    }
    const missingFields = D080_DEPENDENCY_CELL_FIELDS.filter((f) => !(f in cell));
    if (missingFields.length > 0) {
      violations.push({ section, reason: "dependency_cell_field_missing", detail: `${key}: required field(s) ${JSON.stringify(missingFields)} absent` });
    }
    // `rows` must be the integer zero, not merely a non-negative count: a skip
    // read nothing, so any other value is a claim about data never fetched.
    if (typeof cell.rows !== "number" || !Number.isInteger(cell.rows) || cell.rows !== 0) {
      violations.push({ section, reason: "dependency_cell_rows_invalid", detail: `${key}: rows ${JSON.stringify(cell.rows)} is not the integer 0` });
    }
    const want = expectedByKey.get(key);
    if (!want) continue;
    for (const field of D080_DEPENDENCY_CELL_FIELDS) {
      if (field === "rows" || !(field in cell)) continue;
      const observed = field === "missingPrerequisites"
        ? (Array.isArray(cell[field]) ? [...(cell[field] as unknown[])].map(String) : cell[field])
        : (cell[field] ?? null);
      const wanted = (want as unknown as Record<string, unknown>)[field] ?? null;
      if (canonicalJson(observed ?? null) !== canonicalJson(wanted)) {
        violations.push({
          section,
          reason: DEPENDENCY_FIELD_REASON[field] ?? "dependency_cell_field_mismatch",
          detail: `${key}: ${field} ${canonicalJson(observed ?? null)} does not match the expected ${canonicalJson(wanted)} derived from the ledger, the pinned matrix and the static plan`,
        });
      }
    }
  }

  // And the multisets themselves must be equal, so a cell can be neither
  // dropped nor duplicated even when every surviving cell is well formed.
  const project = (rows: Array<Record<string, unknown>>) =>
    rows
      .map((r) => canonicalJson(Object.fromEntries(D080_DEPENDENCY_CELL_FIELDS.map((f) => [f, r[f] ?? null]))))
      .sort();
  const observedMultiset = project(cells as Array<Record<string, unknown>>);
  const expectedMultiset = project(expected.cells as unknown as Array<Record<string, unknown>>);
  if (canonicalJson(observedMultiset) !== canonicalJson(expectedMultiset)) {
    const missingOnes = expectedMultiset.filter((x) => !observedMultiset.includes(x));
    const extraOnes = observedMultiset.filter((x) => !expectedMultiset.includes(x));
    violations.push({
      section, reason: "dependency_cell_projection_mismatch",
      detail: `the cell multiset is not the expected projection: ${missingOnes.length} missing, ${extraOnes.length} unexpected; first missing ${missingOnes[0]?.slice(0, 160) ?? "-"}`,
    });
  }

  // A binding that lost its prerequisites must still occupy every coverage
  // matrix, with an explicit dependency state rather than an absent row.
  // Only a binding blocked at the cutoff loses its whole matrix row set. A
  // narrower dependency (a missing canonical as-of, say) blocks one invocation
  // and must NOT be read as a demand for empty matrix cells.
  const affected = new Set(
    cells
      .filter((c) => text(c.dependencyCode) === "binding_cutoff_unavailable" && text(c.provider_account_id) !== null)
      .map((c) => `${text(c.business_id) ?? ""}|${text(c.provider_account_id) ?? ""}`),
  );
  const matrixExpectations: Array<{ path: string; per: number }> = [
    { path: "unitEvidence.coverageMatrix", per: 4 },
    { path: "configStates.coverage", per: 6 },
    { path: "canonicalDecisions.servedDateCoverage", per: 1 },
    { path: "canonicalDecisions.perBinding", per: 1 },
  ];
  for (const key of affected) {
    const [businessId, providerAccountId] = key.split("|");
    for (const { path, per } of matrixExpectations) {
      const rows = ((at(artifact, path) as Row[] | undefined) ?? []).filter(
        (r) => text(r.business_id) === businessId && text(r.provider_account_id) === providerAccountId,
      );
      if (rows.length !== per) {
        violations.push({ section: path, reason: "dependency_matrix_hole", detail: `${key}: expected ${per} cell(s) for a dependency-blocked binding, found ${rows.length}` });
        continue;
      }
      const stated = rows.every(
        (r) => text(r.status) === "not_run_dependency_failed" || text(r.latest_status) === "not_run_dependency_failed",
      );
      if (!stated) {
        violations.push({ section: path, reason: "dependency_state_not_stated", detail: `${key}: a dependency-blocked cell does not carry not_run_dependency_failed` });
      }
    }
  }
  return violations;
}

/**
 * C9.1 — which evidence family an invocation belongs to. Every owned
 * binding-scoped plan maps to exactly one family, so a dependency cell names
 * the evidence that is missing rather than only the plan key.
 */
export const D080_PLAN_FAMILY: Record<string, string> = {
  observationCoverage: "observation",
  stateChangeDensity: "state_change",
  seriesCampaign: "series",
  seriesAdset: "series",
  ownershipAggregate: "ownership",
  ownershipSameClockConflicts: "ownership",
  ownershipObservations: "ownership",
  unitEvidenceCampaignDaily: "unit",
  unitEvidenceCampaignLifetime: "unit",
  unitEvidenceAdsetDaily: "unit",
  unitEvidenceAdsetLifetime: "unit",
  "configSemanticStates:pointInTime": "config",
  "configSemanticStates:retrospective": "config",
  configTransitionIdentities: "config",
  servedDateCandidates: "served_date",
  canonicalLatestAsOf: "canonical",
  canonicalIdentities: "canonical",
  budgetVerbCensus: "budget_verb",
  engineVersionOverlap: "engine_version",
  campaignRole: "campaign_role",
  campaignRoleCensus: "campaign_role",
};

/**
 * C9.1 — the ONE evidence-collection flow. Production runs it inside a real
 * read-only transaction; the behavioural tests run it against a deterministic
 * synthetic source through the same `safeQ`/`skip` boundary. Correction 8's
 * scenario stopped at `orchestrateEvidence` and never assembled a package, so
 * nothing proved the package a missing prerequisite actually produces.
 */
export async function collectEvidence(deps: {
  proof: Row;
  safeQ: SafeQ;
  skip: (request: CanonicalRequest, code: DependencyCode, missing: string[]) => void;
  ledger: ReadLedgerEntry[];
  businessIds: string[];
  d078Sha: string;
  /**
   * C9.1 — how a binding's series lower bound is resolved from its cutoff.
   * Production passes the real derivation; a behavioural test injects one that
   * reports the bound as unavailable for a single binding, which is the only
   * way to reach the dependency gate through the real flow.
   */
  resolveSeriesFrom?: (cutoff: string | null, binding: PinnedBinding) => string | null;
}) {
  const { proof, safeQ, ledger, skip, businessIds, d078Sha } = deps;
  const resolveSeriesFrom = deps.resolveSeriesFrom ?? ((cutoff) => seriesFromForCutoff(cutoff));
  // --- R1: schema contract first. Nothing is reconstructed before this. ---
  const runCols = await safeQ(buildCanonicalRequest("runSchema", { params: [] }));
  const schemaContract = evaluateSchemaContract(
    runCols.map((r) => text(r.column_name) ?? "").filter(Boolean),
  );
  const vocabulary = await safeQ(buildCanonicalRequest("decisionVocabulary", { params: [VOCABULARY_CONSTRAINTS] }));

  // --- R5: prove the pinned matrix against the database. ---
  const dbBindings = await safeQ(buildCanonicalRequest("bindings", { businessList: businessIds, params: [businessIds] }));
  const observedKeys = new Set(
    dbBindings.map((r) => bindingKey(text(r.business_id) ?? "", text(r.provider_account_id) ?? "")),
  );
  const matrixExpectedMissing = D080_PINNED_BINDINGS.filter(
    (b) => !observedKeys.has(bindingKey(b.businessId, b.providerAccountId)),
  ).map((b) => bindingKey(b.businessId, b.providerAccountId));
  const matrixUnexpectedExtra = [...observedKeys].filter((k) => !PINNED_KEYS.has(k));

  // --- R5: per-binding clocks; every cell savepoint-isolated. ---
  const clockRows: Row[] = [];
  const clockCells = new Map<string, Row>();
  for (const b of D080_PINNED_BINDINGS) {
    const scope = { businessId: b.businessId, providerAccountId: b.providerAccountId };
    // C3.5 — the ledger and the fallback row carry the REAL entity grain and
    // the REAL source table. Correction 2 wrote the query name into the grain
    // field, so the frozen failure read `grain: "clockAdsetConfig"` while the
    // report called it `adset`.
    for (const cell of [
      { name: "clockCampaignDaily", sql: D080_QUERIES.clockCampaignDaily, grain: "campaign", source: "meta_campaign_daily", extra: [] as unknown[] },
      { name: "clockAdsetDaily", sql: D080_QUERIES.clockAdsetDaily, grain: "adset", source: "meta_adset_daily", extra: [] },
      { name: "clockCampaignConfig", sql: D080_QUERIES.clockCampaignConfig, grain: "campaign", source: "meta_campaign_config_history", extra: [] },
      { name: "clockAdsetConfig", sql: D080_QUERIES.clockAdsetConfig, grain: "adset", source: "meta_adset_config_history", extra: ["2026-01-01"] },
    ]) {
      const rows = await safeQ(buildCanonicalRequest(cell.name, {
        businessId: b.businessId, providerAccountId: b.providerAccountId,
        grain: cell.grain as "campaign" | "adset",
        effectiveFrom: cell.extra.length ? String(cell.extra[0]) : null,
        params: [b.businessId, b.providerAccountId, ...cell.extra],
      }));
      const row = rows[0] ?? {
        source: cell.source,
        grain: cell.grain,
        business_id: b.businessId,
        provider_account_id: b.providerAccountId,
        latest_effective: null,
        earliest_effective: null,
        status: "unknown/source_read_failed",
      };
      clockRows.push(row);
      clockCells.set(`${bindingKey(b.businessId, b.providerAccountId)}|${cell.name}`, row);
    }
  }

  // --- R5: cutoff per binding, from the sources the layer actually needs. ---
  const REQUIRED_FOR_LAYER = ["clockCampaignDaily", "clockAdsetDaily"];
  const perBinding: Row[] = [];
  const cutoffByBinding = new Map<string, string | null>();
  const seriesFromByBinding = new Map<string, string | null>();
  for (const b of D080_PINNED_BINDINGS) {
    const key = bindingKey(b.businessId, b.providerAccountId);
    const latests: string[] = [];
    let incomplete: string | null = null;
    for (const need of REQUIRED_FOR_LAYER) {
      const cell = clockCells.get(`${key}|${need}`);
      const latest = (text(cell?.latest_effective) ?? "").slice(0, 10);
      if (!latest) {
        incomplete = need;
        break;
      }
      latests.push(latest);
    }
    const cutoff = incomplete ? null : latests.sort()[0]!;
    cutoffByBinding.set(key, cutoff);
    // One resolution, used by both the clocks row and the dependency gate, so
    // the reported bound and the bound the gate acts on can never disagree.
    const seriesFrom = resolveSeriesFrom(cutoff, b);
    seriesFromByBinding.set(key, seriesFrom);
    perBinding.push({
      business: b.business,
      business_id: b.businessId,
      provider_account_id: b.providerAccountId,
      is_selected: b.isSelected,
      cutoff,
      series_from: seriesFrom,
      cutoff_status: cutoff ? "resolved" : `unknown/source_read_failed:${incomplete}`,
      per_source: Object.fromEntries(
        ["clockCampaignDaily", "clockAdsetDaily", "clockCampaignConfig", "clockAdsetConfig"].map((n) => [
          n,
          text(clockCells.get(`${key}|${n}`)?.latest_effective),
        ]),
      ),
    });
  }

  // --- C8.1: the shared orchestration seam, also driven by the test. ---
  const orchestrated = await orchestrateEvidence({
    safeQ, skip, ledger, businessIds, cutoffByBinding, seriesFromByBinding,
  });
  const {
    observationCoverage, stateChangeDensity, seriesRows, ownershipRows,
    ownershipAggregate, ownershipConflicts, unitEvidence, unitCoverage,
    configLayers, configIdentities, configCoverage, configIdentityTruncated,
    canonicalPerBinding, servedDate, servedCoverage, canonicalIdentities,
    budgetVerbCensus, engineVersionOverlap, roleRows, roleCensus, targetPackHistory,
    dependencyCoverage,
  } = orchestrated;


  return {
    proof, ledger, schemaContract, vocabulary, dbBindings, matrixExpectedMissing,
    matrixUnexpectedExtra, clockRows, perBinding, observationCoverage, stateChangeDensity,
    seriesRows, ownershipRows, ownershipAggregate, ownershipConflicts,
    unitEvidence, unitCoverage, configLayers, configIdentities, configCoverage,
    configIdentityTruncated, canonicalPerBinding, servedDate, servedCoverage,
    canonicalIdentities, budgetVerbCensus, engineVersionOverlap, roleRows, roleCensus,
    targetPackHistory, dependencyCoverage, d078Sha,
  };
}

export async function runExtract() {
  const d078Bytes = readFileSync(resolve(D080_PINNED_INPUTS.d078BundlePath));
  const d078Sha = createHash("sha256").update(d078Bytes).digest("hex");
  if (d078Sha !== D080_PINNED_INPUTS.d078BundleSha256) {
    throw new Error(`D078 bundle hash mismatch: expected ${D080_PINNED_INPUTS.d078BundleSha256}, observed ${d078Sha}`);
  }

  const { db, authority } = await openDbBoundary();
  const businessIds = [...new Set(D080_PINNED_BINDINGS.map((b) => b.businessId))];

  const frozen = await withReadOnlyTransaction(db, async (proof, safeQ, ledger, skip) =>
    collectEvidence({ proof, safeQ, ledger, skip, businessIds, d078Sha }),
  );

  const artifact = assembleArtifact({ ...frozen, authority });
  writeFileSync(resolve(D080_EVIDENCE_JSON_OUT), JSON.stringify(artifact, null, 1));
  console.log(
    JSON.stringify(
      {
        phase: "extract",
        retrievedAt: (artifact.provenance as Row).retrievedAt,
        schemaCompatibility: frozen.schemaContract.compatibility,
        missingRunColumns: frozen.schemaContract.missingRunColumns,
        artifactHash: artifact.artifactHash,
        matrixExpectedMissing: frozen.matrixExpectedMissing,
        matrixUnexpectedExtra: frozen.matrixUnexpectedExtra,
        readFailures: frozen.ledger.filter((f) => f.status !== "ok").map((f) => `${f.query}[${f.providerAccountId ?? ""}${f.grain ? "/" + f.grain : ""}]`),
        counts: {
          series: frozen.seriesRows.length,
          ownershipLineageRows: frozen.ownershipRows.length,
          ownershipAggregateRows: frozen.ownershipAggregate.length,
          configPitRows: frozen.configLayers.pointInTime.length,
          configRetroRows: frozen.configLayers.retrospective.length,
          configIdentities: frozen.configIdentities.length,
          unitEvidence: frozen.unitEvidence.length,
          roleRows: frozen.roleRows.length,
          targetPackRevisions: frozen.targetPackHistory.length,
        },
      },
      null,
      1,
    ),
  );
}

// ---------------------------------------------------------------------------
// replay — three separately labelled layers over the frozen package
// ---------------------------------------------------------------------------

/**
 * C9.1 — the analysis-and-seal stage, separated from file IO so the same code
 * that produces the real package also produces the synthetic one under test.
 */
export function analyseAndSeal(raw: Record<string, unknown>): {
  sealed: Record<string, unknown>;
  summary: Record<string, unknown>;
} {
  const frozen = Object.fromEntries(
    Object.entries(raw).filter(
      ([k]) => !HASH_META_KEYS.has(k) && !(D080_DERIVED_SECTIONS as readonly string[]).includes(k),
    ),
  );

  const schemaContract = frozen.schemaContract as SchemaContract;
  const clocks = frozen.clocks as { perBinding: Row[] };
  const cutoffByBinding = new Map<string, string | null>(
    clocks.perBinding.map((r) => [
      bindingKey(String(r.business_id), String(r.provider_account_id)),
      text(r.cutoff),
    ]),
  );

  // ---- L1: observed canonical CREATIVE decisions --------------------------
  const canonical = frozen.canonicalDecisions as {
    perBinding: Row[];
    budgetVerbCensus: Row[];
    engineVersionOverlap: Row[];
    vocabularyConstraints: Row[];
  };
  const creativeDenominator = canonical.perBinding.reduce(
    (s, r) => s + ((r.membership as MembershipManifest | undefined)?.count ?? 0),
    0,
  );
  const combinedManifestHash = sha256Canonical(
    canonical.perBinding
      .map((r) => `${r.business_id}|${r.provider_account_id}|${(r.membership as MembershipManifest).groupHash}`)
      .sort(),
  );
  const scannedRows = canonical.budgetVerbCensus.reduce((s, r) => s + (num(r.scanned_rows) ?? 0), 0);
  const typedBudget = canonical.budgetVerbCensus.reduce(
    (s, r) =>
      s + (num(r.typed_budget_label) ?? 0) + (num(r.typed_budget_authorized) ?? 0) + (num(r.typed_budget_blocked) ?? 0),
    0,
  );
  const crossSourceFreshness = canonical.perBinding.map((r) => ({
    business: r.business,
    businessId: r.business_id,
    providerAccountId: r.provider_account_id,
    decisionLatestAsOf: text(r.latest_as_of),
    performanceCutoff: text(r.cutoff),
    decisionAheadOfPerformance:
      Boolean(text(r.latest_as_of) && text(r.cutoff) && text(r.latest_as_of)! > text(r.cutoff)!),
  }));
  const layer1Creative = {
    layer: "L1_observed_canonical_creative_decisions",
    crossSourceFreshness,
    crossSourceFreshnessNote:
      "The decision table and the performance tables have DIFFERENT clocks. Where decisionLatestAsOf exceeds performanceCutoff, the served decision generation was computed against a day the performance evidence in this package does not cover. That is a freshness divergence to report, not a scope violation, and the two layers keep separate cutoffs.",
    selectionRule: CANONICAL_DECISION_SELECTION,
    denominator: creativeDenominator,
    denominatorMeaning:
      "rows in the LATEST generation per pinned binding — the projection the production read model serves. It is not a sum over engine versions or days.",
    membershipManifestHash: combinedManifestHash,
    perBinding: canonical.perBinding.map((r) => ({
      business: r.business,
      // C4.1 — derived rows must carry enough identity to be scope-validated.
      businessId: r.business_id,
      providerAccountId: r.provider_account_id,
      isSelected: r.is_selected,
      latestAsOf: r.latest_as_of,
      engineVersionsAtLatest: r.engine_versions_at_latest,
      membership: r.membership,
      labelCensus: r.label_census,
      authorizedCensus: r.authorized_census,
    })),
    overlappingGenerationDays: canonical.engineVersionOverlap,
    note: "Creative verdicts only. A creative scale/cut/keep is a verdict about a creative and is never reinterpreted as a budget intent.",
  };

  // ---- L1b: observed canonical BUDGET decisions ---------------------------
  const layer1Budget = {
    layer: "L1_observed_canonical_budget_decisions",
    denominator: 0,
    denominatorReason: "schema_capability_gap",
    scannedHistoricalSnapshotRows: scannedRows,
    typedBudgetVerbRowsFound: typedBudget,
    vocabularyConstraints: canonical.vocabularyConstraints,
    finding:
      "engine_v3_ad_decision_snapshots_daily constrains label to scale|keep|refresh|cut|test_more|diagnose|out_of_scope, authorized_action and blocked_action_type to scale|cut|refresh, and decision_entity_type to 'ad'. A budget verb cannot be stored, and no campaign- or ad-set-grain decision can exist at all. Zero is therefore a SCHEMA CAPABILITY GAP, not evidence that a historical budget policy chose to make no changes. There is no historical budget-policy performance test available from this table.",
  };

  // ---- Strict-PIT availability, per source --------------------------------
  const semantics = (frozen.sourceSemantics as { sources: SourceSemantics[] }).sources;
  const strictPitSources = semantics.filter((s) => s.pitReconstructible).map((s) => s.source);
  const nonPitSources = semantics.filter((s) => !s.pitReconstructible).map((s) => s.source);
  const strictPitAvailable =
    schemaContract.strictPitOwnerReconstruction === "available" &&
    ["meta_campaign_daily", "meta_adset_daily", "meta_entity_state_history"].every((s) =>
      strictPitSources.includes(s),
    );

  // ---- Shared PIT structures ---------------------------------------------
  const packsByBusiness = new Map<string, TargetPackRevision[]>();
  for (const row of (frozen.targetPackHistory as Row[]) ?? []) {
    const businessId = text(row.business_id);
    if (!businessId) continue;
    const list = packsByBusiness.get(businessId) ?? [];
    list.push({
      effectiveAt: text(row.effective_at) ?? "",
      recordedAt: text(row.recorded_at),
      operation: text(row.operation),
      targetRoas: num(row.target_roas),
      breakEvenRoas: num(row.break_even_roas),
    });
    packsByBusiness.set(businessId, list);
  }

  const roleSection = frozen.campaignRole as { rows: Row[]; census: Row[] };
  const roleSourceTemporalStatus: RoleSourceTemporalStatus =
    semantics.find((x) => x.source === "engine_v3_campaign_context_daily")?.pitReconstructible === true
      ? "immutable_knowledge_time"
      : "mutable_current_snapshot";
  const roleByCampaign = new Map<string, RoleRow[]>();
  for (const row of roleSection.rows ?? []) {
    const key = `${text(row.business_id)}|${text(row.campaign_id) ?? ""}`;
    const list = roleByCampaign.get(key) ?? [];
    list.push({
      providerAccountId: text(row.provider_account_id),
      inferredKind: text(row.inferred_kind),
      confidenceClass: text(row.confidence_class),
      confidenceScore: num(row.confidence_score),
      resolverVersion: text(row.resolver_version),
      asOfDate: (text(row.as_of_date) ?? "").slice(0, 10),
      recordedAt: text(row.recorded_at),
      overwrittenAfterInsert: row.overwritten_after_insert === true,
    });
    roleByCampaign.set(key, list);
  }

  const ownershipRows = fromColumnar(frozen.ownershipObservations as ColumnarTable);
  const campaignOwnership = new Map<string, OwnershipObservation[]>();
  const adsetOwnership = new Map<string, OwnershipObservation[]>();
  for (const row of ownershipRows) {
    const obs: OwnershipObservation = {
      businessId: text(row.business_id) ?? "",
      providerAccountId: text(row.provider_account_id) ?? "",
      entityType: text(row.entity_type) ?? "",
      entityId: text(row.entity_id),
      campaignId: text(row.campaign_id),
      adsetId: text(row.adset_id),
      budgetOrigin: text(row.budget_origin),
      presence: text(row.presence),
      runCompleteness: text(row.run_completeness),
      endpoint: text(row.endpoint),
      runId: text(row.run_id),
      stateHash: text(row.state_hash),
      observedAt: text(row.observed_at) ?? "",
      capturedAt: text(row.captured_at),
      createdAt: text(row.created_at),
      id: text(row.id),
      hasCampaignDaily: row.has_campaign_daily === true,
      hasCampaignLifetime: row.has_campaign_lifetime === true,
      hasAdsetDaily: row.has_adset_daily === true,
      hasAdsetLifetime: row.has_adset_lifetime === true,
    };
    // Account is part of the key: two accounts can reuse an entity id.
    if (obs.entityType === "campaign") {
      const key = `${obs.businessId}|${obs.providerAccountId}|${obs.campaignId ?? ""}`;
      campaignOwnership.set(key, [...(campaignOwnership.get(key) ?? []), obs]);
    } else if (obs.entityType === "adset") {
      const key = `${obs.businessId}|${obs.providerAccountId}|${obs.adsetId ?? ""}`;
      adsetOwnership.set(key, [...(adsetOwnership.get(key) ?? []), obs]);
    }
  }

  const entities = new Map<
    string,
    {
      businessId: string; providerAccountId: string; grain: string; entityId: string;
      campaignId: string | null; points: ReplayPoint[];
    }
  >();
  for (const row of fromColumnar(frozen.series as ColumnarTable)) {
    const businessId = text(row.business_id) ?? "";
    const providerAccountId = text(row.provider_account_id) ?? "";
    const grain = text(row.grain) ?? "";
    const entityId = text(row.entity_id) ?? "";
    const key = `${businessId}|${providerAccountId}|${grain}|${entityId}`;
    const entry =
      entities.get(key) ??
      { businessId, providerAccountId, grain, entityId, campaignId: text(row.parent_campaign_id), points: [] };
    entry.points.push({
      effectiveDate: (text(row.effective_date) ?? "").slice(0, 10),
      status: text(row.status),
      currency: text(row.account_currency),
      dailyBudget: num(row.daily_budget),
      lifetimeBudget: num(row.lifetime_budget),
      isBudgetMixed: row.is_budget_mixed === true,
      spend: num(row.spend),
      conversions: num(row.conversions),
      revenue: num(row.revenue),
      truthState: text(row.truth_state),
    });
    entities.set(key, entry);
  }

  const originsByEntity = new Map<string, string[]>();
  for (const [key, entity] of entities) {
    const cutoff = cutoffByBinding.get(bindingKey(entity.businessId, entity.providerAccountId)) ?? null;
    originsByEntity.set(
      key,
      Array.from(new Set(entity.points.map((p) => p.effectiveDate)))
        .filter((d) => Boolean(d) && (!cutoff || d <= cutoff))
        .sort(),
    );
  }
  const entityDayDenominator = Array.from(originsByEntity.values()).reduce((s, l) => s + l.length, 0);

  const evaluate = (contract: MonetaryUnitContract, lookbackDays: number) => {
    const outcomes: ReplayOutcome[] = [];
    const roleBlockers: string[] = [];
    for (const [entityKey, entity] of entities) {
      const packs = packsByBusiness.get(entity.businessId) ?? [];
      const adsetId = entity.grain === "adset" ? entity.entityId : null;
      const campaignKey = `${entity.businessId}|${entity.providerAccountId}|${entity.campaignId ?? ""}`;
      const observations = {
        campaign: campaignOwnership.get(campaignKey) ?? [],
        adset: adsetId === null ? [] : (adsetOwnership.get(`${entity.businessId}|${entity.providerAccountId}|${adsetId}`) ?? []),
      };
      const roleRows = roleByCampaign.get(`${entity.businessId}|${entity.campaignId ?? ""}`) ?? [];
      for (const origin of originsByEntity.get(entityKey) ?? []) {
        const ownership = resolveBudgetOwnerAtOrigin({
          origin, campaignId: entity.campaignId, adsetId, schemaContract, observations,
        });
        const isBudgetOwner =
          ownership.status === "resolved" &&
          ownership.owner === entity.grain &&
          (entity.grain === "campaign" ? ownership.ownerEntityId === entity.entityId : ownership.ownerEntityId === adsetId);
        const roleAuthority = resolveRoleAuthorityAtOrigin({
          origin,
          expectedProviderAccountId: entity.providerAccountId,
          staleAfterDays: REPLAY_STALE_AFTER_DAYS,
          sourceTemporalStatus: roleSourceTemporalStatus,
          rows: roleRows,
        });
        roleBlockers.push(roleAuthority.status);
        outcomes.push(
          evaluateEntityAtOrigin({
            origin, lookbackDays, points: entity.points, contract, ownership, isBudgetOwner,
            anchor: resolveAnchorAtOrigin({ origin, revisions: packs }),
            roleAuthority,
          }).outcome,
        );
      }
    }
    return { entityDays: outcomes.length, outcomes: tally(outcomes), roleAuthority: tally(roleBlockers) };
  };

  // ---- L2: strict point-in-time -------------------------------------------
  const layer2StrictPit = {
    layer: "L2_strict_point_in_time",
    available: strictPitAvailable,
    denominator: strictPitAvailable ? entityDayDenominator : 0,
    outcomes: strictPitAvailable ? evaluate(FACTUAL_UNIT_CONTRACT, 14).outcomes : { not_pit_reconstructible: entityDayDenominator },
    unavailableBecause: strictPitAvailable
      ? null
      : {
          schemaContract: schemaContract.basis,
          mutableSources: nonPitSources,
          detail:
            "Strict PIT requires immutable knowledge-time lineage for BOTH the owner state and the performance facts. The daily tables are mutable UPSERTs whose current values overwrite the earlier ones an origin would need, and the observation-run schema cannot place a heartbeat confirmation on a knowledge-time axis. The strict-PIT denominator is therefore zero and NO result is reported in this layer.",
        },
    note: "This denominator is kept separate. No row from the retrospective layer below is ever counted here.",
  };

  // ---- L3: retrospective finalized counterfactual --------------------------
  const factual = evaluate(FACTUAL_UNIT_CONTRACT, 14);
  const layer3 = {
    layer: "retrospective_finalized_counterfactual",
    isPointInTime: false,
    isObservedPolicyPerformance: false,
    establishesCausalLift: false,
    denominator: entityDayDenominator,
    denominatorMeaning:
      "one row per entity per day that entity was observed, bounded above by its own binding cutoff. Computed over CURRENT finalized facts, which cannot prove what was known at the origin.",
    unitContract: FACTUAL_UNIT_CONTRACT,
    windows: Object.fromEntries(
      REPLAY_LOOKBACK_DAYS.map((days) => [String(days), evaluate(FACTUAL_UNIT_CONTRACT, days)]),
    ),
    roleAuthorityCensus: factual.roleAuthority,
    note: "Every threshold is a HYPOTHESIS. A candidate_* outcome is a candidate under an assumed policy, never an offer the system would have made, and no causal lift or safe budget-step percentage follows.",
  };

  const sensitivity = SENSITIVITY_UNIT_CONTRACTS.map((contract) => ({
    assumedDivisor: contract.budgetToSpendDivisor,
    basis: contract.basis,
    windows: Object.fromEntries(REPLAY_LOOKBACK_DAYS.map((d) => [String(d), evaluate(contract, d)])),
  }));
  const candidateCounts = sensitivity.map((entry) =>
    Object.values(entry.windows).reduce((s, w) => s + ((w.outcomes.candidate_increase ?? 0) as number), 0),
  );
  const layer3Sensitivity = {
    layer: "assumed_unit_divisor_sensitivity",
    authoritative: false,
    promotableToFactual: false,
    sensitivity,
    divergentAcrossAssumedUnits: new Set(candidateCounts).size > 1,
    note: "These counts change with the ASSUMED divisor, which is exactly why they cannot be reported as facts.",
  };

  // ---- C3.2/C3.3: config-change quality, per layer and per grain ---------
  const readFailures = (frozen.provenance as { readFailures?: ReadLedgerEntry[] }).readFailures ?? [];
  const configSection = frozen.configStates as {
    pointInTime: Row[]; retrospective: Row[]; identities: Row[];
    coverage: Row[]; identityTruncatedFor: string[];
  };

  const summariseLayer = (rows: Row[], layer: string) => {
    const perGrain: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      const grain = text(row.grain) ?? "unknown";
      const bucket = (perGrain[grain] ??= {
        semanticStates: 0, rawCaptures: 0, duplicateCaptures: 0,
        sameClockConflictStates: 0, transitions: {}, stateClasses: {},
      });
      const n = num(row.transitions) ?? 0;
      bucket.semanticStates = (bucket.semanticStates as number) + n;
      bucket.rawCaptures = (bucket.rawCaptures as number) + (num(row.raw_captures) ?? 0);
      bucket.duplicateCaptures = (bucket.duplicateCaptures as number) + (num(row.duplicate_captures) ?? 0);
      bucket.sameClockConflictStates =
        (bucket.sameClockConflictStates as number) + (num(row.same_clock_conflict_states) ?? 0);
      const tc = text(row.transition_class) ?? "unknown";
      const sc = text(row.state_class) ?? "unknown";
      const t = bucket.transitions as Record<string, number>;
      const c = bucket.stateClasses as Record<string, number>;
      t[tc] = (t[tc] ?? 0) + n;
      c[sc] = (c[sc] ?? 0) + n;
    }
    return { layer, perGrain };
  };

  const pitLayer = summariseLayer(configSection.pointInTime ?? [], "config_point_in_time");
  const retroLayer = summariseLayer(configSection.retrospective ?? [], "config_retrospective_finalized");

  // Coverage: a cell is claimable only when every expected binding/grain/layer
  // read succeeded. A failed cell stays unknown and is never read as zero.
  // C4.5 — the expected composite-key set, including the identity cells.
  const expectedCells = D080_PINNED_BINDINGS.flatMap((b) =>
    ["campaign", "adset"].flatMap((g) =>
      ["pointInTime", "retrospective", "identities"].map((l) => `${b.providerAccountId}/${g}/${l}`),
    ),
  );
  const coverageKeys = (configSection.coverage ?? []).map(
    (c) => `${text(c.provider_account_id)}/${text(c.grain)}/${text(c.layer)}`,
  );
  const configKeyAudit = auditExpectedKeys(expectedCells, coverageKeys);
  const okCells = new Set(
    (configSection.coverage ?? [])
      .filter((c) => text(c.status) === "ok")
      .map((c) => `${text(c.provider_account_id)}/${text(c.grain)}/${text(c.layer)}`),
  );
  const unknownCells = expectedCells.filter((c) => !okCells.has(c));
  const semanticCells = expectedCells.filter((c) => !c.endsWith("/identities"));
  const identityCells = expectedCells.filter((c) => c.endsWith("/identities"));
  const semanticCountsClaimable = configKeyAudit.ok && semanticCells.every((c) => okCells.has(c));
  const identityManifestComplete =
    configKeyAudit.ok &&
    identityCells.every((c) => okCells.has(c)) &&
    (configSection.identityTruncatedFor ?? []).length === 0;

  // A transition may only be counted as clean when BOTH sides resolved.
  const unresolvedTransitionClasses = ["unresolved_prior_state", "unresolved_next_state"];
  const cleanTotals: Record<string, Record<string, number>> = {};
  for (const [layerName, layer] of [["pointInTime", pitLayer], ["retrospective", retroLayer]] as const) {
    const totals: Record<string, number> = {};
    for (const [grain, bucket] of Object.entries(layer.perGrain)) {
      const t = bucket.transitions as Record<string, number>;
      totals[grain] = t.true_change ?? 0;
      totals[`${grain}_unresolved`] = unresolvedTransitionClasses.reduce((acc, k) => acc + (t[k] ?? 0), 0);
    }
    cleanTotals[layerName] = totals;
  }

  const identityManifest = buildMembershipManifest(
    (configSection.identities ?? []).map((r) =>
      [
        r.business_id, r.provider_account_id, r.grain, r.entity_id,
        r.prev_effective_from ?? "", r.prev_fingerprint ?? "", r.prev_id ?? "",
        r.effective_from, r.config_fingerprint ?? "", r.id ?? "", r.transition_class,
      ].map((v) => String(v ?? "")).join("|"),
    ),
  );

  // ---- C3.7/C4.3: UI served-date contract, coverage-driven -----------------
  const servedRows = (frozen.canonicalDecisions as { servedDate?: Row[] }).servedDate ?? [];
  const servedCoverageRows = (frozen.canonicalDecisions as { servedDateCoverage?: Row[] }).servedDateCoverage ?? [];
  const expectedServedKeys = D080_PINNED_BINDINGS.map((b) => bindingKey(b.businessId, b.providerAccountId));
  const servedCoverageKeys = servedCoverageRows.map((r) => bindingKey(String(r.business_id), String(r.provider_account_id)));
  const servedKeyAudit = auditExpectedKeys(expectedServedKeys, servedCoverageKeys);
  const servedOkKeys = new Set(
    servedCoverageRows.filter((r) => text(r.status) === "ok").map((r) => bindingKey(String(r.business_id), String(r.provider_account_id))),
  );
  // Every pinned binding must have exactly one OK cell before any fleet claim.
  const servedFleetClaimable = servedKeyAudit.ok && servedOkKeys.size === expectedServedKeys.length;

  const servedPerBinding = servedRows.map((row) => {
    const native = text(row.native_ad_max);
    const legacy = text(row.legacy_creative_max);
    const job = text(row.native_job_run_max);
    const candidates = [native, legacy, job].filter((v): v is string => Boolean(v));
    const served = candidates.length > 0 ? candidates.sort()[candidates.length - 1]! : null;
    return {
      businessId: text(row.business_id),
      providerAccountId: text(row.provider_account_id),
      nativeAdMax: native, legacyCreativeMax: legacy, nativeJobRunMax: job,
      uiServedDate: served,
      equalsNativeMax: served !== null && native !== null ? served === native : null,
      divergenceReason:
        served === null ? "no_candidate_resolved" : native === null ? "native_max_missing" : served === native ? null : "later_non_native_candidate",
    };
  });
  const servedDateContract = {
    assignedAccountReader: "native MAX(as_of_date) per (business, provider_account) — lib/meta/assigned-account-states.ts",
    workspaceReader:
      "resolveWorkspaceEndDate resolves a SERVED end date from MAX over three candidates (native ad decisions; legacy creative snapshots scoped by creative_account_keys = meta_creative_dimensions UNION meta_creative_daily with the account-exclusivity rule; native job runs), then reads that exact day — app/api/meta/decisions-workspace/route.ts",
    contractsIdentical: false,
    reproductionScope:
      "DEFAULT path only: no explicit end date and a non-null provider account. The route returns an explicit endDate verbatim, and returns the previous UTC date when the provider account is null. Those two fallbacks are described, not synthesised as observed evidence.",
    coverage: servedCoverageRows,
    expectedCells: expectedServedKeys.length,
    keyAudit: servedKeyAudit,
    fleetComparisonClaimable: servedFleetClaimable,
    perBinding: servedPerBinding,
    // Null, not `true`, when the fleet is unclaimable: `.every()` over a short
    // list would otherwise report vacuous agreement.
    allServedEqualNativeMax: servedFleetClaimable
      ? servedPerBinding.every((r) => r.equalsNativeMax === true)
      : null,
    divergentBindings: servedPerBinding.filter((r) => r.equalsNativeMax !== true),
    note: "Equality is PROVEN per binding, and only when every pinned binding produced an OK cell. A failed, missing or candidate-less binding makes the fleet comparison unclaimable rather than vacuously equal.",
  };

  const configChangeQuality = {
    pointInTime: pitLayer,
    retrospective: retroLayer,
    isPointInTime: { pointInTime: true, retrospective: false },
    cleanTrueChangeByLayerAndGrain: cleanTotals,
    identityManifest,
    identitiesMaterialised: (configSection.identities ?? []).length,
    identityTruncatedFor: configSection.identityTruncatedFor ?? [],
    expectedCells: expectedCells.length,
    keyAudit: configKeyAudit,
    unknownCells,
    // C4.5 — two distinct claims. Semantic counts can stand while the identity
    // manifest is incomplete, and neither may borrow the other's success.
    semanticCountsClaimable,
    identityManifestComplete,
    totalClaimable: semanticCountsClaimable && identityManifestComplete,
    readFailures: readFailures
      .filter((f) => f.query.startsWith("config"))
      .map((f) => `${f.query}[${f.providerAccountId ?? "?"}/${f.grain ?? "?"}]`),
    semantics:
      "A transition is true_change only when the prior AND next semantic states are individually resolved and single-kind. both_fields_present, mixed, conflicting_capture and neither are UNRESOLVED and produce their own transition classes; they can seed neither true_change nor unchanged. Within-day ordering is deterministic on (effective_from, captured_at, id) and config_fingerprint identity is preserved. Counts are aggregated in SQL; only non-routine transition identities are materialised.",
    layerSemantics:
      "pointInTime bounds captured_at by the binding cutoff and is knowledge-time safe as of that cutoff. retrospective covers the same effective window but admits capture recorded after it, so it is finalized evidence and NOT point-in-time.",
  };

  // C4.5 — the four-cell unit matrix must also be exactly the expected key set.
  const unitSection = frozen.unitEvidence as { coverageMatrix?: Row[] };
  const expectedUnitKeys = D080_PINNED_BINDINGS.flatMap((b) =>
    ["campaign", "adset"].flatMap((g) => ["daily", "lifetime"].map((f) => `${b.providerAccountId}/${g}/${f}`)),
  );
  const unitKeyAudit = auditExpectedKeys(
    expectedUnitKeys,
    (unitSection.coverageMatrix ?? []).map((c) => `${text(c.provider_account_id)}/${text(c.grain)}/${text(c.budget_field)}`),
  );
  const unitCoverage = {
    expectedCells: expectedUnitKeys.length,
    // C5.5 — a frozen sum verify can recompute from the rows.
    totalCompared: ((frozen.unitEvidence as { rows?: Row[] }).rows ?? []).reduce((acc, r) => acc + (num(r.compared) ?? 0), 0),
    keyAudit: unitKeyAudit,
    byStatus: tally((unitSection.coverageMatrix ?? []).map((c) => text(c.status) ?? "unknown")),
    // A dependency-blocked cell was not read either, so it must not count as
    // one that was.
    allCellsRead:
      unitKeyAudit.ok &&
      (unitSection.coverageMatrix ?? []).every(
        (c) => text(c.status) !== "unknown/source_read_failed" && text(c.status) !== "not_run_dependency_failed",
      ),
    note: "zero_rows_returned is a successful read that found nothing comparable — zero evidence. It is not the same as unknown/source_read_failed, and neither is absence of the field.",
  };

  // C4.5 — canonical identity cells, one per pinned binding.
  const canonicalKeyAudit = auditExpectedKeys(
    D080_PINNED_BINDINGS.map((b) => bindingKey(b.businessId, b.providerAccountId)),
    canonical.perBinding.map((r) => bindingKey(String(r.business_id), String(r.provider_account_id))),
  );

  // C6.2 — persist an invocation result receipt per invocation, recomputed and
  // compared by verify. A row-content change alters the hash without altering
  // the count, so the hash is the part that catches silent edits.
  const resultReceipts = reconcileInvocationResults(frozen as Record<string, unknown>).receipts;

  const sealed = sealArtifact({
    ...frozen,
    invocationResults: { receipts: resultReceipts, note: "One receipt per expected invocation. recomputable=false marks a source-query aggregate whose raw rows are not materialised; it carries an explicit receipt rather than a silent pass." },
    analysis: {
      unitCoverage,
      canonicalKeyAudit,
      layer1Creative, layer1Budget, layer2StrictPit, layer3, layer3Sensitivity, configChangeQuality,
      servedDateContract,
    },
    capabilityMatrix: {
      ...D080_CAPABILITY_MATRIX,
      graphApiVersions: {
        ...D080_CAPABILITY_MATRIX.graphApiVersions,
        // C4.6/C5.6 — this hashes OUR claim metadata, not source bytes. No page
        // capture is archived (developers.facebook.com blocks direct curl), so
        // the name says exactly what it covers and nothing more.
        claimMetadataHashes: D080_CAPABILITY_MATRIX.graphApiVersions.primarySourceVerification.map((r) => ({
          claim: r.claim,
          status: r.status,
          claimMetadataHash: sha256Canonical(r),
        })),
        claimMetadataHashMeaning:
          "sha256 over this audit's own claim record (url, retrievedAt, precision, method, excerpt, status). It detects edits to the claim metadata. It is NOT a hash of captured source bytes, and no source capture is archived.",
      },
    },
    d080bContract: D080B_CONTRACT,
    correctionLedger: D080_CORRECTION_LEDGER,
  });
  return {
    sealed,
    summary: {
      strictPitAvailable,
      strictPitDenominator: layer2StrictPit.denominator,
      retrospectiveDenominator: entityDayDenominator,
      canonicalCreativeDenominator: creativeDenominator,
      canonicalBudgetDenominator: 0,
      scannedHistoricalSnapshotRows: scannedRows,
      retrospectiveOutcomes14d: layer3.windows["14"],
      roleAuthorityCensus: layer3.roleAuthorityCensus,
      configPointInTime: cleanTotals.pointInTime,
      configRetrospective: cleanTotals.retrospective,
      configUnknownCells: unknownCells.length,
      semanticCountsClaimable,
      identityManifestComplete,
      servedFleetClaimable,
      unitCellsOk: unitKeyAudit.ok,
      sensitivityCandidateCounts: candidateCounts,
    },
  };
}

export function runReplay(artifactPath = D080_EVIDENCE_JSON_OUT) {
  const raw = JSON.parse(readFileSync(resolve(artifactPath), "utf8")) as Record<string, unknown>;
  const { sealed, summary } = analyseAndSeal(raw);
  writeFileSync(resolve(artifactPath), JSON.stringify(sealed, null, 1));
  console.log(JSON.stringify({ phase: "replay", artifactHash: sealed.artifactHash, ...summary }, null, 1));
}

/** C8.6 — the unique delimiters the report's ONE current block must carry. */
export const REPORT_BLOCK_BEGIN = "<!-- D080-VERIFICATION-BLOCK:BEGIN -->";
export const REPORT_BLOCK_END = "<!-- D080-VERIFICATION-BLOCK:END -->";

/**
 * C8.6 — renders the single authoritative current-verification block from the
 * live artifact and verifier output. The report must contain exactly one, and a
 * test compares it byte for byte, so a substring appearing elsewhere in the
 * historical narrative can never satisfy a current-value check.
 */
export function renderVerificationBlock(
  artifact: Record<string, unknown>,
  result: ReturnType<typeof verifyArtifact>,
): string {
  const c = result.scope.counters;
  const rows = [
    ["contract", String(artifact.contract)],
    ["retrievedAt", String(at(artifact, "provenance.retrievedAt"))],
    ["sqlTemplates", String(at(artifact, "provenance.sqlTemplateCount"))],
    ["planDefinitions", String(at(artifact, "provenance.planDefinitionCount"))],
    ["expectedInvocations", String(c.expectedInvocations)],
    ["observedInvocations", String(c.observedInvocations)],
    ["requiredSections", `${c.requiredSectionsPresent} / ${c.requiredSectionsExpected}`],
    ["discoveredRowSets", `${c.discoveredRowSets} / ${c.registeredSections}`],
    ["totalRows", String(c.totalRows)],
    ["scopeCheckedRows", String(c.scopeCheckedRows)],
    ["effectiveTimeCheckedFields", String(c.effectiveTimeCheckedFields)],
    ["knowledgeTimeCheckedFields", String(c.knowledgeTimeCheckedFields)],
    ["matrixAudits", String(c.matrixChecks)],
    ["crossSectionReconciliations", String(c.crossSectionReconciliations)],
    ["invocationResultReceipts", String(c.invocationResultReceipts)],
    ["recomputableResultReceipts", String(c.recomputableResultReceipts)],
    ["sourceAggregateRows", String(c.sourceAggregateRows)],
    ["violations", String(result.scope.violations.length)],
    ["ok", String(result.ok)],
  ];
  return [
    REPORT_BLOCK_BEGIN,
    "| Verified value | Current |",
    "|---|---|",
    ...rows.map(([k, v]) => `| \`${k}\` | ${v} |`),
    REPORT_BLOCK_END,
  ].join("\n");
}

export function runVerify(artifactPath = D080_EVIDENCE_JSON_OUT) {
  const artifact = JSON.parse(readFileSync(resolve(artifactPath), "utf8")) as Record<string, unknown>;
  const result = verifyArtifact(artifact);
  console.log(
    JSON.stringify(
      {
        phase: "verify",
        ok: result.ok,
        checkedSections: result.checkedSections,
        // C4.1 — separate counters. "visited by a handler" is not "bound-checked".
        counters: result.scope.counters,
        requiredSectionsMissing: result.scope.missingRequiredSections,
        unhandledRowBearingSections: result.scope.unhandledSections,
        sqlTemplates: Object.keys(D080_QUERIES).length,
        planDefinitions: Object.keys(D080_READ_PLAN).length,
        expectedInvocations: result.scope.counters.expectedInvocations,
        observedInvocations: result.scope.counters.observedInvocations,
        exemptions: result.scope.coverage
          .filter((c) => c.exemptedFields.length > 0)
          .map((c) => `${c.section}: exempt ${c.exemptedFields.join(",")}`),
        perHandler: result.scope.coverage.reduce<Record<string, { sections: number; rows: number; scope: number; effective: number; knowledge: number }>>((acc, c) => {
          const bucket = (acc[c.handler] ??= { sections: 0, rows: 0, scope: 0, effective: 0, knowledge: 0 });
          bucket.sections += 1;
          bucket.rows += c.rows;
          bucket.scope += c.scopeChecked;
          bucket.effective += c.effectiveChecked;
          bucket.knowledge += c.knowledgeChecked;
          return acc;
        }, {}),
        matrixAudits: result.scope.matrixAudits,
        violations: result.scope.violations.length,
        reportBlock: renderVerificationBlock(artifact, result),
        failures: result.failures.slice(0, 20),
        artifactHash: artifact.artifactHash,
      },
      null,
      1,
    ),
  );
  if (!result.ok) process.exitCode = 1;
}

async function main() {
  const phase = process.argv[2] ?? "probe";
  const target = process.argv[3] ?? D080_EVIDENCE_JSON_OUT;
  if (phase === "probe") return runProbe();
  if (phase === "extract") return runExtract();
  if (phase === "replay") return runReplay(target);
  if (phase === "verify") return runVerify(target);
  throw new Error(`unknown phase: ${phase} (probe|extract|replay|verify)`);
}

if (process.argv[1] && process.argv[1].includes("d080-meta-budget-edit-evidence")) {
  void main().catch((error) => {
    console.error(sanitizeReason(error));
    process.exit(1);
  });
}
