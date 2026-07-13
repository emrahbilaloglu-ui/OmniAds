import { createHash } from "node:crypto";

export type StableConfigValue =
  | null
  | boolean
  | number
  | string
  | StableConfigValue[]
  | { [key: string]: StableConfigValue };

export interface DeduplicatedConfig<T> {
  hash: string;
  canonical: string;
  config: T;
  firstIndex: number;
  duplicateIndices: number[];
}

export interface StableConfigDeduplication<T> {
  inputCount: number;
  uniqueCount: number;
  duplicateCount: number;
  unique: Array<DeduplicatedConfig<T>>;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
): StableConfigValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("stable config numbers must be finite");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new Error(`unsupported stable config value: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new Error("stable config cannot be cyclic");
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const result: StableConfigValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error("stable config arrays cannot be sparse");
        }
        result.push(canonicalize(value[index], ancestors));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("stable config objects must be plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("stable config objects cannot have symbol keys");
    }

    const result: Record<string, StableConfigValue> = {};
    const keys = Object.getOwnPropertyNames(value).sort(compareCodePoints);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) {
        throw new Error("stable config properties must be enumerable");
      }
      if (descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw new Error("stable config properties cannot be accessors");
      }
      result[key] = canonicalize(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function stableConfigStringify(config: unknown): string {
  return JSON.stringify(canonicalize(config, new Set<object>()));
}

export function stableConfigHash(config: unknown): string {
  return createHash("sha256")
    .update(stableConfigStringify(config))
    .digest("hex");
}

export function deduplicateStableConfigs<T>(
  configs: readonly T[],
  selectConfig: (entry: T) => unknown = (entry) => entry,
): StableConfigDeduplication<T> {
  const byHash = new Map<string, number>();
  const unique: Array<DeduplicatedConfig<T>> = [];

  configs.forEach((config, index) => {
    const canonical = stableConfigStringify(selectConfig(config));
    const hash = createHash("sha256").update(canonical).digest("hex");
    const existingIndex = byHash.get(hash);
    if (existingIndex === undefined) {
      byHash.set(hash, unique.length);
      unique.push({
        hash,
        canonical,
        config,
        firstIndex: index,
        duplicateIndices: [],
      });
      return;
    }

    const existing = unique[existingIndex];
    if (existing.canonical !== canonical) {
      throw new Error(`stable config SHA-256 collision: ${hash}`);
    }
    existing.duplicateIndices.push(index);
  });

  return {
    inputCount: configs.length,
    uniqueCount: unique.length,
    duplicateCount: configs.length - unique.length,
    unique,
  };
}
