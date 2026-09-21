import type {
  CommerceCostComponent,
  CommerceCostStructure,
  CostEmbeddedShare,
  CostLedgerEvent,
  CostRefundLine,
  CostResolutionEntry,
  CostResolutionResult,
} from "@/src/types/commerce-cost";
import { allocateMoney, convertMoney, roundMoney } from "./money";
import { PRODUCT_COST_FAMILIES, costFamilyMeta } from "./taxonomy";
import { DAY_MS, parseAsOfInstant, parseInstant, periodFractionForRange, startOfUtcDay } from "./time";

/**
 * The cost ledger.
 *
 * A sale books what the resolver decided at the moment of the sale. A refund
 * books a reversal computed from that stored decision — including the embedded
 * share as it was then — so editing a cost tomorrow cannot rewrite what a past
 * day earned.
 *
 * Event id segments are escaped, so an id that carries a provider string
 * containing the delimiter cannot collide with another event, and re-deriving
 * a window stays an idempotent upsert.
 */

/** Reasons that mean "we could not tell", as opposed to "nothing comes back". */
const UNRESOLVED_REFUND_REASONS = [
  "restock_type_unknown",
  "embedded_product_share_unknown",
  "embedded_product_share_inconsistent",
  "original_quantity_unknown",
  "refund_quantity_invalid",
] as const;

/** Ids carry operator and provider strings, which may contain the delimiter. */
function idSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function recognitionDate(entry: CostResolutionEntry, resolution: CostResolutionResult): {
  date: string;
  reasons: string[];
} {
  if (entry.recognition === "on_fulfillment") {
    return resolution.dates.fulfilled
      ? { date: resolution.dates.fulfilled, reasons: [] }
      : { date: resolution.dates.order, reasons: ["fulfillment_date_missing"] };
  }
  if (entry.recognition === "on_payout") {
    return resolution.dates.payout
      ? { date: resolution.dates.payout, reasons: [] }
      : { date: resolution.dates.order, reasons: ["payout_date_missing"] };
  }
  return { date: resolution.dates.order, reasons: [] };
}

/** One event per resolved line and family, including the stateful non-values. */
export function buildSaleLedger(resolution: CostResolutionResult): CostLedgerEvent[] {
  return resolution.entries.map((entry) => {
    const { date, reasons } = recognitionDate(entry, resolution);
    return {
      eventId: [
        "sale",
        idSegment(resolution.orderId),
        idSegment(entry.lineId),
        idSegment(entry.family),
        idSegment(entry.slot),
      ].join(":"),
      kind: "sale",
      occurredDate: date,
      orderId: resolution.orderId,
      lineId: entry.lineId,
      family: entry.family,
      slot: entry.slot,
      layer: entry.layer,
      quantity: entry.quantity,
      amount: entry.amount,
      state: entry.state,
      estimated: entry.estimated,
      decisionClass: entry.decisionClass,
      taxTreatment: entry.taxTreatment,
      hostFamily: entry.shadowedBy?.family ?? null,
      unavailableReason: entry.unavailableReason ?? null,
      evidence: entry.evidence ?? null,
      ownerComponentId: entry.ownerComponentId ?? null,
      ownerComponentVersion: entry.ownerComponentVersion ?? null,
      structureVersion: resolution.structureVersion,
      reasons: [...entry.reasons, ...reasons],
    } satisfies CostLedgerEvent;
  });
}

interface ProductShare {
  amount: number | null;
  reason: string | null;
}

/**
 * The product part of a loaded host, when it is fully stated.
 *
 * "Fully" matters: a host that declares two embedded families and quantifies
 * only one of them has not said what the product part is, and reading the
 * unstated half as zero would hand back money the return never recovered.
 */
function productShareOf(
  entry: CostResolutionEntry,
  component: CommerceCostComponent | undefined,
  quantity: number,
): ProductShare {
  if (entry.amount === null) return { amount: null, reason: "embedded_product_share_unknown" };
  const shares = component?.embeddedShares ?? [];
  const embeds = component?.embeds ?? [];
  if (!component || shares.length === 0) {
    return { amount: null, reason: "embedded_product_share_unknown" };
  }

  // A direct replacement removes its stated embedded share from the host
  // before the sale resolution is stored. Refund allocation, however, needs
  // the original loaded host amount; subtracting a percentage from the already
  // reduced amount would remove the same share twice.
  const originalHostAmount = entry.amount + (entry.hostShareRemoved ?? 0);
  const sizeOf = (share: CostEmbeddedShare) =>
    share.kind === "amount_per_unit"
      ? share.value * quantity
      : (originalHostAmount * share.value) / 100;
  const stated = new Set(shares.map((share) => share.family));
  const hostFamilyIsProduct = PRODUCT_COST_FAMILIES.includes(entry.family);

  // Every embedded family that bears on the split has to be quantified.
  const needed = embeds.filter((family) =>
    hostFamilyIsProduct
      ? !PRODUCT_COST_FAMILIES.includes(family)
      : PRODUCT_COST_FAMILIES.includes(family),
  );
  if (needed.some((family) => !stated.has(family))) {
    return { amount: null, reason: "embedded_product_share_unknown" };
  }

  const share = hostFamilyIsProduct
    ? originalHostAmount -
      shares
        .filter((candidate) => !PRODUCT_COST_FAMILIES.includes(candidate.family))
        .reduce((sum, candidate) => sum + sizeOf(candidate), 0)
    : shares
        .filter((candidate) => PRODUCT_COST_FAMILIES.includes(candidate.family))
        .reduce((sum, candidate) => sum + sizeOf(candidate), 0);

  // A share outside the host's own amount is a contradiction, not a number.
  if (!Number.isFinite(share) || share < 0 || share > Math.abs(originalHostAmount) + 0.005) {
    return { amount: null, reason: "embedded_product_share_inconsistent" };
  }
  return { amount: roundMoney(share), reason: null };
}

export interface RefundLedgerRequest {
  /** The stored sale decision for the order being refunded. */
  saleResolution: CostResolutionResult;
  refundLines: readonly CostRefundLine[];
  /**
   * Needed to read the embedded shares that were true at sale time. Versions
   * are matched, so a newer record cannot restate an older reversal.
   */
  structure?: CommerceCostStructure;
  /**
   * Quantities already reversed per line by earlier refunds, so a sequence of
   * partial refunds cannot give back more than was sold. Without it only the
   * refunds in this call are accounted for.
   */
  priorRefundedQuantityByLine?: Readonly<Record<string, number>>;
}

/**
 * Reversals for refunded quantities.
 *
 * What comes back depends on the family, not on the refund: a returned unit
 * restores its product cost, while the parcel that carried it and the fee that
 * processed it are already spent. Where the answer is not knowable — an
 * unknown restock type, an unstated or contradictory product share — nothing
 * is reversed and the gap is stated, because understating the recovery is the
 * safe direction for a spending decision.
 */
export function buildRefundLedger(request: RefundLedgerRequest): CostLedgerEvent[] {
  const { saleResolution, refundLines, structure } = request;
  const byLine = new Map<string, CostResolutionEntry[]>();
  for (const entry of saleResolution.entries) {
    byLine.set(entry.lineId, [...(byLine.get(entry.lineId) ?? []), entry]);
  }
  // Versioned lookup: the share that was true at sale time, not today's.
  const componentByVersion = new Map<string, CommerceCostComponent>();
  for (const component of structure?.components ?? []) {
    componentByVersion.set(`${component.id}::${component.version}`, component);
  }

  const events: CostLedgerEvent[] = [];
  const seenRefundLines = new Set<string>();
  const reversedByLine = new Map<string, number>(
    Object.entries(request.priorRefundedQuantityByLine ?? {}),
  );

  for (const refund of refundLines) {
    const entries = byLine.get(refund.lineId) ?? [];
    if (entries.length === 0) continue;
    // A repeated refund line is the same refund, not a second one.
    if (seenRefundLines.has(refund.refundLineId)) continue;
    seenRefundLines.add(refund.refundLineId);

    const originalQuantity =
      saleResolution.lines.find((line) => line.lineId === refund.lineId)?.quantity ?? 0;
    const alreadyReversed = reversedByLine.get(refund.lineId) ?? 0;
    const quantityValid = Number.isFinite(refund.quantity) && refund.quantity > 0;
    const remaining = Math.max(0, originalQuantity - alreadyReversed);
    // Never give back more than was sold, however the refunds arrive.
    const effectiveQuantity = quantityValid ? Math.min(refund.quantity, remaining) : 0;
    const capped = quantityValid && effectiveQuantity < refund.quantity;
    reversedByLine.set(refund.lineId, alreadyReversed + effectiveQuantity);

    for (const entry of entries) {
      if (entry.state !== "value" && entry.state !== "zero") continue;
      if (entry.amount === null) continue;

      const reasons: string[] = [];
      if (!quantityValid) reasons.push("refund_quantity_invalid");
      if (originalQuantity <= 0) reasons.push("original_quantity_unknown");
      if (capped) reasons.push("refund_quantity_capped_at_sold");
      const fraction = originalQuantity > 0 ? effectiveQuantity / originalQuantity : 0;
      const restockKnown = refund.restockType !== "unknown";

      let reversible: number | null = null;
      switch (entry.refundBehaviour) {
        case "reverse_on_restock":
          if (!restockKnown) reasons.push("restock_type_unknown");
          else if (refund.restockType === "return" || refund.restockType === "cancel") {
            reversible = entry.amount;
          } else reasons.push("not_restocked");
          break;
        case "reverse_on_cancel_only":
          // A cancel would have recovered this, so not knowing whether it was
          // a cancel is a gap rather than a zero.
          if (!restockKnown) reasons.push("restock_type_unknown");
          else if (refund.restockType === "cancel") reversible = entry.amount;
          else reasons.push("only_reversed_before_fulfillment");
          break;
        case "product_share_only": {
          const share = productShareOf(
            entry,
            componentByVersion.get(
              `${entry.ownerComponentId ?? ""}::${entry.ownerComponentVersion ?? ""}`,
            ),
            entry.quantity,
          );
          if (share.reason) reasons.push(share.reason);
          else if (!restockKnown) reasons.push("restock_type_unknown");
          else if (refund.restockType === "return" || refund.restockType === "cancel") {
            reversible = share.amount;
          } else reasons.push("not_restocked");
          break;
        }
        case "non_recoverable":
          reasons.push("non_recoverable_family");
          break;
      }

      const unresolved = UNRESOLVED_REFUND_REASONS.some((reason) => reasons.includes(reason));
      // A family that gives nothing back reverses a real zero, so a window of
      // nothing but non-recoverable refunds can still state its contribution.
      // Not knowing carries no number at all.
      const amount = unresolved ? null : roundMoney(-(reversible ?? 0) * fraction);

      events.push({
        eventId: [
          "refund",
          idSegment(saleResolution.orderId),
          idSegment(entry.lineId),
          idSegment(refund.refundLineId),
          idSegment(entry.family),
          idSegment(entry.slot),
        ].join(":"),
        kind: "refund_reversal",
        occurredDate: refund.refundedDate,
        orderId: saleResolution.orderId,
        lineId: entry.lineId,
        refundLineId: refund.refundLineId,
        family: entry.family,
        slot: entry.slot,
        layer: entry.layer,
        quantity: -effectiveQuantity,
        amount,
        state: unresolved
          ? "unknown"
          : amount !== null && Math.abs(amount) >= 0.005
            ? "value"
            : "zero",
        estimated: entry.estimated,
        decisionClass: entry.decisionClass,
        taxTreatment: entry.taxTreatment,
        hostFamily: entry.shadowedBy?.family ?? null,
        evidence: entry.evidence ?? null,
        ownerComponentId: entry.ownerComponentId ?? null,
        ownerComponentVersion: entry.ownerComponentVersion ?? null,
        structureVersion: saleResolution.structureVersion,
        reasons,
      });
    }
  }

  return events;
}

export interface PeriodLedgerRequest {
  structure: CommerceCostStructure;
  /** Inclusive `YYYY-MM-DD` days, read as UTC. The dates are the window. */
  window: { startDate: string; endDate: string; days: number };
  reportingCurrency: string;
  fxRates?: Readonly<Record<string, number>>;
  /** Rebuild the ledger from only the component records known at this instant. */
  asOfRecordedAt?: string | null;
}

/**
 * Effective intervals are half-open: a component whose `effectiveTo` is the
 * first instant of Sep 16 owns Sep 1-15, not Sep 16. Exact instants are kept,
 * so a mid-day change contributes half a day rather than a whole hidden day.
 */
function effectiveOverlap(
  component: CommerceCostComponent,
  window: PeriodLedgerRequest["window"],
): { startMs: number; endMs: number; days: number } | null {
  const windowStart = startOfUtcDay(window.startDate);
  const windowEndStart = startOfUtcDay(window.endDate);
  const componentStart = parseInstant(component.effectiveFrom);
  const componentEnd = component.effectiveTo ? parseInstant(component.effectiveTo) : null;
  // An unreadable window or start date is no reason to charge anything.
  if (windowStart === null || windowEndStart === null || componentStart === null) return null;
  if (component.effectiveTo && componentEnd === null) return null;

  const windowEndExclusive = windowEndStart + DAY_MS;
  const overlapStart = Math.max(windowStart, componentStart);
  const overlapEnd = Math.min(windowEndExclusive, componentEnd ?? Number.POSITIVE_INFINITY);
  if (overlapEnd <= overlapStart) return null;
  return { startMs: overlapStart, endMs: overlapEnd, days: (overlapEnd - overlapStart) / DAY_MS };
}

/** Days the window's own dates span, end date inclusive. */
function windowSpanDays(window: PeriodLedgerRequest["window"]): number | null {
  const start = startOfUtcDay(window.startDate);
  const endStart = startOfUtcDay(window.endDate);
  if (start === null || endStart === null) return null;
  return Math.max(0, (endStart + DAY_MS - start) / DAY_MS);
}

function recordedVersionVisible(component: CommerceCostComponent, asOf: number | null): boolean {
  const recordedAt = parseInstant(component.recordedAt);
  // A record we cannot place in time cannot be replayed, so it is not used.
  if (recordedAt === null) return false;
  if (asOf !== null && recordedAt > asOf) return false;
  if (component.supersededAt) {
    const supersededAt = parseInstant(component.supersededAt);
    if (supersededAt === null) return false;
    if (asOf === null || supersededAt <= asOf) return false;
  }
  return true;
}

/**
 * Recurring costs prorated into the window.
 *
 * These never touch a line, and therefore never reach a marginal decision.
 * They exist so operating profit can be stated at all.
 *
 * Calendar-aware: a window covering a whole calendar month charges exactly the
 * monthly amount the operator typed, so the fixed rung reconciles against the
 * invoice instead of drifting with the length of the month.
 */
export function buildPeriodLedger(request: PeriodLedgerRequest): CostLedgerEvent[] {
  const { structure, window, reportingCurrency, fxRates } = request;
  const asOf = parseAsOfInstant(request.asOfRecordedAt);
  const events: CostLedgerEvent[] = [];
  const spanDays = windowSpanDays(window);

  // One recurring cost per component id: the latest visible version. Charging
  // two versions of the same rent to one window would double the overhead.
  const latestById = new Map<string, CommerceCostComponent>();
  for (const component of structure.components) {
    if (component.status !== "active") continue;
    if (component.basis.kind !== "period_amount") continue;
    // Paid marketing comes from the ad platforms; a retainer miscategorised
    // there would be subtracted on top of the platform spend.
    if (!costFamilyMeta(component.family).componentAllowed) continue;
    if (!recordedVersionVisible(component, asOf)) continue;
    const existing = latestById.get(component.id);
    if (!existing || existing.version < component.version) latestById.set(component.id, component);
  }

  for (const component of latestById.values()) {
    if (component.basis.kind !== "period_amount") continue;
    const overlap = effectiveOverlap(component, window);
    if (!overlap) continue;
    const meta = costFamilyMeta(component.family);
    const fraction = periodFractionForRange(component.basis.period, overlap.startMs, overlap.endMs);
    const amountFinite = Number.isFinite(component.basis.amount);
    const prorated =
      fraction === null || !amountFinite ? null : roundMoney(component.basis.amount * fraction);
    const converted =
      prorated === null
        ? null
        : convertMoney(
            prorated,
            component.currency,
            reportingCurrency,
            fxRates,
            component.fx?.policy === "fixed_rate" ? component.fx.fixedRate ?? null : null,
          );

    events.push({
      eventId: [
        "period",
        idSegment(component.id),
        idSegment(component.version),
        idSegment(window.startDate),
        idSegment(window.endDate),
      ].join(":"),
      kind: "period_allocation",
      occurredDate: window.endDate,
      family: component.family,
      slot: component.slot,
      layer: meta.layer,
      quantity: 0,
      amount: converted,
      state: converted === null ? "unavailable" : converted === 0 ? "zero" : "value",
      estimated:
        component.evidence === "operator_estimate" || component.evidence === "template_default",
      decisionClass: component.decisionClass ?? meta.decisionClass,
      taxTreatment: component.taxTreatment,
      unavailableReason: converted === null && amountFinite ? "currency_blocked" : null,
      evidence: component.evidence,
      ownerComponentId: component.id,
      ownerComponentVersion: component.version,
      structureVersion: structure.version,
      reasons: [
        `prorated_${component.basis.period}`,
        ...(spanDays !== null && Math.abs(overlap.days - spanDays) >= 0.000_001
          ? [`effective_overlap_days:${roundMoney(overlap.days)}`]
          : []),
        // The dates are the window; a `days` that disagrees with them is a
        // caller bug worth stating rather than silently honouring.
        ...(spanDays !== null && Math.abs(spanDays - window.days) >= 0.000_001
          ? [`window_days_mismatch:${roundMoney(spanDays)}`]
          : []),
        ...(!amountFinite ? ["period_amount_not_finite"] : []),
        ...(amountFinite && converted === null
          ? [`currency_unconvertible:${component.currency}`]
          : []),
      ],
    });
  }

  return events;
}

/**
 * Spreads one window-level amount over lines for reporting only.
 *
 * Exposed because allocation must be visible and reproducible, never a hidden
 * step inside a chart.
 */
export function allocateWindowAmount(amount: number, weights: readonly number[]): number[] {
  return allocateMoney(amount, weights);
}
