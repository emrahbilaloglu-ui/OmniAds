import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";

function summarizeLineage(intent: MetaLaunchIntent) {
  const sources = [
    intent.lineage.sourceDecisionId ? "Decision" : null,
    intent.lineage.creativeBriefId ? "Brief" : null,
    intent.lineage.sourceDraftId ? "Draft" : null,
  ].filter(Boolean);
  return sources.length > 0 ? sources.join(" -> ") : "Manual origin";
}

function statusClass(status: MetaLaunchIntent["status"]) {
  if (status === "succeeded") return "chip chip--healthy";
  if (
    status === "failed" ||
    status === "partially_succeeded" ||
    status === "silent_failure" ||
    status === "validation_blocked" ||
    status === "write_blocked"
  ) {
    return "chip chip--action";
  }
  return "chip chip--ghost";
}

function resultFacts(intent: MetaLaunchIntent) {
  const receipt = intent.resultReceipt ?? intent.errorReceipt?.partialResult;
  if (!receipt) return [];
  return [
    receipt.campaignId ? `campaign ${receipt.campaignId}` : null,
    receipt.adsetIds.length > 0
      ? `${receipt.adsetIds.length} ad set${receipt.adsetIds.length === 1 ? "" : "s"}`
      : null,
    receipt.adIds.length > 0
      ? `${receipt.adIds.length} ad${receipt.adIds.length === 1 ? "" : "s"}`
      : null,
  ].filter((value): value is string => Boolean(value));
}

function formatTimestamp(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "time unavailable";
}

export function LaunchIntentReceiptRows({
  intents,
}: {
  intents: MetaLaunchIntent[];
}) {
  return (
    <div className="divide-y divide-[var(--border)]" data-testid="launch-intent-receipts">
      {intents.map((intent) => {
        const facts = resultFacts(intent);
        return (
          <div key={intent.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[12.5px] font-medium text-[var(--ink)]">
                  {intent.operation === "new_campaign"
                    ? "New campaign"
                    : "Add to existing"}
                </p>
                <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                  {summarizeLineage(intent)} · PAUSED only
                </p>
              </div>
              <span className={statusClass(intent.status)}>
                {intent.status.replaceAll("_", " ")}
              </span>
            </div>
            <p className="mono mt-2 truncate text-[12px] text-[var(--muted)]" title={intent.id}>
              {intent.id} · {formatTimestamp(intent.updatedAt)}
            </p>
            {facts.length > 0 ? (
              <p className="mono mt-1 text-[12px] text-[var(--ink-3)]">
                receipt: {facts.join(" · ")}
              </p>
            ) : null}
            {intent.errorReceipt ? (
              <p className="mono mt-1 text-[12px] text-[var(--danger)]">
                {intent.errorReceipt.code} — {intent.errorReceipt.message}
              </p>
            ) : null}
            <p className="mt-1 text-[12px] text-[var(--muted)]">
              Immutable receipt · no automatic retry or rollback
            </p>
          </div>
        );
      })}
    </div>
  );
}
