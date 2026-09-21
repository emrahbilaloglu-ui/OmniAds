import {
  COST_ALLOCATION_DRIVERS,
  COST_BASES,
  COST_COMPONENT_STATUSES,
  COST_DECISION_CLASSES,
  COST_EVIDENCE_TIERS,
  COST_FAMILIES,
  COST_FX_POLICIES,
  COST_PERIODS,
  COST_RECOGNITIONS,
  COST_REFUND_BEHAVIOURS,
  COST_SCOPE_DIMENSIONS,
  COST_SCOPE_OPERATORS,
  COST_SOURCE_KINDS,
  COST_STRUCTURE_ORIGINS,
  COST_TAX_TREATMENTS,
  PRODUCT_COST_AUTHORITIES,
  SHOPIFY_HISTORICAL_COST_POLICIES,
  SHOPIFY_MISSING_COST_POLICIES,
  SHOPIFY_UNIT_COST_MEANINGS,
  type CommerceCostComponent,
  type CommerceCostSourcePolicy,
  type CommerceCostStructure,
  type CostBasis,
  type CostBomComponent,
  type CostEmbeddedShare,
  type CostFamily,
  type CostRateTableRow,
  type CostScopePredicate,
  type CostStructureConflict,
} from "@/src/types/commerce-cost";
import { parseInstant } from "./time";

/**
 * The boundary between an HTTP body and the cost domain.
 *
 * Everything is rebuilt field by field from a whitelist: nothing a client
 * sends reaches storage unless this file names it, so an unexpected key can
 * neither be persisted nor change a hash. Anything unreadable is refused with
 * a path, rather than coerced into a default — a coerced cost is a wrong
 * number that looks deliberate.
 *
 * Absent and explicitly null are preserved as they arrive, because in this
 * domain they are different answers.
 */

export interface CostPayloadIssue {
  path: string;
  code: string;
  detail: string;
}

export type CostStructurePayloadResult =
  | { ok: true; structure: CommerceCostStructure }
  | { ok: false; issues: CostPayloadIssue[] };

/** Keeps one malformed body from becoming a multi-megabyte JSONB row. */
export const COST_PAYLOAD_LIMITS = {
  components: 500,
  scopePredicates: 24,
  scopeValues: 200,
  rateTableRows: 500,
  bomComponents: 200,
  embeddedShares: 24,
  families: COST_FAMILIES.length,
  conflicts: 100,
  stringLength: 500,
  noteLength: 2_000,
} as const;

class PayloadError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
    this.name = "PayloadError";
  }
}

function fail(path: string, code: string, detail: string): never {
  throw new PayloadError(path, code, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "expected_object", `${path} must be an object.`);
  return value;
}

function requireArray(value: unknown, path: string, limit: number): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected_array", `${path} must be an array.`);
  if (value.length > limit) {
    fail(path, "too_many_items", `${path} may hold at most ${limit} items.`);
  }
  return value;
}

function requireString(value: unknown, path: string, limit: number = COST_PAYLOAD_LIMITS.stringLength): string {
  if (typeof value !== "string") fail(path, "expected_string", `${path} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) fail(path, "empty_string", `${path} must not be empty.`);
  if (trimmed.length > limit) {
    fail(path, "string_too_long", `${path} may be at most ${limit} characters.`);
  }
  return trimmed;
}

function optionalNullableString(
  container: Record<string, unknown>,
  key: string,
  path: string,
  limit: number = COST_PAYLOAD_LIMITS.stringLength,
): string | null | undefined {
  if (!(key in container)) return undefined;
  const value = container[key];
  // Explicitly null stays null: "there is no label" is not "nobody said".
  if (value === null) return null;
  return requireString(value, path, limit);
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "expected_finite_number", `${path} must be a finite number.`);
  }
  return value;
}

function optionalNullableNumber(
  container: Record<string, unknown>,
  key: string,
  path: string,
): number | null | undefined {
  if (!(key in container)) return undefined;
  const value = container[key];
  if (value === null) return null;
  return requireFiniteNumber(value, path);
}

function optionalBoolean(
  container: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  if (!(key in container)) return undefined;
  const value = container[key];
  if (typeof value !== "boolean") fail(path, "expected_boolean", `${path} must be a boolean.`);
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(path, "unknown_value", `${path} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function requireInstant(value: unknown, path: string): string {
  const text = requireString(value, path);
  // A time nobody can read gives a component no knowable period, and the
  // resolver would refuse to use it. Better to refuse the write.
  if (parseInstant(text) === null) {
    fail(path, "unreadable_time", `${path} must be a readable ISO instant.`);
  }
  return text;
}

function optionalNullableInstant(
  container: Record<string, unknown>,
  key: string,
  path: string,
): string | null | undefined {
  if (!(key in container)) return undefined;
  const value = container[key];
  if (value === null) return null;
  return requireInstant(value, path);
}

function requireInteger(value: unknown, path: string, min = 0): number {
  const numeric = requireFiniteNumber(value, path);
  if (!Number.isInteger(numeric) || numeric < min) {
    fail(path, "expected_integer", `${path} must be an integer of at least ${min}.`);
  }
  return numeric;
}

function familyList(value: unknown, path: string): CostFamily[] {
  const raw = requireArray(value, path, COST_PAYLOAD_LIMITS.families);
  const families = raw.map((entry, index) =>
    requireEnum(entry, COST_FAMILIES, `${path}[${index}]`),
  );
  // Deduplicated because a family listed twice means the same thing once.
  return [...new Set(families)];
}

function sourcePolicy(value: unknown, path: string): CommerceCostSourcePolicy {
  const raw = requireRecord(value, path);
  const productCostAuthority = requireEnum(
    raw.productCostAuthority,
    PRODUCT_COST_AUTHORITIES,
    `${path}.productCostAuthority`,
  );
  const policy: CommerceCostSourcePolicy = { productCostAuthority };

  if ("shopifyUnitCost" in raw && raw.shopifyUnitCost !== undefined) {
    const shopify = requireRecord(raw.shopifyUnitCost, `${path}.shopifyUnitCost`);
    const fallbackComponentId = optionalNullableString(
      shopify,
      "fallbackComponentId",
      `${path}.shopifyUnitCost.fallbackComponentId`,
    );
    policy.shopifyUnitCost = {
      meaning: requireEnum(
        shopify.meaning,
        SHOPIFY_UNIT_COST_MEANINGS,
        `${path}.shopifyUnitCost.meaning`,
      ),
      includedFamilies: familyList(
        shopify.includedFamilies,
        `${path}.shopifyUnitCost.includedFamilies`,
      ),
      minimumCoveragePercent: requireFiniteNumber(
        shopify.minimumCoveragePercent,
        `${path}.shopifyUnitCost.minimumCoveragePercent`,
      ),
      missingCostPolicy: requireEnum(
        shopify.missingCostPolicy,
        SHOPIFY_MISSING_COST_POLICIES,
        `${path}.shopifyUnitCost.missingCostPolicy`,
      ),
      historicalPolicy: requireEnum(
        shopify.historicalPolicy,
        SHOPIFY_HISTORICAL_COST_POLICIES,
        `${path}.shopifyUnitCost.historicalPolicy`,
      ),
      ...(fallbackComponentId === undefined ? {} : { fallbackComponentId }),
    };
  }

  return policy;
}

function scopePredicate(value: unknown, path: string): CostScopePredicate {
  const raw = requireRecord(value, path);
  const operator = requireEnum(raw.operator, COST_SCOPE_OPERATORS, `${path}.operator`);
  const predicate: CostScopePredicate = {
    dimension: requireEnum(raw.dimension, COST_SCOPE_DIMENSIONS, `${path}.dimension`),
    operator,
  };
  if ("values" in raw && raw.values !== undefined) {
    const values = requireArray(raw.values, `${path}.values`, COST_PAYLOAD_LIMITS.scopeValues);
    predicate.values = values.map((entry, index) =>
      requireString(entry, `${path}.values[${index}]`),
    );
  }
  if (operator !== "exists" && (predicate.values?.length ?? 0) === 0) {
    fail(`${path}.values`, "values_required", `${path}.values is required for "${operator}".`);
  }
  const key = optionalNullableString(raw, "key", `${path}.key`);
  if (key !== undefined) predicate.key = key;
  return predicate;
}

function scopeList(value: unknown, path: string): CostScopePredicate[] {
  const raw = requireArray(value, path, COST_PAYLOAD_LIMITS.scopePredicates);
  return raw.map((entry, index) => scopePredicate(entry, `${path}[${index}]`));
}

function rateTableRow(value: unknown, path: string): CostRateTableRow {
  const raw = requireRecord(value, path);
  const row: CostRateTableRow = { amount: requireFiniteNumber(raw.amount, `${path}.amount`) };
  if ("when" in raw && raw.when !== undefined) row.when = scopeList(raw.when, `${path}.when`);
  const weight = optionalNullableNumber(raw, "weightMaxKg", `${path}.weightMaxKg`);
  if (weight !== undefined) row.weightMaxKg = weight;
  return row;
}

function bomComponent(value: unknown, path: string): CostBomComponent {
  const raw = requireRecord(value, path);
  const child: CostBomComponent = {
    quantity: requireFiniteNumber(raw.quantity, `${path}.quantity`),
  };
  const variantId = optionalNullableString(raw, "variantId", `${path}.variantId`);
  if (variantId !== undefined) child.variantId = variantId;
  const sku = optionalNullableString(raw, "sku", `${path}.sku`);
  if (sku !== undefined) child.sku = sku;
  const amount = optionalNullableNumber(raw, "amount", `${path}.amount`);
  if (amount !== undefined) child.amount = amount;
  return child;
}

function basis(value: unknown, path: string): CostBasis {
  const raw = requireRecord(value, path);
  const kind = raw.kind;

  switch (kind) {
    case "amount_per_unit":
    case "amount_per_line":
      return { kind, amount: requireFiniteNumber(raw.amount, `${path}.amount`) };
    case "amount_per_order":
      return {
        kind,
        amount: requireFiniteNumber(raw.amount, `${path}.amount`),
        allocation: requireEnum(raw.allocation, COST_ALLOCATION_DRIVERS, `${path}.allocation`),
      };
    case "percent_of_base": {
      const next: Extract<CostBasis, { kind: "percent_of_base" }> = {
        kind,
        percent: requireFiniteNumber(raw.percent, `${path}.percent`),
        base: requireEnum(raw.base, COST_BASES, `${path}.base`),
      };
      if ("allocation" in raw && raw.allocation !== undefined) {
        next.allocation = requireEnum(raw.allocation, COST_ALLOCATION_DRIVERS, `${path}.allocation`);
      }
      return next;
    }
    case "percent_plus_fixed": {
      const next: Extract<CostBasis, { kind: "percent_plus_fixed" }> = {
        kind,
        percent: requireFiniteNumber(raw.percent, `${path}.percent`),
        base: requireEnum(raw.base, COST_BASES, `${path}.base`),
        fixedAmount: requireFiniteNumber(raw.fixedAmount, `${path}.fixedAmount`),
      };
      if ("fixedPer" in raw && raw.fixedPer !== undefined) {
        next.fixedPer = requireEnum(raw.fixedPer, ["order", "unit"] as const, `${path}.fixedPer`);
      }
      if ("allocation" in raw && raw.allocation !== undefined) {
        next.allocation = requireEnum(raw.allocation, COST_ALLOCATION_DRIVERS, `${path}.allocation`);
      }
      return next;
    }
    case "rate_table": {
      const rows = requireArray(raw.rows, `${path}.rows`, COST_PAYLOAD_LIMITS.rateTableRows);
      const next: Extract<CostBasis, { kind: "rate_table" }> = {
        kind,
        level: requireEnum(raw.level, ["order", "unit"] as const, `${path}.level`),
        rows: rows.map((entry, index) => rateTableRow(entry, `${path}.rows[${index}]`)),
      };
      const fallback = optionalNullableNumber(raw, "fallbackAmount", `${path}.fallbackAmount`);
      if (fallback !== undefined) next.fallbackAmount = fallback;
      if ("allocation" in raw && raw.allocation !== undefined) {
        next.allocation = requireEnum(raw.allocation, COST_ALLOCATION_DRIVERS, `${path}.allocation`);
      }
      return next;
    }
    case "bom": {
      const components = requireArray(
        raw.components,
        `${path}.components`,
        COST_PAYLOAD_LIMITS.bomComponents,
      );
      const next: Extract<CostBasis, { kind: "bom" }> = {
        kind,
        components: components.map((entry, index) =>
          bomComponent(entry, `${path}.components[${index}]`),
        ),
      };
      const waste = optionalNullableNumber(raw, "wastePercent", `${path}.wastePercent`);
      if (waste !== undefined) next.wastePercent = waste;
      return next;
    }
    case "period_amount":
      return {
        kind,
        amount: requireFiniteNumber(raw.amount, `${path}.amount`),
        period: requireEnum(raw.period, COST_PERIODS, `${path}.period`),
        allocation: requireEnum(raw.allocation, COST_ALLOCATION_DRIVERS, `${path}.allocation`),
      };
    case "margin_input": {
      const next: Extract<CostBasis, { kind: "margin_input" }> = {
        kind,
        marginKind: requireEnum(raw.marginKind, ["gross", "contribution"] as const, `${path}.marginKind`),
        marginPercent: requireFiniteNumber(raw.marginPercent, `${path}.marginPercent`),
        base: requireEnum(raw.base, COST_BASES, `${path}.base`),
      };
      if ("allocation" in raw && raw.allocation !== undefined) {
        next.allocation = requireEnum(raw.allocation, COST_ALLOCATION_DRIVERS, `${path}.allocation`);
      }
      return next;
    }
    default:
      return fail(`${path}.kind`, "unknown_basis_kind", `${path}.kind is not a known basis.`);
  }
}

function embeddedShare(value: unknown, path: string): CostEmbeddedShare {
  const raw = requireRecord(value, path);
  return {
    family: requireEnum(raw.family, COST_FAMILIES, `${path}.family`),
    kind: requireEnum(raw.kind, ["amount_per_unit", "percent_of_host"] as const, `${path}.kind`),
    value: requireFiniteNumber(raw.value, `${path}.value`),
  };
}

function component(value: unknown, path: string, recordedAt: string): CommerceCostComponent {
  const raw = requireRecord(value, path);
  const next: CommerceCostComponent = {
    id: requireString(raw.id, `${path}.id`),
    version: "version" in raw ? requireInteger(raw.version, `${path}.version`, 1) : 1,
    family: requireEnum(raw.family, COST_FAMILIES, `${path}.family`),
    slot: "slot" in raw && raw.slot !== undefined ? requireString(raw.slot, `${path}.slot`) : "default",
    scope: "scope" in raw && raw.scope !== undefined ? scopeList(raw.scope, `${path}.scope`) : [],
    basis: basis(raw.basis, `${path}.basis`),
    currency: requireString(raw.currency, `${path}.currency`, 8).toUpperCase(),
    taxTreatment: requireEnum(raw.taxTreatment, COST_TAX_TREATMENTS, `${path}.taxTreatment`),
    effectiveFrom: requireInstant(raw.effectiveFrom, `${path}.effectiveFrom`),
    // Server-owned: when a record was written is not the client's to claim.
    recordedAt,
    recognition: requireEnum(raw.recognition, COST_RECOGNITIONS, `${path}.recognition`),
    evidence: requireEnum(raw.evidence, COST_EVIDENCE_TIERS, `${path}.evidence`),
    source: (() => {
      const source = requireRecord(raw.source, `${path}.source`);
      const ref = optionalNullableString(source, "ref", `${path}.source.ref`);
      return {
        kind: requireEnum(source.kind, COST_SOURCE_KINDS, `${path}.source.kind`),
        ...(ref === undefined ? {} : { ref }),
      };
    })(),
    status: requireEnum(raw.status, COST_COMPONENT_STATUSES, `${path}.status`),
  };

  const label = optionalNullableString(raw, "label", `${path}.label`);
  if (label !== undefined) next.label = label;
  if ("embeds" in raw && raw.embeds !== undefined) {
    next.embeds = familyList(raw.embeds, `${path}.embeds`);
  }
  if ("embeddedShares" in raw && raw.embeddedShares !== undefined) {
    const shares = requireArray(
      raw.embeddedShares,
      `${path}.embeddedShares`,
      COST_PAYLOAD_LIMITS.embeddedShares,
    );
    next.embeddedShares = shares.map((entry, index) =>
      embeddedShare(entry, `${path}.embeddedShares[${index}]`),
    );
  }
  const replaces = optionalBoolean(raw, "replacesEmbedded", `${path}.replacesEmbedded`);
  if (replaces !== undefined) next.replacesEmbedded = replaces;
  if ("fx" in raw && raw.fx !== undefined && raw.fx !== null) {
    const fx = requireRecord(raw.fx, `${path}.fx`);
    const fixedRate = optionalNullableNumber(fx, "fixedRate", `${path}.fx.fixedRate`);
    next.fx = {
      policy: requireEnum(fx.policy, COST_FX_POLICIES, `${path}.fx.policy`),
      ...(fixedRate === undefined ? {} : { fixedRate }),
    };
  }
  const effectiveTo = optionalNullableInstant(raw, "effectiveTo", `${path}.effectiveTo`);
  if (effectiveTo !== undefined) next.effectiveTo = effectiveTo;
  if ("refundBehaviour" in raw && raw.refundBehaviour !== undefined) {
    next.refundBehaviour = requireEnum(
      raw.refundBehaviour,
      COST_REFUND_BEHAVIOURS,
      `${path}.refundBehaviour`,
    );
  }
  if ("decisionClass" in raw && raw.decisionClass !== undefined) {
    next.decisionClass = requireEnum(
      raw.decisionClass,
      COST_DECISION_CLASSES,
      `${path}.decisionClass`,
    );
  }
  const overrideOf = optionalNullableString(raw, "overrideOf", `${path}.overrideOf`);
  if (overrideOf !== undefined) next.overrideOf = overrideOf;
  const reason = optionalNullableString(raw, "reason", `${path}.reason`, COST_PAYLOAD_LIMITS.noteLength);
  if (reason !== undefined) next.reason = reason;

  return next;
}

function conflict(value: unknown, path: string): CostStructureConflict {
  const raw = requireRecord(value, path);
  const candidates = requireArray(raw.candidates, `${path}.candidates`, 20);
  return {
    family: requireEnum(raw.family, COST_FAMILIES, `${path}.family`),
    slot: requireString(raw.slot, `${path}.slot`),
    detail: requireString(raw.detail, `${path}.detail`, COST_PAYLOAD_LIMITS.noteLength),
    candidates: candidates.map((entry, index) => {
      const candidate = requireRecord(entry, `${path}.candidates[${index}]`);
      const source = requireRecord(candidate.source, `${path}.candidates[${index}].source`);
      const ref = optionalNullableString(source, "ref", `${path}.candidates[${index}].source.ref`);
      const note = optionalNullableString(
        candidate,
        "note",
        `${path}.candidates[${index}].note`,
        COST_PAYLOAD_LIMITS.noteLength,
      );
      return {
        source: {
          kind: requireEnum(source.kind, COST_SOURCE_KINDS, `${path}.candidates[${index}].source.kind`),
          ...(ref === undefined ? {} : { ref }),
        },
        value: optionalNullableNumber(candidate, "value", `${path}.candidates[${index}].value`) ?? null,
        ...(note === undefined ? {} : { note }),
      };
    }),
  };
}

export interface CostStructureAuthority {
  businessId: string;
  /** Monotonic, assigned by the server. */
  version: number;
  /** When the server wrote it. */
  recordedAt: string;
}

/**
 * Rebuilds a structure from an untrusted body.
 *
 * `businessId`, `version` and `recordedAt` come from `authority`: whatever the
 * client sent for them is dropped rather than trusted, so a body cannot claim
 * to belong to another business or to a version it did not earn.
 */
export function parseCostStructurePayload(
  input: unknown,
  authority: CostStructureAuthority,
): CostStructurePayloadResult {
  try {
    const raw = requireRecord(input, "structure");
    const components = requireArray(
      "components" in raw && raw.components !== undefined ? raw.components : [],
      "structure.components",
      COST_PAYLOAD_LIMITS.components,
    );

    const structure: CommerceCostStructure = {
      businessId: authority.businessId,
      version: authority.version,
      origin: requireEnum(raw.origin, COST_STRUCTURE_ORIGINS, "structure.origin"),
      confirmed: (() => {
        const confirmed = optionalBoolean(raw, "confirmed", "structure.confirmed");
        if (confirmed === undefined) {
          fail("structure.confirmed", "field_required", "structure.confirmed is required.");
        }
        return confirmed;
      })(),
      reportingCurrency: requireString(raw.reportingCurrency, "structure.reportingCurrency", 8).toUpperCase(),
      effectiveFrom: requireInstant(raw.effectiveFrom, "structure.effectiveFrom"),
      recordedAt: authority.recordedAt,
      components: components.map((entry, index) =>
        component(entry, `structure.components[${index}]`, authority.recordedAt),
      ),
    };

    if ("sourcePolicy" in raw && raw.sourcePolicy !== undefined) {
      structure.sourcePolicy = sourcePolicy(raw.sourcePolicy, "structure.sourcePolicy");
    }

    if ("notTracked" in raw && raw.notTracked !== undefined) {
      structure.notTracked = familyList(raw.notTracked, "structure.notTracked");
    }
    if ("expectedFamilies" in raw && raw.expectedFamilies !== undefined) {
      structure.expectedFamilies = familyList(raw.expectedFamilies, "structure.expectedFamilies");
    }
    if ("conflicts" in raw && raw.conflicts !== undefined) {
      const conflicts = requireArray(raw.conflicts, "structure.conflicts", COST_PAYLOAD_LIMITS.conflicts);
      structure.conflicts = conflicts.map((entry, index) =>
        conflict(entry, `structure.conflicts[${index}]`),
      );
    }
    const note = optionalNullableString(raw, "note", "structure.note", COST_PAYLOAD_LIMITS.noteLength);
    if (note !== undefined) structure.note = note;

    // One record per component id, because that is what a current structure
    // holds: a superseded version replaces its predecessor rather than sitting
    // beside it. Two records for one id are two different intentions, and the
    // runtime would not resolve them the way a reader of the payload expects —
    // `activeComponents` drops non-active records BEFORE picking the latest
    // version, so an old active record outlives the retired one meant to end it.
    const seen = new Set<string>();
    for (const [index, entry] of structure.components.entries()) {
      if (seen.has(entry.id)) {
        return {
          ok: false,
          issues: [
            {
              path: `structure.components[${index}]`,
              code: "duplicate_component_id",
              detail: `Component ${entry.id} appears more than once. Send the record that should apply now; earlier ones stay readable in the structure history.`,
            },
          ],
        };
      }
      seen.add(entry.id);
    }

    return { ok: true, structure };
  } catch (error) {
    if (error instanceof PayloadError) {
      return { ok: false, issues: [{ path: error.path, code: error.code, detail: error.message }] };
    }
    throw error;
  }
}
