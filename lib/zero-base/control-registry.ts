/**
 * Interaction contract registry.
 *
 * One control key per drawn control. Exactly one range alias exists — the Meta
 * workflow menu — and it is modelled explicitly so a rendered key set can be
 * compared against contracts without a wildcard escape hatch.
 */
import {
  GENERATED_CONTRACT_EVENTS,
  GENERATED_CONTRACT_KEYS,
  type InteractionContractKey,
} from "@/lib/zero-base/generated-contracts";

export type { InteractionContractKey };

export const CONTRACT_KEYS = GENERATED_CONTRACT_KEYS;
export const CONTRACT_EVENTS = GENERATED_CONTRACT_EVENTS;

export type ControlClass = "live" | "gated" | "disabled";

export function controlClassOf(key: InteractionContractKey): ControlClass {
  const head = key.split(":", 1)[0];
  if (head === "live" || head === "gated" || head === "disabled") return head;
  throw new Error(`contract key has no known control class: ${key}`);
}

/** The only permitted range alias, with its exact expansion. */
export const RANGE_ALIASES = [
  {
    alias: "gated:META-WF-02..08 menu",
    expandsTo: [
      "META-WF-02",
      "META-WF-03",
      "META-WF-04",
      "META-WF-05",
      "META-WF-06",
      "META-WF-07",
      "META-WF-08",
    ],
  },
] as const;

/** Any other `..` token is an unmodelled range and must fail closed. */
export function unexpandedRangeKeys(
  keys: readonly string[] = CONTRACT_KEYS,
): readonly string[] {
  const allowed = new Set<string>(RANGE_ALIASES.map((a) => a.alias));
  return keys.filter((key) => key.includes("..") && !allowed.has(key));
}

/** Events are many-to-one by design; `none` marks a non-interactive contract. */
export function actionableContractKeys(): readonly InteractionContractKey[] {
  return CONTRACT_KEYS.filter((key) => controlClassOf(key) !== "disabled");
}
