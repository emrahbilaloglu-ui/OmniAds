/**
 * What the plan actually gates.
 *
 * Plan & Billing told every operator: *"Your plan is shown for reference. No
 * route or control in this product is gated by it."* That was false on a
 * mounted surface. On a Starter business, three of the five Creative Studio
 * tabs answer "Growth plan required" and refuse to render, and Reports and
 * Insights do the same at Pro — proven at runtime against the real routes, not
 * inferred from the source.
 *
 * A page that denies the gate is worse than one that has none: an operator who
 * cannot open Copies goes looking for a bug, or for a permission, or for a
 * connection they have not made — anywhere except the plan, because the product
 * told them the plan is only decoration.
 *
 * The list is here, once, and `plan-gated-modules.test.ts` holds it against
 * every `PlanGate` in the tree and every `requiredPlan` in the rail. Adding a
 * gate without adding it here fails; removing one and leaving the claim fails
 * too. This file is the reason the sentence on Plan & Billing can be trusted.
 */
import type { PlanId } from "@/lib/pricing/plans";

export interface PlanGatedModule {
  /** What the operator calls it. */
  readonly label: string;
  /** Plan required to open it. */
  readonly requiredPlan: PlanId;
  /** Where the gate is enforced, so a reader can check it. */
  readonly enforcedIn: string;
}

export const PLAN_GATED_MODULES: readonly PlanGatedModule[] = [
  {
    label: "Creative Studio — Assets",
    requiredPlan: "growth",
    enforcedIn: "app/(dashboard)/platforms/meta/creatives/legacy-page.tsx",
  },
  {
    label: "Creative Studio — Copies",
    requiredPlan: "growth",
    enforcedIn: "app/(dashboard)/platforms/meta/copies/legacy-page.tsx",
  },
  {
    label: "Creative Studio — Landing Pages",
    requiredPlan: "growth",
    enforcedIn: "app/(dashboard)/platforms/meta/landing-pages/legacy-page.tsx",
  },
  {
    label: "Commercial Truth",
    requiredPlan: "growth",
    enforcedIn: "components/layout/nav-items.ts",
  },
  {
    label: "Reports",
    requiredPlan: "pro",
    enforcedIn: "components/reports/reports-exact-container.tsx",
  },
  {
    label: "Insights",
    requiredPlan: "pro",
    enforcedIn: "app/(dashboard)/insights/layout.tsx",
  },
  {
    label: "Team",
    requiredPlan: "scale",
    enforcedIn: "components/layout/nav-items.ts",
  },
] as const;

/** Plans named on Plan & Billing, in the order the gates escalate. */
export function planGateSummary(): { plan: PlanId; modules: string[] }[] {
  const order: PlanId[] = ["growth", "pro", "scale"];
  return order
    .map((plan) => ({
      plan,
      modules: PLAN_GATED_MODULES.filter((module) => module.requiredPlan === plan).map(
        (module) => module.label,
      ),
    }))
    .filter((row) => row.modules.length > 0);
}

/**
 * The sentence Plan & Billing shows.
 *
 * Built from the list rather than written beside it, so the page cannot say
 * something the gates contradict.
 */
export function planGatingDisclosure(): string {
  const summary = planGateSummary();
  if (summary.length === 0) {
    return "No route or control in this product is gated by your plan.";
  }
  const clauses = summary.map(
    (row) =>
      `${row.plan[0]!.toUpperCase()}${row.plan.slice(1)} unlocks ${listOf(row.modules)}`,
  );
  return `Some modules are plan-gated: ${clauses.join("; ")}. Everything else is open on every plan.`;
}

function listOf(values: readonly string[]): string {
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]!}`;
}
