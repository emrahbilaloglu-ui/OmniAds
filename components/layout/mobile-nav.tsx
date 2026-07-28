"use client";

import { Menu } from "lucide-react";
import { useState } from "react";
import { SidebarContent } from "@/components/layout/sidebar-content";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

/**
 * Authenticated navigation for viewports below `md`.
 *
 * Both shells hide the left rail below `md` (`hidden … md:block`). A drawer used
 * to cover that case and was removed in "Phase Shell: 3-layer sidebar +
 * PlatformSwitcher + route migration" along with the `mobileSidebarOpen` store
 * flags — and nothing replaced it. The result was an authenticated product with
 * no way to move between destinations on a phone: the top bar and the page
 * content rendered, and that was all there was.
 *
 * The same component serves both shells rather than each growing its own, so
 * there is one place where "can you navigate on mobile" is true or false. It
 * carries its own open state instead of restoring the store flags: nothing else
 * needs to read it, and the collapse preference beside it is already local.
 */
export function MobileNav({ variant = "legacy" }: { variant?: "legacy" | "console" }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-neutral-600 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-1 md:hidden"
      >
        <Menu className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-60 p-0" data-shell-mobile-nav>
          {/* Radix requires an accessible title on a dialog; the rail itself is
              the content, so the title is for screen readers only. */}
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContent variant={variant} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
