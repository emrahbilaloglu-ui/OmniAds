"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, CornerDownLeft, Search } from "lucide-react";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { getTranslations } from "@/lib/i18n";
import { useAppStore } from "@/store/app-store";
import { usePreferencesStore } from "@/store/preferences-store";
import { getRailJumpTargets, getRailModel } from "./nav-model";

interface PaletteEntry {
  id: string;
  label: string;
  group: string;
  hint?: string;
  run: () => void | Promise<void>;
}

/**
 * "Jump or act…" — the ⌘K surface the design puts in the topbar. It resolves
 * over the real route inventory and the real workspace list, so every entry
 * performs the same navigation or business switch the chrome would.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const language = usePreferencesStore((state) => state.language);
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const selectBusiness = useAppStore((state) => state.selectBusiness);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const t = getTranslations(language).layout;

  const entries = useMemo<PaletteEntry[]>(() => {
    const model = getRailModel(language);
    const navEntries: PaletteEntry[] = getRailJumpTargets(model).map((target) => ({
      id: `nav:${target.id}`,
      label: target.label,
      group: target.group,
      run: () => router.push(target.href),
    }));

    const businessEntries: PaletteEntry[] = businesses
      .filter((business) => business.id !== selectedBusinessId)
      .map((business) => ({
        id: `business:${business.id}`,
        label: business.name,
        group: t.switchBusiness,
        hint: business.currency,
        run: async () => {
          const previous = selectedBusinessId;
          selectBusiness(business.id);
          const response = await fetch("/api/auth/switch-business", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ businessId: business.id }),
          }).catch(() => null);
          if (!response?.ok) {
            selectBusiness(previous ?? null);
            logClientAuthEvent("business_switch_failed", {
              attemptedBusinessId: business.id,
              previousBusinessId: previous,
            });
            return;
          }
          logClientAuthEvent("business_switch_succeeded", {
            activeBusinessId: business.id,
          });
          router.refresh();
        },
      }));

    return [...navEntries, ...businessEntries];
  }, [
    businesses,
    language,
    router,
    selectBusiness,
    selectedBusinessId,
    t.switchBusiness,
  ]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      `${entry.group} ${entry.label}`.toLowerCase().includes(needle),
    );
  }, [entries, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  if (!open) return null;

  const run = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    onOpenChange(false);
    void entry.run();
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-[rgba(11,16,32,0.45)] px-4 pt-[12vh]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump or act"
        className="w-full max-w-[560px] overflow-hidden rounded-[var(--adv-r-card)] border border-[var(--adv-border)] bg-white shadow-[0_26px_72px_rgba(11,16,32,0.28)]"
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--adv-hairline)] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--adv-ink-3)]" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onOpenChange(false);
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((value) => Math.min(results.length - 1, value + 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((value) => Math.max(0, value - 1));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                run(results[cursor]);
              }
            }}
            placeholder="Jump or act…"
            className="h-6 w-full border-0 bg-transparent text-[14px] text-[var(--adv-ink)] outline-none placeholder:text-[var(--adv-ink-4)]"
          />
          <span className="adv-kbd shrink-0">Esc</span>
        </div>
        <div className="max-h-[52vh] overflow-y-auto py-1.5">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-[var(--adv-ink-3)]">
              Nothing matches “{query}”.
            </p>
          ) : (
            results.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                onMouseEnter={() => setCursor(index)}
                onClick={() => run(entry)}
                data-active={index === cursor}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13.5px] text-[var(--adv-ink)] data-[active=true]:bg-[var(--adv-accent-bg)]"
              >
                {entry.group === t.switchBusiness ? (
                  <Building2 className="h-3.5 w-3.5 shrink-0 text-[var(--adv-accent)]" aria-hidden="true" />
                ) : null}
                <span className="adv-mono text-[9.5px] uppercase tracking-[0.08em] text-[var(--adv-ink-3)]">
                  {entry.group}
                </span>
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {entry.hint ? (
                  <span className="adv-mono text-[10px] text-[var(--adv-ink-4)]">{entry.hint}</span>
                ) : null}
                {index === cursor ? (
                  <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-[var(--adv-ink-3)]" aria-hidden="true" />
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
