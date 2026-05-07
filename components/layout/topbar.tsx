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
    <header className="h-12 border-b border-slate-200 bg-white flex items-center px-4 gap-2 sticky top-0 z-50">
      <BusinessSelector />
      <span className="text-slate-300">/</span>
      <PlatformSwitcher />

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          className="w-8 h-8 rounded-md hover:bg-slate-50 grid place-items-center text-slate-500 relative"
          aria-label={t.notifications}
        >
          <Bell className="h-[15px] w-[15px]" />
        </button>
        <PersonalAccountMenu userName={userName} />
      </div>
    </header>
  );
}
