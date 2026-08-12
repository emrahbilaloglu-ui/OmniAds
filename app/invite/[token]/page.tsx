"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AuthSurface } from "@/components/auth/auth-surface";
import { InviteStatePanel } from "@/components/zero-base/auth/auth-states";
import { inviteStateFromResponse, type InviteState } from "@/lib/zero-base/auth-states";
import { useZeroBaseUi } from "@/components/zero-base/rollout-provider";

interface InvitePayload {
  invite: {
    email: string;
    role: "admin" | "collaborator" | "guest";
    status: "pending" | "accepted" | "revoked" | "expired";
    expiresAt?: string;
    workspaces?: Array<{ id: string; name: string }>;
  };
}

interface MePayload {
  authenticated: boolean;
  user?: { email: string };
}

export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const token = String(params?.token ?? "");
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<InvitePayload["invite"] | null>(null);
  const [me, setMe] = useState<MePayload | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server distinguishes five outcomes with five codes; the page renders
  // whichever it returned rather than collapsing them into "invalid or
  // expired", which covers four situations with four different remedies.
  const [inviteState, setInviteState] = useState<InviteState | null>(null);
  const { canonical } = useZeroBaseUi();

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      const [inviteRes, meRes] = await Promise.all([
        fetch(`/api/invite/${token}`, { cache: "no-store" }),
        fetch("/api/auth/me", { cache: "no-store" }),
      ]);
      const inviteJson = (await inviteRes.json().catch(() => null)) as
        | InvitePayload
        | { message?: string }
        | null;
      const meJson = (await meRes.json().catch(() => null)) as MePayload | null;
      if (!mounted) return;
      if (!inviteRes.ok || !inviteJson || !("invite" in inviteJson)) {
        const payload = inviteJson as { message?: string; error?: string } | null;
        setInviteState(
          inviteStateFromResponse({ status: inviteRes.status, code: payload?.error ?? null }),
        );
        setError(payload?.message ?? "Invite link is invalid or expired.");
      } else {
        setInvite(inviteJson.invite);
      }
      setMe(meJson);
      setLoading(false);
    }
    if (token) load();
    return () => {
      mounted = false;
    };
  }, [token]);

  async function acceptInvite() {
    setSubmitting(true);
    setError(null);
    const res = await fetch(`/api/invite/${token}`, { method: "POST" });
    const json = (await res.json().catch(() => null)) as
      | { message?: string; error?: string; businessId?: string }
      | null;
    if (!res.ok) {
      setInviteState(inviteStateFromResponse({ status: res.status, code: json?.error ?? null }));
      setError(json?.message ?? "Could not accept invite.");
      setSubmitting(false);
      return;
    }
    // Canonicalise onto the business just joined, which is now the actor's
    // single active membership. Legacy keeps its own destination.
    router.push(canonical && json?.businessId ? "/app/home" : "/overview");
  }

  async function switchAccount() {
    setSwitchingAccount(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    router.push(`/login?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(invite?.email ?? "")}`);
    router.refresh();
  }

  if (loading) {
    return (
      <AuthSurface
        eyebrow="Team invite"
        title="Loading invite..."
        description="Preparing workspace invitation context."
      >
        <div className="h-2 rounded-full bg-neutral-100" />
      </AuthSurface>
    );
  }

  if (!invite) {
    const state = inviteState ?? "not_found";
    return (
      <AuthSurface eyebrow="Team invite" title="Team invite">
        <InviteStatePanel state={state} token={token} />
        <Link href="/login" className="ad-auth-link-button">
          Back to sign in
        </Link>
      </AuthSurface>
    );
  }

  const isAuthed = Boolean(me?.authenticated);
  const emailMatch = !isAuthed || me?.user?.email?.toLowerCase() === invite.email.toLowerCase();

  return (
    <AuthSurface
      eyebrow="Team invite"
      title="You're invited"
      description={
        <>
          You are invited as <span className="font-semibold capitalize">{invite.role}</span>{" "}
          {invite.workspaces && invite.workspaces.length > 0
            ? `across ${invite.workspaces.map((workspace) => workspace.name).join(", ")}.`
            : "to this workspace."}
        </>
      }
    >
      <div className="ad-auth-form">
        <p className="ad-auth-mono">
          Invite for: <span>{invite.email}</span>
          {invite.expiresAt ? ` · Expires ${new Date(invite.expiresAt).toLocaleDateString()}` : ""}
        </p>

        {error ? <p className="ad-auth-alert ad-auth-alert-danger">{error}</p> : null}

        {!isAuthed ? (
          <>
            <Link
              href={`/login?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(invite.email)}`}
              className="ad-auth-link-button"
            >
              Sign in to accept
            </Link>
            <Link
              href={`/signup?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(invite.email)}`}
              className="ad-auth-link-button"
            >
              Create account and accept
            </Link>
          </>
        ) : (
          <>
            {!emailMatch ? (
              <p className="ad-auth-alert ad-auth-alert-caution">
                You are signed in as <span className="font-semibold">{me?.user?.email}</span> — this invite is for{" "}
                <span className="font-semibold">{invite.email}</span>. Sign in with the invited address to accept.
              </p>
            ) : null}
            {!emailMatch ? (
              <button type="button" className="ad-auth-secondary" onClick={switchAccount} disabled={switchingAccount}>
                {switchingAccount ? "Switching account..." : "Switch account"}
              </button>
            ) : null}
            <button type="button" className="ad-auth-primary" onClick={acceptInvite} disabled={submitting || !emailMatch}>
              {submitting ? "Accepting..." : "Accept invite"}
            </button>
            {!emailMatch ? (
              <div className="ad-auth-mono">
                Disabled with the reason visible above — never a silent dead button.
              </div>
            ) : null}
          </>
        )}
      </div>
    </AuthSurface>
  );
}
