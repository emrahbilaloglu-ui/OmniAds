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

export const SETTINGS_DASH = "—";

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
    planName: string | null;
    monthlyPrice: number | null;
    upgradeAvailable: boolean;
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

  return {
    eyebrow: "Workspace · Preferences",
    title: "Settings",
    fullName: input.account.name ?? "",
    email: input.account.email ?? "",
    language: input.language,
    // Derived from Shopify first, then GA4 — never operator-chosen, so the
    // control shows the derived value and offers no alternative.
    timezone: timezone ? `${timezone}${timezoneSource ? ` · from ${timezoneSource}` : ""}` : SETTINGS_DASH,
    timezoneOptions: [
      timezone ? `${timezone}${timezoneSource ? ` · from ${timezoneSource}` : ""}` : SETTINGS_DASH,
    ],
    plan: {
      title: planTitle,
      detail: input.billing.unavailable
        ? "Plan and billing could not be read, so this workspace's entitlements are not stated here."
        : "Unlocks Commercial Truth. Reports & Insights need Pro; Team seats need Scale.",
      action: input.billing.upgradeAvailable ? "Upgrade to Pro" : null,
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
