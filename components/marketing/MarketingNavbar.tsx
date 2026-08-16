"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { BrandLogo } from "@/components/brand/BrandLogo";

export function MarketingNavbar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <BrandLogo markClassName="h-8 w-8" size={32} />
          </Link>

          <nav className="hidden md:flex items-center gap-7">
            <Link href="/product" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Product
            </Link>
            <Link href="/pricing" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Pricing
            </Link>
            <Link href="/demo" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Demo
            </Link>
            <Link href="/contact" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Contact
            </Link>
            <Link href="/about" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              About
            </Link>
          </nav>

          <div className="hidden md:flex items-center gap-3">
            <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground transition-colors px-2">
              Log in
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 transition-opacity"
            >
              Get started
            </Link>
          </div>

          <button
            className="md:hidden text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(!open)}
            aria-label="Toggle menu"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {open && (
          <div className="md:hidden border-t border-border pb-4 pt-3 flex flex-col gap-1">
            <Link href="/product" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={() => setOpen(false)}>
              Product
            </Link>
            <Link href="/pricing" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={() => setOpen(false)}>
              Pricing
            </Link>
            <Link href="/demo" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={() => setOpen(false)}>
              Demo
            </Link>
            <Link href="/contact" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={() => setOpen(false)}>
              Contact
            </Link>
            <Link href="/about" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={() => setOpen(false)}>
              About
            </Link>
            <div className="mt-2 pt-3 border-t border-border flex flex-col gap-2">
              <Link href="/login" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={() => setOpen(false)}>
                Log in
              </Link>
              <Link href="/login" className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background text-center hover:opacity-90 transition-opacity" onClick={() => setOpen(false)}>
                Get started
              </Link>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
