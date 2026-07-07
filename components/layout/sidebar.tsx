"use client";

import { SidebarContent } from "./sidebar-content";

export function DesktopSidebar() {
  return (
    <aside className="hidden w-60 shrink-0 md:block">
      <SidebarContent />
    </aside>
  );
}
