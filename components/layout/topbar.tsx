"use client";

import { Bell } from "lucide-react";
import { BusinessSelector } from "@/components/business/BusinessSelector";
import { PersonalAccountMenu } from "@/components/layout/PersonalAccountMenu";
import { PlatformSwitcher } from "@/components/layout/PlatformSwitcher";
import { getTranslations } from "@/lib/i18n";
import { usePreferencesStore } from "@/store/preferences-store";

interface TopbarProps {
  userName: string;
}

export function Topbar({ userName }: TopbarProps) {
  const language = usePreferencesStore((state) => state.language);
  const t = getTranslations(language).layout;

  return (
    <header className="sticky top-0 z-50 flex h-12 items-center gap-1.5 border-b border-neutral-200 bg-white px-3 sm:gap-2 sm:px-4">
      <BusinessSelector />
      <span className="hidden text-neutral-300 sm:inline">/</span>
      <PlatformSwitcher />

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          className="w-8 h-8 rounded-md hover:bg-neutral-50 grid place-items-center text-neutral-500 relative"
          aria-label={t.notifications}
        >
          <Bell className="h-[15px] w-[15px]" />
        </button>
        <PersonalAccountMenu userName={userName} />
      </div>
    </header>
  );
}
