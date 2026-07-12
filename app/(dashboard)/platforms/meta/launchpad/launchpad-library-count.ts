export function launchpadLibraryCount(input: {
  rowCount: number;
  loading: boolean;
  capabilityStatus: "ready" | "migration_required" | null;
}): number | "Loading" | "Unavailable" {
  if (input.rowCount > 0) return input.rowCount;
  if (input.loading) return "Loading";
  if (input.capabilityStatus !== "ready") return "Unavailable";
  return 0;
}
