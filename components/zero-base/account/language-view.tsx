"use client";

/**
 * Language.
 *
 * The honest part is the limitation notice. `getLanguageFromCookieValue` is
 * currently pinned to English app-wide, so a Turkish selection changes the
 * stored preference but not what renders. Saying so is the whole point: a
 * selector that silently does nothing teaches the user the product is broken,
 * where a stated limitation teaches them it is not ready.
 */
import { RadioGroup } from "@/components/zero-base/primitives/choice";
import { usePreferencesStore } from "@/store/preferences-store";
import type { AppLanguage } from "@/lib/i18n";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";
import { useState } from "react";

export const LANGUAGE_LIMITATION =
  "Turkish is stored as your preference but the interface still renders in English. " +
  "This selector will take effect when Turkish copy ships.";

export function LanguageView({ current, embedded = false }: { current: AppLanguage; embedded?: boolean }) {
  const copy = useCopy();
  const language = usePreferencesStore((state) => state.language);
  const setLanguage = usePreferencesStore((state) => state.setLanguage);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function updateLanguage(value: string) {
    const next = value as AppLanguage;
    const previous = language ?? current;
    if (pending || next === previous) return;
    setPending(true);
    setError(null);
    setLanguage(next);
    try {
      const response = await fetch("/api/settings/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: next }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Could not update the language preference.");
      }
    } catch (reason) {
      setLanguage(previous);
      setError(reason instanceof Error ? reason.message : "Could not update the language preference.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section style={{ maxWidth: 560 }}>
      <h2 style={{ fontSize: embedded ? 14 : 20, fontWeight: 700, lineHeight: embedded ? "20px" : "26px", margin: 0 }}>{copy.language}</h2>
      <div aria-busy={pending || undefined} style={{ marginTop: embedded ? 10 : 16, opacity: pending ? 0.65 : 1 }}>
        <RadioGroup
          ctl="live:I18N-02 lang"
          legend="Interface language"
          name="language"
          value={language ?? current}
          onChange={(value) => void updateLanguage(value)}
          options={[
            { value: "en", label: "English" },
            { value: "tr", label: "Türkçe" },
          ]}
        />
      </div>
      {error ? <p role="alert" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-semantic-danger)" }}>{error}</p> : null}
      <p
        data-language-limitation=""
        style={{
          marginTop: 12,
          padding: "10px 14px",
          borderRadius: "var(--ledger-radius-card)",
          border: "1px dashed var(--ledger-border-control)",
          fontSize: 12,
          lineHeight: "18px",
          color: "var(--ledger-ink-secondary)",
        }}
      >
        {LANGUAGE_LIMITATION}
      </p>
    </section>
  );
}
