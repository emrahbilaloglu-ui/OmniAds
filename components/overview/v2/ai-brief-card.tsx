"use client";

import type { AiDailyInsightSnapshot } from "@/src/types/models";

type BriefKind = "Opportunity" | "Risk" | "Action";

const KIND_TONE: Record<BriefKind, { background: string; color: string }> = {
  Opportunity: { background: "#E7F6F0", color: "#0b7954" },
  Risk: { background: "#FDECF0", color: "#E11D48" },
  Action: { background: "#EAF0FF", color: "#2a5fe2" },
};

function firstPresent(values: string[]) {
  return values.find((value) => value.trim().length > 0)?.trim() ?? null;
}

function toRows(insight: AiDailyInsightSnapshot | null | undefined) {
  const candidates: Array<{ kind: BriefKind; text: string | null }> = [
    {
      kind: "Opportunity",
      text: insight ? firstPresent(insight.opportunities) : null,
    },
    { kind: "Risk", text: insight ? firstPresent(insight.risks) : null },
    {
      kind: "Action",
      text: insight ? firstPresent(insight.recommendations) : null,
    },
  ];

  return candidates.map((row) => ({ ...row, text: row.text ?? "—" }));
}

export function AiBriefCard({
  insight,
  loading,
  onRegenerate,
  regenerating,
}: {
  insight: AiDailyInsightSnapshot | null | undefined;
  loading?: boolean;
  error?: string | null;
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  const rows = toRows(insight);
  const summary = insight?.summary.trim() || "—";
  const insightDate = insight?.insightDate.trim() || "—";

  return (
    <article className="adv-card overflow-hidden" aria-busy={Boolean(loading || regenerating)}>
      <div className="flex items-center gap-2.5 px-4 py-3.5" style={{ background: "#0B1020" }}>
        <span
          className="grid h-[26px] w-[26px] place-items-center rounded-[8px] text-white"
          style={{ background: "#6C41BE" }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
            aria-hidden="true"
          >
            <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z" />
          </svg>
        </span>
        <h2 className="m-0 text-[15px] font-semibold text-white" style={{ fontFamily: "var(--adv-font-display)" }}>
          AI Daily Brief
        </h2>
        <span className="ml-auto text-[10px] text-[#8B93A7]" style={{ fontFamily: "var(--adv-font-mono)" }}>
          {insightDate}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <p className="m-0 text-[13px] leading-[1.6] text-[#45526B]">{summary}</p>
        {rows.map((row) => (
          <div
            key={row.kind}
            data-overview-brief-kind={row.kind}
            className="flex items-start gap-2.5 rounded-[10px] border border-[#EDF0F6] px-3 py-2.5"
          >
            <span
              className="mt-px shrink-0 whitespace-nowrap rounded-[5px] px-[7px] py-[3px] text-[9px] uppercase tracking-[0.08em]"
              style={{
                fontFamily: "var(--adv-font-mono)",
                background: KIND_TONE[row.kind].background,
                color: KIND_TONE[row.kind].color,
              }}
            >
              {row.kind}
            </span>
            <span className="text-[12.5px] leading-[1.5] text-[#0E1526]">{row.text}</span>
          </div>
        ))}
        <button
          type="button"
          onClick={onRegenerate}
          disabled={!onRegenerate || regenerating}
          aria-busy={Boolean(regenerating)}
          className="adv-btn h-8 justify-center !px-0 !text-[12.5px] !text-[#45526B]"
          style={{ height: 32, borderRadius: 8, opacity: 1, cursor: "pointer" }}
        >
          Regenerate brief
        </button>
      </div>
    </article>
  );
}
