"use client";

/**
 * Account & security.
 *
 * The server exposes one session action: revoke every session, including this
 * one. The surface mirrors that contract exactly so it never advertises a
 * safer "other devices only" action that the backend cannot perform.
 */
import { useState } from "react";

import { Button } from "@/components/zero-base/primitives/button";
import { ZeroBaseDialog } from "@/components/zero-base/primitives/overlays";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { ThemeControl } from "@/components/theme/theme-control";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export const CURRENT_SESSION_CONSEQUENCE =
  "Every device is signed out, including this one. You will need to log in again.";

export function AccountSecurityView({
  name,
  email,
  currentSessionId,
  onSaveProfile,
  onChangePassword,
  onRevokeSessions,
  profileError,
  passwordError,
  profileStatus,
  passwordStatus,
  sessionError,
  busy,
  preferences,
}: {
  name: string;
  email: string;
  currentSessionId: string;
  onSaveProfile?: (input: { name: string; email: string }) => void | Promise<void>;
  onChangePassword?: (input: { current: string; next: string }) => void | boolean | Promise<void | boolean>;
  onRevokeSessions?: () => void | Promise<void>;
  /** The server's own words, kept beside the field, value preserved. */
  profileError?: string | null;
  passwordError?: string | null;
  profileStatus?: string | null;
  passwordStatus?: string | null;
  sessionError?: string | null;
  busy?: "profile" | "password" | "sessions" | null;
  /**
   * Account-wide preferences, between the profile and the session controls.
   *
   * The design places language here rather than on a separate surface: it is
   * part of who the account is, and it must not be reached only by scrolling
   * past controls that end sessions.
   */
  preferences?: React.ReactNode;
}) {
  const copy = useCopy();
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [draftEmail, setDraftEmail] = useState(email);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");

  return (
    <>
    <section style={{ maxWidth: 1000, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 14 }}>
      <div style={{ border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)", padding: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, lineHeight: "20px", margin: 0 }}>{copy.profile}</h2>
        <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
          <TextInput
            label={copy.name}
            data-ctl="live:AUTH-11 name"
            value={draftName}
            error={profileError}
            onChange={(event) => setDraftName(event.target.value)}
            // Saved on blur, and the value stays put if the server refuses —
            // clearing a field on error makes the operator retype what they
            // already got right.
            disabled={busy === "profile"}
            onBlur={() => void onSaveProfile?.({ name: draftName, email: draftEmail })}
          />
          <TextInput
            label={copy.email}
            type="email"
            data-ctl="live:AUTH-11 email"
            value={draftEmail}
            readOnly
            aria-readonly="true"
            onChange={(event) => setDraftEmail(event.target.value)}
            hint={copy.signInEmailReadOnly}
            style={{ background: "var(--ledger-bg-inset)", color: "var(--ledger-ink-secondary)" }}
          />
          {profileStatus ? <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--ledger-semantic-ok)" }}>{profileStatus}</p> : null}
        </div>
          {preferences ? <div style={{ marginTop: 4, paddingTop: 12, borderTop: "1px solid var(--ledger-border-subtle)" }}>{preferences}</div> : null}
      </div>

      <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
        <div style={{ border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)", padding: 16 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, lineHeight: "20px", margin: 0 }}>{copy.password}</h3>
        <div style={{ marginTop: 8, display: "grid", gap: 12 }}>
          <TextInput
            label={copy.currentPassword}
            type="password"
            autoComplete="current-password"
            data-ctl="live:AUTH-12 current"
            value={current}
            error={passwordError}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <TextInput
            label={copy.newPassword}
            type="password"
            autoComplete="new-password"
            data-ctl="live:AUTH-12 new"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            hint={copy.passwordStrengthHint}
          />
          <div>
            <Button
              variant="secondary"
              data-ctl="live:AUTH-12 save"
              state={busy === "password"
                ? { kind: "busy", label: "Saving…" }
                : !current
                  ? { kind: "disabled", reason: "Enter your current password." }
                  : next.length < 12
                    ? { kind: "disabled", reason: "The new password must be at least 12 characters." }
                    : { kind: "enabled" }}
              onClick={async () => {
                const result = await onChangePassword?.({ current, next });
                if (result !== false) {
                  setCurrent("");
                  setNext("");
                }
              }}
            >
              {copy.save}
            </Button>
          </div>
          {passwordStatus ? <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--ledger-semantic-ok)" }}>{passwordStatus}</p> : null}
        </div>
        </div>

      <div data-el="destructive-ceremony" style={{ border: "1px solid var(--ledger-semantic-danger)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)", padding: 16 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, lineHeight: "20px", margin: 0, color: "var(--ledger-semantic-danger)" }}>{copy.sessions}</h3>
        <p style={{ fontSize: 12, lineHeight: "18px", color: "var(--ledger-ink-secondary)", marginTop: 4 }}>
          {copy.signedInAsSession} <code style={{ fontFamily: "var(--font-adc-mono), monospace" }}>{currentSessionId.slice(0, 8)}</code>. Revoking sessions signs every device out.
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <Button variant="danger" data-ctl="live:AUTH-13 revoke" state={busy === "sessions" ? { kind: "busy", label: "Revoking…" } : { kind: "enabled" }} onClick={() => setConfirmRevokeAll(true)}>
            {copy.revokeAllSessions}
          </Button>
        </div>
        {sessionError ? <p role="alert" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-semantic-danger)" }}>{sessionError}</p> : null}
      </div>

      <div style={{ border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)", padding: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, lineHeight: "22px", margin: 0 }}>{copy.theme}</h3>
        <div style={{ marginTop: 8 }}>
          <ThemeControl />
        </div>
      </div>
      </div>

    </section>
      <ZeroBaseDialog
        open={confirmRevokeAll}
        onOpenChange={setConfirmRevokeAll}
        title={copy.revokeAllSessionsQ}
        description={CURRENT_SESSION_CONSEQUENCE}
        confirmLabel="Revoke and sign out"
        destructive
        confirmPhrase="REVOKE"
        onConfirm={() => {
          setConfirmRevokeAll(false);
          void onRevokeSessions?.();
        }}
      />
    </>
  );
}
