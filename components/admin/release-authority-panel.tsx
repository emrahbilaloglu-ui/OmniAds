import Link from "next/link";
import type {
  ReleaseAuthorityDriftState,
  ReleaseAuthorityFlagMode,
  ReleaseAuthorityReport,
  ReleaseAuthorityRuntimeState,
  ReleaseAuthoritySurface,
} from "@/lib/release-authority/types";

function toneForDrift(state: ReleaseAuthorityDriftState) {
  if (state === "aligned") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (state === "unknown") return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-red-50 text-red-700 border-red-200";
}

function toneForRuntime(state: ReleaseAuthorityRuntimeState) {
  if (state === "live") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (state === "legacy") return "bg-slate-100 text-slate-700 border-slate-200";
  if (state === "hidden") return "bg-zinc-100 text-zinc-700 border-zinc-200";
  return "bg-amber-50 text-amber-700 border-amber-200";
}

function labelForFlagMode(mode: ReleaseAuthorityFlagMode | null) {
  if (!mode) return "n/a";
  if (mode === "allowlist") return "allowlist";
  return mode;
}

function StatCard({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  help?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
        {label}
      </p>
      <p className="mt-2 break-all font-mono text-sm text-gray-900">{value}</p>
      {help ? <p className="mt-2 text-xs text-gray-500">{help}</p> : null}
    </div>
  );
}

function VerdictCard({
  label,
  summary,
  status,
}: {
  label: string;
  summary: string;
  status: ReleaseAuthorityDriftState;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-gray-900">{label}</p>
        <span
          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${toneForDrift(
            status,
          )}`}
        >
          {status}
        </span>
      </div>
      <p className="mt-3 text-sm text-gray-600">{summary}</p>
    </div>
  );
}

function SurfaceReferences({ surface }: { surface: ReleaseAuthoritySurface }) {
  return (
    <div className="space-y-1">
      {surface.references.map((reference) => (
        <div key={`${surface.id}-${reference.kind}-${reference.path}`}>
          <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
            {reference.kind}
          </span>
          <p className="font-mono text-[11px] text-gray-700">{reference.path}</p>
        </div>
      ))}
    </div>
  );
}

export function ReleaseAuthorityPanel({
  report,
}: {
  report: ReleaseAuthorityReport;
}) {
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Release Authority</h1>
          <p className="mt-1 text-sm text-gray-500">
            Canonical baseline authority for live SHA, remote main, docs posture,
            flag posture, and legacy aliases.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <span>Schema: <code className="font-mono">{report.schemaVersion}</code></span>
          <Link
            href="/api/release-authority"
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            View JSON
          </Link>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <StatCard
          label="Current Live SHA"
          value={report.runtime.currentLiveSha}
          help="Current runtime build identity from the deployed app."
        />
        <StatCard
          label="Remote Main SHA"
          value={report.runtime.currentMainSha ?? "unresolved"}
          help={`Source: ${report.runtime.currentMainShaSource}`}
        />
        <StatCard
          label="Previous Known-Good"
          value={report.release.previousKnownGoodSha}
          help={`Source: ${report.release.previousKnownGoodSource}`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <VerdictCard
          label="Live vs Main"
          summary={report.verdicts.liveVsMain.summary}
          status={report.verdicts.liveVsMain.status}
        />
        <VerdictCard
          label="Docs vs Runtime"
          summary={report.verdicts.docsVsRuntime.summary}
          status={report.verdicts.docsVsRuntime.status}
        />
        <VerdictCard
          label="Flags vs Runtime"
          summary={report.verdicts.flagsVsRuntime.summary}
          status={report.verdicts.flagsVsRuntime.status}
        />
        <VerdictCard
          label="Live / Main / Docs"
          summary={report.verdicts.liveMainDocs.summary}
          status={report.verdicts.liveMainDocs.status}
        />
        <VerdictCard
          label="Overall"
          summary={report.verdicts.overall.summary}
          status={report.verdicts.overall.status}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.45fr_0.85fr]">
        <div className="rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-200 px-5 py-4">
            <h2 className="text-base font-semibold text-gray-900">Feature Matrix</h2>
            <p className="mt-1 text-sm text-gray-500">
              Current decision-system surfaces with runtime, docs, and flag authority in one place.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs font-semibold uppercase tracking-widest text-gray-500">
                  <th className="px-5 py-3">Surface</th>
                  <th className="px-5 py-3">Runtime</th>
                  <th className="px-5 py-3">Flags</th>
                  <th className="px-5 py-3">Docs</th>
                  <th className="px-5 py-3">Drift</th>
                  <th className="px-5 py-3">References</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {report.surfaces.map((surface) => (
                  <tr key={surface.id} data-testid={`release-surface-${surface.id}`}>
                    <td className="px-5 py-4 align-top">
                      <p className="font-semibold text-gray-900">{surface.label}</p>
                      <p className="mt-1 text-xs uppercase tracking-widest text-gray-400">
                        {surface.area}
                      </p>
                      <div className="mt-2 space-y-1">
                        {surface.notes.map((note) => (
                          <p key={`${surface.id}-${note}`} className="text-xs text-gray-500">
                            {note}
                          </p>
                        ))}
                      </div>
                    </td>
                    <td className="px-5 py-4 align-top">
                      <div className="flex flex-wrap gap-2">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${toneForRuntime(
                            surface.runtimeState,
                          )}`}
                        >
                          {surface.runtimeState}
                        </span>
                        <span className="inline-flex rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-semibold text-gray-700">
                          {surface.repositoryState}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-4 align-top">
                      <p className="font-mono text-xs text-gray-700">
                        {labelForFlagMode(surface.flagPosture?.mode ?? null)}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        {surface.flagPosture?.summary ?? "No feature flag gate applies."}
                      </p>
                    </td>
                    <td className="px-5 py-4 align-top">
                      <span className="inline-flex rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-semibold text-gray-700">
                        {surface.docsState}
                      </span>
                    </td>
                    <td className="px-5 py-4 align-top">
                      <span
                        className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${toneForDrift(
                          surface.driftState,
                        )}`}
                      >
                        {surface.driftState}
                      </span>
                      <div className="mt-2 space-y-1">
                        {surface.driftReasons.length > 0 ? (
                          surface.driftReasons.map((reason) => (
                            <p key={`${surface.id}-${reason}`} className="text-xs text-gray-500">
                              {reason}
                            </p>
                          ))
                        ) : (
                          <p className="text-xs text-gray-500">
                            No unresolved drift is recorded for this surface.
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4 align-top">
                      <SurfaceReferences surface={surface} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold text-gray-900">Authority Source</h2>
            <div className="mt-4 space-y-3 text-sm text-gray-600">
              <p>
                Manifest:{" "}
                <code className="font-mono text-xs">
                  {report.release.featureAuthoritySource.manifestModule}
                </code>
              </p>
              <p>
                API route:{" "}
                <code className="font-mono text-xs">
                  {report.release.featureAuthoritySource.apiRoute}
                </code>
              </p>
              <p>
                Admin route:{" "}
                <code className="font-mono text-xs">
                  {report.release.featureAuthoritySource.adminRoute}
                </code>
              </p>
              <p>
                Canonical doc:{" "}
                <code className="font-mono text-xs">
                  {report.release.featureAuthoritySource.canonicalDoc}
                </code>
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold text-gray-900">Unresolved Drift</h2>
            <div className="mt-4 space-y-3">
              {report.unresolvedDriftItems.length === 0 ? (
                <p className="text-sm text-gray-600">
                  No unresolved drift items remain. This baseline is explainable from one authority surface.
                </p>
              ) : (
                report.unresolvedDriftItems.map((item) => (
                  <div key={item.id} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-amber-900">
                        {item.surfaceId ?? item.scope}
                      </p>
                      <span className="text-xs font-semibold uppercase tracking-widest text-amber-700">
                        {item.status}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-amber-800">{item.detail}</p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold text-gray-900">
              Carry-Forward Acceptance Gaps
            </h2>
            <p className="mt-2 text-sm text-gray-600">{report.carryForward.summary}</p>
            <div className="mt-4 space-y-3">
              {report.carryForward.acceptanceGaps.length === 0 ? (
                <p className="text-sm text-gray-600">
                  No accepted carry-forward gaps remain.
                </p>
              ) : (
                report.carryForward.acceptanceGaps.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-lg border border-blue-200 bg-blue-50 p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-blue-900">
                        {item.label}
                      </p>
                      <span className="text-xs font-semibold uppercase tracking-widest text-blue-700">
                        {item.status}
                      </span>
                    </div>
                    {item.proofLevel ? (
                      <p className="mt-2 text-xs text-blue-800">
                        Proof: <code className="font-mono">{item.proofLevel}</code>
                      </p>
                    ) : null}
                    <p className="mt-2 text-sm text-blue-800">{item.detail}</p>
                    <p className="mt-2 text-xs text-blue-800">
                      Next: {item.nextRequirement}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-base font-semibold text-gray-900">GPT Review Order</h2>
            <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-gray-600">
              {report.reviewOrder.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
