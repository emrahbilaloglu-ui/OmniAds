"use client";

import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { GoogleRecommendation } from "@/lib/google-ads/growth-advisor-types";

/**
 * The design's Plan & activity execution queue: the advisor's ranked findings as
 * numbered steps with per-step approval ticks and a CSV export.
 *
 * "Apply all approved" sends the ticked steps to the guarded execution path
 * (advisor-memory, executionAction "apply_mutate"). The operator chose direct
 * apply over an intermediate confirmation step, so the button acts on the ticks
 * themselves — the server still enforces trust bands, dependency readiness and
 * per-recommendation blockers, and returns a receipt per step.
 */
export function GoogleExecutionQueue({
  recommendations,
  accountLabel,
  businessId,
  accountId,
  onApplied,
}: {
  recommendations: GoogleRecommendation[];
  accountLabel: string | null;
  businessId: string;
  accountId?: string | null;
  onApplied?: () => void;
}) {
  const steps = useMemo(
    () =>
      [...recommendations]
        .sort((left, right) => (right.rankScore ?? 0) - (left.rankScore ?? 0))
        .slice(0, 12),
    [recommendations],
  );
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; applied: number; failed: number }
    | { kind: "error"; message: string }
    | null
  >(null);

  if (steps.length === 0) return null;

  const approvedCount = steps.filter((step) => approved[step.id]).length;

  const applyApproved = async () => {
    const targets = steps.filter((step) => approved[step.id]);
    if (targets.length === 0) return;
    setApplying(true);
    setResult(null);
    let applied = 0;
    let failed = 0;
    let lastMessage: string | null = null;

    for (const step of targets) {
      try {
        const response = await fetch("/api/google-ads/advisor-memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId,
            accountId: accountId ?? undefined,
            recommendationFingerprint: step.recommendationFingerprint,
            executionAction: "apply_mutate",
          }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; message?: string; error?: string }
          | null;
        if (response.ok && payload?.ok !== false) {
          applied += 1;
        } else {
          failed += 1;
          lastMessage = payload?.message ?? payload?.error ?? `Failed (${response.status})`;
        }
      } catch (caught) {
        failed += 1;
        lastMessage = caught instanceof Error ? caught.message : "Request failed";
      }
    }

    setApplying(false);
    setResult(
      failed > 0 && applied === 0 && lastMessage
        ? { kind: "error", message: lastMessage }
        : { kind: "ok", applied, failed },
    );
    if (applied > 0) onApplied?.();
  };

  const downloadCsv = () => {
    const header = ["#", "Recommendation", "Layer", "Priority", "Action", "Why now", "Approved"];
    const rows = steps.map((step, index) => [
      String(index + 1),
      step.title,
      step.strategyLayer,
      step.priority,
      step.recommendedAction,
      step.whyNow,
      approved[step.id] ? "yes" : "no",
    ]);
    const escape = (cell: string) => `"${String(cell ?? "").replace(/"/g, '""')}"`;
    const csv = [header, ...rows].map((row) => row.map(escape).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `google-plan-${accountLabel ?? "account"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <article className="overflow-hidden rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--adv-hairline)] px-4 py-[13px]">
        <h2 className="m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]">
          Execution queue
        </h2>
        <span className="font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
          {steps.length} queued · {approvedCount} approved
        </span>
        <div className="ml-auto flex gap-1.5">
          <button
            type="button"
            onClick={applyApproved}
            disabled={applying || approvedCount === 0}
            className="h-[30px] rounded-lg bg-[var(--adv-rail)] px-[13px] text-[12px] font-semibold text-white disabled:opacity-45"
          >
            {applying ? "Applying…" : "Apply all approved"}
          </button>
          <button
            type="button"
            onClick={downloadCsv}
            className="h-[30px] rounded-lg border border-[var(--adv-border)] bg-[var(--adv-surface)] px-[11px] text-[12px] font-semibold text-[var(--adv-ink-2)] hover:bg-[var(--adv-fill)]"
          >
            Download CSV
          </button>
        </div>
      </div>

      <p className="m-0 border-b border-[var(--adv-hairline)] px-4 py-[11px] text-[12.5px] leading-[1.5] text-[var(--adv-ink-3)]">
        Approved changes execute here through the guarded write boundary — the
        server still enforces trust bands, dependencies and blockers, and every
        write returns a Google receipt.
      </p>

      {result ? (
        <p
          role="status"
          className="m-0 border-b px-4 py-[11px] text-[12.5px]"
          style={
            result.kind === "error"
              ? {
                  borderColor: "var(--adc-danger-bd)",
                  background: "var(--adc-danger-bg)",
                  color: "var(--adc-danger-fg)",
                }
              : {
                  borderColor: "var(--adv-hairline)",
                  background: "var(--adc-pos-bg)",
                  color: "var(--adc-pos-fg)",
                }
          }
        >
          {result.kind === "error"
            ? result.message
            : `${result.applied} applied${result.failed > 0 ? ` · ${result.failed} failed` : ""}`}
        </p>
      ) : null}

      {steps.map((step, index) => {
        const on = Boolean(approved[step.id]);
        return (
          <div
            key={step.id}
            className="flex flex-col gap-2 border-t border-[var(--adv-hairline)] px-4 py-[13px]"
          >
            <div className="flex items-start gap-[11px]">
              <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-[var(--adv-fill-2)] font-[family-name:var(--adv-font-mono)] text-[11px] text-[var(--adv-ink-2)]">
                {index + 1}
              </span>
              <div className="min-w-[200px] flex-1">
                <p className="m-0 text-[13.5px] font-semibold text-[var(--adv-ink)]">
                  {step.title}
                </p>
                <p className="m-0 mt-0.5 font-[family-name:var(--adv-font-mono)] text-[10px] text-[var(--adv-ink-4)]">
                  {step.strategyLayer} · {step.entityName ?? "account"}
                </p>
                {step.blockers.length > 0 ? (
                  <p className="m-0 mt-[3px] text-[11.5px] text-[var(--adc-caution-fg)]">
                    {step.blockers.join(" · ")}
                  </p>
                ) : null}
              </div>
              <a
                href="https://ads.google.com/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-[var(--adv-accent)]"
              >
                Open <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </div>
            <div className="flex flex-wrap items-center gap-2 pl-[33px]">
              <button
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setApproved((current) => ({ ...current, [step.id]: !current[step.id] }))
                }
                className="inline-flex items-center gap-[7px]"
              >
                <span
                  className="grid h-4 w-4 place-items-center rounded-[5px] border"
                  style={{
                    borderColor: on ? "var(--adv-accent)" : "var(--adv-border)",
                    background: on ? "var(--adv-accent)" : "var(--adv-surface)",
                  }}
                >
                  {on ? (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#ffffff"
                      strokeWidth={3.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-[11px] w-[11px]"
                      aria-hidden="true"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : null}
                </span>
                <span
                  className="text-[12px] font-semibold"
                  style={{ color: on ? "var(--adv-accent)" : "var(--adv-ink-3)" }}
                >
                  {on ? "Approved for manual apply" : "Mark approved"}
                </span>
              </button>
              <span className="font-[family-name:var(--adv-font-mono)] text-[10px] text-[var(--adv-ink-4)]">
                {step.recommendedAction}
              </span>
            </div>
          </div>
        );
      })}
    </article>
  );
}
