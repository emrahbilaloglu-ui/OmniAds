"use client";

import type { GoogleAdsActivityEntry } from "@/lib/google-ads/advisor-memory";

/**
 * The design's Activity card on Plan: every guarded write with its receipt,
 * newest first. "Who" reads the account the write executed against, because the
 * execution log records the target, not a per-seat actor.
 */

const HEAD =
  "bg-[var(--adv-fill)] px-3 py-[9px] text-left font-[family-name:var(--adv-font-mono)] text-[10px] font-medium uppercase tracking-[0.1em] whitespace-nowrap text-[var(--adv-ink-3)]";

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function humanise(value: string) {
  return value.replace(/_/g, " ").toLowerCase();
}

export function GoogleActivityTable({
  rows,
  isLoading,
}: {
  rows: GoogleAdsActivityEntry[];
  isLoading: boolean;
}) {
  return (
    <article className="overflow-hidden rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--adv-hairline)] px-4 py-[13px]">
        <h2 className="m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]">
          Activity
        </h2>
        <span className="font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
          manual confirmations
        </span>
      </div>
      <p className="m-0 px-4 py-[11px] text-[12px] leading-[1.5] text-[var(--adv-ink-3)]">
        Every guarded write lands here with its receipt and is confirmed against
        the Google Ads change history.
      </p>
      {isLoading ? (
        <p className="m-0 px-4 pb-[11px] text-[11.5px] text-[var(--adv-ink-4)]">Loading activity…</p>
      ) : rows.length === 0 ? (
        <p className="m-0 px-4 pb-[11px] text-[11.5px] text-[var(--adv-ink-4)]">
          No guarded write has executed on this account yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[440px] border-collapse text-[12px]">
            <thead>
              <tr>
                <th className={`${HEAD} px-4`}>When</th>
                <th className={HEAD}>Who</th>
                <th className={HEAD}>What</th>
                <th className={`${HEAD} px-4`}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-[var(--adv-hairline)]">
                  <td className="px-4 py-2.5 text-[10.5px] text-[var(--adv-ink-3)]">
                    {formatWhen(row.createdAt)}
                  </td>
                  <td className="px-3 py-2.5 text-[var(--adv-ink-2)]">{row.accountId}</td>
                  <td className="px-3 py-2.5 font-semibold text-[var(--adv-ink)]">
                    {humanise(row.mutateActionType)}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--adv-ink-2)]">
                    {row.detail ?? `${humanise(row.operation)} · ${humanise(row.status)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
