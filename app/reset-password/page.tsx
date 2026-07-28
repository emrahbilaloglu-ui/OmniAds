"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuthSurface } from "@/components/auth/auth-surface";

type AlertTone = "positive" | "caution" | "danger";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  // `null` means "not read yet" and must not render the invalid-link state,
  // otherwise the page flashes "Reset link invalid" before the effect runs.
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    // New links carry the token in the fragment, which never reaches the
    // server and so never enters an access log. Query-string links already
    // sitting in inboxes keep working for their remaining lifetime.
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("token");
    const fromQuery = searchParams.get("token");
    setToken(fromHash ?? fromQuery ?? "");
    // Strip it either way: a token left in the address bar survives in browser
    // history and in anything the user screen-shares.
    window.history.replaceState(null, "", window.location.pathname);
  }, [searchParams]);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<AlertTone>("caution");
  const [done, setDone] = useState(false);

  async function submit() {
    if (password.length < 8) {
      setTone("danger");
      setMessage("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setTone("danger");
      setMessage("Passwords do not match.");
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (response.ok) {
        setDone(true);
        setTone("positive");
        setMessage(payload?.message ?? "Your password has been updated.");
      } else {
        setTone("danger");
        setMessage(payload?.message ?? "This reset link is invalid or has expired.");
      }
    } catch {
      setTone("danger");
      setMessage("Could not reset your password right now. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // Still reading the fragment — say nothing rather than accuse a good link.
  if (token === null) return null;

  if (!token) {
    return (
      <AuthSurface titleOnBrandLine title="Reset link invalid" description="This reset link is missing its token.">
        <div className="ad-auth-form">
          <p className="ad-auth-alert ad-auth-alert-danger">
            Open the reset link from your email, or request a new one.
          </p>
          <div className="ad-auth-row">
            <Link href="/forgot-password">Request a new link</Link>
            <span />
          </div>
        </div>
      </AuthSurface>
    );
  }

  return (
    <AuthSurface titleOnBrandLine title="Choose a new password" description="Enter a new password for your account.">
      <form
        className="ad-auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {!done ? (
          <>
            <label className="ad-auth-label">
              New password
              <input
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="ad-auth-input"
                placeholder="At least 8 characters"
              />
            </label>
            <label className="ad-auth-label">
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                className="ad-auth-input"
                placeholder="Re-enter your new password"
              />
            </label>
            <button type="submit" className="ad-auth-primary" disabled={loading}>
              {loading ? "Updating..." : "Update password"}
            </button>
          </>
        ) : null}
        {message ? (
          <p
            className={`ad-auth-alert ${
              tone === "danger"
                ? "ad-auth-alert-danger"
                : tone === "positive"
                  ? "ad-auth-alert-positive"
                  : "ad-auth-alert-caution"
            }`}
          >
            {message}
          </p>
        ) : null}
        <div className="ad-auth-row">
          <Link href="/login">Back to sign in</Link>
          <span />
        </div>
      </form>
    </AuthSurface>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <AuthSurface titleOnBrandLine title="Reset your password" description="Loading…">
          <div className="ad-auth-form" />
        </AuthSurface>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
