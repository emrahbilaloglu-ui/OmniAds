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

export function isCommandCenterV1Enabled() {
  return envBoolean("COMMAND_CENTER_V1", true);
}

export function getCommandCenterCanaryBusinesses() {
  return parseEnvList("COMMAND_CENTER_CANARY_BUSINESSES");
}

export function isCommandCenterV1EnabledForBusiness(
  businessId: string | null | undefined,
) {
  if (!isCommandCenterV1Enabled()) return false;
  const canaryBusinesses = getCommandCenterCanaryBusinesses();
  if (canaryBusinesses.length === 0) return true;
  if (!businessId) return false;
  return canaryBusinesses.includes(businessId);
}
