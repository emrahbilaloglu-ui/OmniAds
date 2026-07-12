"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleStop,
  Clock3,
  Database,
  Lock,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  MetaAutomationControlPlane,
  MetaAutomationDecisionMode,
  MetaAutomationDecisionType,
  MetaAutomationReadinessControlTier,
} from "@/lib/meta/automation-control-plane";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import { useAppStore } from "@/store/app-store";
import styles from "./automation.module.css";

type AutomationPayload = MetaAutomationControlPlane;

type CanonicalMode =
  "Observe" | "Recommend" | "Approval Required" | "Auto-execute";

type EffectiveAuthority = {
  mode: CanonicalMode;
  reason: string;
};

type BadgeTone =
  "neutral" | "danger" | "warning" | "success" | "info" | "automation";

export type AutomationTab =
  "authority" | "evidence" | "guardrails" | "activity";

const AUTOMATION_TABS: Array<{
  id: AutomationTab;
  label: string;
}> = [
  { id: "authority", label: "Effective authority" },
  { id: "evidence", label: "Evidence" },
  { id: "guardrails", label: "Guardrails" },
  { id: "activity", label: "Activity" },
];

const READINESS_LABELS: Record<MetaAutomationReadinessControlTier, string> = {
  read_only: "Read only",
  manual_review: "Manual review",
  backtest_candidate: "Backtest candidate",
  auto_execute: "Auto-execute",
};

const LEGACY_MODE_LABELS: Record<MetaAutomationDecisionMode, string> = {
  manual: "manual",
  semi_auto: "semi_auto",
  auto: "auto",
};

const ACTION_CLASSES: Array<{
  id: string;
  preferenceType: MetaAutomationDecisionType;
  name: string;
  detail: string;
}> = [
  {
    id: "pause_underperformer",
    preferenceType: "pause",
    name: "Pause underperformer",
    detail: "Single campaign or ad-set containment after review",
  },
  {
    id: "cut_sustained_loss",
    preferenceType: "pause",
    name: "Cut sustained loss",
    detail: "Single-ad pause after mature loss evidence",
  },
  {
    id: "apply_bid_cap",
    preferenceType: "bid",
    name: "Apply bid or cost cap",
    detail: "Ad-set-owned bid control with provider preflight",
  },
  {
    id: "promote_test_to_main",
    preferenceType: "creative",
    name: "Promote test to Main",
    detail: "Budget-neutral PAUSED copy routed through Launchpad",
  },
  {
    id: "refresh_fatigued",
    preferenceType: "creative",
    name: "Refresh fatigued",
    detail: "Creative recommendation; no direct provider mutation",
  },
  {
    id: "rebuild_structure",
    preferenceType: "creative",
    name: "Rebuild structure",
    detail: "Launchpad-only rebuild with immutable source lineage",
  },
  {
    id: "swap_placement",
    preferenceType: "creative",
    name: "Swap placement",
    detail: "Observe-only until a provider contract exists",
  },
  {
    id: "duplicate_winner",
    preferenceType: "creative",
    name: "Duplicate winner",
    detail: "Contain-only duplicate path; never implies activation",
  },
  {
    id: "scale_budget_step",
    preferenceType: "budget",
    name: "Scale budget step",
    detail: "Campaign or ad-set budget owner; approval remains required",
  },
  {
    id: "resume_paused",
    preferenceType: "pause",
    name: "Resume paused",
    detail: "Fresh-state resume candidate with a new approval",
  },
];

const PROMOTION_GATES = [
  {
    title: "Runtime sample",
    requirement: "n >= 30 per calibration cell",
    missing: "No per-class runtime sample in v1",
  },
  {
    title: "Calibration",
    requirement: "ECE <= 0.05 per label",
    missing: "No per-label ECE in v1",
  },
  {
    title: "Financial outcomes",
    requirement: "Mature outcomes; unknown excluded",
    missing: "No maturity evidence in v1",
  },
  {
    title: "Critical failures",
    requirement: "Zero critical or silent failures",
    missing: "No per-class breaker evidence in v1",
  },
] as const;

const BLOCK_REASON_LABELS: Record<string, string> = {
  META_ADS_WRITE_KILL_SWITCH: "environment STOP",
  business_kill_switch: "business STOP",
  auto_execution_not_enabled: "auto execution disabled",
  dry_run_only_guardrail: "dry-run-only posture",
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not recorded";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Invalid timestamp";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time));
}

function formatMinorMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
) {
  if (value == null) return "No cap configured";
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    return `${new Intl.NumberFormat("en").format(value)} minor units - currency unknown`;
  }
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

function notificationPolicyLabel(
  policy: AutomationPayload["businessControl"]["guardrails"]["notificationPolicy"],
) {
  return policy === "every_auto_action"
    ? "Every auto action"
    : "None configured";
}

function requirementLabel(value: boolean) {
  return value ? "Required" : "Not required";
}

function blockedReasonLabel(value: string) {
  return BLOCK_REASON_LABELS[value] ?? value;
}

function modeRow(
  payload: AutomationPayload | null,
  decisionType: MetaAutomationDecisionType,
) {
  return (
    payload?.decisionTypeModes.find(
      (row) => row.decisionType === decisionType,
    ) ?? null
  );
}

export function deriveEffectiveAuthority(
  payload: AutomationPayload | null,
  error: string | null = null,
): EffectiveAuthority {
  if (error) {
    return {
      mode: "Observe",
      reason: "Control state is unreadable; authority fails closed.",
    };
  }
  if (!payload) {
    return {
      mode: "Observe",
      reason: "No business control payload is loaded.",
    };
  }
  if (payload.businessControl.source !== "persisted") {
    return {
      mode: "Observe",
      reason: "Persisted control state is not proven; authority fails closed.",
    };
  }
  if (
    payload.globalKillSwitch.engaged ||
    payload.businessControl.killSwitchEngaged ||
    payload.execution.writeEndpointsBlocked
  ) {
    return {
      mode: "Observe",
      reason: "A write STOP is engaged; execution authority is withheld.",
    };
  }
  if (payload.businessControl.readinessTier === "read_only") {
    return {
      mode: "Observe",
      reason: "The server readiness tier is read only.",
    };
  }
  return {
    mode: "Approval Required",
    reason: payload.execution.autoExecutionAllowed
      ? "A server policy flag is enabled, but executor and per-class release evidence are absent; Stage B remains person-initiated."
      : "Stage B writes remain person-initiated while auto execution is blocked.",
  };
}

function controlReadState(
  payload: AutomationPayload | null,
  loading: boolean,
  error: string | null,
) {
  if (loading) return { label: "Reading", tone: "neutral" as const };
  if (error) return { label: "Unreadable", tone: "danger" as const };
  if (!payload) return { label: "Not loaded", tone: "neutral" as const };
  if (payload.businessControl.source !== "persisted") {
    return { label: "Unverified", tone: "warning" as const };
  }
  return { label: "Readable", tone: "success" as const };
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <span className={styles.badge} data-tone={tone}>
      {children}
    </span>
  );
}

function AlertBand({
  tone,
  title,
  children,
  action,
}: {
  tone: "danger" | "warning" | "neutral" | "info";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const Icon =
    tone === "danger"
      ? ShieldAlert
      : tone === "warning"
        ? AlertTriangle
        : Server;
  return (
    <div
      className={styles.alertBand}
      data-tone={tone}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
      <div className={styles.alertCopy}>
        <strong>{title}</strong>
        <span>{children}</span>
      </div>
      {action ? <div className={styles.alertAction}>{action}</div> : null}
    </div>
  );
}

function SummaryItem({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: BadgeTone;
}) {
  return (
    <div className={styles.summaryItem} data-tone={tone}>
      <span className={styles.summaryLabel}>{label}</span>
      <strong>{value}</strong>
      <span className={styles.summaryDetail}>{detail}</span>
    </div>
  );
}

function ActionClassRow({
  actionClass,
  payload,
  authority,
}: {
  actionClass: (typeof ACTION_CLASSES)[number];
  payload: AutomationPayload | null;
  authority: EffectiveAuthority;
}) {
  const stored = modeRow(payload, actionClass.preferenceType);

  return (
    <article
      className={styles.actionClassRow}
      data-action-class={actionClass.id}
    >
      <div className={styles.actionClassHeading}>
        <div>
          <h3>{actionClass.name}</h3>
          <p>{actionClass.detail}</p>
        </div>
        <Badge tone="warning">Promotion closed</Badge>
      </div>

      <dl className={styles.actionClassFacts}>
        <div>
          <dt>Configured preference</dt>
          <dd>
            {stored ? (
              <code>{LEGACY_MODE_LABELS[stored.mode]}</code>
            ) : (
              "Not stored"
            )}
            <span>Raw v1 value</span>
          </dd>
        </div>
        <div>
          <dt>Effective authority</dt>
          <dd>
            <strong>{authority.mode}</strong>
            <span>{authority.reason}</span>
          </dd>
        </div>
      </dl>

      <div className={styles.rowFootnotes}>
        <span>
          Last change:{" "}
          {stored ? formatDateTime(stored.updatedAt) : "Not recorded"}
          {stored?.updatedBy ? ` by ${stored.updatedBy}` : ""}
        </span>
        <span>Preference group: {actionClass.preferenceType}</span>
        <span>Per-class release evidence: not in v1</span>
        <span>Class STOP: not in v1</span>
        {stored?.lockReason ? (
          <span>Stored note: {stored.lockReason}</span>
        ) : null}
      </div>
    </article>
  );
}

function parseAutomationTab(value: string | null): AutomationTab {
  return AUTOMATION_TABS.some((tab) => tab.id === value)
    ? (value as AutomationTab)
    : "authority";
}

function GuardrailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.guardrailRow}>
      <span>{label}</span>
      <strong>{value}</strong>
      <Badge tone="warning">Configured only</Badge>
    </div>
  );
}

function LedgerSourceLabel(
  source: AutomationPayload["activityLedger"][number]["source"],
) {
  return source === "automation_ledger"
    ? "Control ledger"
    : "Provider action log";
}

function severityLabel(
  severity: AutomationPayload["activityLedger"][number]["severity"],
) {
  if (severity === "success") return "Success record";
  if (severity === "danger") return "Danger";
  if (severity === "warning") return "Warning";
  return "Info";
}

export function MetaAutomationView({
  businessId = null,
  businessName,
  providerAccounts = [],
  providerAccountId = "",
  providerAccountsLoading = false,
  providerAccountsError = null,
  payload,
  loading = false,
  error = null,
  initialTab = "authority",
  onAutomationChange,
  onProviderAccountChange,
  onRetry,
}: {
  businessId?: string | null;
  businessName: string | null;
  providerAccounts?: MetaHistoryAccount[];
  providerAccountId?: string;
  providerAccountsLoading?: boolean;
  providerAccountsError?: string | null;
  payload: AutomationPayload | null;
  loading?: boolean;
  error?: string | null;
  initialTab?: AutomationTab;
  onAutomationChange?: (payload: AutomationPayload) => void;
  onProviderAccountChange?: (providerAccountId: string) => void;
  onRetry?: () => void;
}) {
  const [stopPending, setStopPending] = useState(false);
  const [releaseArmed, setReleaseArmed] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AutomationTab>(initialTab);
  useEffect(() => setActiveTab(initialTab), [initialTab]);
  const scopedBusinessId = payload?.businessId ?? businessId;
  const scopedProviderAccountId =
    (payload?.providerAccountId ?? providerAccountId) || null;
  const routeScope = {
    businessId: scopedBusinessId,
    providerAccountId: scopedProviderAccountId,
  };
  const authority = deriveEffectiveAuthority(payload, error);
  const readState = controlReadState(payload, loading, error);
  const globalStop = payload?.globalKillSwitch.engaged === true;
  const businessStop = payload?.businessControl.killSwitchEngaged === true;
  const stopEngaged = globalStop || businessStop;
  const businessControlVerified =
    payload?.businessControl.source === "persisted";
  const controlFailClosed =
    Boolean(error) || Boolean(payload && !businessControlVerified);
  const blockedReasons = payload?.execution.blockedReasons ?? [];
  const guardrails = payload?.businessControl.guardrails ?? null;
  const stopScopeCount = Number(globalStop) + Number(businessStop);
  const canEngageBusinessStop =
    Boolean(scopedBusinessId) &&
    Boolean(scopedProviderAccountId) &&
    !businessStop &&
    !stopPending;
  const canReleaseBusinessStop =
    Boolean(scopedBusinessId) &&
    Boolean(scopedProviderAccountId) &&
    businessStop &&
    businessControlVerified &&
    !stopPending;
  const effectiveSummaryTone: BadgeTone =
    authority.mode === "Auto-execute"
      ? "automation"
      : stopEngaged || controlFailClosed
        ? "danger"
        : "neutral";
  const writeStopSummary = (() => {
    const tone: BadgeTone =
      stopEngaged || controlFailClosed
        ? "danger"
        : payload
          ? "success"
          : "neutral";
    if (error) {
      return {
        value: "Unverified",
        detail:
          "UI authority fails closed; provider block could not be verified",
        tone,
      };
    }
    if (payload && !businessControlVerified) {
      return {
        value: "Unverified",
        detail:
          "UI authority fails closed; persisted business control is not proven",
        tone,
      };
    }
    if (!payload) {
      return { value: "Unknown", detail: "No control state loaded", tone };
    }
    return {
      value:
        stopScopeCount > 0
          ? `${stopScopeCount} scope${stopScopeCount === 1 ? "" : "s"} engaged`
          : "Clear",
      detail:
        blockedReasons.length > 0
          ? blockedReasons.map(blockedReasonLabel).join("; ")
          : "No engaged scope in the payload",
      tone,
    };
  })();
  const businessSwitchPresentation = (() => {
    if (!payload) return { label: "Unknown", tone: "neutral" as BadgeTone };
    if (!businessControlVerified) {
      return { label: "Unverified", tone: "warning" as BadgeTone };
    }
    return businessStop
      ? { label: "Engaged", tone: "danger" as BadgeTone }
      : { label: "Clear", tone: "success" as BadgeTone };
  })();
  const desktopQuery = new URLSearchParams();
  desktopQuery.set("automationTab", activeTab);
  if (scopedBusinessId) {
    desktopQuery.set("businessId", scopedBusinessId);
  }
  if (scopedProviderAccountId) {
    desktopQuery.set("providerAccountId", scopedProviderAccountId);
  }
  const desktopHref = `/platforms/meta/automation?${desktopQuery.toString()}`;

  async function engageBusinessStop() {
    if (!scopedBusinessId || !canEngageBusinessStop) return;
    setStopPending(true);
    setActionNotice(null);
    try {
      const response = await fetch(
        `/api/meta/automation?businessId=${encodeURIComponent(scopedBusinessId)}&providerAccountId=${encodeURIComponent(scopedProviderAccountId ?? "")}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "engage_kill_switch",
            reason:
              "Operator engaged the business STOP from Automation supervision.",
          }),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        automation?: AutomationPayload;
        error?: { message?: string };
      } | null;
      if (!response.ok || body?.ok === false || !body?.automation) {
        throw new Error(
          body?.error?.message ?? "Business STOP could not be engaged.",
        );
      }
      onAutomationChange?.(body.automation);
      setActionNotice(
        "Business STOP engaged. New Meta mutations are blocked by that scope.",
      );
    } catch (stopError) {
      setActionNotice(
        stopError instanceof Error
          ? stopError.message
          : "Business STOP could not be engaged.",
      );
    } finally {
      setStopPending(false);
    }
  }

  async function releaseBusinessStop() {
    if (!scopedBusinessId || !canReleaseBusinessStop || !releaseArmed) return;
    setStopPending(true);
    setActionNotice(null);
    try {
      const response = await fetch(
        `/api/meta/automation?businessId=${encodeURIComponent(scopedBusinessId)}&providerAccountId=${encodeURIComponent(scopedProviderAccountId ?? "")}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "release_kill_switch" }),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        automation?: AutomationPayload;
        error?: { message?: string };
      } | null;
      if (!response.ok || body?.ok === false || !body?.automation) {
        throw new Error(
          body?.error?.message ?? "Business STOP could not be released.",
        );
      }
      onAutomationChange?.(body.automation);
      setReleaseArmed(false);
      setActionNotice(
        "Business STOP released after a fresh server preflight. Remaining global, readiness, and dry-run gates still apply.",
      );
    } catch (releaseError) {
      setActionNotice(
        releaseError instanceof Error
          ? releaseError.message
          : "Business STOP could not be released.",
      );
    } finally {
      setStopPending(false);
    }
  }

  return (
    <div
      className={`${styles.page} meta-automation-route`}
      data-screen-label="Automation"
    >
      <section
        className={styles.mobileSurface}
        data-testid="meta-mobile-automation"
        aria-labelledby="automation-mobile-title"
      >
        <div className={styles.mobileEyebrow}>
          <span>Automation status</span>
          <Badge tone={readState.tone}>{readState.label}</Badge>
        </div>
        <h1 id="automation-mobile-title">Meta authority</h1>
        <p>
          Read-only status for {businessName ?? "no selected business"}. Open
          the desktop workspace for guarded controls and full receipts.
        </p>
        <dl className={styles.mobileFacts}>
          <div>
            <dt>Effective authority</dt>
            <dd>{authority.mode}</dd>
          </div>
          <div>
            <dt>Business STOP</dt>
            <dd>{businessSwitchPresentation.label}</dd>
          </div>
          <div>
            <dt>Readiness</dt>
            <dd>
              {payload
                ? READINESS_LABELS[payload.businessControl.readinessTier]
                : "Not loaded"}
            </dd>
          </div>
          <div>
            <dt>Ad account</dt>
            <dd>{scopedProviderAccountId ?? "Not selected"}</dd>
          </div>
        </dl>
        {error ? (
          <div className={styles.mobileWarning} role="alert">
            <ShieldAlert aria-hidden="true" size={16} strokeWidth={1.8} />
            Control state is unreadable. Authority remains Observe.
          </div>
        ) : null}
        <Link href={desktopHref} className={styles.mobileDeepLink}>
          Open {AUTOMATION_TABS.find((tab) => tab.id === activeTab)?.label} on
          desktop
        </Link>
      </section>

      <div className={styles.desktopSurface}>
        <header className={styles.pageHeader}>
          <div className={styles.titleBlock}>
            <div className={styles.eyebrow}>
              <Badge>Stage B</Badge>
              <span>Meta supervision</span>
            </div>
            <h1>Automation</h1>
            <p>Authority, evidence, guardrails, and persisted activity.</p>
          </div>
          <div className={styles.headerActions}>
            <label className={styles.accountSelect}>
              <span>Ad account</span>
              <select
                aria-label="Meta ad account for Automation"
                value={providerAccountId}
                disabled={providerAccountsLoading || !onProviderAccountChange}
                onChange={(event) =>
                  onProviderAccountChange?.(event.currentTarget.value)
                }
              >
                <option value="">
                  {providerAccountsLoading
                    ? "Loading accounts"
                    : providerAccounts.length === 0
                      ? "No assigned account"
                      : "Select account"}
                </option>
                {providerAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name ?? account.id}
                    {account.currency ? ` · ${account.currency}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <Badge tone={readState.tone}>{readState.label}</Badge>
            <Link href={buildMetaScopedHref("/platforms/meta", routeScope)} className={styles.backLink}>
              <ArrowLeft aria-hidden="true" size={14} strokeWidth={1.8} />
              Decisions
            </Link>
          </div>
        </header>

        <nav className={styles.tabBar} aria-label="Automation views">
          {AUTOMATION_TABS.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={styles.tabButton}
              data-active={activeTab === tab.id ? "true" : "false"}
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                if (typeof window !== "undefined") {
                  const url = new URL(window.location.href);
                  url.searchParams.set("automationTab", tab.id);
                  window.history.replaceState(null, "", url);
                }
              }}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className={styles.content}>
          {!businessName ? (
            <AlertBand tone="warning" title="Select a business.">
              Automation controls are business-scoped. No default account is
              assumed.
            </AlertBand>
          ) : null}

          {businessName && providerAccountsError ? (
            <AlertBand
              tone="danger"
              title="Account scope unreadable - fail closed."
            >
              {providerAccountsError}
            </AlertBand>
          ) : null}

          {businessName &&
          !providerAccountsLoading &&
          !scopedProviderAccountId ? (
            <AlertBand tone="warning" title="Select one Meta ad account.">
              Account-scoped evidence and all write controls remain withheld.
            </AlertBand>
          ) : null}

          {loading ? (
            <AlertBand tone="neutral" title="Reading the control plane.">
              Authority remains Observe until persisted state is available.
            </AlertBand>
          ) : null}

          {error ? (
            <AlertBand
              tone="danger"
              title="Control plane unreadable - fail closed."
              action={
                onRetry ? (
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={onRetry}
                  >
                    <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
                    Retry read
                  </button>
                ) : null
              }
            >
              No authority or clearing action is inferred. {error}
            </AlertBand>
          ) : null}

          {payload && payload.businessControl.source !== "persisted" ? (
            <AlertBand
              tone="warning"
              title="Persisted business control is not proven."
            >
              The payload source is default. Effective authority is Observe and
              mode changes stay unavailable.
            </AlertBand>
          ) : null}

          {payload?.execution.autoExecutionAllowed ? (
            <AlertBand
              tone="warning"
              title="Server policy allows Auto-execute; executor absent."
            >
              This is a policy flag, not proof that a scheduler, per-class
              evidence gate, or provider executor exists.
            </AlertBand>
          ) : null}

          {globalStop || businessStop ? (
            <AlertBand tone="danger" title="STOP engaged.">
              New mutations are blocked. A provider request already accepted may
              still complete.
              {payload?.businessControl.killSwitchReason
                ? ` Business reason: ${payload.businessControl.killSwitchReason}`
                : ""}
            </AlertBand>
          ) : null}

          {scopedProviderAccountId ? (
            <div className={styles.scopeLine}>
              <span>Provider evidence</span>
              <code>{scopedProviderAccountId}</code>
              <span>Business controls cover all assigned Meta accounts.</span>
            </div>
          ) : null}

          {actionNotice ? (
            <div className={styles.actionNotice} aria-live="polite">
              {actionNotice}
            </div>
          ) : null}

          {activeTab === "authority" ? (
            <section
              className={styles.section}
              data-testid="automation-authority-panel"
              aria-labelledby="authority-title"
            >
              <div className={styles.sectionHeader}>
                <div>
                  <h2 id="authority-title">Effective authority</h2>
                  <p>
                    Stored preferences are evidence. Server gates determine the
                    authority actually served.
                  </p>
                </div>
                <Badge tone={effectiveSummaryTone}>{authority.mode}</Badge>
              </div>

              <div className={styles.summaryBand}>
                <SummaryItem
                  label="Effective authority"
                  value={authority.mode}
                  detail={authority.reason}
                  tone={effectiveSummaryTone}
                />
                <SummaryItem
                  label="Business STOP"
                  value={writeStopSummary.value}
                  detail={writeStopSummary.detail}
                  tone={writeStopSummary.tone}
                />
                <SummaryItem
                  label="Readiness tier"
                  value={
                    payload
                      ? READINESS_LABELS[payload.businessControl.readinessTier]
                      : "Not loaded"
                  }
                  detail={
                    payload
                      ? `Source: ${payload.businessControl.source}`
                      : "No server tier available"
                  }
                  tone={
                    payload?.businessControl.source === "persisted"
                      ? "neutral"
                      : "warning"
                  }
                />
              </div>

              <div className={styles.authorityLegend} role="note">
                <strong>Canonical progression</strong>
                <span>Observe</span>
                <span>Recommend</span>
                <span>Approval Required</span>
                <span>Auto-execute</span>
                <small>
                  Auto-execute remains unavailable without an executor.
                </small>
              </div>

              <div className={styles.actionClassList}>
                {ACTION_CLASSES.map((actionClass) => (
                  <ActionClassRow
                    actionClass={actionClass}
                    authority={authority}
                    key={actionClass.id}
                    payload={payload}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {activeTab === "evidence" ? (
            <section
              className={styles.section}
              data-testid="automation-evidence-panel"
              aria-labelledby="evidence-title"
            >
              <div className={styles.sectionHeader}>
                <div>
                  <h2 id="evidence-title">Evidence</h2>
                  <p>
                    Ten product action classes mapped to four persisted v1
                    preference groups, with missing release evidence stated explicitly.
                  </p>
                </div>
                <Badge tone="danger">10 promotions closed</Badge>
              </div>

              <div className={styles.evidenceTable} role="table">
                <div className={styles.evidenceHeader} role="row">
                  <span role="columnheader">Action class</span>
                  <span role="columnheader">Configured</span>
                  <span role="columnheader">Effective</span>
                  <span role="columnheader">Promotion</span>
                  <span role="columnheader">Class STOP</span>
                </div>
                {ACTION_CLASSES.map((actionClass) => {
                  const stored = modeRow(payload, actionClass.preferenceType);
                  return (
                    <div
                      className={styles.evidenceRow}
                      data-action-class={actionClass.id}
                      role="row"
                      key={actionClass.id}
                    >
                      <span role="cell">
                        <strong>{actionClass.name}</strong>
                        <small>{actionClass.detail}</small>
                      </span>
                      <code role="cell">
                        {stored
                          ? LEGACY_MODE_LABELS[stored.mode]
                          : "not_stored"}
                      </code>
                      <span role="cell">{authority.mode}</span>
                      <span role="cell">Closed: per-class evidence absent</span>
                      <span role="cell">Not in v1</span>
                    </div>
                  );
                })}
              </div>

              <div className={styles.gateGrid}>
                {PROMOTION_GATES.map((gate) => (
                  <article className={styles.gateItem} key={gate.title}>
                    <div className={styles.gateTitle}>
                      <Lock aria-hidden="true" size={13} strokeWidth={2} />
                      <strong>{gate.title}</strong>
                    </div>
                    <span className={styles.gateRequirement}>
                      {gate.requirement}
                    </span>
                    <span className={styles.gateMissing}>{gate.missing}</span>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {activeTab === "guardrails" ? (
            <div
              className={styles.controlGrid}
              data-testid="automation-guardrails-panel"
            >
              <section className={styles.panel} aria-labelledby="stop-title">
                <div className={styles.panelHeader}>
                  <div>
                    <h2 id="stop-title">Business STOP</h2>
                    <p>
                      Engage is risk-reducing. Release is Admin-only, desktop-only,
                      and requires a fresh persisted-state preflight.
                    </p>
                  </div>
                  <ShieldAlert aria-hidden="true" size={18} strokeWidth={1.7} />
                </div>

                <div className={styles.switchList}>
                  <div className={styles.switchRow}>
                    <div className={styles.switchIdentity}>
                      <Server aria-hidden="true" size={15} strokeWidth={1.7} />
                      <span>
                        <strong>Environment STOP</strong>
                        <small>META_ADS_WRITE_KILL_SWITCH</small>
                      </span>
                    </div>
                    <div className={styles.switchState}>
                      <Badge
                        tone={
                          globalStop
                            ? "danger"
                            : payload
                              ? "success"
                              : "neutral"
                        }
                      >
                        {payload
                          ? globalStop
                            ? "Engaged"
                            : "Clear"
                          : "Unknown"}
                      </Badge>
                      <Badge>Server-enforced</Badge>
                    </div>
                  </div>

                  <div className={styles.switchRow}>
                    <div className={styles.switchIdentity}>
                      <Database
                        aria-hidden="true"
                        size={15}
                        strokeWidth={1.7}
                      />
                      <span>
                        <strong>Business STOP</strong>
                        <small>{scopedBusinessId ?? "No business scope"}</small>
                      </span>
                    </div>
                    <div className={styles.switchState}>
                      <Badge tone={businessSwitchPresentation.tone}>
                        {businessSwitchPresentation.label}
                      </Badge>
                      <Badge>Server-enforced</Badge>
                    </div>
                    {!businessStop ? (
                      <button
                        type="button"
                        className={styles.stopButton}
                        data-testid="engage-business-stop"
                        disabled={!canEngageBusinessStop}
                        onClick={() => void engageBusinessStop()}
                      >
                        <CircleStop
                          aria-hidden="true"
                          size={15}
                          strokeWidth={1.9}
                        />
                        {stopPending
                          ? "Engaging STOP..."
                          : "Engage Business STOP"}
                      </button>
                    ) : (
                      <div className={styles.releaseControl}>
                        <div className={styles.releaseLimit}>
                          <Lock aria-hidden="true" size={13} strokeWidth={2} />
                          Releasing only clears the business STOP. It does not enable
                          auto-execution and cannot bypass the environment STOP.
                        </div>
                        {releaseArmed ? (
                          <div className={styles.releaseActions} role="group" aria-label="Confirm Business STOP release">
                            <button
                              type="button"
                              className={styles.secondaryButton}
                              disabled={stopPending}
                              onClick={() => setReleaseArmed(false)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className={styles.releaseButton}
                              data-testid="confirm-release-business-stop"
                              disabled={!canReleaseBusinessStop}
                              onClick={() => void releaseBusinessStop()}
                            >
                              {stopPending ? "Rechecking..." : "Confirm release (Admin)"}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            data-testid="review-release-business-stop"
                            disabled={!canReleaseBusinessStop}
                            onClick={() => setReleaseArmed(true)}
                          >
                            Review release (Admin)
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <section
                className={styles.panel}
                aria-labelledby="guardrails-title"
              >
                <div className={styles.panelHeader}>
                  <div>
                    <h2 id="guardrails-title">Guardrail configuration</h2>
                    <p>
                      Configured defaults, not yet enforced by an automation
                      executor.
                    </p>
                  </div>
                  <Badge tone="warning">Enforcement unproven</Badge>
                </div>

                {guardrails ? (
                  <div className={styles.guardrailList}>
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
                      label="Maximum budget increase"
                      value={`${guardrails.maxBudgetIncreasePct}%`}
                    />
                    <GuardrailRow
                      label="Maximum daily budget change"
                      value={formatMinorMoney(
                        guardrails.maxDailyBudgetChangeMinor,
                        guardrails.perActionSpendCeilingCurrency,
                      )}
                    />
                    <GuardrailRow
                      label="Notification policy"
                      value={notificationPolicyLabel(
                        guardrails.notificationPolicy,
                      )}
                    />
                    <GuardrailRow
                      label="Campaign label"
                      value={requirementLabel(guardrails.requireCampaignLabel)}
                    />
                    <GuardrailRow
                      label="Commercial anchor"
                      value={requirementLabel(
                        guardrails.requireCommercialAnchor,
                      )}
                    />
                    <GuardrailRow
                      label="Live preflight"
                      value={requirementLabel(guardrails.requireLivePreflight)}
                    />
                    <GuardrailRow
                      label="Rollback plan"
                      value={requirementLabel(guardrails.requireRollbackPlan)}
                    />
                    <GuardrailRow
                      label="Dry-run only"
                      value={guardrails.dryRunOnly ? "On" : "Off"}
                    />
                  </div>
                ) : (
                  <div className={styles.emptyState}>
                    Guardrail configuration is not loaded.
                  </div>
                )}
              </section>
            </div>
          ) : null}

          {activeTab === "activity" ? (
            <div
              className={styles.ledgerGrid}
              data-testid="automation-activity-panel"
            >
              <section
                className={styles.panel}
                aria-labelledby="activity-title"
              >
                <div className={styles.panelHeader}>
                  <div>
                    <h2 id="activity-title">Activity ledger</h2>
                    <p>
                      Business control events plus provider action logs for
                      {` ${scopedProviderAccountId ?? "no selected account"}`}.
                    </p>
                  </div>
                  <Badge tone="warning">Partial receipt evidence</Badge>
                </div>

                <div className={styles.receiptLimit}>
                  <AlertTriangle
                    aria-hidden="true"
                    size={14}
                    strokeWidth={1.8}
                  />
                  v1 does not expose prior, intended, and observed state or
                  verifiedAt in this list.
                </div>

                <div className={styles.ledgerList}>
                  {(payload?.activityLedger ?? []).map((item) => (
                    <article
                      className={styles.ledgerRow}
                      data-severity={item.severity}
                      key={item.id}
                    >
                      <div className={styles.ledgerIcon} aria-hidden="true">
                        {item.severity === "success" ? (
                          <CheckCircle2 size={15} strokeWidth={1.8} />
                        ) : item.severity === "danger" ? (
                          <ShieldAlert size={15} strokeWidth={1.8} />
                        ) : (
                          <Activity size={15} strokeWidth={1.8} />
                        )}
                      </div>
                      <div className={styles.ledgerBody}>
                        <div className={styles.ledgerMessage}>
                          <strong>{item.message}</strong>
                          <Badge
                            tone={
                              item.severity === "danger"
                                ? "danger"
                                : item.severity === "warning"
                                  ? "warning"
                                  : item.severity === "success"
                                    ? "success"
                                    : "neutral"
                            }
                          >
                            {severityLabel(item.severity)}
                          </Badge>
                        </div>
                        <div className={styles.ledgerMeta}>
                          <span>{LedgerSourceLabel(item.source)}</span>
                          <code>{item.activityType}</code>
                          <time dateTime={item.createdAt}>
                            {formatDateTime(item.createdAt)}
                          </time>
                          {item.payload ? <span>Payload attached</span> : null}
                        </div>
                      </div>
                    </article>
                  ))}
                  {payload && payload.activityLedger.length === 0 ? (
                    <div className={styles.emptyState}>
                      No activity records are stored for this business.
                    </div>
                  ) : null}
                  {!payload && !loading ? (
                    <div className={styles.emptyState}>
                      Activity is not loaded.
                    </div>
                  ) : null}
                </div>
              </section>

              <section className={styles.panel} aria-labelledby="records-title">
                <div className={styles.panelHeader}>
                  <div>
                    <h2 id="records-title">Authority change records</h2>
                    <p>
                      Raw v1 promotion and mode-change records; not
                      evidence-gated proposals.
                    </p>
                  </div>
                  <Clock3 aria-hidden="true" size={18} strokeWidth={1.7} />
                </div>

                <div className={styles.ledgerList}>
                  {(payload?.promotionRecords ?? []).map((record) => (
                    <article className={styles.promotionRow} key={record.id}>
                      <div className={styles.promotionTopline}>
                        <strong>
                          {record.entityType}{" "}
                          {record.entityId ?? "Unknown entity"}
                        </strong>
                        <Badge>{record.status}</Badge>
                      </div>
                      <div className={styles.promotionTransition}>
                        <code>{record.sourceTier ?? "unknown"}</code>
                        <span aria-hidden="true">to</span>
                        <code>{record.targetTier ?? "unknown"}</code>
                      </div>
                      <p>{record.reason ?? "No reason stored"}</p>
                      <time dateTime={record.createdAt}>
                        {formatDateTime(record.createdAt)}
                      </time>
                    </article>
                  ))}
                  {payload && payload.promotionRecords.length === 0 ? (
                    <div className={styles.emptyState}>
                      No authority change records are stored.
                    </div>
                  ) : null}
                  {!payload && !loading ? (
                    <div className={styles.emptyState}>
                      Authority change records are not loaded.
                    </div>
                  ) : null}
                </div>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function MetaAutomationPage() {
  const searchParams = useSearchParams();
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const businessName = useMemo(
    () =>
      businesses.find((business) => business.id === selectedBusinessId)?.name ??
      null,
    [businesses, selectedBusinessId],
  );
  const [payload, setPayload] = useState<AutomationPayload | null>(null);
  const [providerAccounts, setProviderAccounts] = useState<
    MetaHistoryAccount[]
  >([]);
  const [selectedProviderAccountId, setSelectedProviderAccountId] =
    useState("");
  const [providerAccountsLoading, setProviderAccountsLoading] = useState(false);
  const [providerAccountsError, setProviderAccountsError] = useState<
    string | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const requestedProviderAccountId =
    searchParams.get("providerAccountId") ?? "";
  const requestedTab = parseAutomationTab(searchParams.get("automationTab"));

  const providerAccountId =
    selectedProviderAccountId ||
    (providerAccounts.length === 1 ? providerAccounts[0]!.id : "");

  useEffect(() => {
    if (!selectedBusinessId) {
      setProviderAccounts([]);
      setSelectedProviderAccountId("");
      setProviderAccountsError(null);
      setProviderAccountsLoading(false);
      return;
    }
    let cancelled = false;
    setProviderAccountsLoading(true);
    setProviderAccountsError(null);
    fetchMetaHistoryAccounts({ businessId: selectedBusinessId })
      .then((accounts) => {
        if (cancelled) return;
        setProviderAccounts(accounts);
        setSelectedProviderAccountId((current) =>
          current && accounts.some((account) => account.id === current)
            ? current
            : accounts.some(
                  (account) => account.id === requestedProviderAccountId,
                )
              ? requestedProviderAccountId
              : "",
        );
      })
      .catch((accountError: unknown) => {
        if (cancelled) return;
        setProviderAccounts([]);
        setSelectedProviderAccountId("");
        setProviderAccountsError(
          accountError instanceof Error
            ? accountError.message
            : "Assigned Meta accounts could not load.",
        );
      })
      .finally(() => {
        if (!cancelled) setProviderAccountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestedProviderAccountId, selectedBusinessId]);

  useEffect(() => {
    if (!selectedBusinessId || !providerAccountId) {
      setPayload(null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(
      `/api/meta/automation?businessId=${encodeURIComponent(selectedBusinessId)}&providerAccountId=${encodeURIComponent(providerAccountId)}`,
      {
        signal: controller.signal,
        cache: "no-store",
      },
    )
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as {
          ok?: boolean;
          automation?: AutomationPayload;
          error?: { message?: string };
        } | null;
        if (!response.ok || body?.ok === false || !body?.automation) {
          throw new Error(
            body?.error?.message ?? "Automation control plane failed.",
          );
        }
        setPayload(body.automation);
      })
      .catch((fetchError: unknown) => {
        if (controller.signal.aborted) return;
        setPayload(null);
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : "Automation control plane failed.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [providerAccountId, refreshKey, selectedBusinessId]);

  return (
    <MetaAutomationView
      businessId={selectedBusinessId}
      businessName={businessName}
      providerAccounts={providerAccounts}
      providerAccountId={providerAccountId}
      providerAccountsLoading={providerAccountsLoading}
      providerAccountsError={providerAccountsError}
      payload={payload}
      loading={loading}
      error={error}
      initialTab={requestedTab}
      onAutomationChange={setPayload}
      onProviderAccountChange={(nextProviderAccountId) => {
        setPayload(null);
        setSelectedProviderAccountId(nextProviderAccountId);
        if (typeof window !== "undefined") {
          const url = new URL(window.location.href);
          if (nextProviderAccountId) {
            url.searchParams.set("providerAccountId", nextProviderAccountId);
          } else {
            url.searchParams.delete("providerAccountId");
          }
          window.history.replaceState(null, "", url);
        }
      }}
      onRetry={() => setRefreshKey((value) => value + 1)}
    />
  );
}
