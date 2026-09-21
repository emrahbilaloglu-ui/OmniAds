import {
  COST_BASES,
  COST_LINE_BASES,
  type CommerceCostComponent,
  type CommerceCostStructure,
  type CostFamily,
  type CostIssueSeverity,
  type CostStructureIssue,
  type CostStructureIssueCode,
} from "@/src/types/commerce-cost";
import { basisLevel } from "./basis";
import { parseInstant } from "./time";
import { scopeSignature, scopesMayOverlap } from "./scope";
import { costFamilyMeta, marginImpliedFamilies } from "./taxonomy";

/**
 * Structure validation.
 *
 * These are the combinations that produce a confidently wrong profit number:
 * the same cost counted twice, a percentage with no base, ad spend smuggled
 * into a cost, a margin stated on top of the costs it already contains. They
 * are refused here — before anything is stored or shown — rather than being
 * detected later in a number nobody can reconcile.
 *
 * Pure: the same structure always yields the same issues, in the same order.
 */

const MAX_BOM_DEPTH = 8;
const CLEAR_LINE_SCOPE_DIMENSIONS = new Set([
  "product_id",
  "variant_id",
  "sku",
  "collection",
  "product_tag",
  "supplier",
]);

function issue(
  code: CostStructureIssueCode,
  severity: CostIssueSeverity,
  componentIds: string[],
  detail: string,
  family?: CostFamily | null,
): CostStructureIssue {
  return { code, severity, componentIds, detail, family: family ?? null };
}

function parseTime(value: string | null | undefined): number {
  return parseInstant(value) ?? 0;
}

function rangesOverlap(left: CommerceCostComponent, right: CommerceCostComponent): boolean {
  const leftFrom = parseTime(left.effectiveFrom);
  const rightFrom = parseTime(right.effectiveFrom);
  const leftTo = left.effectiveTo ? parseTime(left.effectiveTo) : Number.POSITIVE_INFINITY;
  const rightTo = right.effectiveTo ? parseTime(right.effectiveTo) : Number.POSITIVE_INFINITY;
  return leftFrom < rightTo && rightFrom < leftTo;
}

/**
 * Every family whose money sits inside this component: the ones it declares,
 * plus the ones a stated margin necessarily covers.
 */
function embeddedFamiliesOf(component: CommerceCostComponent): Set<CostFamily> {
  const families = new Set<CostFamily>(component.embeds ?? []);
  if (component.basis.kind === "margin_input") {
    for (const family of marginImpliedFamilies(component.basis.marginKind)) {
      if (family !== component.family) families.add(family);
    }
  }
  return families;
}

function bomIdentity(component: CommerceCostComponent): string[] {
  return component.scope
    .filter((predicate) => predicate.dimension === "variant_id" || predicate.dimension === "sku")
    .flatMap((predicate) => (predicate.values ?? []).map((value) => value.trim().toLowerCase()));
}

function detectBomProblems(components: readonly CommerceCostComponent[]): CostStructureIssue[] {
  const issues: CostStructureIssue[] = [];
  const byIdentity = new Map<string, CommerceCostComponent[]>();
  for (const component of components) {
    for (const identity of bomIdentity(component)) {
      byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), component]);
    }
  }

  const walk = (
    component: CommerceCostComponent,
    seen: readonly string[],
    depth: number,
  ): void => {
    if (component.basis.kind !== "bom") return;
    if (depth >= MAX_BOM_DEPTH) {
      issues.push(
        issue("bom_depth_exceeded", "error", [component.id], `Recipe nests deeper than ${MAX_BOM_DEPTH} levels.`),
      );
      return;
    }
    for (const child of component.basis.components) {
      const identity = (child.variantId ?? child.sku ?? "").trim().toLowerCase();
      if (!identity) {
        if (typeof child.amount !== "number") {
          issues.push(
            issue(
              "bom_child_unidentified",
              "error",
              [component.id],
              "A recipe line has neither a variant, a SKU nor a stated cost.",
            ),
          );
        }
        continue;
      }
      if (seen.includes(identity)) {
        issues.push(
          issue("bom_cycle", "error", [component.id], `Recipe cycles back to ${identity}.`),
        );
        continue;
      }
      for (const next of byIdentity.get(identity) ?? []) {
        if (next.id === component.id) continue;
        walk(next, [...seen, identity], depth + 1);
      }
    }
  };

  for (const component of components) {
    if (component.basis.kind !== "bom") continue;
    walk(component, bomIdentity(component), 0);
  }

  return issues;
}

export function validateCostStructure(structure: CommerceCostStructure): CostStructureIssue[] {
  const issues: CostStructureIssue[] = [];
  const components = structure.components.filter((component) => component.status !== "retired");
  const byId = new Map(structure.components.map((component) => [component.id, component]));

  const sourcePolicy = structure.sourcePolicy;
  const shopifyParticipates =
    sourcePolicy?.productCostAuthority === "shopify_unit_cost" ||
    sourcePolicy?.productCostAuthority === "hybrid";
  if (shopifyParticipates) {
    const shopify = sourcePolicy.shopifyUnitCost;
    if (!shopify || shopify.meaning === "unknown") {
      issues.push(
        issue(
          "shopify_source_meaning_unknown",
          "warning",
          [],
          "State what Shopify unit cost includes before treating it as a usable cost source.",
        ),
      );
    }
    if (shopify) {
      if (!Number.isFinite(shopify.minimumCoveragePercent) ||
          shopify.minimumCoveragePercent < 0 ||
          shopify.minimumCoveragePercent > 100) {
        issues.push(
          issue(
            "shopify_coverage_threshold_invalid",
            "error",
            [],
            "Shopify minimum coverage must be between 0% and 100%.",
          ),
        );
      }
      if (!shopify.includedFamilies.includes("product_purchase")) {
        issues.push(
          issue(
            "shopify_source_product_cost_missing",
            "error",
            [],
            "A Shopify product-cost source must include product purchase cost.",
            "product_purchase",
          ),
        );
      }
      for (const family of shopify.includedFamilies) {
        if (!costFamilyMeta(family).embeddable) {
          issues.push(
            issue(
              "shopify_source_family_not_embeddable",
              "error",
              [],
              `${costFamilyMeta(family).label} cannot be hidden inside Shopify unit cost.`,
              family,
            ),
          );
        }
      }

      const fallback = shopify.fallbackComponentId
        ? byId.get(shopify.fallbackComponentId)
        : undefined;
      if (shopify.missingCostPolicy === "manual_fallback") {
        if (!shopify.fallbackComponentId) {
          issues.push(
            issue(
              "shopify_fallback_component_missing",
              "error",
              [],
              "Choose the manual component used when a variant has no Shopify unit cost.",
            ),
          );
        } else if (
          !fallback ||
          fallback.status !== "active" ||
          fallback.family !== "product_purchase" ||
          fallback.evidence === "override" ||
          fallback.decisionClass === "informational" ||
          fallback.source.kind === "shopify_unit_cost"
        ) {
          issues.push(
            issue(
              "shopify_fallback_component_invalid",
              "error",
              fallback ? [fallback.id] : [],
              "The Shopify fallback must be an active manual product-purchase component, not an override or another Shopify value.",
              "product_purchase",
            ),
          );
        } else {
          const fallbackFamilies = new Set<CostFamily>([
            fallback.family,
            ...embeddedFamiliesOf(fallback),
          ]);
          const expectedFamilies = new Set(shopify.includedFamilies);
          const sameComposition =
            fallbackFamilies.size === expectedFamilies.size &&
            [...fallbackFamilies].every((family) => expectedFamilies.has(family));
          if (!sameComposition) {
            issues.push(
              issue(
                "shopify_fallback_composition_mismatch",
                "error",
                [fallback.id],
                "The manual fallback must cover exactly the same cost families as the Shopify unit-cost definition.",
                "product_purchase",
              ),
            );
          }
        }
      }

      for (const component of components) {
        if (component.decisionClass === "informational") continue;
        if (
          shopify.missingCostPolicy === "manual_fallback" &&
          component.id === shopify.fallbackComponentId
        ) {
          continue;
        }
        const componentFamilies = new Set<CostFamily>([
          component.family,
          ...embeddedFamiliesOf(component),
        ]);
        const overlap = shopify.includedFamilies.find((family) => componentFamilies.has(family));
        if (!overlap) continue;
        issues.push(
          issue(
            "shopify_source_family_also_direct",
            "error",
            [component.id],
            `${costFamilyMeta(overlap).label} is already inside Shopify unit cost and also owned by ${component.label ?? component.id}. Remove one owner or use that component only as the explicit missing-cost fallback.`,
            overlap,
          ),
        );
      }
    }
  }

  for (const component of components) {
    const meta = costFamilyMeta(component.family);

    if (!meta.componentAllowed) {
      issues.push(
        issue(
          "marketing_family_not_allowed",
          "error",
          [component.id],
          `${meta.label} comes from the ad platforms and cannot be a cost component.`,
          component.family,
        ),
      );
    }

    for (const embedded of component.embeds ?? []) {
      if (!costFamilyMeta(embedded).embeddable) {
        issues.push(
          issue(
            "family_not_embeddable",
            "error",
            [component.id],
            `${costFamilyMeta(embedded).label} cannot be embedded in another cost.`,
            embedded,
          ),
        );
      }
    }

    // A time nobody can read gives the component no knowable period, and the
    // resolver will refuse to use it. Better to say so before it is stored.
    for (const [field, value] of [
      ["effectiveFrom", component.effectiveFrom],
      ["effectiveTo", component.effectiveTo],
      ["recordedAt", component.recordedAt],
      ["supersededAt", component.supersededAt],
    ] as const) {
      if (value === null || value === undefined) continue;
      if (parseInstant(value) === null) {
        issues.push(
          issue("unparseable_time", "error", [component.id], `${field} is not a readable instant.`),
        );
      }
    }

    for (const share of component.embeddedShares ?? []) {
      if (
        !Number.isFinite(share.value) ||
        share.value < 0 ||
        (share.kind === "percent_of_host" && share.value > 100)
      ) {
        issues.push(
          issue(
            "embedded_share_not_a_cost",
            "error",
            [component.id],
            `The stated ${costFamilyMeta(share.family).label} share is not a share of this cost.`,
            share.family,
          ),
        );
      }
      if (!embeddedFamiliesOf(component).has(share.family)) {
        issues.push(
          issue(
            "embedded_share_without_embed",
            "error",
            [component.id],
            `A share is stated for ${costFamilyMeta(share.family).label}, which this cost does not contain.`,
            share.family,
          ),
        );
      }
    }

    const embedsNonProductCost = (component.embeds ?? []).some(
      (family) =>
        costFamilyMeta(family).embeddable &&
        costFamilyMeta(family).layer === "variable_operating",
    );
    if (
      costFamilyMeta(component.family).layer === "product" &&
      embedsNonProductCost &&
      component.refundBehaviour !== "product_share_only"
    ) {
      issues.push(
        issue(
          "loaded_product_refund_policy_invalid",
          "error",
          [component.id],
          "A product cost containing shipping, fees or another operating cost must reverse only its product share on a return.",
          component.family,
        ),
      );
    }

    if (component.effectiveTo && parseTime(component.effectiveTo) <= parseTime(component.effectiveFrom)) {
      issues.push(
        issue("effective_range_inverted", "error", [component.id], "Effective end is not after its start."),
      );
    }

    if (component.currency.toUpperCase() !== structure.reportingCurrency.toUpperCase()) {
      const fx = component.fx;
      const fixedRateMissing =
        fx?.policy === "fixed_rate" &&
        !(typeof fx.fixedRate === "number" && Number.isFinite(fx.fixedRate) && fx.fixedRate > 0);
      if (!fx || fx.policy === "reporting_currency" || fixedRateMissing) {
        issues.push(
          issue(
            "currency_without_fx_policy",
            "error",
            [component.id],
            fixedRateMissing
              ? `${component.currency} is pinned to a fixed rate that is not set.`
              : `${component.currency} needs a conversion policy before it can be summed.`,
          ),
        );
      }
    }

    if (component.overrideOf) {
      if (!component.reason || component.reason.trim().length === 0) {
        issues.push(issue("override_without_reason", "error", [component.id], "An override needs a stated reason."));
      }
      const target = byId.get(component.overrideOf);
      if (!target) {
        issues.push(
          issue("override_target_missing", "error", [component.id], `Overrides unknown component ${component.overrideOf}.`),
        );
      } else if (target.family !== component.family || target.slot !== component.slot) {
        issues.push(
          issue(
            "override_target_mismatch",
            "error",
            [component.id, target.id],
            "An override must target the same cost family and charge group.",
            component.family,
          ),
        );
      }
    }

    const basis = component.basis;
    if ("base" in basis && !COST_BASES.includes(basis.base)) {
      issues.push(issue("unknown_base", "error", [component.id], `Unknown revenue base ${String(basis.base)}.`));
    }
    if (
      "base" in basis &&
      !COST_LINE_BASES.includes(basis.base) &&
      component.scope.some((predicate) => CLEAR_LINE_SCOPE_DIMENSIONS.has(predicate.dimension))
    ) {
      issues.push(
        issue(
          "line_scope_with_order_base",
          "error",
          [component.id],
          "A product, variant, SKU, collection, tag or supplier scope needs a line-level revenue base; an order-level base would charge the whole order for every matched line.",
          component.family,
        ),
      );
    }
    if (basis.kind === "percent_of_base" || basis.kind === "percent_plus_fixed") {
      if (basis.percent < 0 || basis.percent > 100) {
        issues.push(
          issue("percent_out_of_range", "error", [component.id], `${basis.percent}% is not a share of revenue.`),
        );
      }
    }
    if (basis.kind === "margin_input") {
      if (basis.marginPercent > 100 || basis.marginPercent < -100) {
        issues.push(
          issue("margin_out_of_range", "error", [component.id], `${basis.marginPercent}% is not a margin.`),
        );
      }
    }
    // Negative money can hide in any part of a basis, and a negative cost is
    // revenue the owner never earned.
    const negative =
      ((basis.kind === "amount_per_unit" ||
        basis.kind === "amount_per_line" ||
        basis.kind === "amount_per_order" ||
        basis.kind === "period_amount") &&
        basis.amount < 0) ||
      (basis.kind === "percent_plus_fixed" && basis.fixedAmount < 0) ||
      (basis.kind === "rate_table" &&
        (basis.rows.some((row) => row.amount < 0) ||
          (typeof basis.fallbackAmount === "number" && basis.fallbackAmount < 0))) ||
      (basis.kind === "bom" &&
        (basis.components.some((child) => (child.amount ?? 0) < 0 || child.quantity < 0) ||
          (basis.wastePercent ?? 0) < 0));
    if (negative) {
      issues.push(issue("negative_amount", "error", [component.id], "A cost cannot be negative."));
    }
    if (
      basis.kind === "rate_table" &&
      basis.rows.length === 0 &&
      !(typeof basis.fallbackAmount === "number" && Number.isFinite(basis.fallbackAmount))
    ) {
      issues.push(issue("rate_table_without_rows", "error", [component.id], "The rate table has no rows and no fallback."));
    }
    if (
      basisLevel(basis) === "order" &&
      basis.kind !== "amount_per_order" &&
      !("allocation" in basis && basis.allocation)
    ) {
      issues.push(
        issue(
          "allocation_missing_for_order_amount",
          "warning",
          [component.id],
          "An order-level cost with no allocation driver is spread by revenue.",
        ),
      );
    }
    if (meta.layer === "fixed" && basis.kind !== "period_amount") {
      issues.push(
        issue(
          "fixed_family_needs_period_basis",
          "warning",
          [component.id],
          `${meta.label} is a recurring cost; state it as a period amount so it stays out of marginal decisions.`,
          component.family,
        ),
      );
    }
    if (basis.kind === "period_amount" && meta.layer !== "fixed" && meta.layer !== "marketing") {
      issues.push(
        issue(
          "period_basis_on_variable_family",
          "warning",
          [component.id],
          `${meta.label} varies with orders; a recurring amount would never reach a line.`,
          component.family,
        ),
      );
    }
    if (
      (basis.kind === "amount_per_unit" || basis.kind === "amount_per_line") &&
      basis.amount === 0 &&
      component.evidence === "template_default"
    ) {
      issues.push(
        issue(
          "unconfirmed_zero_amount",
          "warning",
          [component.id],
          "A zero from a template is indistinguishable from an unanswered question.",
          component.family,
        ),
      );
    }
  }

  // ---- double counting: embedded families that are also modelled directly
  for (const host of components) {
    const embedded = embeddedFamiliesOf(host);
    if (embedded.size === 0) continue;

    for (const other of components) {
      if (other.id === host.id) continue;
      if (!embedded.has(other.family)) continue;
      if (!scopesMayOverlap(host.scope, other.scope)) continue;
      if (!rangesOverlap(host, other)) continue;

      const share = host.embeddedShares?.find((entry) => entry.family === other.family);
      if (other.replacesEmbedded && share) continue;
      if (other.replacesEmbedded && !share) {
        issues.push(
          issue(
            "embedded_share_required_for_replacement",
            "error",
            [other.id, host.id],
            `${costFamilyMeta(other.family).label} can only replace the share inside ${host.id} once that share is stated.`,
            other.family,
          ),
        );
        continue;
      }
      issues.push(
        issue(
          host.basis.kind === "margin_input"
            ? "margin_input_with_direct_component"
            : "embedded_family_also_direct",
          "error",
          [host.id, other.id],
          host.basis.kind === "margin_input"
            ? `The stated margin in ${host.id} already covers ${costFamilyMeta(other.family).label}.`
            : `${costFamilyMeta(other.family).label} is already inside ${host.id}.`,
          other.family,
        ),
      );
    }
  }

  for (const component of components) {
    if (!component.replacesEmbedded) continue;
    const hasHost = components.some(
      (host) =>
        host.id !== component.id &&
        embeddedFamiliesOf(host).has(component.family) &&
        scopesMayOverlap(host.scope, component.scope) &&
        rangesOverlap(host, component),
    );
    if (!hasHost) {
      issues.push(
        issue(
          "replacement_without_host",
          "error",
          [component.id],
          "Nothing embeds this family, so there is no share to replace.",
          component.family,
        ),
      );
    }
  }

  // ---- two components competing for the same slot at the same time
  const bySlotKey = new Map<string, CommerceCostComponent[]>();
  for (const component of components) {
    const key = [
      component.family,
      component.slot,
      scopeSignature(component.scope),
      component.evidence,
    ].join("\u0001");
    bySlotKey.set(key, [...(bySlotKey.get(key) ?? []), component]);
  }
  for (const group of bySlotKey.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const first = group[left]!;
        const second = group[right]!;
        if (first.id === second.id) continue;
        if (!rangesOverlap(first, second)) continue;
        issues.push(
          issue(
            "duplicate_effective_range",
            "error",
            [first.id, second.id],
            `${costFamilyMeta(second.family).label} has two equally-trusted values for the same scope and period.`,
            second.family,
          ),
        );
      }
    }
  }

  // ---- percentages that would eat the whole order
  // Only the newest stored version of an id is current. Older versions remain
  // in the structure for replay and must not be added to today's percentage.
  const newestById = new Map<string, CommerceCostComponent>();
  for (const component of components) {
    const current = newestById.get(component.id);
    if (
      !current ||
      component.version > current.version ||
      (component.version === current.version &&
        parseTime(component.recordedAt) > parseTime(current.recordedAt))
    ) {
      newestById.set(component.id, component);
    }
  }
  const percentByBase = new Map<string, CommerceCostComponent[]>();
  for (const component of newestById.values()) {
    const basis = component.basis;
    if (basis.kind !== "percent_of_base" && basis.kind !== "percent_plus_fixed") continue;
    if (costFamilyMeta(component.family).layer === "fixed") continue;
    if (component.scope.length > 0) continue;
    percentByBase.set(basis.base, [...(percentByBase.get(basis.base) ?? []), component]);
  }
  for (const [base, bucket] of percentByBase) {
    const instants = [...new Set(bucket.map((component) => parseTime(component.effectiveFrom)))].sort(
      (left, right) => left - right,
    );
    const impossible = instants
      .map((instant) => {
        const active = bucket.filter((component) => {
          const from = parseTime(component.effectiveFrom);
          const to = component.effectiveTo
            ? parseTime(component.effectiveTo)
            : Number.POSITIVE_INFINITY;
          return from <= instant && instant < to;
        });
        const total = active.reduce((sum, component) => {
          const basis = component.basis;
          return sum +
            (basis.kind === "percent_of_base" || basis.kind === "percent_plus_fixed"
              ? basis.percent
              : 0);
        }, 0);
        return { active, total };
      })
      .find((candidate) => candidate.total >= 100);
    if (!impossible) continue;
    issues.push(
      issue(
        "variable_percent_exceeds_full_revenue",
        "error",
        impossible.active.map((component) => component.id),
        `Store-wide percentages of ${base} add up to ${impossible.total}% in an overlapping effective period.`,
      ),
    );
  }

  // Two records with the same id AND version is a storage accident: nothing
  // downstream can tell which one is meant, so neither is trustworthy.
  const seenVersions = new Map<string, number>();
  for (const component of components) {
    const key = `${component.id}::${component.version}`;
    seenVersions.set(key, (seenVersions.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seenVersions) {
    if (count <= 1) continue;
    const [id] = key.split("::");
    issues.push(
      issue(
        "duplicate_component_version",
        "error",
        [id ?? key],
        `${count} records share the id and version ${key.replace("::", " v")}.`,
      ),
    );
  }

  issues.push(...detectBomProblems(components));

  return issues;
}

/** True when nothing blocks activating this structure. */
export function isCostStructureActivatable(structure: CommerceCostStructure): boolean {
  return !validateCostStructure(structure).some((entry) => entry.severity === "error");
}
