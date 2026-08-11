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

export const LANGUAGE_LIMITATION =
  "Turkish is stored as your preference but the interface still renders in English. " +
  "This selector will take effect when Turkish copy ships.";

export function LanguageView({ current }: { current: AppLanguage }) {
  const copy = useCopy();
  const language = usePreferencesStore((state) => state.language);
  const setLanguage = usePreferencesStore((state) => state.setLanguage);

  return (
    <section style={{ maxWidth: 560 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: "26px", margin: 0 }}>{copy.language}</h2>
      <div style={{ marginTop: 16 }}>
        <RadioGroup
          ctl="live:I18N-02 lang"
          legend="Interface language"
          name="language"
          value={language ?? current}
          onChange={(value) => setLanguage(value as AppLanguage)}
          options={[
            { value: "en", label: "English" },
            { value: "tr", label: "Türkçe" },
          ]}
        />
      </div>
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
