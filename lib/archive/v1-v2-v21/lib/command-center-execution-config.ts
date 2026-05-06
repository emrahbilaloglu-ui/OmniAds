function envBoolean(name: string, fallback = false) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function parseEnvList(name: string) {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isCommandCenterExecutionV1Enabled() {
  return envBoolean("COMMAND_CENTER_EXECUTION_V1", true);
}

export function isMetaExecutionApplyEnabled() {
  return envBoolean("META_EXECUTION_APPLY_ENABLED", false);
}

export function isMetaExecutionKillSwitchActive() {
  return envBoolean("META_EXECUTION_KILL_SWITCH", false);
}

export function getMetaExecutionCanaryBusinesses() {
  return parseEnvList("META_EXECUTION_CANARY_BUSINESSES");
}

export function isMetaExecutionCanaryBusiness(
  businessId: string | null | undefined,
) {
  if (!businessId) return false;
  const canaries = getMetaExecutionCanaryBusinesses();
  if (canaries.length === 0) return false;
  return canaries.includes(businessId);
}

export function canApplyMetaExecutionForBusiness(
  businessId: string | null | undefined,
) {
  return (
    isMetaExecutionApplyEnabled() &&
    !isMetaExecutionKillSwitchActive() &&
    isMetaExecutionCanaryBusiness(businessId)
  );
}

export function getMetaExecutionApplyBoundaryState(
  businessId: string | null | undefined,
) {
  const executionPreviewEnabled = isCommandCenterExecutionV1Enabled();
  const applyEnabled = isMetaExecutionApplyEnabled();
  const killSwitchActive = isMetaExecutionKillSwitchActive();
  const canaryBusinesses = getMetaExecutionCanaryBusinesses();
  const businessAllowlisted = isMetaExecutionCanaryBusiness(businessId);
  const blockedReasons: string[] = [];

  if (!executionPreviewEnabled) {
    blockedReasons.push("Execution preview is disabled.");
  }
  if (!applyEnabled) {
    blockedReasons.push("Meta execution apply is disabled.");
  }
  if (killSwitchActive) {
    blockedReasons.push("Meta execution kill switch is active.");
  }
  if (canaryBusinesses.length === 0) {
    blockedReasons.push("No Meta execution canary allowlist is configured.");
  } else if (!businessAllowlisted) {
    blockedReasons.push("Business is not in the Meta execution canary allowlist.");
  }

  return {
    executionPreviewEnabled,
    applyEnabled,
    killSwitchActive,
    canaryScoped: canaryBusinesses.length > 0,
    businessAllowlisted,
    eligible:
      executionPreviewEnabled &&
      applyEnabled &&
      !killSwitchActive &&
      businessAllowlisted,
    blockedReasons,
  };
}
