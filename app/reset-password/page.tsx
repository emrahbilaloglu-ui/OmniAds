"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuthSurface } from "@/components/auth/auth-surface";

type AlertTone = "positive" | "caution" | "danger";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
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
      <div className="ad-auth-form">
        {!done ? (
          <>
            <label className="ad-auth-label">
              New password
              <input
                type="password"
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
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                className="ad-auth-input"
                placeholder="Re-enter your new password"
              />
            </label>
            <button type="button" className="ad-auth-primary" onClick={submit} disabled={loading}>
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
      </div>
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
