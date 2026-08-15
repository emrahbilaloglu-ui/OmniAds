import { cn } from "@/lib/utils";
import type { SeoFindingsResponse } from "./seo-intelligence-support";

type UrlInspectionEvidence = NonNullable<SeoFindingsResponse["meta"]["urlInspection"]>;
type UrlInspectionFailure = UrlInspectionEvidence["failures"][number];

const URL_INSPECTION_FAILURE_LABELS: Record<
  UrlInspectionFailure["kind"],
  string
> = {
  timeout: "Timed out",
  provider: "Provider error",
  transport: "Network error",
  invalid_response: "Invalid response",
  quota_exhausted: "Quota exhausted",
  quota_state_unavailable: "Quota state unavailable",
  cooldown: "Provider cooldown active",
  governance_state_unavailable: "Provider safety state unavailable",
};

function summarizeUrlInspectionFailures(
  failures: UrlInspectionFailure[],
): string[] {
  const grouped = new Map<string, { label: string; count: number }>();

  for (const failure of failures) {
    const statusSuffix =
      failure.status !== null ? ` (HTTP ${failure.status})` : "";
    const label = `${URL_INSPECTION_FAILURE_LABELS[failure.kind]}${statusSuffix}`;
    const current = grouped.get(label);
    grouped.set(label, {
      label,
      count: (current?.count ?? 0) + 1,
    });
  }

  return Array.from(grouped.values())
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map(({ label, count }) => `${label}: ${count}`);
}

export function UrlInspectionStatusPanel({
  evidence,
}: {
  // The builder does not always emit this evidence block; an absent one is
  // "nothing measured", which draws nothing rather than a zeroed panel.
  evidence: UrlInspectionEvidence | undefined;
}) {
  if (!evidence) return null;
  if (evidence.status !== "partial" && evidence.status !== "failed") {
    return null;
  }

  const isFailed = evidence.status === "failed";
  const processed = evidence.succeeded + evidence.failed;
  const countsMatch = processed === evidence.attempted;
  const failureReasons = summarizeUrlInspectionFailures(evidence.failures);

  return (
    <div
      role="status"
      data-testid="url-inspection-status"
      className={cn(
        "rounded-xl border px-4 py-4",
        isFailed
          ? "border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]"
          : "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-semibold">
            URL Inspection: {isFailed ? "Failed" : "Partial"}
          </p>
          <p className="max-w-3xl text-sm leading-5 opacity-80">
            {isFailed
              ? "No reliable URL Inspection coverage was returned. Treat the technical findings below as incomplete."
              : "Some URL inspections failed. Technical findings below include only the inspection evidence that completed successfully."}
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide",
            isFailed
              ? "bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]"
              : "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]",
          )}
        >
          {evidence.status}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-2 sm:max-w-lg">
        {[
          ["Attempted", evidence.attempted],
          ["Succeeded", evidence.succeeded],
          ["Failed", evidence.failed],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-lg border border-current/10 bg-white/70 px-3 py-2"
          >
            <dt className="text-[11px] font-medium uppercase tracking-wide opacity-70">
              {label}
            </dt>
            <dd className="mt-1 text-lg font-semibold">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 text-xs leading-5 opacity-75">
        {countsMatch
          ? `${processed} attempted URL inspection${processed === 1 ? "" : "s"} reached a terminal outcome.`
          : `${processed} terminal outcomes were reported for ${evidence.attempted} attempts. Coverage counts are inconsistent.`}
      </p>

      {evidence.failed > 0 && (
        <div className="mt-3 border-t border-current/10 pt-3 text-sm">
          <span className="font-medium">Failure reasons: </span>
          <span className="opacity-80">
            {failureReasons.length
              ? failureReasons.join(" · ")
              : "Details unavailable"}
          </span>
        </div>
      )}
    </div>
  );
}
