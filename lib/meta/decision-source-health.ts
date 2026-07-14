export const META_DECISION_SOURCE_FALLBACK_DETAILS: Readonly<
  Record<string, string>
> = {
  native_latest_job_failed:
    "The latest native Ad decision job failed before producing authoritative output.",
  native_latest_job_skipped:
    "The latest native Ad decision job was skipped without authoritative output.",
  native_latest_job_engine_mismatch:
    "The latest native Ad decision generation belongs to a different engine version and cannot authorize current-version actions.",
  native_job_unavailable:
    "The native Ad decision job has not produced a usable successful generation.",
  native_account_manifest_incomplete:
    "The native Ad generation is incomplete for this ad account.",
  native_generation_lineage_or_manifest_invalid:
    "The native Ad generation failed its lineage or account-manifest check.",
  native_schema_or_generation_read_failed:
    "The native Ad decision source could not be read.",
  native_schema_or_generation_unavailable:
    "The native Ad decision schema or generation is unavailable.",
  native_generation_unavailable:
    "A native Ad decision generation is not available for this account.",
};

export function metaDecisionSourceFallbackDetail(
  reason: string | null | undefined,
) {
  return (
    META_DECISION_SOURCE_FALLBACK_DETAILS[
      reason ?? "native_fallback_unspecified"
    ] ?? "The native Ad decision source is not currently authoritative."
  );
}
