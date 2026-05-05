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

export function isMetaDecisionOsV1Enabled() {
  return envBoolean("META_DECISION_OS_V1", true);
}

export function getMetaDecisionOsCanaryBusinesses() {
  return parseEnvList("META_DECISION_OS_CANARY_BUSINESSES");
}

export function isMetaDecisionOsV1EnabledForBusiness(
  businessId: string | null | undefined,
) {
  if (!isMetaDecisionOsV1Enabled()) return false;
  const canaryBusinesses = getMetaDecisionOsCanaryBusinesses();
  if (canaryBusinesses.length === 0) return true;
  if (!businessId) return false;
  return canaryBusinesses.includes(businessId);
}
