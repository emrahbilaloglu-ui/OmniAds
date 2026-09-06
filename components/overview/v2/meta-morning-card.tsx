"use client";

import type { MetaDailyBrief } from "@/lib/meta/daily-brief";

/**
 * What Meta did overnight, and what is waiting.
 *
 * Home's brief card said nothing about Meta at all, so the only way to find
 * out whether anything had been applied while the operator slept was to open
 * four screens and know which four.
 *
 * Every number carries whether it was actually read. An empty queue and an
 * unreadable queue look identical as "0" and mean opposite things — one is a
 * quiet morning, the other is a broken read reported as one.
 */
function stateOf(section: { state: "read" | "unavailable" }) {
  return section.state === "read";
}

function count(section: { state: "read" | "unavailable" }, value: number) {
  return stateOf(section) ? String(value) : "not read";
}

const MODE_WORDS: Record<string, string> = {
  manual: "Manual",
  semi_auto: "Semi-automatic",
  auto: "Automatic",
};

export function MetaMorningCard({
  brief,
  loading,
  error,
}: {
  brief: MetaDailyBrief | null | undefined;
  loading?: boolean;
  error?: string | null;
}) {
  return (
    <article className="adv-card overflow-hidden" aria-busy={Boolean(loading)} data-testid="meta-morning-card">
      <div className="flex items-center justify-between gap-2.5 px-4 py-3.5" style={{ background: "#0B1020" }}>
        <p className="text-[13px] font-semibold text-white">Meta this morning</p>
        <span className="text-[11.5px]" style={{ color: "#94A3B8" }} data-field="brief-as-of">
          {brief?.asOf ?? "—"}
        </span>
      </div>

      {error ? (
        <p className="px-4 py-3 text-[13px]" data-field="brief-error">
          {/* The reason, not a shrug: an operator who cannot see this card
              needs to know whether to wait or to go looking. */}
          {error}
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-px" style={{ background: "var(--border, #e5e7eb)" }}>
        <Cell
          label="Applied overnight"
          value={brief ? count(brief.appliedYesterday, brief.appliedYesterday.applied) : "—"}
          note={brief && stateOf(brief.appliedYesterday) && brief.appliedYesterday.failed > 0
            ? `${brief.appliedYesterday.failed} failed`
            : null}
          field="applied-overnight"
        />
        <Cell
          label="Waiting for you"
          value={brief ? count(brief.queue, brief.queue.pending) : "—"}
          note={null}
          field="queue-pending"
        />
        <Cell
          label="Alerts"
          value={brief ? count(brief.alerts, brief.alerts.total) : "—"}
          note={brief && stateOf(brief.alerts) && brief.alerts.high > 0
            ? `${brief.alerts.high} need attention`
            : null}
          field="alerts"
        />
        <Cell
          label="Decisions to act on"
          value={brief ? count(brief.decisions, brief.decisions.actionable) : "—"}
          note={null}
          field="actionable-decisions"
        />
      </dl>

      <div className="px-4 py-3 text-[12px]" style={{ color: "var(--muted)" }}>
        <p data-field="brief-modes">
          {brief && stateOf(brief.modes)
            ? `Budget ${MODE_WORDS[brief.modes.budget ?? ""] ?? "—"} · Pause ${MODE_WORDS[brief.modes.pause ?? ""] ?? "—"}`
            : "Management modes could not be read"}
        </p>
        {/*
          Staleness, stated rather than implied. A brief built on a three-day-old
          snapshot is not wrong; reading it as this morning's picture would be.
        */}
        <p data-field="brief-freshness" className="mt-1">
          {brief && stateOf(brief.freshness) && brief.freshness.lastSnapshotDate
            ? brief.freshness.staleDays && brief.freshness.staleDays > 1
              ? `Based on decisions from ${brief.freshness.lastSnapshotDate} — ${brief.freshness.staleDays} days old`
              : `Based on decisions from ${brief.freshness.lastSnapshotDate}`
            : "No recent decision snapshot could be read"}
        </p>
      </div>
    </article>
  );
}

function Cell({
  label, value, note, field,
}: {
  label: string;
  value: string;
  note: string | null;
  field: string;
}) {
  return (
    <div className="px-4 py-3" style={{ background: "var(--surface, #fff)" }} data-field={field}>
      <dt className="text-[11.5px]" style={{ color: "var(--muted)" }}>{label}</dt>
      <dd className="mt-1 text-[22px] font-[650] leading-none tabular-nums">{value}</dd>
      {note ? (
        <p className="mt-1 text-[11.5px]" style={{ color: "var(--muted)" }}>{note}</p>
      ) : null}
    </div>
  );
}
