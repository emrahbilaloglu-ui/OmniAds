/**
 * D085 Correction 9 — ONE safe data-snapshot mechanism.
 *
 * WHY THIS WAS REWRITTEN. Correction 8's version validated one property
 * universe and hashed another: required keys were probed with `key in value`,
 * which reaches through the PROTOTYPE, while extras and hashing used own
 * enumerable keys. A crafted object carrying an inherited required field
 * therefore produced no schema problem at all. Objects with arbitrary
 * prototypes passed as plain maps; accessors, symbols and non-enumerable own
 * properties had no coherent model; a Proxy `ownKeys` trap threw; and BigInt,
 * cycles and other JSON-incompatible values threw at every entrypoint that
 * eventually hashed them.
 *
 * THE FIX IS STRUCTURAL, not another list of guards. Every boundary now takes
 * `unknown`, snapshots it ONCE into plain data, and then validates, canonicalises
 * and hashes THAT SNAPSHOT. One universe, observed once.
 *
 * WHAT THIS GUARANTEES, precisely:
 *   D085 safely snapshots what it can observe, or rejects it, and remains total.
 *
 * WHAT IT DOES NOT GUARANTEE. JavaScript cannot prove that a fully hostile
 * Proxy is an authentic plain object — a sufficiently determined exotic object
 * can answer every reflection call consistently and still not be what it
 * claims. This module does not claim proxy authenticity. It claims that a
 * single observation is taken, that observation is what gets used everywhere
 * downstream, and that any failure to observe is a deterministic rejection
 * rather than an exception or a silent pass.
 */

export interface SchemaProblem {
  /** Dotted path to the offending value, e.g. `preflightEvidence.rawAttempt`. */
  path: string;
  why: string;
}

/** Plain, JSON-compatible data. Nothing exotic survives snapshotting. */
export type PlainData =
  | null
  | boolean
  | number
  | string
  | PlainData[]
  | { [key: string]: PlainData };

export type SnapshotResult =
  | { ok: true; value: PlainData }
  | { ok: false; problems: SchemaProblem[] };

/** How deep a structure may nest before we call it hostile rather than deep. */
const MAX_SNAPSHOT_DEPTH = 64;

/*
  RESOURCE BOUNDS — depth alone is not totality.

  r11 read an array's `length` from its own descriptor (correct), then built a
  Set of `length` index strings and iterated `length` times. A caller-supplied
  `length` may legally be up to 4,294,967,295, so a single small object could
  drive multi-gigabyte allocation and minutes of CPU: the observation was
  bounded in DEPTH and unbounded in SIZE.

  Every bound below is checked BEFORE any length-proportional allocation or
  traversal. They are deliberately conservative: real D085 inputs are hundreds
  of nodes, not tens of thousands.
*/
export const SNAPSHOT_LIMITS = {
  maxDepth: MAX_SNAPSHOT_DEPTH,
  /**
   * Most own keys accepted on ONE object — and, because a dense array's
   * indices are own keys, the longest array accepted too.
   *
   * r12 published `maxArrayLength: 10_000` while `maxKeysPerObject: 512` was
   * also applied to array descriptors, so a 513-element array rejected. The
   * published number now IS the enforced number, for both shapes.
   */
  maxKeysPerObject: 4_096,
  /** The effective array bound. Identical by construction; see above. */
  maxArrayLength: 4_096,
  /** Total values visited across the whole observation. */
  maxVisitedNodes: 200_000,
  /**
   * Total UTF-8 BYTES accumulated across the whole observation — keys and
   * scalar values alike.
   *
   * r12 accumulated `string.length`, which counts UTF-16 code units: 4,200,000
   * two-byte characters are 8,400,000 UTF-8 bytes and passed an 8,000,000
   * budget. Object KEYS were never counted at all, so a single 8,000,001-byte
   * key returned ok:true.
   */
  maxTotalStringBytes: 8_000_000,
  /** Most problems recorded before the observation stops reporting. */
  maxProblems: 1_000,
} as const;

/**
 * Describe a THROWN value without ever invoking caller code.
 *
 * r10's error path interpolated `(error as Error).message`, so a Proxy trap
 * that threw a non-Error whose `message` is a throwing getter escaped the
 * boundary entirely — the failure-rendering path became a second attack
 * surface. Nothing here reads a getter, calls `toString`, triggers
 * `Symbol.toPrimitive`, or crosses a proxy trap: the value is classified by
 * `typeof` alone, under nested try/catch, and the result is a fixed string.
 */
/**
 * UTF-8 byte length, measured incrementally and abandoned as soon as a budget
 * is exceeded.
 *
 * `Buffer.byteLength` would be exact but must walk the whole string; a hostile
 * 100 MB string should be refused, not measured. This stops at `budget + 1`,
 * so the cost is bounded by the budget rather than by the input.
 */
export function utf8BytesUpTo(value: string, budget: number): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i += 1; }
      else bytes += 3;
    } else bytes += 3;
    if (bytes > budget) return budget + 1;
  }
  return bytes;
}

function safeThrownLabel(thrown: unknown): string {
  try {
    const t = typeof thrown;
    if (t === "string") return "a thrown string";
    if (t === "number" || t === "boolean" || t === "bigint") return `a thrown ${t}`;
    if (t === "symbol") return "a thrown symbol";
    if (t === "function") return "a thrown function";
    if (thrown === null) return "a thrown null";
    if (thrown === undefined) return "a thrown undefined";
    // An object: report ONLY that it was an object. Reading any property —
    // including `message` or `name` — can execute caller code.
    return "a thrown object";
  } catch {
    return "an unreportable thrown value";
  }
}

function describe(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "bigint") return `a BigInt (${String(value)}n)`;
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return "a symbol";
  // NEVER read a property of the value. r12's `value.length` here was a
  // SECOND observation of the caller's object, reachable from every
  // exactMap/typedArray/exactVariant failure path, through which a stateful
  // array Proxy threw straight out of the boundary.
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "a map";
  if (typeof value === "number" && !Number.isFinite(value)) return `the non-finite number ${String(value)}`;
  try {
    // Only primitives reach here; JSON.stringify on a primitive cannot call
    // caller code. Anything else is already classified above.
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(value) ?? `a ${t}`;
    return `a ${t}`;
  } catch {
    return "an undescribable value";
  }
}

/**
 * Take ONE safe observation of `value` as plain data.
 *
 * Rejects, with a path-specific reason and never an exception:
 *   - nonstandard prototypes (anything but `Object.prototype` or a null proto);
 *   - accessor properties — getters are NEVER invoked for validation;
 *   - symbol-keyed and non-enumerable own properties;
 *   - BigInt, function, symbol, non-finite number and unsupported object values;
 *   - sparse arrays and arrays carrying extra own keys;
 *   - cycles, and structures deeper than `MAX_SNAPSHOT_DEPTH`;
 *   - any reflection failure, including a Proxy trap that throws.
 */
/**
 * The canonical array-index rule, per the language spec.
 *
 * r10 used a digits-only regex, so the own keys `01` and `4294967295` were
 * treated as indices and silently omitted, and `length` was read from
 * `arr.length` AFTER observation instead of from the captured descriptor. An
 * array index is a canonical numeric string strictly below 2^32-1: `"01"` is
 * not canonical (it does not round-trip), and `4294967295` is exactly the
 * excluded maximum.
 */
function arrayIndexOf(key: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return null;
  const n = Number(key);
  if (!Number.isSafeInteger(n) || n >= 4294967295) return null;
  return String(n) === key ? n : null;
}

/** Define an own data property without triggering setters or `__proto__`. */
function defineData(target: Record<string, PlainData>, key: string, value: PlainData): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Take ONE safe observation of `value` as plain data.
 *
 * The OUTPUT is built on `Object.create(null)` with explicit data-property
 * definition. r10 built plain `{}` literals and assigned with `out[key] = …`,
 * so an own enumerable data property named `__proto__` hit the inherited
 * setter: the key was silently LOST and the output's prototype could be
 * mutated by the very data being observed. A snapshot that does not preserve
 * what it observed is not a snapshot.
 *
 * Rejects, with a path-specific reason and never an exception:
 *   - nonstandard prototypes (anything but `Object.prototype` or a null proto);
 *   - accessor properties — getters are NEVER invoked for validation;
 *   - symbol-keyed and non-enumerable own properties, INCLUDING array indices;
 *   - non-canonical own array keys, holes, and any key that is not `length`
 *     or a canonical index;
 *   - BigInt, function, symbol, non-finite number and unsupported objects;
 *   - cycles, and structures deeper than `MAX_SNAPSHOT_DEPTH`;
 *   - any reflection or post-reflection failure, including a Proxy trap that
 *     throws — classified without invoking the thrown value.
 */
export function safeSnapshot(value: unknown, path = "$"): SnapshotResult {
  const problems: SchemaProblem[] = [];
  const seen = new Set<object>();
  let visited = 0;
  let stringBytes = 0;
  let exhausted = false;
  /** Record a problem, but never grow the problem list without bound. */
  const note = (problem: SchemaProblem): void => {
    /*
      EXACTLY `maxProblems`, never one more. r12 pushed a "reporting stopped"
      sentinel once the array had already reached the limit, so the list ended
      at maxProblems + 1 — the published number was not the enforced number.
      The final slot carries the sentinel instead of a further problem.
    */
    if (problems.length < SNAPSHOT_LIMITS.maxProblems - 1) problems.push(problem);
    else if (problems.length === SNAPSHOT_LIMITS.maxProblems - 1) {
      problems.push({ path, why: `at least ${SNAPSHOT_LIMITS.maxProblems} problems were found; reporting stopped at the published limit` });
    }
  };

  const walk = (node: unknown, at: string, depth: number): PlainData => {
    if (exhausted) return null;
    visited += 1;
    if (visited > SNAPSHOT_LIMITS.maxVisitedNodes) {
      exhausted = true;
      note({ path: at, why: `the structure exceeds the ${SNAPSHOT_LIMITS.maxVisitedNodes}-node observation budget` });
      return null;
    }
    if (depth > MAX_SNAPSHOT_DEPTH) {
      note({ path: at, why: `${at} nests deeper than ${MAX_SNAPSHOT_DEPTH} levels` });
      return null;
    }
    const t = typeof node;
    if (node === null) return null;
    if (t === "boolean") return node as boolean;
    if (t === "string") {
      // ACTUAL UTF-8 BYTES, measured only up to the remaining budget.
      stringBytes += utf8BytesUpTo(node as string, SNAPSHOT_LIMITS.maxTotalStringBytes - stringBytes);
      if (stringBytes > SNAPSHOT_LIMITS.maxTotalStringBytes) {
        exhausted = true;
        note({ path: at, why: `the structure exceeds the ${SNAPSHOT_LIMITS.maxTotalStringBytes}-byte string budget` });
        return null;
      }
      return node as string;
    }
    if (t === "number") {
      if (!Number.isFinite(node as number)) {
        note({ path: at, why: `${at} is ${describe(node)}, which cannot be serialized` });
        return null;
      }
      return node as number;
    }
    if (t === "bigint" || t === "function" || t === "symbol") {
      note({ path: at, why: `${at} is ${describe(node)}, which is not JSON-compatible data` });
      return null;
    }
    if (t === "undefined") return null; // callers omit undefined-valued keys

    const obj = node as object;
    if (seen.has(obj)) {
      note({ path: at, why: `${at} is part of a cycle` });
      return null;
    }
    seen.add(obj);

    /*
      EVERYTHING that touches the observed object lives inside this try.

      r10 contained only the three reflection calls, so a later
      `arr.length` read — a Proxy `get` trap — escaped as an uncaught throw.
      Reflection AND every post-reflection read are inside the boundary now.
    */
    try {
      const proto = Object.getPrototypeOf(obj);

      /*
        EXACTLY ONE `ownKeys` OBSERVATION.

        r12 called `getOwnPropertyDescriptors` AND `getOwnPropertySymbols` —
        two observations. A stateful Proxy returning `["visible", Symbol]` then
        `["visible"]` produced ok:true with the symbol SILENTLY DROPPED. And
        `maxKeysPerObject` was enforced only after every descriptor had already
        been requested, so a 5,000-key Proxy drove 5,000
        `getOwnPropertyDescriptor` calls before a 512-key refusal.

        One `Reflect.ownKeys` call now yields the single list. String and
        symbol handling both derive from THAT list, the key-count bound is
        enforced against it BEFORE any descriptor is requested, and no key it
        contained is ever silently omitted.

        LIMITATION, stated rather than engineered around: this bounds what D085
        ASKS a trap to do. JavaScript cannot pre-empt arbitrary work or
        nontermination inside the trap itself.
      */
      const ownKeys = Reflect.ownKeys(obj);
      /*
        The bound is applied to the SHAPE's own budget. A dense array of N
        elements carries N index keys PLUS `length`, so charging it against a
        flat key budget made an array of exactly `maxArrayLength` reject — the
        published number again not being the enforced number.
      */
      const isArrayShape = Array.isArray(obj);
      const keyBudget = isArrayShape
        ? SNAPSHOT_LIMITS.maxArrayLength + 1   // indices plus `length`
        : SNAPSHOT_LIMITS.maxKeysPerObject;
      if (ownKeys.length > keyBudget) {
        note({
          path: at,
          why: isArrayShape
            ? `${at} carries ${ownKeys.length} own keys, beyond the ${SNAPSHOT_LIMITS.maxArrayLength}-element limit`
            : `${at} carries ${ownKeys.length} own keys, beyond the ${SNAPSHOT_LIMITS.maxKeysPerObject}-key limit`,
        });
        seen.delete(obj);
        return null;
      }
      const symbolKeys = ownKeys.filter((k): k is symbol => typeof k === "symbol");
      const stringKeys = ownKeys.filter((k): k is string => typeof k === "string");
      if (symbolKeys.length > 0) {
        note({ path: at, why: `${at} carries ${symbolKeys.length} symbol-keyed own ${symbolKeys.length === 1 ? "property" : "properties"}, which exact data may not` });
      }
      // KEY BYTES COUNT TOO. r12 counted only scalar values, so one
      // 8,000,001-byte key returned ok:true.
      for (const key of stringKeys) {
        stringBytes += utf8BytesUpTo(key, SNAPSHOT_LIMITS.maxTotalStringBytes - stringBytes);
        if (stringBytes > SNAPSHOT_LIMITS.maxTotalStringBytes) {
          exhausted = true;
          note({ path: at, why: `the structure exceeds the ${SNAPSHOT_LIMITS.maxTotalStringBytes}-byte string budget` });
          seen.delete(obj);
          return null;
        }
      }
      // Descriptors ONLY for the accepted list, from the same observation.
      const descriptors: Record<string, PropertyDescriptor> = Object.create(null);
      for (const key of stringKeys) {
        const d = Object.getOwnPropertyDescriptor(obj, key);
        if (d !== undefined) descriptors[key] = d;
      }

      if (Array.isArray(obj)) {
        if (proto !== Array.prototype) {
          note({ path: at, why: `${at} is an array with a nonstandard prototype` });
          seen.delete(obj);
          return null;
        }
        // LENGTH FROM THE CAPTURED DESCRIPTOR, never from `obj.length`.
        const lengthDescriptor = descriptors["length"] ?? Object.getOwnPropertyDescriptor(obj, "length");
        if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
          note({ path: at, why: `${at} has no own data \`length\`, so its extent cannot be observed` });
          seen.delete(obj);
          return null;
        }
        const length = lengthDescriptor.value as unknown;
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
          note({ path: at, why: `${at}.length is ${describe(length)}, not a non-negative safe integer` });
          seen.delete(obj);
          return null;
        }
        /*
          BOUND FIRST, ALLOCATE SECOND.

          r11 built the expected-index Set from a caller-controlled `length`
          before checking anything about its magnitude.
        */
        if (length > SNAPSHOT_LIMITS.maxArrayLength) {
          note({ path: at, why: `${at} declares length ${length}, beyond the ${SNAPSHOT_LIMITS.maxArrayLength}-element limit` });
          seen.delete(obj);
          return null;
        }
        // EXACTLY `length` plus canonical indices 0..length-1, and nothing else.
        const expected = new Set<string>(["length"]);
        for (let i = 0; i < length; i += 1) expected.add(String(i));
        const unexpected = stringKeys.filter((k) => !expected.has(k)).sort();
        if (unexpected.length > 0) {
          note({ path: at, why: `${at} carries own ${unexpected.length === 1 ? "key" : "keys"} {${unexpected.join(", ")}} that are neither \`length\` nor a canonical index below its extent` });
        }
        const out: PlainData[] = [];
        for (let i = 0; i < length; i += 1) {
          const key = String(i);
          const d = descriptors[key];
          if (d === undefined) {
            note({ path: `${at}[${i}]`, why: `${at}[${i}] is a hole; sparse arrays are not exact data` });
            out.push(null);
            continue;
          }
          if (!d.enumerable) {
            note({ path: `${at}[${i}]`, why: `${at}[${i}] is a non-enumerable element, which exact data may not carry` });
            out.push(null);
            continue;
          }
          if (!("value" in d)) {
            note({ path: `${at}[${i}]`, why: `${at}[${i}] is an accessor; getters are never invoked for validation` });
            out.push(null);
            continue;
          }
          if (arrayIndexOf(key) === null) {
            note({ path: `${at}[${i}]`, why: `${at}[${i}] is not a canonical array index` });
            out.push(null);
            continue;
          }
          out.push(walk(d.value, `${at}[${i}]`, depth + 1));
        }
        seen.delete(obj);
        return out;
      }

      if (proto !== Object.prototype && proto !== null) {
        note({ path: at, why: `${at} has a nonstandard prototype; only plain objects are exact data` });
        seen.delete(obj);
        return null;
      }

      // NULL-PROTOTYPE OUTPUT, defined property by property. `__proto__` is an
      // ordinary own key here and can neither be lost nor mutate the output.
      const out = Object.create(null) as Record<string, PlainData>;
      for (const key of stringKeys) {
        const d = descriptors[key];
        if (!d.enumerable) {
          note({ path: `${at}.${key}`, why: `${at}.${key} is a non-enumerable own property, which exact data may not carry` });
          continue;
        }
        if (!("value" in d)) {
          note({ path: `${at}.${key}`, why: `${at}.${key} is an accessor; getters are never invoked for validation` });
          continue;
        }
        if (d.value === undefined) continue; // omitted, as JSON.stringify does
        defineData(out, key, walk(d.value, `${at}.${key}`, depth + 1));
      }
      seen.delete(obj);
      return out;
    } catch (error) {
      // A trap that throws is a deterministic REJECTION, classified WITHOUT
      // invoking the thrown value.
      note({ path: at, why: `${at} could not be observed safely (${safeThrownLabel(error)})` });
      seen.delete(obj);
      return null;
    }
  };

  if (value === undefined) {
    return { ok: false, problems: [{ path, why: `${path} is absent` }] };
  }
  const snapshot = walk(value, path, 0);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: snapshot };
}

/**
 * The snapshot's own advertised invariant: plain data, null-prototype maps,
 * canonical arrays, JSON-compatible scalars. Exported so a test can assert the
 * OUTPUT satisfies what this module promises, not just the input checks.
 */
export function isPlainDataInvariant(value: PlainData, path = "$"): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const walk = (node: PlainData, at: string): void => {
    if (node === null) return;
    const t = typeof node;
    if (t === "string" || t === "boolean") return;
    if (t === "number") {
      if (!Number.isFinite(node as number)) problems.push({ path: at, why: `${at} is not finite` });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${at}[${i}]`));
      return;
    }
    if (t !== "object") {
      problems.push({ path: at, why: `${at} is a ${t}, which is not plain data` });
      return;
    }
    if (Object.getPrototypeOf(node) !== null) {
      problems.push({ path: at, why: `${at} is a map whose prototype is not null` });
    }
    if (Object.getOwnPropertySymbols(node).length > 0) {
      problems.push({ path: at, why: `${at} carries symbol keys` });
    }
    for (const [key, child] of Object.entries(node as Record<string, PlainData>)) {
      walk(child, `${at}.${key}`);
    }
  };
  walk(value, path);
  return problems;
}

/** A plain map, as observed in a snapshot. */
export function isPlainMap(value: unknown): value is Record<string, unknown> {
  const snap = safeSnapshot(value);
  return snap.ok && snap.value !== null && typeof snap.value === "object" && !Array.isArray(snap.value);
}

/**
 * Exactly these keys, over OWN ENUMERABLE DATA properties only.
 *
 * r9 used `key in value` for the required check, so an inherited property
 * satisfied it. Presence is now decided by the same universe as extras and
 * hashing — the snapshot.
 */
export function exactMap(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  problems: SchemaProblem[],
): Record<string, unknown> | null {
  const snap = safeSnapshot(value, path);
  if (!snap.ok) {
    problems.push(...snap.problems);
    return null;
  }
  const data = snap.value;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    problems.push({ path, why: `${path} is ${describe(value)}, not a map` });
    return null;
  }
  const allowed = new Set<string>([...required, ...optional]);
  const present = Object.keys(data);
  const extra = present.filter((k) => !allowed.has(k)).sort();
  if (extra.length > 0) {
    problems.push({
      path,
      why: `${path} carries ${extra.length === 1 ? "an unrecognised key" : "unrecognised keys"} {${extra.join(", ")}}; this contract is exact, and an unread key is an unreviewed field`,
    });
  }
  // OWN data properties only — never `in`, which reaches the prototype.
  const missing = required.filter((k) => !Object.prototype.hasOwnProperty.call(data, k)).sort();
  if (missing.length > 0) {
    problems.push({ path, why: `${path} is missing required ${missing.length === 1 ? "key" : "keys"} {${missing.join(", ")}}` });
  }
  return extra.length === 0 && missing.length === 0 ? (data as Record<string, unknown>) : null;
}

/** An array whose every element satisfies `element`, reported per index. */
export function typedArray(
  value: unknown,
  path: string,
  element: (item: unknown, itemPath: string, problems: SchemaProblem[]) => void,
  problems: SchemaProblem[],
): unknown[] | null {
  const snap = safeSnapshot(value, path);
  if (!snap.ok) {
    problems.push(...snap.problems);
    return null;
  }
  const data = snap.value;
  if (!Array.isArray(data)) {
    problems.push({ path, why: `${path} is ${describe(value)}, not an array` });
    return null;
  }
  const before = problems.length;
  data.forEach((item, i) => element(item, `${path}[${i}]`, problems));
  return problems.length === before ? data : null;
}

/** A non-empty string element. */
export function stringElement(item: unknown, itemPath: string, problems: SchemaProblem[]): void {
  if (typeof item !== "string" || item.trim() === "") {
    problems.push({ path: itemPath, why: `${itemPath} is ${describe(item)}, not a non-empty string` });
  }
}

/** An element of a closed set. */
export function memberElement(set: readonly string[]) {
  return (item: unknown, itemPath: string, problems: SchemaProblem[]): void => {
    if (typeof item !== "string" || !set.includes(item)) {
      problems.push({ path: itemPath, why: `${itemPath} is ${describe(item)}, not one of ${set.join(" | ")}` });
    }
  };
}

/** An element that is itself an exact map. */
export function exactMapElement(required: readonly string[], optional: readonly string[] = []) {
  return (item: unknown, itemPath: string, problems: SchemaProblem[]): void => {
    exactMap(item, itemPath, required, optional, problems);
  };
}

/**
 * A DISCRIMINATED UNION, keyed on one field. The variant map is exact for the
 * variant its discriminant selects.
 */
export function exactVariant(
  value: unknown,
  path: string,
  discriminant: string,
  variants: Record<string, { required: readonly string[]; optional?: readonly string[] }>,
  problems: SchemaProblem[],
): Record<string, unknown> | null {
  const snap = safeSnapshot(value, path);
  if (!snap.ok) {
    problems.push(...snap.problems);
    return null;
  }
  const data = snap.value;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    problems.push({ path, why: `${path} is ${describe(value)}, not a map` });
    return null;
  }
  const tag = (data as Record<string, unknown>)[discriminant];
  if (typeof tag !== "string" || !(tag in variants)) {
    problems.push({ path, why: `${path}.${discriminant} is ${describe(tag)}, not one of ${Object.keys(variants).join(" | ")}` });
    return null;
  }
  const variant = variants[tag];
  return exactMap(data, `${path}(${tag})`, variant.required, variant.optional ?? [], problems);
}

/** Render problems as one deterministic, sorted line. */
export function renderProblems(problems: readonly SchemaProblem[]): string {
  return [...problems].map((p) => p.why).sort().join("; ");
}

// ---------------------------------------------------------------------------
// SCALAR DOMAINS — one specification, not scattered `if`s
// ---------------------------------------------------------------------------

/*
  r9 checked that fields AGREED with each other and never that any of them was
  a LEGAL value, so a negative amount copied coherently through request, CAS,
  receipt and rollback verified as true, as did blank identifiers, a blank
  currency, a negative exponent and fractional minor units. These functions are
  the domain specification every caller shares.
*/

export function checkNonEmptyString(v: unknown, path: string, problems: SchemaProblem[], what = "a non-empty string"): boolean {
  if (typeof v !== "string" || v.trim() === "") {
    problems.push({ path, why: `${path} is ${describe(v)}, not ${what}` });
    return false;
  }
  return true;
}

/** A whole, non-negative, safe integer count of minor units. */
export function checkMinorUnits(v: unknown, path: string, problems: SchemaProblem[]): boolean {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    problems.push({ path, why: `${path} is ${describe(v)}, not a finite number of minor units` });
    return false;
  }
  if (!Number.isInteger(v)) {
    problems.push({ path, why: `${path} is ${v}, not a whole number of minor units` });
    return false;
  }
  if (v < 0) {
    problems.push({ path, why: `${path} is ${v}; a budget amount may not be negative` });
    return false;
  }
  if (!Number.isSafeInteger(v)) {
    problems.push({ path, why: `${path} is ${v}, beyond the safe integer range` });
    return false;
  }
  return true;
}

/** An ISO-4217 alphabetic code: exactly three upper-case letters. */
export function checkCurrencyCode(v: unknown, path: string, problems: SchemaProblem[]): boolean {
  if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) {
    problems.push({ path, why: `${path} is ${describe(v)}, not a three-letter upper-case ISO-4217 code` });
    return false;
  }
  return true;
}

/** A minor-unit exponent: an integer in 0..4. */
export function checkCurrencyExponent(v: unknown, path: string, problems: SchemaProblem[]): boolean {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 4) {
    problems.push({ path, why: `${path} is ${describe(v)}, not an integer minor-unit exponent in 0..4` });
    return false;
  }
  return true;
}

/**
 * A fingerprint in ONE EXACT producing contract's namespace.
 *
 * r11 used the generic form below for CAS and read-back fingerprints, so
 * `foreign.contract:<64hex>` passed: the namespace was decorative.
 */
export function checkNamespacedFingerprint(
  v: unknown, path: string, contract: string, problems: SchemaProblem[],
): boolean {
  const pattern = new RegExp(`^${contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[0-9a-f]{64}$`);
  if (typeof v !== "string" || !pattern.test(v)) {
    problems.push({ path, why: `${path} is ${describe(v)}, not ${contract}: followed by a lowercase 64-hex digest` });
    return false;
  }
  return true;
}

/** A namespaced fingerprint: `<contract>:<64 lowercase hex>`. */
export function checkFingerprint(v: unknown, path: string, problems: SchemaProblem[]): boolean {
  if (typeof v !== "string" || !/^[A-Za-z0-9._-]+:[0-9a-f]{64}$/.test(v)) {
    problems.push({ path, why: `${path} is ${describe(v)}, not a namespaced <contract>:<sha256> fingerprint` });
    return false;
  }
  return true;
}
