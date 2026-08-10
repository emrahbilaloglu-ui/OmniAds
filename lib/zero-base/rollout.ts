/**
 * Server-owned rollout configuration.
 *
 * These flags decide what is *presented*, never what is *permitted*. No value
 * here grants access to an API, a business, a provider write, or a role — that
 * authority lives in `lib/access/authorize-business.ts` and is not readable
 * from configuration. A surface hidden by rollout must still be refused by the
 * authorizer if it is called directly.
 *
 * Nothing here is exposed through `NEXT_PUBLIC_*`: a client-readable value is
 * not a security boundary, and treating one as such is how a "disabled"
 * feature becomes reachable.
 */

export type ZeroBaseUiMode = "off" | "internal" | "allowlist" | "on";

const UI_MODES: readonly ZeroBaseUiMode[] = ["off", "internal", "allowlist", "on"];

export interface ZeroBaseRolloutConfig {
  uiMode: ZeroBaseUiMode;
  /** Businesses enabled when `uiMode` is `allowlist`. */
  allowlistedBusinessIds: readonly string[];
  mutationUiEnabled: boolean;
  /** Selects stricter server behavior for report sharing. Grants nothing. */
  reportShareFailClosed: boolean;
}

/** Unset, misspelled or unknown values fall back to fully off. */
function parseUiMode(raw: string | undefined): ZeroBaseUiMode {
  const value = raw?.trim().toLowerCase();
  return UI_MODES.find((mode) => mode === value) ?? "off";
}

/** Only an exact `true` enables; anything else stays off. */
function parseBooleanFlag(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === "true";
}

function parseBusinessIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
}

export function readZeroBaseRolloutConfig(
  env: NodeJS.ProcessEnv = process.env,
): ZeroBaseRolloutConfig {
  return {
    uiMode: parseUiMode(env.ZERO_BASE_UI_MODE),
    allowlistedBusinessIds: parseBusinessIds(env.ZERO_BASE_UI_BUSINESS_IDS),
    mutationUiEnabled: parseBooleanFlag(env.ZERO_BASE_MUTATION_UI_ENABLED),
    reportShareFailClosed: parseBooleanFlag(env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED),
  };
}

/**
 * Presentation only. A `true` here means "draw the canonical UI", never
 * "this actor may see this business" — that has already been decided.
 */
export function isZeroBaseUiEnabledForBusiness(
  config: ZeroBaseRolloutConfig,
  businessId: string | null | undefined,
): boolean {
  switch (config.uiMode) {
    case "off":
      return false;
    case "on":
      return true;
    case "internal":
      // Internal staff surfaces opt in explicitly; no business is implied.
      return false;
    case "allowlist":
      return Boolean(businessId) && config.allowlistedBusinessIds.includes(businessId!);
  }
}

/** Internal-only mode is for signed-in staff previewing outside a client. */
export function isZeroBaseUiEnabledForInternal(config: ZeroBaseRolloutConfig): boolean {
  return config.uiMode === "internal" || config.uiMode === "on";
}

export function isMutationUiEnabled(config: ZeroBaseRolloutConfig): boolean {
  return config.mutationUiEnabled;
}
