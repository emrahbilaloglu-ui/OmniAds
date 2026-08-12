"use client";

/**
 * Rendered auth states.
 *
 * Each one is a named state from `lib/zero-base/auth-states.ts`, which maps a
 * server response. Nothing here decides what happened — it only draws it,
 * with the remedy attached, so a user never reads "invalid or expired" and has
 * to guess which of four situations they are in.
 */
import Link from "next/link";

import {
  inviteStateCopy,
  loginFailureCopy,
  oauthCallbackCopy,
  resetDeliveryCopy,
  type InviteState,
  type LoginFailureState,
  type OAuthCallbackError,
  type ResetDeliveryState,
} from "@/lib/zero-base/auth-states";

const panel: React.CSSProperties = {
  borderRadius: "var(--ledger-radius-card)",
  padding: "10px 14px",
  fontSize: 13,
  lineHeight: "19px",
};

export function InviteStatePanel({
  state,
  invitedEmail,
  signedInEmail,
  token,
}: {
  state: InviteState;
  invitedEmail?: string | null;
  signedInEmail?: string | null;
  token?: string;
}) {
  const copy = inviteStateCopy(state, { invitedEmail, signedInEmail, token });
  const positive = state === "acceptable" || state === "accepted";

  return (
    <div
      data-invite-state={state}
      style={{
        ...panel,
        border: `1px solid ${positive ? "var(--ledger-border-subtle)" : "var(--ledger-semantic-warn)"}`,
        background: positive ? "var(--ledger-bg-inset)" : "transparent",
      }}
    >
      <p
        style={{
          margin: 0,
          fontWeight: 600,
          color: positive ? "var(--ledger-ink-primary)" : "var(--ledger-semantic-warn)",
        }}
      >
        {copy.title}
      </p>
      <p style={{ margin: "4px 0 0", color: "var(--ledger-ink-secondary)" }}>{copy.body}</p>
      {copy.action ? (
        <Link
          href={copy.action.href}
          data-invite-action=""
          style={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: 44,
            marginTop: 8,
            fontWeight: 600,
            color: "var(--ledger-accent-action)",
          }}
        >
          {copy.action.label}
        </Link>
      ) : null}
    </div>
  );
}

export function LoginFailurePanel({
  state,
  retryAfterSeconds,
}: {
  state: LoginFailureState;
  retryAfterSeconds?: number | null;
}) {
  return (
    <p
      role="alert"
      data-login-failure={state}
      style={{ ...panel, border: "1px solid var(--ledger-semantic-danger)", color: "var(--ledger-semantic-danger)" }}
    >
      {loginFailureCopy(state, retryAfterSeconds)}
    </p>
  );
}

export function ResetDeliveryPanel({ state }: { state: ResetDeliveryState }) {
  const failed = state === "delivery_unavailable";
  return (
    <p
      role="status"
      data-reset-delivery={state}
      style={{
        ...panel,
        border: `1px solid ${failed ? "var(--ledger-semantic-danger)" : "var(--ledger-border-subtle)"}`,
        color: failed ? "var(--ledger-semantic-danger)" : "var(--ledger-ink-secondary)",
      }}
    >
      {resetDeliveryCopy(state)}
    </p>
  );
}

export function OAuthCallbackErrorPanel({ error }: { error: OAuthCallbackError }) {
  const copy = oauthCallbackCopy(error);
  return (
    <div
      role="alert"
      data-oauth-error={error.code}
      style={{ ...panel, border: "1px solid var(--ledger-semantic-danger)" }}
    >
      <p style={{ margin: 0, fontWeight: 600, color: "var(--ledger-semantic-danger)" }}>{copy.title}</p>
      <p style={{ margin: "4px 0 0", color: "var(--ledger-ink-secondary)" }}>{copy.body}</p>
      {/* The provider's own words, verbatim — a paraphrase loses the detail
          that tells support what actually went wrong. */}
      <p
        style={{
          margin: "4px 0 0",
          fontFamily: "var(--font-adc-mono), ui-monospace, monospace",
          fontSize: 12,
          lineHeight: "16px",
          color: "var(--ledger-ink-tertiary)",
        }}
      >
        {error.code}
        {error.description ? ` — ${error.description}` : ""}
      </p>
    </div>
  );
}

export function PostureNotice({ text, kind }: { text: string; kind?: "reviewer" | "demo" }) {
  return (
    <p
      data-posture-notice=""
      data-posture-kind={kind}
      // Reviewer and demo are different refusals: one is about the actor, the
      // other about the workspace, and an operator needs to know which applies
      // before they go looking for a permission that would not help.
      data-el={kind === "reviewer" ? "reviewer-banner" : kind === "demo" ? "demo-refusal" : undefined}
      style={{
        ...panel,
        border: "1px dashed var(--ledger-border-control)",
        color: "var(--ledger-ink-secondary)",
        marginTop: 12,
      }}
    >
      {text}
    </p>
  );
}
