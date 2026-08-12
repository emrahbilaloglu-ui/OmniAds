"use client";

/**
 * Login (H05).
 *
 * Four things here are contract rather than taste:
 *
 * - **The server's error, verbatim, above the form.** "Something went wrong"
 *   tells an operator nothing about whether to retry, wait, or fix a typo. A
 *   rate limit shows its retry-after; being offline re-enables the button
 *   rather than leaving it spinning against a request that never left.
 * - **Password managers work.** A real `<input type="password">` with
 *   `autoComplete="current-password"` and a stable name, never a custom widget
 *   that defeats autofill (3.3.8). Caps Lock is hinted, because the most common
 *   login failure is not a forgotten password.
 * - **Reset always claims to have sent.** An unknown address must be
 *   indistinguishable from a known one, so the copy discloses that delivery is
 *   not verified rather than implying a mailbox exists.
 * - **Nothing is validated as a puzzle.** Email format is checked on blur and
 *   described by `aria-describedby`; there is no CAPTCHA and no cognitive test.
 */
import { useState, type FormEvent } from "react";
import Link from "next/link";

import { Button } from "@/components/zero-base/primitives/button";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export interface LoginFailure {
  /** The server's own words. Never softened, never replaced. */
  message: string;
  /** Seconds the server told us to wait. Null when it did not say. */
  retryAfterSeconds: number | null;
  /** True when the request never reached the server at all. */
  offline: boolean;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function LoginView({
  invitedEmail = null,
  failure = null,
  submitting = false,
  onSubmit,
  demoAvailable = true,
}: {
  /** Prefilled from an invite when there is one (3.3.7). */
  invitedEmail?: string | null;
  failure?: LoginFailure | null;
  submitting?: boolean;
  onSubmit?: (input: { email: string; password: string }) => void;
  /** False where no demo workspace is provisioned; the control is then absent. */
  demoAvailable?: boolean;
}) {
  const copy = useCopy();
  const [email, setEmail] = useState(invitedEmail ?? "");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [capsLock, setCapsLock] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit?.({ email, password });
  };

  return (
    <div data-login-surface="" style={{ minHeight: "100vh", display: "grid", gridTemplateRows: "64px 1fr auto", background: "var(--ledger-bg-app)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, padding: "0 clamp(20px,3vw,40px)", borderBottom: "1px solid var(--ledger-border-subtle)", background: "var(--ledger-bg-surface)" }}>
        <Link href="/" aria-label={copy.adsecuteHome} style={{ display: "inline-flex", alignItems: "center", gap: 9, color: "var(--ledger-ink-primary)", textDecoration: "none", fontSize: 14, fontWeight: 800, letterSpacing: ".08em" }}><span aria-hidden="true" style={{ width: 20, height: 20, display: "grid", placeItems: "center", borderRadius: 5, background: "var(--ledger-accent-action)", color: "var(--ledger-bg-surface)", fontSize: 12, letterSpacing: 0 }}>A</span>{copy.brandName}</Link>
      <nav aria-label={copy.public} style={{ display: "flex", gap: 20, fontSize: 12 }}>
        <Link href="/product" data-ctl="live:PUBLIC-03" style={{ color: "var(--ledger-accent-action)" }}>
          {copy.product}
        </Link>
        <Link href="/pricing" data-ctl="live:PUBLIC-03" style={{ color: "var(--ledger-accent-action)" }}>
          {copy.pricing}
        </Link>
        {/* One consistent help channel, never a scattering of mailtos (3.2.6). */}
        <Link href="/contact" data-ctl="live:PUBLIC-05" style={{ color: "var(--ledger-accent-action)" }}>
          {copy.contact}
        </Link>
      </nav>
      </header>

      <div style={{ display: "grid", placeItems: "center", padding: "36px 16px 18px" }}>
      <main style={{ width: "100%", maxWidth: 420, padding: 28, display: "grid", gap: 16, border: "1px solid var(--ledger-border-subtle)", borderRadius: 14, background: "var(--ledger-bg-surface)", boxShadow: "0 14px 38px color-mix(in srgb, var(--ledger-ink-primary) 9%, transparent)" }}>

      <div><h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{copy.signIn}</h1><p style={{ margin: "3px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>{copy.mediaBuyingOperatingSystem}</p></div>

      {failure ? (
        <div
          role="alert"
          data-login-failure={failure.offline ? "offline" : failure.retryAfterSeconds ? "rate-limited" : "rejected"}
          style={{
            border: "1px solid var(--ledger-semantic-danger)",
            borderRadius: "var(--ledger-radius-card)",
            padding: "10px 14px",
            fontSize: 12,
            lineHeight: "18px",
            color: "var(--ledger-semantic-danger)",
          }}
        >
          {failure.message}
          {failure.retryAfterSeconds !== null ? (
            <span style={{ display: "block" }}>
              Try again in {failure.retryAfterSeconds} seconds.
            </span>
          ) : null}
        </div>
      ) : null}

      <form data-el="login-form" onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <TextInput
          label={copy.email}
          type="email"
          name="email"
          autoComplete="username"
          data-ctl="live:AUTH-02 email"
          value={email}
          error={emailError}
          onChange={(event) => setEmail(event.target.value)}
          // Checked on blur, not per keystroke: telling someone their address is
          // invalid while they are still typing it is noise, not help.
          onBlur={() =>
            setEmailError(
              email.trim() === "" || looksLikeEmail(email) ? null : "Enter an email address, like name@example.com.",
            )
          }
        />
        <TextInput
          label={copy.password}
          type="password"
          name="password"
          autoComplete="current-password"
          data-ctl="live:AUTH-02 password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyUp={(event) => setCapsLock(event.getModifierState?.("CapsLock") ?? false)}
          hint={capsLock ? copy.capsLockOn : undefined}
        />
        <p style={{ margin: 0, fontSize: 12 }}>
          <Link href="/reset" data-ctl="live:AUTH-05 forgot" style={{ color: "var(--ledger-accent-action)" }}>
            {copy.forgotPassword}
          </Link>
        </p>
        <Button
          type="submit"
          variant="primary"
          data-ctl="live:AUTH-02 submit"
          state={submitting ? { kind: "busy", label: copy.signingIn } : { kind: "enabled" }}
        >
          {copy.signIn}
        </Button>
      </form>

      <div style={{ display: "grid", gap: 8 }}>
        <div aria-hidden="true" style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 8, color: "var(--ledger-ink-tertiary)", fontSize: 12 }}><span style={{ borderTop: "1px solid var(--ledger-border-subtle)" }} />or<span style={{ borderTop: "1px solid var(--ledger-border-subtle)" }} /></div>
        <Button variant="secondary" data-ctl="live:AUTH-03 google" onClick={() => {}}>
          {copy.continueWithGoogle}
        </Button>
        <Button variant="secondary" data-ctl="live:AUTH-04 facebook" onClick={() => {}}>
          {copy.continueWithFacebook}
        </Button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12 }}>
        <Link href="/signup" data-ctl="live:AUTH-01" style={{ color: "var(--ledger-accent-action)" }}>
          {copy.createAccount}
        </Link>
        {/* Absent, not disabled, where no demo workspace exists. */}
        {demoAvailable ? (
          <Link href="/demo" data-ctl="live:AUTH-06 demo" style={{ color: "var(--ledger-accent-action)" }}>
            {copy.exploreDemo}
          </Link>
        ) : null}
      </div>
      </main>
      </div>
      <footer style={{ padding: "0 16px 16px", textAlign: "center", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>Privacy · Terms · Security · AI transparency</footer>
    </div>
  );
}
