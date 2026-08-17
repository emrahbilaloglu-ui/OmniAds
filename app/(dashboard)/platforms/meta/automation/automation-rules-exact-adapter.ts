/**
 * PURE adapter: served rules → the exact Rules table's view model.
 *
 * No fetch, no clock, no state. Given the same payload this returns the same
 * rows, which is what lets the surface be tested by rendering it.
 *
 * Columns, in the design's order: Rule / Then / Mode / Fired · 28d / Active.
 */

import {
  describeAction,
  describeTrigger,
  type AutomationRuleAnchorValues,
  type AutomationRuleMode,
} from "@/lib/meta/automation-rules";
import type { MetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";

export const AUTOMATION_RULES_UNKNOWN = "—";

export interface AutomationRuleRowViewModel {
  id: string;
  name: string;
  /** The deterministic trigger, rendered with the live Commercial Truth value. */
  trigger: string;
  then: string;
  mode: string;
  modeTone: "enforced" | "confirm" | "suggest";
  fired: string;
  active: boolean;
  locked: boolean;
  toggleTitle: string;
}

export interface AutomationRulesViewModel {
  /** `null` means the rules read was never proven; the table stays em-dashed. */
  rows: AutomationRuleRowViewModel[] | null;
  /** True only when a proven-complete read returned no rules — an honest empty. */
  isProvenEmpty: boolean;
  canCreate: boolean;
}

const MODE_LABELS: Record<AutomationRuleMode, string> = {
  confirm: "Confirm",
  suggest: "Suggest",
  enforced: "Enforced",
};

function formatLastFired(lastFiredAt: string | null) {
  if (!lastFiredAt) return null;
  const time = Date.parse(lastFiredAt);
  if (!Number.isFinite(time)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).formatToParts(new Date(time));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const month = part("month");
  const day = part("day");
  return month && day ? `${month} ${day}` : null;
}

/**
 * "Fired · 28d" is a real count over recorded firings. Zero is a fact, not an
 * absence, so it renders as `0×` rather than an em dash — but only because the
 * caller already proved the read was complete.
 */
export function formatFiredCount(input: {
  firedCount: number;
  lastFiredAt: string | null;
}) {
  const count = Number.isFinite(input.firedCount)
    ? Math.max(0, Math.trunc(input.firedCount))
    : 0;
  if (count === 0) return "0×";
  const last = formatLastFired(input.lastFiredAt);
  return last ? `${count}× · ${last}` : `${count}×`;
}

export function buildAutomationRulesViewModel(input: {
  payload: Pick<
    MetaAutomationControlPlane,
    "rules" | "commercialAnchors" | "readCompleteness"
  > | null;
  canCreate: boolean;
}): AutomationRulesViewModel {
  const payload = input.payload;
  const proven = payload?.readCompleteness?.rules === "complete";
  if (!payload || !proven) {
    return { rows: null, isProvenEmpty: false, canCreate: input.canCreate };
  }

  const anchors: AutomationRuleAnchorValues = payload.commercialAnchors ?? {
    target_roas: null,
    break_even_roas: null,
    target_cpa: null,
    break_even_cpa: null,
  };
  const rules = payload.rules ?? [];

  return {
    rows: rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      trigger: describeTrigger(rule.trigger, anchors),
      then: describeAction(rule.action),
      mode: MODE_LABELS[rule.mode],
      modeTone: rule.mode,
      fired: formatFiredCount({
        firedCount: rule.firedCount,
        lastFiredAt: rule.lastFiredAt,
      }),
      active: rule.active,
      locked: rule.locked,
      toggleTitle: rule.locked
        ? "Enforced — cannot be disabled"
        : "Toggle rule",
    })),
    isProvenEmpty: rules.length === 0,
    canCreate: input.canCreate,
  };
}
