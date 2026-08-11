"use client";

/**
 * The four truth-state panels.
 *
 * A buyer must be able to tell *missing data*, *unsafe to show*, *needs a fix*
 * and *deliberately off* apart at a glance — they lead to four different
 * actions. Each therefore gets its own grammar:
 *
 * - unavailable — dashed border, no fill. Not served at this grain.
 * - withheld — plum tint and solid border, plus what would unlock it. Plum is
 *   reserved for this state so it cannot be confused with verified green,
 *   caution amber or reference slate.
 * - error — danger border with the server's verbatim text, never a paraphrase.
 * - empty — the only one that legitimately means zero.
 *
 * None of them is interactive, and none ever renders as `0`, a skeleton, or a
 * live-looking control. Every one carries a word as well as a colour, so the
 * meaning survives for a colour-blind reader.
 */
import type { ReactNode } from "react";

import type { SurfaceState } from "@/lib/zero-base/state-types";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

const panelBase: React.CSSProperties = {
  borderRadius: "var(--ledger-radius-card)",
  padding: "10px 14px",
  fontSize: 13,
  lineHeight: "19px",
};

function Panel({
  tone,
  title,
  children,
  code,
  testId,
}: {
  tone: "unavailable" | "withheld" | "error" | "empty";
  title: string;
  children?: ReactNode;
  code?: string;
  testId: string;
}) {
  const style: React.CSSProperties =
    tone === "unavailable"
      ? { ...panelBase, border: "1px dashed var(--ledger-border-control)", background: "transparent" }
      : tone === "withheld"
        ? {
            ...panelBase,
            border: "1px solid var(--ledger-state-withheld-border)",
            background: "var(--ledger-state-withheld-tint)",
          }
        : tone === "error"
          ? { ...panelBase, border: "1px solid var(--ledger-semantic-danger)", background: "transparent" }
          : { ...panelBase, border: "1px solid var(--ledger-border-subtle)", background: "var(--ledger-bg-inset)" };

  const titleColour =
    tone === "withheld"
      ? "var(--ledger-state-withheld)"
      : tone === "error"
        ? "var(--ledger-semantic-danger)"
        : "var(--ledger-ink-secondary)";

  return (
    <div data-surface-state={tone} data-testid={testId} style={style}>
      {/* The state word carries the meaning; colour only reinforces it. */}
      <p style={{ margin: 0, fontSize: 13, fontWeight: 600, lineHeight: "19px", color: titleColour }}>
        {title}
      </p>
      {children ? (
        <div style={{ marginTop: 2, color: "var(--ledger-ink-secondary)", fontSize: 12.5 }}>{children}</div>
      ) : null}
      {code ? (
        <p
          style={{
            margin: "4px 0 0",
            fontFamily: "var(--font-adc-mono), ui-monospace, monospace",
            fontSize: 12,
            lineHeight: "16px",
            color: "var(--ledger-ink-tertiary)",
          }}
        >
          {code}
        </p>
      ) : null}
    </div>
  );
}

export function UnavailableState({ reason, code }: { reason: string; code?: string }) {
  const copy = useCopy();
  return (
    <Panel tone="unavailable" title={copy.unavailable} code={code} testId="state-unavailable">
      {reason}
    </Panel>
  );
}

export function WithheldState({
  reason,
  unlock,
  code,
}: {
  reason: string;
  unlock?: string;
  code?: string;
}) {
  return (
    <Panel tone="withheld" title="Withheld — safety" code={code} testId="state-withheld">
      {reason}
      {unlock ? <p style={{ margin: "4px 0 0" }}>Unlocks when {unlock}</p> : null}
    </Panel>
  );
}

export function ErrorState({
  reason,
  verbatim,
  code,
  onRetry,
}: {
  reason: string;
  verbatim?: string;
  code?: string;
  onRetry?: () => void;
}) {
  const copy = useCopy();
  return (
    <Panel tone="error" title="Failed" code={code} testId="state-error">
      {reason}
      {verbatim ? (
        <p
          style={{
            margin: "4px 0 0",
            fontFamily: "var(--font-adc-mono), ui-monospace, monospace",
            fontSize: 12,
            lineHeight: "16px",
          }}
        >
          {verbatim}
        </p>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: 8,
            minHeight: 24,
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: 600,
            borderRadius: "var(--ledger-radius-button)",
            border: "1px solid var(--ledger-border-control)",
            background: "var(--ledger-bg-surface)",
            color: "var(--ledger-ink-primary)",
            cursor: "pointer",
          }}
        >
          {copy.retry}
        </button>
      ) : null}
    </Panel>
  );
}

export function EmptyState({ reason, code }: { reason: string; code?: string }) {
  return (
    <Panel tone="empty" title="Nothing to show" code={code} testId="state-empty">
      {reason}
    </Panel>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const copy = useCopy();
  const text = label ?? copy.loading;
  return (
    <div
      data-surface-state="loading"
      data-testid="state-loading"
      role="status"
      aria-live="polite"
      style={{ ...panelBase, border: "1px solid var(--ledger-border-subtle)", color: "var(--ledger-ink-secondary)" }}
    >
      {text}
    </div>
  );
}

/**
 * Renders the panel for a state, or the children when ready.
 *
 * Routing every surface through one component is what stops a view from
 * inventing a fifth grammar, or from rendering content while claiming to be
 * unavailable.
 */
export function SurfaceStateBoundary({
  state,
  children,
  onRetry,
}: {
  state: SurfaceState;
  children: ReactNode;
  onRetry?: () => void;
}) {
  switch (state.kind) {
    case "ready":
      return <>{children}</>;
    case "loading":
      return <LoadingState label={state.label} />;
    case "empty":
      return <EmptyState reason={state.reason} code={state.code} />;
    case "unavailable":
      return <UnavailableState reason={state.reason} code={state.code} />;
    case "withheld":
      return <WithheldState reason={state.reason} unlock={state.unlock} code={state.code} />;
    case "error":
      return (
        <ErrorState
          reason={state.reason}
          verbatim={state.verbatim}
          code={state.code}
          onRetry={state.retry ? onRetry : undefined}
        />
      );
  }
}
