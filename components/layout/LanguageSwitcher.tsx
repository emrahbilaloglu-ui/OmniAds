"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getTranslations, LANGUAGE_OPTIONS, type AppLanguage } from "@/lib/i18n";
import { usePreferencesStore } from "@/store/preferences-store";
import { cn } from "@/lib/utils";

const LANGUAGE_FLAG: Record<AppLanguage, string> = {
  en: "🇬🇧",
  tr: "🇹🇷",
};

export function LanguageSwitcher() {
  const router = useRouter();
  const language = usePreferencesStore((state) => state.language);
  const setLanguage = usePreferencesStore((state) => state.setLanguage);
  const [pendingLanguage, setPendingLanguage] = useState<AppLanguage | null>(null);
  const t = getTranslations(language);

  async function handleSelect(nextLanguage: AppLanguage) {
    if (nextLanguage === language || pendingLanguage) return;

    setPendingLanguage(nextLanguage);
    const previousLanguage = language;
    setLanguage(nextLanguage);

    try {
      const response = await fetch("/api/settings/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: nextLanguage }),
      });

      if (!response.ok) {
        throw new Error("language_update_failed");
      }

      router.refresh();
    } catch {
      setLanguage(previousLanguage);
    } finally {
      setPendingLanguage(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-9 gap-2 rounded-lg border-neutral-200 bg-white px-3 text-sm shadow-sm transition-colors hover:bg-neutral-50"
          aria-label={t.settings.languageLabel}
        >
          <span className="flex h-5 min-w-8 items-center justify-center rounded bg-primary/10 px-1.5 text-xs">
            {LANGUAGE_FLAG[language]}
          </span>
          <span className="hidden sm:inline">{language.toUpperCase()}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t.settings.languageTitle}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {LANGUAGE_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => void handleSelect(option.value)}
            className="cursor-pointer gap-2"
            disabled={Boolean(pendingLanguage)}
          >
            <span className="flex h-6 min-w-9 items-center justify-center rounded bg-primary/10 px-1.5 text-sm">
              {LANGUAGE_FLAG[option.value]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{option.label}</p>
              <p className="text-xs text-muted-foreground">{option.value.toUpperCase()}</p>
            </div>
            <Check
              className={cn(
                "h-4 w-4 shrink-0",
                option.value === language ? "opacity-100" : "opacity-0"
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
