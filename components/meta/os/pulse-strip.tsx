"use client";

import Link from "next/link";
import type { MetaPulsePayload } from "@/components/meta/redesign/types";
import { currencySymbolFor, formatCurrencySmart } from "@/lib/metric-format";
import styles from "./pulse-strip.module.css";

/**
 * Dashboard v2 pulse strip: five server-truth cells above the decision lanes.
 *
 * Every figure is read straight off the account-pulse payload. Anything the
 * server did not supply renders as an em dash — the page contract forbids
 * substituting zero for missing data.
 */

function dash(value: number | null | undefined, render: (value: number) => string) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return render(value);
}

function deltaPct(current: number | null | undefined, baseline: number | null | undefined) {
  if (
    current === null ||
    current === undefined ||
    baseline === null ||
    baseline === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(baseline) ||
    baseline === 0
  ) {
    return null;
  }
  return ((current - baseline) / baseline) * 100;
}

/** "engine_version_mismatch" reads as "Engine version mismatch". */
function humanize(value: string) {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function ageLabel(hours: number | null) {
  if (hours === null || !Number.isFinite(hours)) return "age —";
  if (hours < 1) return "under 1h old";
  if (hours < 48) return `${Math.round(hours)}h old`;
  return `${Math.round(hours / 24)}d old`;
}

function relativeMinutes(iso: string | null | undefined) {
  if (!iso) return "synced —";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "synced —";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `synced ${hours}h ago`;
  return `synced ${Math.round(hours / 24)}d ago`;
}

/** ROAS history against the dashed target line, in the design's 100×20 box. */
function RoasSpark({ history, target }: { history: number[]; target: number | null }) {
  if (history.length < 2) return null;
  const values = target !== null ? [...history, target] : history;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max === min ? 1 : max - min;
  const y = (value: number) => 18 - ((value - min) / span) * 16;
  const step = 100 / (history.length - 1);
  const path = history
    .map((value, index) => `${index ? "L" : "M"}${(index * step).toFixed(1)} ${y(value).toFixed(1)}`)
    .join(" ");

  return (
    <svg viewBox="0 0 100 20" preserveAspectRatio="none" className={styles.spark} aria-hidden="true">
      {target !== null ? (
        <path
          d={`M0 ${y(target).toFixed(1)} L100 ${y(target).toFixed(1)}`}
          stroke="var(--adv-scroll-thumb)"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <path
        d={path}
        fill="none"
        stroke="var(--adv-accent)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function MetaPulseStrip({
  pulse,
  currency,
  manageLabelsHref,
}: {
  pulse: MetaPulsePayload | null | undefined;
  currency: string | null;
  manageLabelsHref: string;
}) {
  const symbol = currencySymbolFor(currency);
  const money = (value: number) =>
    formatCurrencySmart(value, symbol, { compactLarge: false });

  // A partial or absent payload must degrade to em dashes, not throw.
  const spendToday = pulse?.pacing?.spendToday ?? null;
  const avg7dSpend = pulse?.pacing?.avg7dSpend ?? null;
  const spendDelta = deltaPct(spendToday, avg7dSpend);
  const conversionsToday = pulse?.pacing?.conversionsToday ?? null;
  const avg7dConversions = pulse?.pacing?.avg7dConversions ?? null;

  const roas = pulse?.roas?.selected ?? null;
  const target = pulse?.roas?.target ?? null;
  const snapshot = pulse?.snapshotHealth ?? null;
  const coverage = pulse?.labelCoverage ?? null;
  const coveragePct =
    coverage && coverage.activeCampaigns > 0
      ? Math.round((coverage.labeledCampaigns / coverage.activeCampaigns) * 100)
      : null;

  const snapshotTone =
    snapshot?.status === "fresh"
      ? "pos"
      : snapshot?.status === "stale" || snapshot?.status === "engine_version_mismatch"
        ? "warn"
        : "neutral";

  const trackingTone =
    pulse?.trackingHealth?.status === "healthy"
      ? "pos"
      : pulse?.trackingHealth?.status === "blocked"
        ? "neg"
        : pulse?.trackingHealth?.status === "degraded"
          ? "warn"
          : "neutral";

  return (
    <div className={styles.strip} data-testid="meta-pulse-strip">
      <article className={styles.cell}>
        <p className={styles.label}>Spend · today</p>
        <p className={styles.value}>
          {dash(spendToday, money)}
          {spendDelta !== null ? (
            <span
              className={styles.valueNote}
              data-tone={spendDelta >= 0 ? "pos" : "neg"}
            >
              {`${spendDelta > 0 ? "+" : ""}${spendDelta.toFixed(0)}% vs 7d avg`}
            </span>
          ) : null}
        </p>
        <p className={styles.foot}>
          {dash(conversionsToday, (value) => `${Math.round(value)} conversions`)} ·{" "}
          {dash(avg7dConversions, (value) => `7d avg ${Math.round(value)}`)}
        </p>
      </article>

      <article className={styles.cell}>
        <p className={styles.label}>ROAS · window</p>
        <p className={styles.value}>
          {dash(roas, (value) => value.toFixed(2))}
          <span className={styles.valueNote}>
            {target === null ? "no target anchored" : `target ${target.toFixed(2)}`}
          </span>
        </p>
        <RoasSpark history={pulse?.roasHistory ?? []} target={target} />
      </article>

      <article className={styles.cell}>
        <p className={styles.label}>Snapshot</p>
        <span className={styles.pill} data-tone={snapshotTone}>
          {snapshot ? `${humanize(snapshot.status)} · ${ageLabel(snapshot.ageHours)}` : "—"}
        </span>
        <p className={styles.foot}>
          {`engine ${pulse?.engineVersion ?? "—"} · ${relativeMinutes(pulse?.lastSyncAt)}`}
        </p>
      </article>

      <article className={styles.cell}>
        <p className={styles.label}>Labels</p>
        <p className={styles.value}>
          {coverage ? `${coverage.labeledCampaigns}/${coverage.activeCampaigns}` : "—"}
          {coveragePct !== null ? (
            <span className={styles.valueNote} data-tone={coveragePct >= 90 ? "pos" : "warn"}>
              {`${coveragePct}%`}
            </span>
          ) : null}
        </p>
        <Link href={manageLabelsHref} className={styles.link}>
          Manage labels →
        </Link>
      </article>

      <article className={styles.cell}>
        <p className={styles.label}>Mode</p>
        <p className={styles.mode}>
          {pulse?.operatingMode ? humanize(pulse.operatingMode) : "—"}
        </p>
        <div className={styles.tags}>
          {pulse?.seasonalRegime ? (
            <span className={styles.tag} data-tone="warn">
              {humanize(pulse.seasonalRegime)}
            </span>
          ) : null}
          <span className={styles.tag} data-tone={trackingTone}>
            {pulse?.trackingHealth
              ? `Tracking · ${humanize(pulse.trackingHealth.status)}`
              : "Tracking —"}
          </span>
        </div>
      </article>
    </div>
  );
}
