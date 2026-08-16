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
  decisionCenterItems,
  decisionCenterMoneyAtStake,
  decisionCenterQueueCounts,
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

function money(value: number | null, currency: string | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const body =
    abs >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(abs < 10 ? 2 : 0);
  return `${currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "TRY" ? "₺" : ""}${body}`;
}

function ratio(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
}

/** One KPI tile. Every tile states a server fact, never a derived verdict. */
function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "accent" | "warn" }) {
  return (
    <article className="flex min-w-0 flex-col gap-1 rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-4">
      <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[12px] uppercase tracking-[0.12em] text-[var(--adv-ink-3)]">
        {label}
      </p>
      <p
        className={cn(
          "m-0 font-[family-name:var(--adv-font-display)] text-[26px] font-bold leading-[1.05] tracking-[-0.02em]",
          tone === "accent" ? "text-[var(--adv-accent)]" : tone === "warn" ? "text-[#b45309]" : "text-[var(--adv-ink)]",
        )}
      >
        {value}
      </p>
      <p className="m-0 text-[12px] leading-[1.4] text-[var(--adv-ink-3)]">{note}</p>
    </article>
  );
}

export function DecisionCenterBody({
  presentation,
  accountLabel,
  currency,
  windowLabel,
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
          <p className="m-0 mt-1 font-[family-name:var(--adv-font-mono)] text-[12px] text-[var(--adv-ink-4)]">
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
            className="h-[34px] rounded-[9px] border border-[var(--adv-border)] bg-[var(--adv-surface)] px-3 text-[12.5px] font-semibold text-[var(--adv-ink-2)] disabled:opacity-50"
          >
            Run snapshot
          </button>
          <button
            type="button"
            onClick={onNewCampaign}
            data-testid="decision-center-new-campaign"
            className="h-[34px] rounded-[9px] bg-[var(--adv-accent)] px-3 text-[12.5px] font-semibold text-white"
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
        <Tile
          label="Action now"
          value={String(counts.act)}
          note={
            atStake.measured > 0
              ? `${money(atStake.total, atStake.currency ?? currency)} measured across ${atStake.measured}${atStake.unmeasured > 0 ? ` · ${atStake.unmeasured} unmeasured` : ""}`
              : "no measured spend on this queue"
          }
          tone="accent"
        />
        <Tile label="Watching" value={String(counts.monitor)} note="held for evidence, no command issued" />
        <Tile
          label="Blocked"
          value={String(counts.blocked)}
          note="authority withheld until the blocker clears"
          tone={counts.blocked > 0 ? "warn" : undefined}
        />
        <Tile
          label="Snapshot"
          value={snapshot ?? "—"}
          note={degraded ? `degraded · ${presentation.source.fallbackReason ?? "source fallback"}` : "healthy"}
          tone={degraded ? "warn" : undefined}
        />
        <Tile
          label="Engine"
          value={presentation.source.engineVersion ?? "—"}
          note={presentation.source.adsSource === "native_ad_decision" ? "native ad authority" : "legacy creative · review only"}
        />
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
                "h-[30px] rounded-[8px] px-3 text-[12.5px] font-semibold",
                layer === key ? "bg-[var(--adv-surface)] text-[var(--adv-ink)] shadow-sm" : "text-[var(--adv-ink-3)]",
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
              "inline-flex h-[30px] items-center gap-2 rounded-full px-3 text-[12.5px] font-semibold",
              queue === key
                ? "bg-[var(--adv-accent)] text-white"
                : "border border-[var(--adv-border)] bg-[var(--adv-surface)] text-[var(--adv-ink-2)]",
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
                  "cursor-pointer rounded-[14px] border bg-[var(--adv-surface)] p-4",
                  selected?.id === item.id ? "border-[var(--adv-accent-bd)]" : "border-[var(--adv-border)]",
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="m-0 text-[14.5px] font-semibold text-[var(--adv-ink)]">{item.name}</p>
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

        <aside
          data-testid="decision-center-evidence"
          className="rounded-[14px] bg-[var(--adv-rail)] p-4 text-[var(--adv-rail-ink)]"
        >
          <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[12px] uppercase tracking-[0.12em] text-[var(--adv-rail-ink-2)]">
            Evidence inspector
          </p>
          {selected ? (
            <>
              <p className="m-0 mt-2 text-[14.5px] font-semibold">{selected.name}</p>
              <p className="m-0 mt-0.5 font-[family-name:var(--adv-font-mono)] text-[12px] text-[var(--adv-rail-ink-3)]">
                {selected.levelLabel}
                {selected.contextName ? ` · ${selected.contextName}` : ""}
              </p>

              <div className="mt-3 rounded-[11px] bg-[var(--adv-rail-raised)] p-3">
                <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[12px] uppercase tracking-[0.1em] text-[var(--adv-rail-ink-2)]">
                  Decision contract
                </p>
                <p className="m-0 mt-1 text-[12.5px] leading-[1.5]">
                  Server verdict: <strong>{selected.actionLabel}</strong>. {selected.scopeNote}. The UI never
                  computes this action.
                </p>
              </div>

              {selected.whyNow ? (
                <>
                  <p className="m-0 mt-3 font-[family-name:var(--adv-font-mono)] text-[12px] uppercase tracking-[0.1em] text-[var(--adv-rail-ink-2)]">
                    Why now
                  </p>
                  <p className="m-0 mt-1 text-[12.5px] leading-[1.5]">{selected.whyNow}</p>
                </>
              ) : null}

              {selected.evidence.length > 0 ? (
                <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
                  {selected.evidence.map((row) => (
                    <li key={`${row.label}-${row.value}`} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                      <span className="text-[var(--adv-rail-ink-2)]">{row.label}</span>
                      <span className={cn("font-[family-name:var(--adv-font-mono)]", row.tone === "warning" && "text-[#fbbf24]")}>
                        {row.value}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {selected.blockers.length > 0 ? (
                <>
                  <p className="m-0 mt-3 font-[family-name:var(--adv-font-mono)] text-[12px] uppercase tracking-[0.1em] text-[var(--adv-rail-ink-2)]">
                    Blockers
                  </p>
                  <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0 text-[12.5px]">
                    {selected.blockers.map((blocker) => (
                      <li key={blocker.code}>{blocker.label}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : (
            <p className="m-0 mt-2 text-[12.5px] text-[var(--adv-rail-ink-2)]">
              Select a decision to read the evidence the server used.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
