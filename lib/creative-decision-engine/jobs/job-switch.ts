export function engineV3JobsDisabled() {
  const normalized = process.env.DECISION_ENGINE_V3_JOBS_DISABLED?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "enabled";
}
