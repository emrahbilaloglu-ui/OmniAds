"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthSurface } from "@/components/auth/auth-surface";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"positive" | "caution" | "danger">("caution");

  async function requestReset() {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      setTone(response.ok ? "positive" : response.status === 501 ? "caution" : "danger");
      setMessage(payload?.message ?? "Password reset is not available right now.");
    } catch {
      setTone("danger");
      setMessage("Password reset is not available right now.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthSurface
      titleOnBrandLine
      title="Reset your password"
      description="Enter your email address to request a reset link."
    >
      <form
        className="ad-auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          void requestReset();
        }}
      >
        <label className="ad-auth-label">
          Email
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="ad-auth-input"
            placeholder="you@company.com"
          />
        </label>
        <button type="submit" className="ad-auth-primary" disabled={loading}>
          {loading ? "Checking reset setup..." : "Send reset link"}
        </button>
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
