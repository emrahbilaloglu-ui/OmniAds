"use client";

/**
 * Account & security.
 *
 * Revoking sessions is the interesting control: revoking *all other* sessions
 * is safe, but revoking the current one signs the user out of the page they
 * are standing on. That consequence is stated before the confirm rather than
 * discovered afterwards, and it is the reason the two actions are separate
 * controls instead of one list with a checkbox.
 */
import { useState } from "react";

import { Button } from "@/components/zero-base/primitives/button";
import { ZeroBaseDialog } from "@/components/zero-base/primitives/overlays";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { ThemeControl } from "@/components/theme/theme-control";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export const CURRENT_SESSION_CONSEQUENCE =
  "This signs you out on this device immediately. You will need to log in again.";

export function AccountSecurityView({
  name,
  email,
  currentSessionId,
  onSaveProfile,
  onChangePassword,
  profileError,
  passwordError,
}: {
  name: string;
  email: string;
  currentSessionId: string;
  onSaveProfile?: (input: { name: string; email: string }) => void;
  onChangePassword?: (input: { current: string; next: string }) => void;
  /** The server's own words, kept beside the field, value preserved. */
  profileError?: string | null;
  passwordError?: string | null;
}) {
  const copy = useCopy();
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const [confirmRevokeCurrent, setConfirmRevokeCurrent] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [draftEmail, setDraftEmail] = useState(email);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");

  return (
    <section style={{ maxWidth: 560, display: "grid", gap: 24 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: "26px", margin: 0 }}>
          Account &amp; security
        </h2>
        <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          <TextInput
            label={copy.name}
            data-ctl="live:AUTH-11 name"
            value={draftName}
            error={profileError}
            onChange={(event) => setDraftName(event.target.value)}
            // Saved on blur, and the value stays put if the server refuses —
            // clearing a field on error makes the operator retype what they
            // already got right.
            onBlur={() => onSaveProfile?.({ name: draftName, email: draftEmail })}
          />
          <TextInput
            label={copy.email}
            type="email"
            data-ctl="live:AUTH-11 email"
            value={draftEmail}
            onChange={(event) => setDraftEmail(event.target.value)}
            onBlur={() => onSaveProfile?.({ name: draftName, email: draftEmail })}
            hint={copy.emailChangeReverifies}
          />
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: 16, fontWeight: 600, lineHeight: "22px", margin: 0 }}>{copy.password}</h3>
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
              onClick={() => {
                onChangePassword?.({ current, next });
                // Only the passwords are cleared on submit; everything else the
                // operator typed survives a failure.
                setCurrent("");
                setNext("");
              }}
            >
              {copy.save}
            </Button>
          </div>
        </div>
      </div>

      <div data-el="destructive-ceremony">
        <h3 style={{ fontSize: 16, fontWeight: 600, lineHeight: "22px", margin: 0 }}>{copy.sessions}</h3>
        <p style={{ fontSize: 12.5, lineHeight: "18px", color: "var(--ledger-ink-secondary)", marginTop: 4 }}>
          {copy.signedInAsSession} <code style={{ fontFamily: "var(--font-adc-mono), monospace" }}>{currentSessionId.slice(0, 8)}</code>.
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <Button variant="secondary" data-ctl="live:AUTH-13 revoke" onClick={() => setConfirmRevokeAll(true)}>
            {copy.revokeOtherSessions}
          </Button>
          <Button variant="danger" onClick={() => setConfirmRevokeCurrent(true)}>
            {copy.revokeThisSession}
          </Button>
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: 16, fontWeight: 600, lineHeight: "22px", margin: 0 }}>{copy.theme}</h3>
        <div style={{ marginTop: 8 }}>
          <ThemeControl />
        </div>
      </div>

      <ZeroBaseDialog
        open={confirmRevokeAll}
        onOpenChange={setConfirmRevokeAll}
        title={copy.revokeOtherSessionsQ}
        description="Every other device is signed out. This device stays signed in."
        confirmLabel="Revoke others"
        onConfirm={() => setConfirmRevokeAll(false)}
      />
      <ZeroBaseDialog
        open={confirmRevokeCurrent}
        onOpenChange={setConfirmRevokeCurrent}
        title={copy.revokeThisSessionQ}
        // The consequence is stated before the confirm, not discovered after.
        description={CURRENT_SESSION_CONSEQUENCE}
        confirmLabel="Sign out here"
        destructive
        confirmPhrase="SIGN OUT"
        onConfirm={() => setConfirmRevokeCurrent(false)}
      />
    </section>
  );
}
