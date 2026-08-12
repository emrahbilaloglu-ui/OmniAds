"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AccountSecurityView } from "@/components/zero-base/account/account-security-view";
import { LanguageView } from "@/components/zero-base/account/language-view";
import type { AppLanguage } from "@/lib/i18n";

type BusyKind = "profile" | "password" | "sessions" | null;

async function responseMessage(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
}

export function AccountSecurityClient({ name, email, currentSessionId, language }: {
  name: string;
  email: string;
  currentSessionId: string;
  language: AppLanguage;
}) {
  const router = useRouter();
  const [savedName, setSavedName] = useState(name);
  const [busy, setBusy] = useState<BusyKind>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);

  async function saveProfile(input: { name: string; email: string }) {
    const nextName = input.name.trim();
    if (nextName === savedName) return;
    setBusy("profile");
    setProfileError(null);
    setProfileStatus(null);
    try {
      const response = await fetch("/api/settings/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName }),
      });
      if (!response.ok) throw new Error(await responseMessage(response, "Could not update the profile."));
      const body = (await response.json()) as { user?: { name?: string } };
      const confirmedName = body.user?.name?.trim();
      if (!confirmedName) throw new Error("The server did not confirm the saved name.");
      setSavedName(confirmedName);
      setProfileStatus("Profile updated.");
      router.refresh();
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Could not update the profile.");
    } finally {
      setBusy(null);
    }
  }

  async function changePassword(input: { current: string; next: string }) {
    setBusy("password");
    setPasswordError(null);
    setPasswordStatus(null);
    try {
      const response = await fetch("/api/settings/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: input.current, nextPassword: input.next }),
      });
      if (!response.ok) throw new Error(await responseMessage(response, "Could not update the password."));
      setPasswordStatus("Password updated.");
      return true;
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Could not update the password.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function revokeSessions() {
    setBusy("sessions");
    setSessionError(null);
    try {
      const response = await fetch("/api/settings/security/revoke-sessions", { method: "POST" });
      if (!response.ok) throw new Error(await responseMessage(response, "Could not revoke sessions."));
      window.location.assign("/login");
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Could not revoke sessions.");
      setBusy(null);
    }
  }

  return (
    <AccountSecurityView
      name={name}
      email={email}
      currentSessionId={currentSessionId}
      onSaveProfile={saveProfile}
      onChangePassword={changePassword}
      onRevokeSessions={revokeSessions}
      profileError={profileError}
      passwordError={passwordError}
      sessionError={sessionError}
      profileStatus={profileStatus}
      passwordStatus={passwordStatus}
      busy={busy}
      preferences={<LanguageView current={language} embedded />}
    />
  );
}
