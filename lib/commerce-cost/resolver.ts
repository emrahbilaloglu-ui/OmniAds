import { COST_LINE_BASES } from "@/src/types/commerce-cost";
import type {
  CommerceCostComponent,
  CommerceCostStructure,
  CostAllocationDriver,
  CostAllocationTrace,
  CostAmountState,
  CostBomComponent,
  CostDecisionClass,
  CostEvidenceTier,
  CostFamily,
  CostLineContext,
  CostOrderContext,
  CostRecognition,
  CostRefundBehaviour,
  CostResolutionEntry,
  CostResolutionRequest,
  CostResolutionResult,
  CostSourceRef,
  CostTaxTreatment,
  CostUnavailableReason,
} from "@/src/types/commerce-cost";
import { allocationWeight, basisLevel, evaluateBasis, type BomChildCost } from "./basis";
import { allocateMoney, convertMoney, roundMoney, sameMoney } from "./money";
import { matchScope, scopeContextFor } from "./scope";
import { parseAsOfInstant, parseInstant } from "./time";
import {
  costFamilyMeta,
  evidenceRank,
  isContributionFamily,
  isEstimateEvidence,
  marginImpliedFamilies,
} from "./taxonomy";

/**
 * The cost resolver.
 *
 * It answers one question per line and per cost family: who owns this cost,
 * and how much is it? The answer is a single owner — never a sum of two
 * sources for the same thing — and every other candidate is recorded as
 * shadowed so the reason is inspectable rather than invisible.
 *
 * Deliberate properties:
 *  - A family a component declares as embedded belongs to that component. A
 *    direct component may take it over only when the host states that share
 *    explicitly, and then the share is subtracted from the host.
 *  - Recurring (period) components are not order costs. They are deferred to
 *    the window so they can never enter a marginal, per-order number.
 *  - Absent, zero, not-applicable, not-tracked and unreadable stay distinct.
 *  - Estimates are carried, never silently promoted to observations.
 *
 * Pure and deterministic: same input, same output, no clock and no I/O.
 */

const AMOUNT_EPSILON = 0.005;

interface Candidate {
  componentId: string;
  componentVersion: number;
  family: CostFamily;
  slot: string;
  evidence: CostEvidenceTier;
  source: CostSourceRef;
  specificity: number;
  isOverride: boolean;
  effectiveFromMs: number;
  recordedAtMs: number;
  amount: number | null;
  estimated: boolean;
  reasons: string[];
  allocation: CostAllocationTrace | null;
  refundBehaviour: CostRefundBehaviour;
  decisionClass: CostDecisionClass;
  recognition: CostRecognition;
  taxTreatment: CostTaxTreatment;
  /** True for a measured fact about this line, false for configuration. */
  observed: boolean;
  /** The recognition instant was missing, so the order's was used instead. */
  anchorFellBack: boolean;
  replacesEmbedded: boolean;
  component: CommerceCostComponent | null;
}

/** Ordering only; validity is decided by `activeComponents`. */
function parseTime(value: string | null | undefined): number {
  return parseInstant(value) ?? 0;
}

function atomKey(family: CostFamily, slot: string): string {
  return `${family}::${slot}`;
}

function lineComponentKey(lineId: string, componentId: string): string {
  return `${lineId}::${componentId}`;
}

function recognitionAnchor(component: CommerceCostComponent, order: CostOrderContext): string {
  if (component.recognition === "on_fulfillment") return order.fulfilledAt ?? order.occurredAt;
  if (component.recognition === "on_payout") return order.payoutAt ?? order.occurredAt;
  return order.occurredAt;
}

/** Components that are live for this order, latest version per id. */
function activeComponents(
  structure: CommerceCostStructure,
  order: CostOrderContext,
  asOfRecordedAt: string | null | undefined,
): CommerceCostComponent[] {
  const asOfMs = parseAsOfInstant(asOfRecordedAt);
  const byId = new Map<string, CommerceCostComponent>();

  for (const component of structure.components) {
    if (component.status !== "active") continue;
    // A component whose own times cannot be read has no knowable period, so
    // it is not used. Collapsing a malformed date to the epoch made a cost
    // effective for every order that ever happened.
    const recordedAt = parseInstant(component.recordedAt);
    const effectiveFrom = parseInstant(component.effectiveFrom);
    if (recordedAt === null || effectiveFrom === null) continue;
    const effectiveTo = component.effectiveTo ? parseInstant(component.effectiveTo) : null;
    if (component.effectiveTo && effectiveTo === null) continue;
    if (asOfMs !== null && recordedAt > asOfMs) continue;
    if (component.supersededAt) {
      const supersededAt = parseInstant(component.supersededAt);
      if (supersededAt === null) continue;
      if (asOfMs === null || supersededAt <= asOfMs) continue;
    }
    const anchorValue = recognitionAnchor(component, order);
    const anchor = parseInstant(anchorValue);
    if (anchor === null) continue;
    if (effectiveFrom > anchor) continue;
    if (effectiveTo !== null && effectiveTo <= anchor) continue;

    const existing = byId.get(component.id);
    if (!existing || existing.version < component.version) byId.set(component.id, component);
  }

  return [...byId.values()];
}

function notApplicableReason(family: CostFamily, line: CostLineContext): string | null {
  if (line.notApplicableFamilies?.includes(family)) return "declared_not_applicable";
  // A gift card is not goods: it carries no product or fulfilment cost.
  if (line.isGiftCard && isContributionFamily(family)) return "gift_card_line";
  if (line.requiresShipping === false && family === "outbound_shipping") {
    return "line_requires_no_shipping";
  }
  return null;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.isOverride !== right.isOverride) return left.isOverride ? -1 : 1;
  const evidence = evidenceRank(left.evidence) - evidenceRank(right.evidence);
  if (evidence !== 0) return evidence;
  // A measurement of THIS line beats configuration at the same tier, however
  // many predicates that configuration carries.
  if (left.observed !== right.observed) return left.observed ? -1 : 1;
  if (left.specificity !== right.specificity) return right.specificity - left.specificity;
  if (left.effectiveFromMs !== right.effectiveFromMs) {
    return right.effectiveFromMs - left.effectiveFromMs;
  }
  if (left.recordedAtMs !== right.recordedAtMs) return right.recordedAtMs - left.recordedAtMs;
  return left.componentId.localeCompare(right.componentId);
}

function sameRank(left: Candidate, right: Candidate): boolean {
  return (
    left.isOverride === right.isOverride &&
    evidenceRank(left.evidence) === evidenceRank(right.evidence) &&
    left.observed === right.observed &&
    left.specificity === right.specificity
  );
}

function stateForAmount(amount: number | null, reasons: readonly string[]): {
  state: CostAmountState;
  unavailableReason: CostUnavailableReason | null;
} {
  if (amount === null) {
    if (reasons.some((reason) => reason.startsWith("currency_unconvertible"))) {
      return { state: "unavailable", unavailableReason: "currency_blocked" };
    }
    return { state: "unknown", unavailableReason: null };
  }
  if (Math.abs(amount) < AMOUNT_EPSILON) return { state: "zero", unavailableReason: null };
  return { state: "value", unavailableReason: null };
}

function toReporting(
  amount: number | null,
  fromCurrency: string,
  component: CommerceCostComponent | null,
  request: CostResolutionRequest,
): { amount: number | null; reasons: string[] } {
  if (amount === null) return { amount: null, reasons: [] };
  const componentCurrency = component?.currency?.toUpperCase();
  const sourceCurrency = fromCurrency.toUpperCase();
  const fixedRate =
    component?.fx?.policy === "fixed_rate" && componentCurrency === sourceCurrency
      ? component.fx.fixedRate ?? null
      : null;
  const converted = convertMoney(
    amount,
    fromCurrency,
    request.reportingCurrency,
    request.fxRates,
    fixedRate,
  );
  if (converted === null) {
    return { amount: null, reasons: [`currency_unconvertible:${fromCurrency}`] };
  }
  return { amount: converted, reasons: [] };
}

export function resolveOrderCosts(request: CostResolutionRequest): CostResolutionResult {
  const { structure, order, lines } = request;
  const components = activeComponents(structure, order, request.asOfRecordedAt);
  const resultReasons: string[] = [];
  const deferredPeriodComponentIds: string[] = [];

  const orderScopeContext = scopeContextFor(order, {
    lineId: "__order__",
    quantity: 0,
  });
  const lineScopeContexts = new Map<string, Map<string, string[]>>();
  for (const line of lines) lineScopeContexts.set(line.lineId, scopeContextFor(order, line));

  /** Candidates per line, keyed by family::slot. */
  const candidates = new Map<string, Map<string, Candidate[]>>();
  /** Hosts per line and family: components that embed that family. */
  const hosts = new Map<string, Map<CostFamily, Candidate[]>>();
  for (const line of lines) {
    candidates.set(line.lineId, new Map());
    hosts.set(line.lineId, new Map());
  }

  const pushCandidate = (lineId: string, candidate: Candidate) => {
    const perLine = candidates.get(lineId);
    if (!perLine) return;
    const key = atomKey(candidate.family, candidate.slot);
    perLine.set(key, [...(perLine.get(key) ?? []), candidate]);
  };

  const resolveChildUnitCost = (
    childOwner: CommerceCostComponent,
    child: CostBomComponent,
    depth: number,
  ): BomChildCost => {
    const childLine: CostLineContext = {
      lineId: `${childOwner.id}::bom::${child.variantId ?? child.sku ?? "child"}`,
      quantity: 1,
      variantId: child.variantId ?? null,
      sku: child.sku ?? null,
    };
    const childContext = scopeContextFor(order, childLine);
    // A recipe ingredient resolves only its purchase-cost atom. Freight,
    // duties and labour are separate families on the finished item unless the
    // purchase-cost component explicitly embeds them.
    const childCandidates = components
      .filter((candidate) => candidate.family === "product_purchase")
      .filter((candidate) => candidate.id !== childOwner.id)
      .filter((candidate) => matchScope(candidate.scope, childContext).matched)
      .filter((candidate) => basisLevel(candidate.basis) === "line");

    if (childCandidates.length === 0) {
      return { amount: null, estimated: false, reasons: ["bom_child_no_component"] };
    }

    const scored = childCandidates
      .map((candidate) => {
        const evaluated = evaluateBasis({
          component: candidate,
          order,
          line: childLine,
          scopeContext: childContext,
          deps: {
            reportingCurrency: request.reportingCurrency,
            depth,
            resolveChildUnitCost: (grandChild, nextDepth) =>
              resolveChildUnitCost(candidate, grandChild, nextDepth),
            convertStatedBomAmount: (amount) => {
              const converted = toReporting(amount, candidate.currency, candidate, request);
              return {
                amount: converted.amount,
                estimated: isEstimateEvidence(candidate.evidence),
                reasons: converted.reasons,
              };
            },
          },
        });
        const converted = toReporting(evaluated.amount, evaluated.currency, candidate, request);
        return {
          candidate,
          amount: converted.amount,
          estimated: evaluated.estimated || isEstimateEvidence(candidate.evidence),
          reasons: [...evaluated.reasons, ...converted.reasons],
          rank: evidenceRank(candidate.evidence),
          specificity: matchScope(candidate.scope, childContext).specificity,
        };
      })
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          right.specificity - left.specificity ||
          left.candidate.id.localeCompare(right.candidate.id),
      );

    // A higher-authority answer that is currently unavailable stays unknown;
    // falling through to a weaker number would silently change ownership.
    const best = scored[0]!;
    return { amount: best.amount, estimated: best.estimated, reasons: best.reasons };
  };

  for (const component of components) {
    const meta = costFamilyMeta(component.family);
    if (!meta.componentAllowed) {
      // Paid marketing is owned by the ad platforms. A component claiming it
      // would double count every ROAS and profit figure.
      resultReasons.push(`component_family_not_allowed:${component.id}`);
      continue;
    }
    if (basisLevel(component.basis) === "period") {
      deferredPeriodComponentIds.push(component.id);
      continue;
    }

    const applicable = lines.filter((line) => {
      if (notApplicableReason(component.family, line)) return false;
      return matchScope(component.scope, lineScopeContexts.get(line.lineId)!).matched;
    });
    if (applicable.length === 0) continue;

    const refundBehaviour = component.refundBehaviour ?? meta.refundBehaviour;
    const decisionClass = component.decisionClass ?? meta.decisionClass;
    const baseCandidate = {
      componentId: component.id,
      componentVersion: component.version,
      family: component.family,
      slot: component.slot,
      evidence: component.evidence,
      source: component.source,
      isOverride: Boolean(component.overrideOf) || component.evidence === "override",
      effectiveFromMs: parseTime(component.effectiveFrom),
      recordedAtMs: parseTime(component.recordedAt),
      refundBehaviour,
      decisionClass,
      recognition: component.recognition,
      taxTreatment: component.taxTreatment,
      observed: false,
      anchorFellBack:
        (component.recognition === "on_fulfillment" && !order.fulfilledAt) ||
        (component.recognition === "on_payout" && !order.payoutAt),
      replacesEmbedded: Boolean(component.replacesEmbedded),
      component,
    };

    const level = basisLevel(component.basis);
    const perLineAmounts = new Map<string, { amount: number | null; estimated: boolean; reasons: string[]; allocation: CostAllocationTrace | null }>();

    if (level === "order") {
      const evaluationLine =
        component.basis.kind === "percent_plus_fixed" && component.basis.fixedPer === "unit"
          ? {
              lineId: "__order_units__",
              quantity: applicable.reduce((sum, line) => sum + line.quantity, 0),
            }
          : null;
      const evaluated = evaluateBasis({
        component,
        order,
        line: evaluationLine,
        scopeContext: orderScopeContext,
        deps: { reportingCurrency: request.reportingCurrency },
      });
      const converted = toReporting(evaluated.amount, evaluated.currency, component, request);
      const driver: CostAllocationDriver =
        ("allocation" in component.basis && component.basis.allocation) || "revenue";
      const weights = applicable.map((line) => allocationWeight(driver, line));
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      const shares =
        converted.amount === null ? applicable.map(() => null) : allocateMoney(converted.amount, weights);

      applicable.forEach((line, index) => {
        perLineAmounts.set(line.lineId, {
          amount: shares[index] ?? null,
          estimated: evaluated.estimated,
          reasons: [...evaluated.reasons, ...converted.reasons],
          allocation:
            converted.amount === null
              ? null
              : {
                  driver,
                  orderAmount: converted.amount,
                  weight: weights[index] ?? 0,
                  totalWeight,
                },
        });
      });
    } else {
      const linePercentPlusFixed =
        component.basis.kind === "percent_plus_fixed" &&
        component.basis.fixedPer !== "unit" &&
        COST_LINE_BASES.includes(component.basis.base)
          ? component.basis
          : null;
      const fixedPerOrder = linePercentPlusFixed !== null;
      const fixedShares = (() => {
        if (!linePercentPlusFixed) return null;
        if (order.currency.toUpperCase() !== component.currency.toUpperCase()) return null;
        const driver = linePercentPlusFixed.allocation ?? "revenue";
        const fixedConverted = toReporting(
          linePercentPlusFixed.fixedAmount,
          component.currency,
          component,
          request,
        );
        if (fixedConverted.amount === null) return null;
        return allocateMoney(
          fixedConverted.amount,
          applicable.map((line) => allocationWeight(driver, line)),
        );
      })();
      for (const line of applicable) {
        const basisComponent: CommerceCostComponent = linePercentPlusFixed
          ? {
              ...component,
              basis: { ...linePercentPlusFixed, fixedAmount: 0 },
            }
          : component;
        const evaluated = evaluateBasis({
          component: basisComponent,
          order,
          line,
          scopeContext: lineScopeContexts.get(line.lineId)!,
          deps: {
            reportingCurrency: request.reportingCurrency,
            depth: 0,
            resolveChildUnitCost: (child, depth) => resolveChildUnitCost(component, child, depth),
            convertStatedBomAmount: (amount) => {
              const converted = toReporting(amount, component.currency, component, request);
              return {
                amount: converted.amount,
                estimated: isEstimateEvidence(component.evidence),
                reasons: converted.reasons,
              };
            },
          },
        });
        const converted = toReporting(evaluated.amount, evaluated.currency, component, request);
        const lineIndex = applicable.findIndex((candidate) => candidate.lineId === line.lineId);
        const fixedShare = fixedPerOrder ? fixedShares?.[lineIndex] : 0;
        perLineAmounts.set(line.lineId, {
          amount:
            converted.amount === null || (fixedPerOrder && fixedShare === undefined)
              ? null
              : roundMoney(converted.amount + (fixedShare ?? 0)),
          estimated: evaluated.estimated,
          reasons: [
            ...evaluated.reasons,
            ...converted.reasons,
            ...(fixedPerOrder && fixedShares === null
              ? ["percent_plus_fixed_currency_mismatch"]
              : []),
          ],
          allocation: null,
        });
      }
    }

    for (const line of applicable) {
      const computed = perLineAmounts.get(line.lineId);
      if (!computed) continue;
      const candidate: Candidate = {
        ...baseCandidate,
        specificity: matchScope(component.scope, lineScopeContexts.get(line.lineId)!).specificity,
        amount: computed.amount,
        estimated: computed.estimated || isEstimateEvidence(component.evidence),
        reasons: computed.reasons,
        allocation: computed.allocation,
      };
      pushCandidate(line.lineId, candidate);

      for (const embedded of component.embeds ?? []) {
        if (!costFamilyMeta(embedded).embeddable) {
          resultReasons.push(`embed_family_not_allowed:${component.id}:${embedded}`);
          continue;
        }
        const perLineHosts = hosts.get(line.lineId)!;
        perLineHosts.set(embedded, [...(perLineHosts.get(embedded) ?? []), candidate]);
      }

      if (component.basis.kind === "margin_input") {
        // A stated margin implies the cost of everything it covers.
        const implied = marginImpliedFamilies(component.basis.marginKind);
        const perLineHosts = hosts.get(line.lineId)!;
        for (const family of implied) {
          if (family === component.family) continue;
          perLineHosts.set(family, [...(perLineHosts.get(family) ?? []), candidate]);
        }
      }
    }
  }

  // Observed facts are data about one line, so they are maximally specific.
  for (const line of lines) {
    for (const [index, fact] of (line.observed ?? []).entries()) {
      const family = fact.family;
      const meta = costFamilyMeta(family);
      if (!meta.componentAllowed) {
        resultReasons.push(`observed_family_not_allowed:${line.lineId}:${family}`);
        continue;
      }
      if (notApplicableReason(family, line)) continue;
      const amount = fact.per === "unit" ? fact.amount * line.quantity : fact.amount;
      const converted = toReporting(amount, fact.currency, null, request);
      pushCandidate(line.lineId, {
        componentId: `observed:${family}:${fact.slot ?? "default"}:${index}`,
        componentVersion: 0,
        family,
        slot: fact.slot ?? "default",
        evidence: fact.evidence ?? "observed_exact",
        source: fact.source,
        specificity: 200,
        isOverride: fact.evidence === "override",
        effectiveFromMs: parseTime(order.occurredAt),
        recordedAtMs: parseTime(order.occurredAt),
        amount: converted.amount,
        estimated: false,
        reasons: converted.reasons,
        allocation: null,
        refundBehaviour: meta.refundBehaviour,
        decisionClass: meta.decisionClass,
        recognition: "on_order",
        // A measured invoice says nothing about recoverable tax unless the
        // importer tagged it.
        taxTreatment: fact.taxTreatment ?? "unknown",
        observed: true,
        anchorFellBack: false,
        replacesEmbedded: false,
        component: null,
      });
    }
  }

  // ---- families we expect to see, so a silent gap becomes a stated unknown
  // Recurring costs are answered at the window, so they are not a per-line
  // gap. Reporting them as unknown here would null the operating rung for a
  // business that states its overheads correctly.
  const orderScoped = components.filter((component) => basisLevel(component.basis) !== "period");
  const orderScopedFamilies = new Set<CostFamily>([
    ...orderScoped.map((component) => component.family),
    ...orderScoped.flatMap((component) => [...(component.embeds ?? [])]),
    ...lines.flatMap((line) => (line.observed ?? []).map((fact) => fact.family)),
  ]);
  const baselineExpectedFamilies: CostFamily[] = [
    "product_purchase",
    "payment_processing",
    ...(lines.some((line) => line.requiresShipping === true)
      ? (["outbound_shipping"] as CostFamily[])
      : []),
    ...orderScopedFamilies,
  ];
  const expected = new Set<CostFamily>(
    (
      structure.expectedFamilies ?? baselineExpectedFamilies
    ).filter(
      (family) =>
        costFamilyMeta(family).componentAllowed &&
        (isContributionFamily(family) || orderScopedFamilies.has(family)),
    ),
  );
  const notTracked = new Set<CostFamily>(structure.notTracked ?? []);
  const sourceIssues = new Map<CostFamily, CostUnavailableReason>(
    (request.sourceIssues ?? []).map((issue) => [issue.family, issue.reason]),
  );

  /** Entries by `lineId::family::slot`, so phase two can overwrite phase one. */
  const entries = new Map<string, CostResolutionEntry>();
  /** Components that actually won an atom on a line, with their amount. */
  const ownedNumeric = new Map<string, number>();
  /** Shares a host gives up, per line, per host, per family — once each. */
  const shareRemovals = new Map<string, Map<CostFamily, number>>();

  for (const line of lines) {
    const perLine = candidates.get(line.lineId)!;
    const perLineHosts = hosts.get(line.lineId)!;
    const familiesWithCandidates = new Set(
      [...perLine.keys()].map((key) => key.split("::")[0] as CostFamily),
    );
    const atoms = new Set<string>([...perLine.keys()]);
    for (const family of [
      ...expected,
      ...notTracked,
      ...(line.notApplicableFamilies ?? []),
      ...perLineHosts.keys(),
    ]) {
      // A family stated in named slots is not also missing a "default" one.
      if (familiesWithCandidates.has(family)) continue;
      atoms.add(atomKey(family, "default"));
    }
    const ordered = [...atoms].sort();

    const baseEntryFor = (atom: string) => {
      const [familyRaw, slot] = atom.split("::");
      const family = familyRaw as CostFamily;
      const meta = costFamilyMeta(family);
      return {
        family,
        slot: slot ?? "default",
        base: {
          lineId: line.lineId,
          family,
          slot: slot ?? "default",
          layer: meta.layer,
          quantity: line.quantity,
          decisionClass: meta.decisionClass,
          refundBehaviour: meta.refundBehaviour,
          recognition: "on_order" as CostRecognition,
          taxTreatment: "unknown" as CostTaxTreatment,
          estimated: false,
        },
      };
    };

    // ---- phase one: who owns each atom, ignoring embedding entirely.
    // A component that loses its own atom must not be able to shadow another
    // family, and a host whose own amount is unknown must not swallow one.
    for (const atom of ordered) {
      const { family, base } = baseEntryFor(atom);
      const key = `${line.lineId}::${atom}`;

      const notApplicable = notApplicableReason(family, line);
      if (notApplicable) {
        entries.set(key, { ...base, state: "not_applicable", amount: null, reasons: [notApplicable] });
        continue;
      }

      const direct = (perLine.get(atom) ?? []).slice().sort(compareCandidates);
      if (direct.length === 0) {
        if (notTracked.has(family)) {
          entries.set(key, {
            ...base,
            state: "not_tracked",
            amount: null,
            reasons: ["declared_not_tracked"],
          });
          continue;
        }
        const issue = sourceIssues.get(family);
        entries.set(
          key,
          issue
            ? {
                ...base,
                state: "unavailable",
                amount: null,
                unavailableReason: issue,
                reasons: [`source_issue:${issue}`],
              }
            : { ...base, state: "unknown", amount: null, reasons: ["no_component_matched"] },
        );
        continue;
      }

      const winner = direct[0]!;
      const rivals = direct
        .slice(1)
        .filter(
          (candidate) =>
            sameRank(winner, candidate) &&
            !(
              winner.amount !== null &&
              candidate.amount !== null &&
              sameMoney(winner.amount, candidate.amount)
            ),
        );

      if (rivals.length > 0) {
        const numeric = [winner, ...rivals]
          .map((candidate) => candidate.amount)
          .filter((amount): amount is number => amount !== null);
        // Equally-evidenced disagreement is surfaced, and the conservative
        // (higher cost) number is what any decision sees.
        entries.set(key, {
          ...base,
          state: "conflict",
          amount: numeric.length > 0 ? Math.max(...numeric) : null,
          estimated: winner.estimated,
          evidence: winner.evidence,
          source: winner.source,
          ownerComponentId: winner.componentId,
          ownerComponentVersion: winner.componentVersion,
          decisionClass: winner.decisionClass,
          refundBehaviour: winner.refundBehaviour,
          recognition: winner.recognition,
          taxTreatment: winner.taxTreatment,
          conflictingComponentIds: [winner.componentId, ...rivals.map((rival) => rival.componentId)],
          reasons: ["equal_rank_conflict", ...winner.reasons],
        });
        continue;
      }

      const resolved = stateForAmount(winner.amount, winner.reasons);
      if (winner.amount !== null && (resolved.state === "value" || resolved.state === "zero")) {
        ownedNumeric.set(lineComponentKey(line.lineId, winner.componentId), winner.amount);
      }
      entries.set(key, {
        ...base,
        state: resolved.state,
        amount: winner.amount,
        estimated: winner.estimated,
        evidence: winner.evidence,
        source: winner.source,
        ownerComponentId: winner.componentId,
        ownerComponentVersion: winner.componentVersion,
        decisionClass: winner.decisionClass,
        refundBehaviour: winner.refundBehaviour,
        recognition: winner.recognition,
        taxTreatment: winner.taxTreatment,
        unavailableReason: resolved.unavailableReason,
        allocation: winner.allocation ?? undefined,
        reasons: [
          ...winner.reasons,
          // The rate was chosen as of the order because the recognition
          // instant was absent, while the ledger may still book it elsewhere.
          ...(winner.anchorFellBack ? [`recognition_anchor_missing:${winner.recognition}`] : []),
          ...direct.slice(1).map((candidate) => `outranked:${candidate.componentId}`),
        ],
      });
    }

    // ---- phase two: embedding, now that ownership is known.
    for (const atom of ordered) {
      const { family, base } = baseEntryFor(atom);
      const key = `${line.lineId}::${atom}`;
      if (notApplicableReason(family, line)) continue;

      // Only a component that won its own atom with a real number can hold
      // another family's money.
      const activeHosts = (perLineHosts.get(family) ?? [])
        .filter((host) => host.family !== family)
        .filter((host) => ownedNumeric.has(lineComponentKey(line.lineId, host.componentId)))
        .sort(compareCandidates);
      if (activeHosts.length === 0) continue;

      const hostAmountOf = (host: Candidate) =>
        ownedNumeric.get(lineComponentKey(line.lineId, host.componentId)) ?? null;
      const shareOf = (host: Candidate): { amount: number | null; reasons: string[] } => {
        const declared = host.component?.embeddedShares?.find((entry) => entry.family === family);
        if (!declared) return { amount: null, reasons: [] };
        const hostAmount = hostAmountOf(host) ?? 0;
        const size =
          declared.kind === "amount_per_unit"
            ? declared.value * line.quantity
            : (hostAmount * declared.value) / 100;
        // A negative share would grow the host it is taken out of.
        if (!Number.isFinite(size) || size < 0) {
          return { amount: null, reasons: [`embedded_share_not_a_cost:${host.componentId}`] };
        }
        return { amount: roundMoney(size), reasons: [] };
      };

      const replacements = (perLine.get(atom) ?? [])
        .filter((candidate) => candidate.replacesEmbedded)
        .slice()
        .sort(compareCandidates);
      const replacement = replacements[0];
      const replacementRivals = replacements
        .slice(1)
        .filter(
          (candidate) =>
            replacement !== undefined &&
            sameRank(replacement, candidate) &&
            !(
              replacement.amount !== null &&
              candidate.amount !== null &&
              sameMoney(replacement.amount, candidate.amount)
            ),
        );
      const shares = activeHosts.map((host) => ({ host, share: shareOf(host) }));
      const shareReasons = shares.flatMap((entry) => entry.share.reasons);
      // Every host holding this family has to be reducible, or the money would
      // be counted both inside a host and again on its own.
      const allHostsQuantified = shares.every((entry) => entry.share.amount !== null);
      const replacementUsable =
        replacement !== undefined &&
        replacement.amount !== null &&
        replacementRivals.length === 0;

      const hostReasons = [
        ...(activeHosts.length > 1 ? ["multiple_embedding_hosts"] : []),
        ...shareReasons,
      ];

      if (replacement && allHostsQuantified && replacementUsable) {
        for (const { host, share } of shares) {
          const hostKey = lineComponentKey(line.lineId, host.componentId);
          const perFamily = shareRemovals.get(hostKey) ?? new Map<CostFamily, number>();
          // Keyed by family, so several replacing slots of one family cannot
          // take the same share out of the host more than once.
          perFamily.set(family, share.amount!);
          shareRemovals.set(hostKey, perFamily);
        }
        const resolved = stateForAmount(replacement.amount, replacement.reasons);
        entries.set(key, {
          ...base,
          state: resolved.state,
          amount: replacement.amount,
          estimated: replacement.estimated,
          evidence: replacement.evidence,
          source: replacement.source,
          ownerComponentId: replacement.componentId,
          ownerComponentVersion: replacement.componentVersion,
          decisionClass: replacement.decisionClass,
          refundBehaviour: replacement.refundBehaviour,
          recognition: replacement.recognition,
          taxTreatment: replacement.taxTreatment,
          unavailableReason: resolved.unavailableReason,
          reasons: [...hostReasons, "replaced_embedded_share", ...replacement.reasons],
        });
        if (replacement.amount !== null) {
          ownedNumeric.set(lineComponentKey(line.lineId, replacement.componentId), replacement.amount);
        }
        continue;
      }

      if (replacement && replacementRivals.length > 0) {
        // Two equally-trusted measured costs disagree. Taking either would
        // also strip a host share on the strength of a coin flip.
        entries.set(key, {
          ...base,
          state: "conflict",
          amount: null,
          evidence: replacement.evidence,
          source: replacement.source,
          ownerComponentId: replacement.componentId,
          ownerComponentVersion: replacement.componentVersion,
          conflictingComponentIds: [
            replacement.componentId,
            ...replacementRivals.map((rival) => rival.componentId),
          ],
          shadowedBy: { componentId: activeHosts[0]!.componentId, family: activeHosts[0]!.family },
          reasons: [...hostReasons, "replacement_conflict"],
        });
        continue;
      }

      const host = activeHosts[0]!;
      entries.set(key, {
        ...base,
        state: "embedded",
        amount: null,
        evidence: host.evidence,
        source: host.source,
        ownerComponentId: host.componentId,
        ownerComponentVersion: host.componentVersion,
        refundBehaviour: host.refundBehaviour,
        decisionClass: host.decisionClass,
        recognition: host.recognition,
        taxTreatment: host.taxTreatment,
        shadowedBy: { componentId: host.componentId, family: host.family },
        reasons: [
          ...hostReasons,
          "embedded_in_host",
          ...(replacement && !allHostsQuantified
            ? ["embedded_share_unknown_replacement_rejected"]
            : []),
          ...(replacement && replacement.amount === null ? ["replacement_amount_unknown"] : []),
          ...(perLine.get(atom) ?? []).map((candidate) => `shadowed:${candidate.componentId}`),
        ],
      });
    }
  }

  // A replaced embedded share leaves the host, so the host is reduced by it.
  const adjusted = [...entries.values()].map((entry) => {
    const perFamily = entry.ownerComponentId
      ? shareRemovals.get(lineComponentKey(entry.lineId, entry.ownerComponentId))
      : undefined;
    if (!perFamily || entry.state !== "value" || entry.amount === null) return entry;
    // Only the host's OWN family entry pays: an entry that merely reports
    // another family (embedded, or the replacement itself) holds no money.
    if (perFamily.has(entry.family)) return entry;
    const removal = roundMoney([...perFamily.values()].reduce((sum, value) => sum + value, 0));
    if (removal <= 0) return entry;
    // A share declared larger than the host's own amount is an inconsistent
    // declaration, not a negative cost. The host is emptied and the
    // inconsistency is stated; a cost that pays the owner would read as
    // revenue everywhere downstream.
    const exceeded = removal > entry.amount + AMOUNT_EPSILON;
    const applied = exceeded ? entry.amount : removal;
    const nextAmount = roundMoney(entry.amount - applied);
    return {
      ...entry,
      amount: nextAmount,
      hostShareRemoved: applied,
      state: Math.abs(nextAmount) < AMOUNT_EPSILON ? ("zero" as CostAmountState) : entry.state,
      reasons: [
        ...entry.reasons,
        "embedded_share_removed",
        ...(exceeded ? [`embedded_share_exceeded_host:${roundMoney(removal)}`] : []),
      ],
    };
  });

  return {
    orderId: order.orderId,
    structureVersion: structure.version,
    reportingCurrency: request.reportingCurrency,
    dates: {
      order: order.occurredDate,
      fulfilled: order.fulfilledDate ?? null,
      payout: order.payoutDate ?? null,
    },
    lines: lines.map((line) => ({
      lineId: line.lineId,
      quantity: line.quantity,
      netSales:
        typeof line.bases?.line_net_sales === "number" ? line.bases.line_net_sales : null,
    })),
    entries: adjusted,
    deferredPeriodComponentIds,
    reasons: resultReasons,
  };
}
