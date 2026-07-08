"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAppStore } from "@/store/app-store";
import type {
  MetaAutomationControlPlane,
  MetaAutomationReadinessControlTier,
} from "@/lib/meta/automation-control-plane";

type AutomationPayload = MetaAutomationControlPlane;

// ---------------------------------------------------------------------------
// Reference: "04 Automation.dc.html" — dense IBM Plex operator console.
// Two objects, never conflated: the server grades each recommendation with a
// readiness TIER, and the operator sets a standing MODE per decision type.
// The real control plane models automation at the BUSINESS level (one tier +
// guardrails + kill switches). Per-decision-type judged-outcome gates are NOT
// in the read model, so this surface renders the reference composition but
// shows honest "read model missing" gate states — never fabricated hit/judged
// numbers — and stays strictly read-only (automation is not executable here).
// Styled with the shell's --adc-* reference tokens (fallbacks for isolation).
// ---------------------------------------------------------------------------

const TIER_ORDER: MetaAutomationReadinessControlTier[] = [
  "read_only",
  "manual_review",
  "backtest_candidate",
  "auto_execute",
];

const TIER_LABEL: Record<MetaAutomationReadinessControlTier, string> = {
  read_only: "Read only",
  manual_review: "Manual review",
  backtest_candidate: "Backtest candidate",
  auto_execute: "Auto-execute",
};

const MODES = ["Manual", "Semi-auto", "Auto"] as const;
const MODE_VALUES = ["manual", "semi_auto", "auto"] as const;
// Maps the four action classes to the persisted decision_type key.
const DECISION_TYPE_KEY: Record<string, "pause" | "bid" | "budget" | "creative"> = {
  pause: "pause",
  bid: "bid",
  budget: "budget",
  creative: "creative",
};

// Known Meta action classes. Names/subs are static (the action classes are
// real); no per-type evidence or numbers are invented. `contract` reflects
// whether the write path is wired (guarded) or still pending a server contract.
const DECISION_TYPES = [
  {
    id: "pause",
    name: "Pause bleeding ad set",
    sub: "execute_pause on cut calls above the confidence act threshold",
    contract: "live",
  },
  {
    id: "bid",
    name: "Apply bid cap",
    sub: "execute_bid within the engine's proposed-cap bounds",
    contract: "live",
  },
  {
    id: "budget",
    name: "Budget change",
    sub: "apply ±% with caps",
    contract: "pending",
  },
  {
    id: "creative",
    name: "Creative pause (bulk)",
    sub: "bulk pause on cut creatives",
    contract: "pending",
  },
] as const;

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "—";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time));
}

function formatMinorMoney(value: number | null | undefined, currency: string | null | undefined) {
  if (value == null) return "not capped";
  const normalizedCurrency = currency && /^[A-Z]{3}$/.test(currency) ? currency : "EUR";
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: normalizedCurrency,
    maximumFractionDigits: 0,
  }).format(value / 100);
}

function notificationPolicyLabel(policy: AutomationPayload["businessControl"]["guardrails"]["notificationPolicy"]) {
  return policy === "every_auto_action" ? "on every auto action" : "not configured";
}

function severityTone(severity: AutomationPayload["activityLedger"][number]["severity"]) {
  if (severity === "danger") return "text-[var(--adc-danger-fg,#a6224a)]";
  if (severity === "warning") return "text-[var(--adc-caution-fg,#86590a)]";
  if (severity === "success") return "text-[var(--adc-pos-fg,#0b6b4f)]";
  return "text-[var(--adc-ink3,#7d838c)]";
}

// Current effective mode + capability ceiling, derived honestly from the
// business control row. Auto is only "current" when the server actually allows
// auto execution; the tier bounds which higher modes are unlocked at all.
function modeState(payload: AutomationPayload | null) {
  if (!payload) return { current: 0, ceiling: 0 };
  const tierIndex = TIER_ORDER.indexOf(payload.businessControl.readinessTier);
  const ceiling = tierIndex <= 1 ? 0 : tierIndex === 2 ? 1 : 2;
  const current = payload.execution.autoExecutionAllowed
    ? 2
    : payload.businessControl.autoExecutionEnabled && ceiling >= 1
      ? 1
      : 0;
  return { current: Math.min(current, ceiling), ceiling };
}

// --- token helpers (fallbacks keep the surface legible outside the shell) ---
const CARD =
  "rounded-[10px] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#fff)]";
const INK = "text-[var(--adc-ink,#1a1c1f)]";
const INK2 = "text-[var(--adc-ink2,#4a4f56)]";
const INK3 = "text-[var(--adc-ink3,#7d838c)]";

const TONES = {
  danger: "border-[var(--adc-danger-bd,#efc4d1)] bg-[var(--adc-danger-bg,#fbedf1)] text-[var(--adc-danger-fg,#a6224a)]",
  caution: "border-[var(--adc-caution-bd,#e8d5a6)] bg-[var(--adc-caution-bg,#faf2df)] text-[var(--adc-caution-fg,#86590a)]",
  info: "border-[var(--adc-info-bd,#c5d6f1)] bg-[var(--adc-info-bg,#ebf1fb)] text-[var(--adc-info-fg,#1d5fc4)]",
  neutral: "border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s3,#ededea)] text-[var(--adc-ink2,#4a4f56)]",
} as const;

function Banner({
  tone,
  title,
  children,
}: {
  tone: keyof typeof TONES;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`flex items-start gap-2.5 rounded-[8px] border px-3 py-2.5 text-[12.5px] leading-5 ${TONES[tone]}`} role="alert">
      <span className="mt-[5px] h-2 w-2 flex-none rounded-[2px] bg-current" aria-hidden="true" />
      <div className="min-w-0">
        <span className="font-semibold">{title}</span>
        {children ? <span className="opacity-90"> {children}</span> : null}
      </div>
    </div>
  );
}

function AutomationContextHeader({
  businessName,
  tier,
}: {
  businessName: string | null;
  tier: MetaAutomationReadinessControlTier | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--adc-b1,#e4e4e0)] pb-3">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-[var(--adc-ink,#1a1c1f)]">
          Automation
        </div>
        <div className="mt-0.5 font-mono text-[11px] text-[var(--adc-ink3,#7d838c)]">
          Meta · {businessName ?? "select business"}
        </div>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--adc-auto-bd,#d9ccf1)] bg-[var(--adc-auto-bg,#f2edfb)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--adc-auto-fg,#6c41be)]">
        <span className="h-1.5 w-1.5 rotate-45 bg-current" aria-hidden="true" />
        autopilot earned gradually
      </span>
      {tier ? (
        <span className="font-mono text-[11px] text-[var(--adc-ink3,#7d838c)]">
          readiness: {TIER_LABEL[tier]}
        </span>
      ) : null}
      <div className="min-w-0 flex-1" />
      <Link
        href="/platforms/meta"
        className="text-[12px] text-[var(--adc-info-fg,#1d5fc4)] hover:underline"
      >
        ← Decisions
      </Link>
    </div>
  );
}

function AutomationMobileSurface({
  businessName,
  payload,
  loading,
  error,
}: {
  businessName: string | null;
  payload: AutomationPayload | null;
  loading: boolean;
  error: string | null;
}) {
  const killSwitchEngaged =
    payload?.globalKillSwitch.engaged === true ||
    payload?.businessControl.killSwitchEngaged === true;
  const blockedReasons = payload?.execution.blockedReasons ?? [];
  const autoAllowed = payload?.execution.autoExecutionAllowed === true;
  const tier = payload?.businessControl.readinessTier ?? null;
  const guardrails = payload?.businessControl.guardrails ?? null;
  const mode = payload ? MODES[modeState(payload).current] : "—";
  const postureTone = killSwitchEngaged ? "danger" : autoAllowed ? "info" : "caution";
  const freshness =
    payload?.businessControl.updatedAt
      ? formatDateTime(payload.businessControl.updatedAt)
      : payload
        ? "persisted"
        : "—";

  return (
    <section
      className="meta-mobile-surface-stage"
      data-testid="meta-mobile-automation"
      aria-label="Automation mobile read-only"
    >
      <div className="ad-mobile-device">
        <div className="ad-mobile-screen">
          <div className="ad-mobile-status">
            <span>--:--</span>
            <span>Automation · read-only</span>
          </div>
          <div className="ad-mobile-freshness">
            synced {freshness} · tier {tier ? TIER_LABEL[tier] : "—"}
          </div>
          <div className="ad-mobile-title">
            <h2>{businessName ?? "Select business"}</h2>
            <p>Guardrails, readiness and stop posture only. Writes stay on desktop.</p>
          </div>
          {loading ? (
            <article className="ad-mobile-row-card">
              <h3>Automation contract</h3>
              <p>loading server control plane —</p>
            </article>
          ) : error ? (
            <article className="ad-mobile-anomaly" data-tone="danger">
              <b>Automation contract failed.</b>
              <div>{error}</div>
            </article>
          ) : payload ? (
            <>
              <article className="ad-mobile-anomaly" data-tone={postureTone}>
                <b>
                  {killSwitchEngaged
                    ? "Kill switch engaged."
                    : autoAllowed
                      ? "Auto execution currently allowed."
                      : "Automation is not executable yet."}
                </b>
                <div>
                  {blockedReasons.length > 0
                    ? `Blocked: ${blockedReasons.join(", ")}.`
                    : "No blocked reason is stored in the payload."}
                </div>
              </article>
              <article className="ad-mobile-row-card">
                <h3>Standing mode</h3>
                <p data-tone={autoAllowed ? "positive" : "caution"}>
                  {mode} · business-scoped posture
                </p>
                <div className="ad-mobile-row-footer">
                  <span>Per-type gates are read-model missing.</span>
                  <span>View only</span>
                </div>
              </article>
              <article className="ad-mobile-row-card">
                <h3>Guardrails</h3>
                <p>
                  {guardrails
                    ? `${guardrails.dailyAutoActionCap} / day · ${formatMinorMoney(
                        guardrails.perActionSpendCeilingMinor,
                        guardrails.perActionSpendCeilingCurrency,
                      )} ceiling`
                    : "guardrails missing —"}
                </p>
                <div className="ad-mobile-row-footer">
                  <span>{guardrails ? notificationPolicyLabel(guardrails.notificationPolicy) : "not loaded"}</span>
                  <span>STOP-only</span>
                </div>
              </article>
            </>
          ) : (
            <article className="ad-mobile-anomaly">
              <b>Select a business.</b>
              <div>Automation state is business-scoped; no default account is assumed.</div>
            </article>
          )}
          <div className="ad-mobile-desktop-note">
            Mobile is read-only — stop, promote, demote and write controls stay on desktop.
          </div>
        </div>
      </div>
    </section>
  );
}

function GuardrailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={`text-[12.5px] ${INK2}`}>{label}</span>
      <span className={`font-mono text-[12px] font-semibold tabular-nums ${INK}`}>{value}</span>
    </div>
  );
}

export function MetaAutomationView({
  businessName,
  payload,
  loading = false,
  error = null,
  onAutomationChange,
}: {
  businessName: string | null;
  payload: AutomationPayload | null;
  loading?: boolean;
  error?: string | null;
  onAutomationChange?: (payload: AutomationPayload) => void;
}) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string }>>([]);
  const [promotionDialog, setPromotionDialog] = useState<{
    decisionName: string;
    decisionType: "pause" | "bid" | "budget" | "creative";
    targetMode: string;
    targetModeValue: (typeof MODE_VALUES)[number];
    reason: string;
  } | null>(null);
  const blockedReasons = payload?.execution.blockedReasons ?? [];
  const killSwitchEngaged =
    payload?.globalKillSwitch.engaged === true ||
    payload?.businessControl.killSwitchEngaged === true;
  const autoAllowed = payload?.execution.autoExecutionAllowed === true;
  const tier = payload?.businessControl.readinessTier ?? null;
  const { current: currentMode, ceiling: modeCeiling } = modeState(payload);
  const guardrails = payload?.businessControl.guardrails ?? null;

  function pushToast(text: string) {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { id, text }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, 5000);
  }

  async function stopAllWrites() {
    if (!payload || killSwitchEngaged || pendingAction) return;
    setPendingAction("kill_switch");
    try {
      const response = await fetch(`/api/meta/automation?businessId=${encodeURIComponent(payload.businessId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "engage_kill_switch",
          reason: "Operator stopped all Meta writes from Automation.",
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; automation?: AutomationPayload; error?: { message?: string } }
        | null;
      if (!response.ok || body?.ok === false || !body?.automation) {
        throw new Error(body?.error?.message ?? "Kill switch could not be engaged.");
      }
      onAutomationChange?.(body.automation);
      pushToast("Kill switch engaged — all Meta writes are stopped.");
    } catch (stopError) {
      pushToast(
        stopError instanceof Error
          ? stopError.message
          : "Kill switch could not be engaged.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function resumeWrites() {
    if (!payload || !payload.businessControl.killSwitchEngaged || pendingAction) return;
    setPendingAction("kill_switch");
    try {
      const response = await fetch(`/api/meta/automation?businessId=${encodeURIComponent(payload.businessId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release_kill_switch" }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; automation?: AutomationPayload; error?: { message?: string } }
        | null;
      if (!response.ok || body?.ok === false || !body?.automation) {
        throw new Error(body?.error?.message ?? "Kill switch could not be released.");
      }
      onAutomationChange?.(body.automation);
      pushToast("Business kill switch released — writes resume subject to the remaining gates.");
    } catch (releaseError) {
      pushToast(
        releaseError instanceof Error
          ? releaseError.message
          : "Kill switch could not be released.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  // Persist a per-decision-type standing mode. Demotions apply immediately; promotions
  // arrive here already confirmed via the dialog. This records the operator preference
  // (with a real audit row) — it does NOT auto-execute; writes stay gated.
  async function setDecisionMode(
    decisionType: "pause" | "bid" | "budget" | "creative",
    modeValue: (typeof MODE_VALUES)[number],
  ) {
    if (!payload || pendingAction) return;
    setPendingAction(`mode:${decisionType}`);
    try {
      const response = await fetch(`/api/meta/automation?businessId=${encodeURIComponent(payload.businessId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set_decision_type_mode", decisionType, mode: modeValue }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; automation?: AutomationPayload; error?: { message?: string } }
        | null;
      if (!response.ok || body?.ok === false || !body?.automation) {
        throw new Error(body?.error?.message ?? "Standing mode could not be saved.");
      }
      onAutomationChange?.(body.automation);
      pushToast(`${decisionType} standing mode saved. Auto execution still honors the kill switch and gates.`);
    } catch (modeError) {
      pushToast(modeError instanceof Error ? modeError.message : "Standing mode could not be saved.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div
      className={`meta-automation-final flex min-h-[calc(100vh-46px)] flex-col bg-[var(--adc-s1,#f5f5f3)] text-[13px] leading-[1.45] ${INK}`}
      data-screen-label="Automation"
    >
      <AutomationMobileSurface
        businessName={businessName}
        payload={payload}
        loading={loading}
        error={error}
      />
      <main className="mx-auto flex w-full max-w-[1080px] flex-1 flex-col gap-4 px-4 py-[18px] sm:px-5">
        <AutomationContextHeader businessName={businessName} tier={tier} />

        {/* Two-objects explainer (educational, matches the reference intent) */}
        <p className={`max-w-[760px] text-[12.5px] leading-6 ${INK2}`}>
          Two different objects, never conflated: the server grades each{" "}
          <b className="font-semibold">recommendation</b> with an automation-readiness tier
          (read_only → manual_review → backtest_candidate → auto_execute), and you set a standing{" "}
          <b className="font-semibold">mode</b> per decision type. An Auto mode still skips any
          recommendation whose tier is below auto_execute. Promotion is never automatic; demotion
          is always one click. This surface is read-only — it reflects server state and never issues
          writes.
        </p>

      {/* Honest state banners */}
      {!businessName ? (
        <Banner tone="caution" title="Select a business.">
          Automation state is business-scoped — no default account is assumed.
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="danger" title="Automation contract failed.">
          {error}
        </Banner>
      ) : null}
      {loading ? (
        <Banner tone="neutral" title="Loading automation contract…">
          Reading persisted guardrails, promotion records, activity, and kill-switch posture.
        </Banner>
      ) : null}
      {payload && killSwitchEngaged ? (
        <Banner tone="danger" title="Kill switch engaged — all Meta writes are disabled.">
          {payload.businessControl.killSwitchReason
            ? `${payload.businessControl.killSwitchReason} `
            : ""}
          {blockedReasons.length > 0
            ? `Blocked: ${blockedReasons.join(", ")}.`
            : "Release the business switch from Guardrails below to resume; a global (env) stop clears only from configuration. The queue stays readable."}
        </Banner>
      ) : null}
      {payload && !killSwitchEngaged && !autoAllowed ? (
        <Banner tone="caution" title="Automation is not executable yet.">
          {blockedReasons.length > 0
            ? `The backend contract does not allow auto execution: ${blockedReasons.join(", ")}.`
            : "The backend contract does not currently allow automatic execution."}
        </Banner>
      ) : null}

      {/* ============ Standing mode — per decision type ============ */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className={`text-[13px] font-semibold ${INK}`}>Standing mode — per decision type</h2>
          <span className={`text-[11px] ${INK3}`}>
            posture is modeled per business today
          </span>
        </div>
        <p className={`text-[11.5px] leading-5 ${INK3}`}>
          Per-decision-type judged-outcome gates are not in the read model, so no hit/judged
          numbers are shown until the server provides them — progress is never faked. Modes below
          reflect the current business posture and are not editable from this page.
        </p>

        <div className="flex flex-col gap-2.5">
          {DECISION_TYPES.map((type) => (
            <div
              key={type.id}
              className={`flex flex-wrap items-center gap-4 px-4 py-3.5 ${CARD}`}
            >
              <div className="min-w-[220px] flex-1">
                <div className="flex items-center gap-2">
                  <span className={`text-[13.5px] font-semibold ${INK}`}>{type.name}</span>
                  {type.contract === "pending" ? (
                    <span className="rounded-[4px] border border-[var(--adc-b1,#e4e4e0)] px-1.5 py-px font-mono text-[10px] text-[var(--adc-ink3,#7d838c)]">
                      write path pending server contract
                    </span>
                  ) : (
                    <span className="rounded-[4px] border border-[var(--adc-pos-bd,#bfdfd1)] bg-[var(--adc-pos-bg,#e9f4ef)] px-1.5 py-px font-mono text-[10px] text-[var(--adc-pos-fg,#0b6b4f)]">
                      write path wired · kill-switch guarded
                    </span>
                  )}
                </div>
                <div className={`mt-0.5 text-[11.5px] ${INK3}`}>{type.sub}</div>
                {/* honest per-type gate: indeterminate track, no fabricated fill */}
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-1.5 max-w-[260px] flex-1 overflow-hidden rounded-[3px] bg-[var(--adc-s3,#ededea)]">
                    <div className="h-full w-full bg-[repeating-linear-gradient(45deg,var(--adc-b1,#e4e4e0)_0_5px,transparent_5px_10px)]" />
                  </div>
                  <span className={`font-mono text-[11px] ${INK3}`}>
                    per-type evidence gate: read model missing
                  </span>
                </div>
              </div>

              {/* per-type standing mode: demote applies immediately, promote opens a confirm */}
              {(() => {
                const typeKey = DECISION_TYPE_KEY[type.id];
                const typeModeRow = payload?.decisionTypeModes.find((m) => m.decisionType === typeKey);
                const currentTypeMode = typeModeRow ? MODE_VALUES.indexOf(typeModeRow.mode) : 0;
                const modePending = pendingAction === `mode:${typeKey}`;
                return (
                  <div className="flex flex-none gap-1" role="group" aria-label={`Standing mode for ${type.name}`}>
                    {MODES.map((mode, i) => {
                      const isCurrent = payload != null && i === currentTypeMode;
                      const isLocked = payload != null && i > modeCeiling;
                      const canDemote = payload != null && i < currentTypeMode && !isLocked && !modePending;
                      const canPromote = payload != null && i > currentTypeMode && !isLocked && !modePending;
                      const isAuto = i === 2;
                      const cls = isCurrent
                        ? isAuto
                          ? "border-[var(--adc-auto-bd,#d9ccf1)] bg-[var(--adc-auto-bg,#f2edfb)] text-[var(--adc-auto-fg,#6c41be)] font-semibold"
                          : "border-[var(--adc-b2,#cdcdc7)] bg-[var(--adc-s3,#ededea)] text-[var(--adc-ink,#1a1c1f)] font-semibold"
                        : isLocked
                          ? "border-dashed border-[var(--adc-b1,#e4e4e0)] text-[var(--adc-ink3,#7d838c)] opacity-70"
                          : "border-[var(--adc-b1,#e4e4e0)] text-[var(--adc-ink2,#4a4f56)]";
                      return (
                        <button
                          key={mode}
                          type="button"
                          data-decision-mode={`${typeKey}:${MODE_VALUES[i]}`}
                          title={
                            !payload
                              ? "Not loaded"
                              : isCurrent
                                ? "Current standing mode"
                                : isLocked
                                  ? `Locked — requires a higher readiness tier than ${tier ? TIER_LABEL[tier] : "current"}`
                                  : canDemote
                                    ? "Demote — applies immediately"
                                    : "Promote — opens the confirmation"
                          }
                          disabled={!canDemote && !canPromote}
                          onClick={() => {
                            if (canDemote) {
                              void setDecisionMode(typeKey, MODE_VALUES[i]);
                            } else if (canPromote) {
                              setPromotionDialog({
                                decisionName: type.name,
                                decisionType: typeKey,
                                targetMode: mode,
                                targetModeValue: MODE_VALUES[i],
                                reason:
                                  "Recording a standing preference. Auto execution still requires the readiness tier, kill switch off and dry-run cleared.",
                              });
                            }
                          }}
                          className={`rounded-[6px] border px-3 py-[5px] text-[12px] disabled:cursor-not-allowed ${canDemote || canPromote ? "cursor-pointer" : ""} ${cls}`}
                        >
                          {mode}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
      </section>

      {/* ============ Guardrails + Activity ============ */}
      <div className="grid gap-3 lg:grid-cols-[1fr_1.3fr]">
        {/* Guardrails — server-enforced */}
        <section className={`p-4 ${CARD}`}>
          <h2 className={`mb-3 text-[13px] font-semibold ${INK}`}>Guardrails — server-enforced</h2>
          {guardrails ? (
            <div className="flex flex-col gap-2">
              <GuardrailRow
                label="Daily auto-action cap"
                value={`${guardrails.dailyAutoActionCap} / day`}
              />
              <GuardrailRow
                label="Per-action spend ceiling"
                value={formatMinorMoney(
                  guardrails.perActionSpendCeilingMinor,
                  guardrails.perActionSpendCeilingCurrency,
                )}
              />
              <GuardrailRow
                label="Notification policy"
                value={notificationPolicyLabel(guardrails.notificationPolicy)}
              />
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-[var(--adc-b1,#e4e4e0)] pt-2.5">
                <span className={`text-[12.5px] ${INK2}`}>Business kill switch</span>
                {payload?.businessControl.killSwitchEngaged ? (
                  <button
                    type="button"
                    disabled={!payload || pendingAction === "kill_switch"}
                    onClick={resumeWrites}
                    className="rounded-[6px] border border-[var(--adc-b2,#cdcdc7)] bg-white px-2.5 py-1 text-[12px] font-medium text-[var(--adc-ink,#1a1c1f)] hover:border-[var(--adc-ink3,#7d838c)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {pendingAction === "kill_switch" ? "Resuming…" : "Resume writes"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!payload || pendingAction === "kill_switch"}
                    onClick={stopAllWrites}
                    className="rounded-[6px] border border-[var(--adc-danger-bd,#efc4d1)] bg-[var(--adc-danger-bg,#fbedf1)] px-2.5 py-1 text-[12px] font-medium text-[var(--adc-danger-fg,#a6224a)] hover:border-[var(--adc-danger-fg,#a6224a)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {pendingAction === "kill_switch" ? "Stopping…" : "Stop all writes"}
                  </button>
                )}
              </div>
              <p className={`font-mono text-[11px] leading-5 ${INK3}`}>
                backend prerequisites: max budget +{guardrails.maxBudgetIncreasePct}% · labels{" "}
                {guardrails.requireCampaignLabel ? "required" : "optional"} · commercial anchor{" "}
                {guardrails.requireCommercialAnchor ? "required" : "optional"} · live preflight{" "}
                {guardrails.requireLivePreflight ? "required" : "optional"} · rollback plan{" "}
                {guardrails.requireRollbackPlan ? "required" : "optional"} · dry-run{" "}
                {guardrails.dryRunOnly ? "on" : "off"}
              </p>
            </div>
          ) : (
            <p className={`text-[12.5px] ${INK3}`}>
              Guardrails are missing until the server returns a business-scoped control row.
            </p>
          )}
          <p className={`mt-3 text-[11px] leading-5 ${INK3}`}>
            The kill switch exists to STOP — there is deliberately no “enable all automation”
            master switch. Auto actions run the same validation, audit log and Meta verification as
            manual writes.
          </p>
        </section>

        {/* Activity — auto-executed ledger */}
        <section className={`p-4 ${CARD}`}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className={`text-[13px] font-semibold ${INK}`}>Activity — auto-executed ledger</h2>
            <span className={`text-[11px] ${INK3}`}>a filtered Audit Trail view</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {(payload?.activityLedger ?? []).map((item) => (
              <div
                key={item.id}
                className="rounded-[8px] border border-[var(--adc-b1,#e4e4e0)] px-3 py-2.5 text-[12px]"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className={`min-w-0 ${INK}`}>
                    <b className="font-semibold">{item.message}</b>{" "}
                    <span className={INK3}>
                      · {item.source === "automation_ledger" ? "Automation" : "Meta action log"}
                    </span>
                  </span>
                  <span className={`flex-none font-medium ${severityTone(item.severity)}`}>
                    {item.severity === "success" ? "verified" : item.severity === "warning" ? "no write" : item.severity}
                  </span>
                </div>
                <div className={`mt-1 flex items-center justify-between gap-2 font-mono text-[11px] ${INK3}`}>
                  <span>
                    {item.activityType} · tier at action: unknown · daily cap check stored in payload when available
                  </span>
                  <span className="tabular-nums">{formatDateTime(item.createdAt)}</span>
                </div>
              </div>
            ))}
            {payload && payload.activityLedger.length === 0 ? (
              <p className={`rounded-[8px] border border-dashed border-[var(--adc-b1,#e4e4e0)] px-3 py-3 text-[12px] ${INK3}`}>
                No automation or Meta action activity is stored yet. Auto-executed actions and
                skips will appear here once they occur — nothing is claimed until it happens.
              </p>
            ) : null}
            {!payload && !loading ? (
              <p className={`text-[12px] ${INK3}`}>Activity is not loaded.</p>
            ) : null}
          </div>
        </section>
      </div>

      {/* ============ Promotion records ============ */}
      <section className={`p-4 ${CARD}`}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className={`text-[13px] font-semibold ${INK}`}>Promotion records</h2>
          <span className={`text-[11px] ${INK3}`}>evidence only — never triggers writes from here</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {(payload?.promotionRecords ?? []).map((record) => (
            <div
              key={record.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[8px] border border-[var(--adc-b1,#e4e4e0)] px-3 py-2.5 text-[12px]"
            >
              <span className={`font-medium ${INK}`}>
                {record.entityType} {record.entityId ?? "—"}
              </span>
              <span className={`font-mono text-[11px] ${INK3}`}>
                {record.sourceTier ?? "—"} → {record.targetTier ?? "—"}
              </span>
              <span className={INK2}>{record.reason ?? "No reason stored"}</span>
              <span className="flex-1" />
              <span className={`font-medium ${INK2}`}>{record.status}</span>
              <span className={`font-mono text-[11px] tabular-nums ${INK3}`}>
                {formatDateTime(record.createdAt)}
              </span>
            </div>
          ))}
          {payload && payload.promotionRecords.length === 0 ? (
            <p className={`rounded-[8px] border border-dashed border-[var(--adc-b1,#e4e4e0)] px-3 py-3 text-[12px] ${INK3}`}>
              No promotion records stored yet. Promotion is operator-confirmed and logged — no
              history is claimed until records exist.
            </p>
          ) : null}
          {!payload && !loading ? (
            <p className={`text-[12px] ${INK3}`}>Promotion records are not loaded.</p>
          ) : null}
        </div>
      </section>

      </main>

      {promotionDialog ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(16,18,22,0.4)] px-4"
          role="presentation"
          onClick={() => setPromotionDialog(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Promote ${promotionDialog.decisionName}`}
            className={`${CARD} flex w-[460px] max-w-[92vw] flex-col gap-3 border-[var(--adc-b2,#cdcdc7)] p-5 shadow-[0_8px_28px_rgba(20,22,26,.14)]`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={`text-[15px] font-semibold ${INK}`}>
              Promote “{promotionDialog.decisionName}” to {promotionDialog.targetMode}
            </div>
            <p className={`text-[12.5px] leading-6 ${INK2}`}>
              {promotionDialog.reason} Confirming records this standing preference with an audit
              row; it does not issue any Meta write on its own.
            </p>
            <div className="rounded-[8px] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] px-3 py-2.5 text-[12px] leading-6">
              Guardrails restated:<br />
              · max {guardrails?.dailyAutoActionCap ?? 3} auto actions/day ·{" "}
              {formatMinorMoney(
                guardrails?.perActionSpendCeilingMinor,
                guardrails?.perActionSpendCeilingCurrency,
              )}{" "}
              per-action ceiling
              <br />
              · {guardrails ? notificationPolicyLabel(guardrails.notificationPolicy) : "notification policy missing"} ·
              kill switch always live
              <br />
              · skips protected entities and tiers below auto_execute
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPromotionDialog(null)}
                className="rounded-[6px] border border-[var(--adc-b2,#cdcdc7)] px-3 py-1.5 text-[12px]"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-promotion"
                disabled={pendingAction != null}
                onClick={() => {
                  const dialog = promotionDialog;
                  setPromotionDialog(null);
                  void setDecisionMode(dialog.decisionType, dialog.targetModeValue);
                }}
                className="rounded-[6px] border border-[var(--adc-auto-bd,#d9ccf1)] bg-[var(--adc-auto-bg,#f2edfb)] px-3 py-1.5 text-[12px] font-medium text-[var(--adc-auto-fg,#6c41be)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Confirm promotion
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div
        aria-live="polite"
        className="fixed bottom-4 left-1/2 z-[120] flex -translate-x-1/2 flex-col items-center gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="rounded-[8px] bg-[var(--adc-ink,#1a1c1f)] px-3.5 py-2 text-[12.5px] text-[var(--adc-s1,#f5f5f3)] shadow-[0_8px_28px_rgba(20,22,26,.14)]"
          >
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MetaAutomationPage() {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const businessName = useMemo(
    () => businesses.find((business) => business.id === selectedBusinessId)?.name ?? null,
    [businesses, selectedBusinessId],
  );
  const [payload, setPayload] = useState<AutomationPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedBusinessId) {
      setPayload(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/meta/automation?businessId=${encodeURIComponent(selectedBusinessId)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { ok?: boolean; automation?: AutomationPayload; error?: { message?: string } }
          | null;
        if (!response.ok || body?.ok === false || !body?.automation) {
          throw new Error(body?.error?.message ?? "Automation contract failed.");
        }
        setPayload(body.automation);
      })
      .catch((fetchError: unknown) => {
        if (controller.signal.aborted) return;
        setPayload(null);
        setError(fetchError instanceof Error ? fetchError.message : "Automation contract failed.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selectedBusinessId]);

  return (
    <MetaAutomationView
      businessName={businessName}
      payload={payload}
      loading={loading}
      error={error}
      onAutomationChange={setPayload}
    />
  );
}
