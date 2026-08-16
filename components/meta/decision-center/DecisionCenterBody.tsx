"use client";

/**
 * The Decision Center body.
 *
 * Presentational on purpose: it takes the server presentation and renders it.
 * It holds no fetching and no decision logic, which is what lets the invariant
 * in docs/meta-decision-center/INVARIANTS.md be checked by reading one file --
 * "UI must render backend-provided recommendations; it must not compute buyer
 * actions, decision labels, label transforms, or automation readiness."
 *
 * The date window scopes METRICS, not decisions. The queue reflects the
 * snapshot, and the header says so in as many words, because the two being
 * confused is the failure this surface is most exposed to.
 */
import { useMemo, useState } from "react";

import {
  DECISION_CENTER_QUEUES,
  decisionCenterHasCommand,
  decisionCenterHeaderFacts,
  decisionCenterItems,
  decisionCenterMoneyAtStake,
  decisionCenterQueueCounts,
  type DecisionCenterHeaderFact,
  type DecisionCenterItem,
  type DecisionCenterLayer,
  type DecisionCenterQueueKey,
} from "@/components/meta/decision-center/decision-center-contract";
import type { MetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-contract";
import { cn } from "@/lib/utils";

export interface DecisionCenterBodyProps {
  presentation: MetaOsDecisionsPresentation;
  accountLabel: string | null;
  currency: string | null;
  /** Metrics window, owned by the shell picker. Scopes metrics only. */
  windowLabel: string | null;
  /** The same window, abbreviated for the KPI heading ("28D"). */
  windowShortLabel?: string | null;
  /**
   * The account pulse the server measured, for the header KPI strip. Absent
   * fields stay absent — the strip prints "—" rather than a zero it invented.
   */
  pulse?: {
    pacing?: {
      spendToday?: number;
      avg7dSpend?: number;
      conversionsToday?: number;
      avg7dConversions?: number;
    } | null;
    roas?: { selected: number; d28: number; target: number | null } | null;
    roasHistory?: number[] | null;
    labelCoverage?: { activeCampaigns: number; labeledCampaigns: number } | null;
    operatingMode?: string | null;
    seasonalRegime?: string | null;
    trackingHealth?: { status: string; detail: string } | null;
  } | null;
  snapshotHealth?: { status: string; ageHours: number | null } | null;
  lastSyncLabel: string | null;
  /**
   * Set when the server downgraded this viewer's write controls. Stated rather
   * than enacted silently: a command that is absent for a permission reason and
   * a command the engine withheld look identical unless one of them says why.
   */
  readOnlyReason?: string | null;
  /**
   * Set when the canonical read model came back unavailable. The queue is then
   * genuinely empty of *read* decisions, which is not the same as there being
   * none — so it is labelled instead of being left to look like a clean slate.
   */
  unavailableReason?: string | null;
  canRunSnapshot: boolean;
  onRunSnapshot?: () => void;
  onNewCampaign?: () => void;
  onCommand?: (item: DecisionCenterItem) => void;
}

function money(value: number | null | undefined, currency: string | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const body =
    abs >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(abs < 10 ? 2 : 0);
  return `${currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "TRY" ? "₺" : ""}${body}`;
}

function ratio(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
}

/** A ROAS trend drawn from the server's own history, or nothing. */
function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * 100;
      const y = 22 - ((point - min) / span) * 20;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="mt-1 h-[24px] w-full"
    >
      <path d={path} fill="none" stroke="var(--adv-accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** One KPI tile. Every tile states a server fact, never a derived verdict. */
function Tile({ fact }: { fact: DecisionCenterHeaderFact }) {
  return (
    <article
      data-testid={`decision-center-kpi-${fact.key}`}
      className="flex min-w-0 flex-col gap-1 rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-[14px]"
    >
      <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[11px] uppercase tracking-[0.12em] text-[var(--adv-ink-3)]">
        {fact.label}
      </p>
      {fact.value ? (
        <p className="m-0 flex flex-wrap items-baseline gap-2">
          <span
            className={cn(
              "font-[family-name:var(--adv-font-display)] text-[26px] font-bold leading-[1.05] tracking-[-0.02em]",
              fact.tone === "accent"
                ? "text-[var(--adv-accent)]"
                : fact.tone === "warn"
                  ? "text-[#b45309]"
                  : "text-[var(--adv-ink)]",
            )}
          >
            {fact.value}
          </span>
          {fact.adjunct && (
            <span className="font-[family-name:var(--adv-font-display)] text-[12px] font-semibold text-[var(--adv-ink-3)]">{fact.adjunct}</span>
          )}
        </p>
      ) : (
        fact.adjunct && <p className="m-0 text-[12.5px] font-semibold text-[var(--adv-ink-3)]">{fact.adjunct}</p>
      )}
      {fact.chips.length > 0 && (
        <p className="m-0 flex flex-wrap gap-1.5">
          {fact.chips.map((chip) => (
            <span
              key={chip.text}
              className={cn(
                "inline-flex h-[22px] items-center rounded-full px-2 text-[11.5px] font-semibold",
                chip.tone === "ok"
                  ? "bg-[#e8f6ed] text-[#16663a]"
                  : chip.tone === "warn"
                    ? "bg-[#fdf1de] text-[#8a5106]"
                    : "bg-[var(--adv-fill)] text-[var(--adv-ink-2)]",
              )}
            >
              {chip.text}
            </span>
          ))}
        </p>
      )}
      {fact.spark && <Spark points={fact.spark} />}
      {fact.note && (
        <p className="m-0 font-[family-name:var(--adv-font-body)] text-[12px] leading-[1.4] text-[var(--adv-ink-3)]">
          {fact.note}
        </p>
      )}
    </article>
  );
}

export function DecisionCenterBody({
  presentation,
  accountLabel,
  currency,
  windowLabel,
  windowShortLabel = null,
  pulse = null,
  snapshotHealth = null,
  lastSyncLabel,
  readOnlyReason = null,
  unavailableReason = null,
  canRunSnapshot,
  onRunSnapshot,
  onNewCampaign,
  onCommand,
}: DecisionCenterBodyProps) {
  const [layer, setLayer] = useState<DecisionCenterLayer>("structure");
  const [queue, setQueue] = useState<DecisionCenterQueueKey>("act");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items = useMemo(() => decisionCenterItems(presentation, layer), [presentation, layer]);
  const counts = useMemo(() => decisionCenterQueueCounts(presentation, layer), [presentation, layer]);
  const visible = useMemo(() => items.filter((item) => item.lane === queue), [items, queue]);
  const atStake = useMemo(() => decisionCenterMoneyAtStake(items, "act"), [items]);

  const selected = visible.find((item) => item.id === selectedId) ?? visible[0] ?? null;
  const snapshot = presentation.source.snapshotAsOf;
  const degraded = presentation.source.health === "degraded";

  const headerFacts = useMemo<DecisionCenterHeaderFact[]>(
    () =>
      decisionCenterHeaderFacts({
        pacing: pulse?.pacing ?? null,
        roas: pulse?.roas ?? null,
        roasHistory: pulse?.roasHistory ?? null,
        labelCoverage: pulse?.labelCoverage ?? null,
        operatingMode: pulse?.operatingMode ?? null,
        seasonalRegime: pulse?.seasonalRegime ?? null,
        trackingHealth: pulse?.trackingHealth ?? null,
        snapshotHealth,
        engineVersion: presentation.source.engineVersion,
        lastSyncLabel,
        currency,
        windowLabel: windowShortLabel,
        formatMoney: money,
      }),
    [pulse, snapshotHealth, presentation.source.engineVersion, lastSyncLabel, currency, windowShortLabel],
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[12px] uppercase tracking-[0.12em] text-[var(--adv-ink-3)]">
            Meta{accountLabel ? ` · ${accountLabel}` : ""}{currency ? ` · ${currency}` : ""}
          </p>
          <h1 className="m-0 mt-1 font-[family-name:var(--adv-font-display)] text-[26px] font-bold leading-[1.1] tracking-[-0.02em] text-[var(--adv-ink)]">
            Decision Center
          </h1>
          <p className="m-0 mt-1 font-[family-name:var(--adv-font-mono)] text-[11px] text-[var(--adv-ink-3)]">
            {[
              lastSyncLabel ? `synced ${lastSyncLabel}` : null,
              snapshot ? `snapshot ${snapshot}` : "no snapshot",
              presentation.source.engineVersion ? `engine ${presentation.source.engineVersion}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRunSnapshot}
            disabled={!canRunSnapshot}
            data-testid="decision-center-run-snapshot"
            className="h-[36px] rounded-[9px] border border-[var(--adv-border)] bg-[var(--adv-surface)] px-[13px] font-[family-name:var(--adv-font-body)] text-[13px] font-semibold text-[var(--adv-ink)] disabled:opacity-50"
          >
            Run snapshot
          </button>
          <button
            type="button"
            onClick={onNewCampaign}
            data-testid="decision-center-new-campaign"
            className="h-[36px] rounded-[9px] bg-[var(--adv-accent)] px-[14px] font-[family-name:var(--adv-font-body)] text-[13px] font-semibold text-white"
          >
            + New campaign
          </button>
        </div>
      </header>

      {(unavailableReason || readOnlyReason) && (
        <div
          className="rounded-[12px] border border-[#f0d8a8] bg-[#fdf7ec] px-4 py-3"
          data-testid="decision-center-state-banner"
          role="status"
        >
          {unavailableReason && (
            <p className="m-0 text-[12.5px] leading-[1.5] text-[#7c4a03]">
              <strong className="font-semibold">Canonical decisions unavailable.</strong>{" "}
              {unavailableReason} An empty queue below means nothing was read, not that nothing
              needs doing.
            </p>
          )}
          {readOnlyReason && (
            <p className="m-0 mt-1 text-[12.5px] leading-[1.5] text-[#7c4a03]">{readOnlyReason}</p>
          )}
        </div>
      )}

      <section
        className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]"
        aria-label="Decision queue summary"
      >
        {headerFacts.map((fact) => (
          <Tile key={fact.key} fact={fact} />
        ))}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-[10px] border border-[var(--adv-border)] bg-[var(--adv-fill)] p-1">
          {(
            [
              ["structure", "Campaigns & Ad sets", presentation.structure.actCount],
              ["ads", "Creatives", presentation.ads.actCount],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={layer === key}
              onClick={() => {
                setLayer(key);
                setSelectedId(null);
              }}
              className={cn(
                "rounded-[8px] px-[13px] py-[6px] font-[family-name:var(--adv-font-body)] text-[12.5px] font-semibold",
                layer === key ? "bg-[var(--adv-rail)] text-white" : "text-[var(--adv-ink-3)]",
              )}
            >
              {label} <span className="font-[family-name:var(--adv-font-mono)] text-[12px]">{count}</span>
            </button>
          ))}
        </div>
        <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[12px] text-[var(--adv-ink-4)]">
          queue reflects snapshot {snapshot ?? "—"}
          {windowLabel ? ` — ${windowLabel} scopes metrics, not decisions` : ""}
        </p>
        {/*
          The source's own health, kept beside the queue it produced. A degraded
          read still returns cards, so leaving this out would present a fallback
          as if it were the full engine verdict.
        */}
        {(degraded || presentation.source.adsSource !== "native_ad_decision") && (
          <p
            data-testid="decision-center-source-health"
            className="m-0 font-[family-name:var(--adv-font-mono)] text-[12px] text-[#8a5106]"
          >
            {degraded ? `source degraded · ${presentation.source.fallbackReason ?? "source fallback"}` : null}
            {degraded && presentation.source.adsSource !== "native_ad_decision" ? " · " : null}
            {presentation.source.adsSource !== "native_ad_decision" ? "legacy creative · review only" : null}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {DECISION_CENTER_QUEUES.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setQueue(key);
              setSelectedId(null);
            }}
            data-testid={`decision-center-queue-${key}`}
            className={cn(
              "inline-flex h-[34px] items-center gap-[7px] rounded-full border px-[14px] font-[family-name:var(--adv-font-body)] text-[13px] font-semibold",
              queue === key
                ? "border-[var(--adv-accent)] bg-[var(--adv-accent)] text-white"
                : "border-[var(--adv-border)] bg-[var(--adv-surface)] text-[var(--adv-ink-2)]",
            )}
          >
            {label}
            <span className="font-[family-name:var(--adv-font-mono)] text-[12px]">{counts[key]}</span>
          </button>
        ))}
      </div>

      <div className="grid items-start gap-3 [grid-template-columns:minmax(0,1.6fr)_minmax(300px,1fr)] max-[1100px]:[grid-template-columns:minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-2">
          {visible.length === 0 ? (
            <p className="m-0 rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-4 text-[12.5px] text-[var(--adv-ink-3)]">
              Nothing in this queue for the current snapshot. The count above is the server&apos;s, so an
              empty list here means the queue is genuinely empty rather than filtered away.
            </p>
          ) : (
            visible.map((item) => (
              <article
                key={item.id}
                data-testid="decision-center-card"
                onClick={() => setSelectedId(item.id)}
                className={cn(
                  "cursor-pointer rounded-[14px] border bg-[var(--adv-surface)] px-4 py-[14px]",
                  selected?.id === item.id ? "border-[var(--adv-accent-bd)]" : "border-[var(--adv-border)]",
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="m-0 font-[family-name:var(--adv-font-body)] text-[14px] font-semibold text-[var(--adv-ink)]">
                      {item.name}
                    </p>
                    <p className="m-0 mt-1 flex flex-wrap gap-1.5 font-[family-name:var(--adv-font-mono)] text-[12px] uppercase tracking-[0.08em] text-[var(--adv-ink-4)]">
                      <span>{item.levelLabel}</span>
                      {item.contextName ? <span>· {item.contextName}</span> : null}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-[var(--adv-fill-2)] px-[10px] py-[3px] text-[12px] font-bold text-[var(--adv-ink-2)]">
                    {item.confidence} confidence
                  </span>
                </div>

                <p className="m-0 mt-2 text-[12.5px] leading-[1.5] text-[var(--adv-ink-2)]">{item.assessment}</p>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span className="font-[family-name:var(--adv-font-mono)] text-[12.5px] text-[var(--adv-ink)]">
                    {money(item.spend, item.currency ?? currency)} · ROAS {ratio(item.roas)}
                  </span>
                  {item.targetRoas != null ? (
                    <span className="font-[family-name:var(--adv-font-mono)] text-[12px] text-[var(--adv-ink-4)]">
                      vs {ratio(item.targetRoas)} target
                    </span>
                  ) : null}
                  <span className="flex-1" />
                  {decisionCenterHasCommand(item) ? (
                    <button
                      type="button"
                      data-testid="decision-center-command"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCommand?.(item);
                      }}
                      className="h-[30px] rounded-[8px] bg-[var(--adv-accent)] px-3 text-[12.5px] font-semibold text-white"
                    >
                      {item.actionLabel}
                    </button>
                  ) : (
                    <span className="rounded-[8px] border border-[var(--adv-border)] px-3 py-1 text-[12px] font-semibold text-[var(--adv-ink-3)]">
                      {item.actionLabel}
                    </span>
                  )}
                </div>
              </article>
            ))
          )}
        </div>

        {/*
          A white panel under a dark header strip, measured from the reference
          (aside #fff, 1px #e4e8f0, radius 16px, body padding 16px, gap 14px).
          It was previously painted `--adv-rail` end to end, which read as a
          different component entirely beside the white cards it belongs to.
        */}
        <aside
          data-testid="decision-center-evidence"
          className="h-fit overflow-hidden rounded-[16px] border border-[var(--adv-border)] bg-[var(--adv-surface)]"
        >
          <div className="flex items-center justify-between gap-3 bg-[var(--adv-rail)] px-4 py-[10px]">
            <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[11px] uppercase tracking-[0.12em] text-[var(--adv-rail-ink-2)]">
              Evidence inspector
            </p>
            {selected ? (
              <span className="shrink-0 rounded-full bg-[#0e9f6e] px-[10px] py-[3px] font-[family-name:var(--adv-font-body)] text-[11.5px] font-semibold text-white">
                {selected.actionCode.replace(/_/g, " ")}
              </span>
            ) : null}
          </div>

          <div className="flex flex-col gap-[14px] p-4">
            {selected ? (
              <>
                <div>
                  <p className="m-0 font-[family-name:var(--adv-font-body)] text-[14px] font-semibold text-[var(--adv-ink)]">
                    {selected.name}
                  </p>
                  <p className="m-0 mt-1 font-[family-name:var(--adv-font-mono)] text-[11px] text-[var(--adv-ink-3)]">
                    {selected.levelLabel.toLowerCase()}
                    {selected.contextName ? ` \u00b7 ${selected.contextName}` : ""}
                  </p>
                </div>

                <div className="rounded-[11px] border border-[var(--adv-border)] bg-[var(--adv-fill)] p-3">
                  <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[11px] uppercase tracking-[0.1em] text-[var(--adv-ink-3)]">
                    Decision contract
                  </p>
                  <p className="m-0 mt-1 font-[family-name:var(--adv-font-body)] text-[12.5px] leading-[1.5] text-[var(--adv-ink-2)]">
                    Server verdict: <strong className="text-[var(--adv-ink)]">{selected.actionLabel}</strong>.{" "}
                    {selected.scopeNote}. The UI never computes this action.
                  </p>
                </div>

                {selected.whyNow ? (
                  <div>
                    <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[11px] uppercase tracking-[0.1em] text-[var(--adv-ink-3)]">
                      Why now
                    </p>
                    <p className="m-0 mt-1 font-[family-name:var(--adv-font-body)] text-[12.5px] leading-[1.5] text-[var(--adv-ink-2)]">
                      {selected.whyNow}
                    </p>
                  </div>
                ) : null}

                {selected.evidence.length > 0 ? (
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {selected.evidence.map((row) => (
                      <li
                        key={`${row.label}-${row.value}`}
                        className="flex items-baseline justify-between gap-3 font-[family-name:var(--adv-font-body)] text-[12.5px]"
                      >
                        <span className="text-[var(--adv-ink-3)]">{row.label}</span>
                        <span
                          className={cn(
                            "font-[family-name:var(--adv-font-mono)]",
                            row.tone === "warning"
                              ? "text-[#8a5106]"
                              : row.tone === "positive"
                                ? "text-[#0e9f6e]"
                                : "text-[var(--adv-ink)]",
                          )}
                        >
                          {row.value}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {selected.blockers.length > 0 ? (
                  <div>
                    <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[11px] uppercase tracking-[0.1em] text-[var(--adv-ink-3)]">
                      Blockers
                    </p>
                    <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0 font-[family-name:var(--adv-font-body)] text-[12.5px] text-[var(--adv-ink-2)]">
                      {selected.blockers.map((blocker) => (
                        <li key={blocker.code}>{blocker.label}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="m-0 font-[family-name:var(--adv-font-body)] text-[12.5px] text-[var(--adv-ink-3)]">
                Select a decision to read the evidence the server used.
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
