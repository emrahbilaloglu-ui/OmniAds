import type { ReactNode } from "react";
import type { InsightWidget } from "@/components/common/briefing/InsightsPanel";

export interface LabelsCoverageInput {
  activeCampaigns: number;
  labeledCampaigns: number;
  unlabeledCampaigns: number;
  mainCount?: number | null;
  testCount?: number | null;
  mixedCount?: number | null;
  fixHref?: string;
  onFixGaps?: () => void;
  scopeNote?: string;
}

export function buildLabelsCoverageWidget(
  input: LabelsCoverageInput | null | undefined,
): InsightWidget | null {
  if (!input || input.activeCampaigns <= 0) return null;
  const coveragePct = Math.round(
    (input.labeledCampaigns / input.activeCampaigns) * 100,
  );
  const hasBreakdown =
    (input.mainCount ?? 0) + (input.testCount ?? 0) + (input.mixedCount ?? 0) > 0;
  const main = hasBreakdown ? (input.mainCount ?? 0) : input.labeledCampaigns;
  const test = hasBreakdown ? (input.testCount ?? 0) : 0;
  const mixed = hasBreakdown ? (input.mixedCount ?? 0) : 0;
  const none = input.unlabeledCampaigns;
  const total = main + test + mixed + none;
  const widthFor = (count: number) =>
    total > 0 ? `${Math.round((count / total) * 100)}%` : "0%";
  const needsAttention = input.unlabeledCampaigns > 0;

  return {
    key: "labels-coverage",
    title: "Campaign labels",
    trailingLabel: `${coveragePct}%`,
    needsAttention,
    content: (
      <div className="text-[12.5px] leading-relaxed">
        <div className="flex h-2.5 overflow-hidden rounded-full bg-neutral-100">
          {main > 0 ? (
            <span
              className="block h-full bg-neutral-900"
              style={{ width: widthFor(main) }}
              aria-hidden="true"
            />
          ) : null}
          {test > 0 ? (
            <span
              className="block h-full bg-blue-600"
              style={{ width: widthFor(test) }}
              aria-hidden="true"
            />
          ) : null}
          {mixed > 0 ? (
            <span
              className="block h-full bg-amber-500"
              style={{ width: widthFor(mixed) }}
              aria-hidden="true"
            />
          ) : null}
          {none > 0 ? (
            <span
              className="block h-full"
              style={{
                width: widthFor(none),
                backgroundImage:
                  "repeating-linear-gradient(45deg, #f5f5f5 0 4px, #d4d4d4 4px 8px)",
              }}
              aria-hidden="true"
            />
          ) : null}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-3 text-[11px] text-neutral-500">
          {hasBreakdown ? (
            <>
              <LegendDot color="bg-neutral-900" label={`Main ${main}`} />
              <LegendDot color="bg-blue-600" label={`Test ${test}`} />
              <LegendDot color="bg-amber-500" label={`Mixed ${mixed}`} />
            </>
          ) : (
            <LegendDot
              color="bg-neutral-900"
              label={`Labeled ${input.labeledCampaigns}`}
            />
          )}
          <LegendDot
            color="bg-neutral-200 border border-neutral-300"
            label={`None ${none}`}
          />
        </div>
        <div className="mt-3 text-[12px] text-neutral-600">
          {input.labeledCampaigns}/{input.activeCampaigns} active campaigns labeled
        </div>
        {input.scopeNote ? (
          <div className="mt-1 text-[11px] text-neutral-500">{input.scopeNote}</div>
        ) : null}
        {needsAttention ? (
          <div className="mt-3">
            {input.onFixGaps ? (
              <button
                type="button"
                onClick={input.onFixGaps}
                className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[12px] font-semibold text-blue-700 hover:bg-blue-100"
              >
                Fix {input.unlabeledCampaigns} unlabeled
              </button>
            ) : (
              <a
                href={input.fixHref ?? "#campaign-labels"}
                className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[12px] font-semibold text-blue-700 hover:bg-blue-100"
              >
                Fix {input.unlabeledCampaigns} unlabeled
              </a>
            )}
          </div>
        ) : null}
      </div>
    ),
  };
}

export interface TargetAnchorInput {
  configured: boolean;
  targetRoas?: number | null;
  breakEvenRoas?: number | null;
  median?: number | null;
  setAnchorHref?: string;
  onSetAnchor?: () => void;
}

export function buildTargetAnchorWidget(
  input: TargetAnchorInput | null | undefined,
): InsightWidget | null {
  if (!input) return null;
  const trailing = input.configured ? "set" : "missing";

  return {
    key: "target-anchor",
    title: "Target anchor",
    trailingLabel: trailing,
    needsAttention: !input.configured,
    content: (
      <div className="text-[12.5px] leading-relaxed text-neutral-700">
        {input.configured ? (
          <div className="space-y-1">
            <div>
              Breakeven · <b className="text-neutral-900">{formatRatio(input.breakEvenRoas)}</b>
            </div>
            <div>
              Target ·{" "}
              <b className="text-neutral-900">{formatRatio(input.targetRoas)}</b>
            </div>
            {input.median != null ? (
              <div>
                Median 90d · <b className="text-neutral-900">{formatRatio(input.median)}</b>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div>
              No target ROAS anchor for this account. Without it, hard cut and
              scale verdicts stay capped.
            </div>
            <div className="mt-3">
              {input.onSetAnchor ? (
                <button
                  type="button"
                  onClick={input.onSetAnchor}
                  className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[12px] font-semibold text-blue-700 hover:bg-blue-100"
                >
                  Set anchor…
                </button>
              ) : (
                <a
                  href={input.setAnchorHref ?? "/commercial-truth"}
                  className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[12px] font-semibold text-blue-700 hover:bg-blue-100"
                >
                  Set anchor…
                </a>
              )}
            </div>
          </>
        )}
      </div>
    ),
  };
}

export interface EngineStatusInput {
  version: string | null;
  lastRunAt: string | null;
  operatingMode?: string | null;
  snapshotStatus?: "fresh" | "stale" | "missing" | "engine_version_mismatch" | null;
}

export function buildEngineStatusWidget(
  input: EngineStatusInput | null | undefined,
): InsightWidget | null {
  if (!input) return null;
  const versionLabel = input.version?.trim() || "—";
  const lastRunLabel = formatLastRun(input.lastRunAt);
  const needsAttention =
    input.snapshotStatus != null && input.snapshotStatus !== "fresh";

  return {
    key: "engine",
    title: "Engine",
    trailingLabel: versionLabel,
    needsAttention,
    content: (
      <div className="text-[12.5px] leading-relaxed text-neutral-700">
        <div>
          Last run · <b className="text-neutral-900">{lastRunLabel}</b>
        </div>
        {input.operatingMode ? (
          <div>
            Operating mode ·{" "}
            <b className="text-neutral-900">{input.operatingMode}</b>
          </div>
        ) : null}
        {needsAttention && input.snapshotStatus ? (
          <div className="mt-2 inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800">
            snapshot · {input.snapshotStatus.replace(/_/g, " ")}
          </div>
        ) : null}
      </div>
    ),
  };
}

export interface AnomaliesInput {
  activeCount: number;
  onView?: () => void;
  viewHref?: string;
  detail?: string;
}

export function buildAnomaliesWidget(
  input: AnomaliesInput | null | undefined,
): InsightWidget | null {
  if (!input) return null;
  const active = input.activeCount > 0;

  return {
    key: "anomalies",
    title: "Anomalies",
    trailingLabel: active
      ? `${input.activeCount} active`
      : "0 active",
    needsAttention: active,
    content: (
      <div className="text-[12.5px] leading-relaxed text-neutral-600">
        {active ? (
          <>
            <div className="text-neutral-800">
              {input.detail ??
                "Tracking, delivery, sync, or performance anomalies are open. Destructive actions require confirmation."}
            </div>
            <div className="mt-3">
              {input.onView ? (
                <button
                  type="button"
                  onClick={input.onView}
                  className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] font-semibold text-amber-800 hover:bg-amber-100"
                >
                  View anomalies
                </button>
              ) : input.viewHref ? (
                <a
                  href={input.viewHref}
                  className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] font-semibold text-amber-800 hover:bg-amber-100"
                >
                  View anomalies
                </a>
              ) : null}
            </div>
          </>
        ) : (
          <span>No active tracking, delivery, or sync anomalies.</span>
        )}
      </div>
    ),
  };
}

function LegendDot({ color, label }: { color: string; label: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={`inline-block h-2.5 w-2.5 rounded-sm ${color}`} aria-hidden="true" />
      {label}
    </span>
  );
}

function formatRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

function formatLastRun(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "just now";
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
