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

export function isCreativeDecisionOsV1Enabled() {
  return envBoolean("CREATIVE_DECISION_OS_V1", true);
}

export function getCreativeDecisionOsCanaryBusinesses() {
  return parseEnvList("CREATIVE_DECISION_OS_CANARY_BUSINESSES");
}

export function isCreativeDecisionOsV1EnabledForBusiness(
  businessId: string | null | undefined,
) {
  if (!isCreativeDecisionOsV1Enabled()) return false;
  const canaryBusinesses = getCreativeDecisionOsCanaryBusinesses();
  if (canaryBusinesses.length === 0) return true;
  if (!businessId) return false;
  return canaryBusinesses.includes(businessId);
}

export function isCreativeDecisionCenterV21Enabled() {
  return envBoolean("CREATIVE_DECISION_CENTER_V21", false);
}

export function getCreativeDecisionCenterV21CanaryBusinesses() {
  return parseEnvList("CREATIVE_DECISION_CENTER_V21_CANARY_BUSINESSES");
}

export function isCreativeDecisionCenterV21EnabledForBusiness(
  businessId: string | null | undefined,
) {
  if (!isCreativeDecisionCenterV21Enabled()) return false;
  const canaryBusinesses = getCreativeDecisionCenterV21CanaryBusinesses();
  if (canaryBusinesses.length === 0) return true;
  if (!businessId) return false;
  return canaryBusinesses.includes(businessId);
}

export function isCreativeDecisionCenterV21LiveRowsEnabled() {
  return envBoolean("CREATIVE_DECISION_CENTER_V21_LIVE_ROWS", false);
}

export function isCreativeDecisionCenterV21LiveRowsEnabledForBusiness(
  businessId: string | null | undefined,
) {
  return (
    isCreativeDecisionCenterV21LiveRowsEnabled() &&
    isCreativeDecisionCenterV21EnabledForBusiness(businessId)
  );
}
