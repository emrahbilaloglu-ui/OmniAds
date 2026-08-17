/**
 * Pure mapping to the Dashboard v2 "Settings" view model.
 *
 * Design reference: markup lines 2988-3019, model 4407-4411.
 *
 * The design defines exactly one field card (Full name, Email, Interface
 * language, Workspace timezone), one navy plan band with a single upgrade
 * button, and exactly three action rows: Change password, Active sessions,
 * Resync warehouse. Nothing else belongs to this screen.
 */

import { PLAN_LABELS, PLAN_ORDER, type PlanId } from "@/lib/pricing/plans";

export const SETTINGS_DASH = "—";

/**
 * The three capabilities the design's plan sentence names, each resolved to the
 * plan this app actually requires for it.
 *
 * These are the app's real gates, not the prototype's:
 *  - Commercial Truth is mounted behind no `PlanGate` at all, so every plan
 *    already carries it;
 *  - `app/(dashboard)/reports/legacy-page.tsx` and
 *    `app/(dashboard)/insights/layout.tsx` both wrap their bodies in
 *    `<PlanGate requiredPlan="pro">`;
 *  - `app/(dashboard)/team/legacy-page.tsx` gates adding a seat on `SEAT_PLAN`
 *    = `"scale"`.
 *
 * The design prints one fixed sentence for every plan, which is only true of
 * the workspace it was drawn for. The same three facts are rendered here
 * against the plan the workspace is actually on.
 */
const PLAN_CAPABILITIES: Array<{ label: string; requires: PlanId }> = [
  { label: "Commercial Truth", requires: "starter" },
  { label: "Reports & Insights", requires: "pro" },
  { label: "Team seats", requires: "scale" },
];

function rank(plan: PlanId): number {
  return PLAN_ORDER.indexOf(plan);
}

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The design's cadence: what this plan includes, then what still needs more. */
export function buildPlanDetail(plan: PlanId): string {
  const included = PLAN_CAPABILITIES.filter((capability) => rank(plan) >= rank(capability.requires));
  const blocked = PLAN_CAPABILITIES.filter((capability) => rank(plan) < rank(capability.requires));

  const clauses: string[] = [];
  if (included.length > 0) {
    clauses.push(`Includes ${listPhrase(included.map((capability) => capability.label))}.`);
  }
  for (const required of PLAN_ORDER) {
    const waiting = blocked.filter((capability) => capability.requires === required);
    if (waiting.length === 0) continue;
    clauses.push(
      `${listPhrase(waiting.map((capability) => capability.label))} need ${PLAN_LABELS[required]}`,
    );
  }
  // The first clause ends in its own period; the "need X" clauses are joined
  // with the design's semicolon and closed once.
  const [first, ...rest] = clauses;
  if (rest.length === 0) return first ?? "";
  return `${first} ${rest.join("; ")}.`;
}

/** The next plan up, or null when the workspace is already on the top plan. */
export function nextPlanAbove(plan: PlanId): PlanId | null {
  const index = PLAN_ORDER.indexOf(plan);
  if (index < 0 || index >= PLAN_ORDER.length - 1) return null;
  return PLAN_ORDER[index + 1];
}

export type SettingsRowId = "password" | "sessions" | "resync";

export interface SettingsRowModel {
  id: SettingsRowId;
  title: string;
  detail: string;
  button: string;
  buttonForeground: string;
  buttonBorder: string;
}

export interface SettingsPlanModel {
  title: string;
  detail: string;
  /** Null hides the button; the design draws exactly one when a plan exists. */
  action: string | null;
}

export interface SettingsExactModel {
  eyebrow: string;
  title: string;
  fullName: string;
  email: string;
  language: "en" | "tr";
  timezone: string;
  timezoneOptions: string[];
  plan: SettingsPlanModel;
  rows: SettingsRowModel[];
}

export interface SettingsAdapterInput {
  account: { name: string | null; email: string | null };
  language: "en" | "tr";
  workspace: { timezone: string | null; timezoneSource: "shopify" | "ga4" | null };
  billing: {
    /** The plan `/api/billing` resolved; null when it named none. */
    planId: PlanId | null;
    planName: string | null;
    monthlyPrice: number | null;
    /** True when `/api/billing` served a managed-pricing URL to send them to. */
    managedPricingAvailable: boolean;
    /** True when the plan read failed, so its copy may not be stated as fact. */
    unavailable: boolean;
  };
}

export function buildSettingsExactModel(input: SettingsAdapterInput): SettingsExactModel {
  const timezone = input.workspace.timezone?.trim();
  const timezoneSource = input.workspace.timezoneSource;

  const planTitle = input.billing.unavailable
    ? `Plan ${SETTINGS_DASH}`
    : input.billing.planName
      ? `${input.billing.planName} plan${
          typeof input.billing.monthlyPrice === "number"
            ? ` · $${input.billing.monthlyPrice}/mo`
            : ""
        }`
      : `No plan connected`;

  const plan = input.billing.unavailable ? null : input.billing.planId;
  const upgradeTarget = plan ? nextPlanAbove(plan) : null;

  return {
    eyebrow: "Workspace · Preferences",
    title: "Settings",
    fullName: input.account.name ?? "",
    email: input.account.email ?? "",
    language: input.language,
    // Derived from Shopify first, then GA4 — never operator-chosen, so the
    // control shows the derived value and offers no alternative. The design
    // draws a live select here; this is a deliberate, recorded divergence
    // (defect TRUTH-TEAM-SETTINGS-47): no route on this backend writes
    // `businesses.timezone`, and a select whose choice is silently discarded
    // would be worse than a disabled control that states its source.
    timezone: timezone ? `${timezone}${timezoneSource ? ` · from ${timezoneSource}` : ""}` : SETTINGS_DASH,
    timezoneOptions: [
      timezone ? `${timezone}${timezoneSource ? ` · from ${timezoneSource}` : ""}` : SETTINGS_DASH,
    ],
    plan: {
      title: planTitle,
      detail: input.billing.unavailable
        ? "Plan and billing could not be read, so this workspace's entitlements are not stated here."
        : plan
          ? buildPlanDetail(plan)
          : "This workspace is on no identified plan, so its entitlements are not stated here.",
      // One button, as the design draws — but naming the plan above this one.
      // On the top plan there is nothing to upgrade to, so the same button
      // manages the existing subscription rather than selling it again.
      action: !input.billing.managedPricingAvailable
        ? null
        : upgradeTarget
          ? `Upgrade to ${PLAN_LABELS[upgradeTarget]}`
          : plan
            ? "Manage plan"
            : null,
    },
    rows: [
      {
        id: "password",
        title: "Change password",
        detail: "Sign-in password for this account.",
        button: "Update",
        buttonForeground: "#45526B",
        buttonBorder: "#E4E8F0",
      },
      {
        id: "sessions",
        title: "Active sessions",
        detail: "Signs you out of every device and browser session.",
        button: "Revoke others",
        buttonForeground: "#45526B",
        buttonBorder: "#E4E8F0",
      },
      {
        id: "resync",
        title: "Resync warehouse",
        detail: "Rebuild read models from provider data. Safe, may take minutes.",
        button: "Run resync",
        buttonForeground: "#B45309",
        buttonBorder: "#EBD6A4",
      },
    ],
  };
}
