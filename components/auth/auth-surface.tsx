"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { useZeroBaseUi } from "@/components/zero-base/rollout-provider";
import { ZERO_BASE_ROOT_ATTRIBUTE, ZERO_BASE_ROOT_VALUE } from "@/lib/design/ledger-tokens";

/**
 * The shared frame behind every auth and onboarding screen.
 *
 * All eight compositions — login, signup, forgot, reset, invite,
 * select-business, businesses/new and select-language — render through here,
 * so this is the one place the canonical experience has to be introduced. No
 * route is renamed and no page's own content changes; only the frame differs.
 *
 * With rollout off the legacy markup is emitted byte-for-byte, which is the
 * rollback: remove the canonical branch and every auth screen is exactly what
 * it was.
 */
export function AuthSurface({
  eyebrow,
  title,
  description,
  children,
  footer,
  supplement,
  width = "sm",
  embedded = false,
  titleOnBrandLine = false,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Optional sibling below the card, used for clearly separated entry paths. */
  supplement?: ReactNode;
  width?: "sm" | "md" | "lg";
  embedded?: boolean;
  titleOnBrandLine?: boolean;
}) {
  const { canonical } = useZeroBaseUi();

  const legacy = (
    <main className={`ad-auth-page${embedded ? " ad-auth-page-embedded" : ""}`}>
      <section className={`ad-auth-card ad-auth-card-${width}`}>
        {eyebrow ? <div className="ad-auth-eyebrow">{eyebrow}</div> : null}
        <div className="ad-auth-brand">
          {/* The only route back to the public site from any auth screen.
              This was an aria-hidden <span>, so /login, /signup,
              /forgot-password and /reset-password were all dead ends: nothing
              on them linked to "/". */}
          <Link href="/" aria-label="Adsecute home" className="ad-auth-mark-link">
            <span className="ad-auth-mark" aria-hidden="true" />
          </Link>
          {titleOnBrandLine ? <h1>{title}</h1> : <Link href="/">Adsecute</Link>}
        </div>
        {titleOnBrandLine ? (
          description ? (
            <div className="ad-auth-heading">
              <p>{description}</p>
            </div>
          ) : null
        ) : (
          <div className="ad-auth-heading">
            <h1>{title}</h1>
            {description ? <p>{description}</p> : null}
          </div>
        )}
        {children}
        {footer ? <div className="ad-auth-footer">{footer}</div> : null}
      </section>
    </main>
  );

  if (!canonical) return legacy;

  const maxWidth = width === "lg" ? 720 : width === "md" ? 560 : 420;

  return (
    <div
      {...{ [ZERO_BASE_ROOT_ATTRIBUTE]: ZERO_BASE_ROOT_VALUE }}
      data-auth-surface="zero-base"
      style={{
        minHeight: "100vh",
        display: "grid",
        gridTemplateRows: "64px 1fr auto",
        background: "var(--ledger-bg-app)",
        color: "var(--ledger-ink-primary)",
        // No auth screen may scroll sideways at 320.
        overflowX: "hidden",
      }}
    >
      <ZeroBasePortalHost>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, padding: "0 clamp(20px, 3vw, 40px)", borderBottom: "1px solid var(--ledger-border-subtle)", background: "var(--ledger-bg-surface)" }}>
          <Link href="/" aria-label="Adsecute home" style={{ display: "inline-flex", alignItems: "center", gap: 9, color: "var(--ledger-ink-primary)", textDecoration: "none", fontSize: 14, fontWeight: 800, letterSpacing: ".08em" }}>
            <span aria-hidden="true" style={{ width: 20, height: 20, display: "grid", placeItems: "center", borderRadius: 5, background: "var(--ledger-accent-action)", color: "var(--ledger-bg-surface)", fontSize: 12, letterSpacing: 0 }}>A</span>
            ADSECUTE
          </Link>
          <nav aria-label="Public" style={{ display: "flex", alignItems: "center", gap: 22, fontSize: 13 }}>
            <Link href="/product" style={{ color: "var(--ledger-ink-primary)", textDecoration: "none" }}>Product</Link>
            <Link href="/pricing" style={{ color: "var(--ledger-ink-primary)", textDecoration: "none" }}>Pricing</Link>
            <Link href="/contact" style={{ color: "var(--ledger-ink-primary)", textDecoration: "none" }}>Contact</Link>
          </nav>
        </header>
        <div style={{ display: "grid", placeItems: "center", width: "100%", padding: "36px 16px 18px" }}>
        <div style={{ display: "grid", gap: 12, width: "100%", maxWidth }}>
        <main
          style={{
            width: "100%",
            maxWidth,
            background: "var(--ledger-bg-surface)",
            border: "1px solid var(--ledger-border-subtle)",
            borderRadius: 14,
            padding: 28,
            boxShadow: "0 14px 38px color-mix(in srgb, var(--ledger-ink-primary) 9%, transparent)",
          }}
        >
          {eyebrow ? <div style={{ marginBottom: 10, fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}>{eyebrow}</div> : null}
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{title}</h1>
          {description ? (
            <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: "19px", color: "var(--ledger-ink-secondary)" }}>
              {description}
            </p>
          ) : null}
          <div style={{ marginTop: 16 }}>{children}</div>
          {footer ? (
            <div
              style={{
                marginTop: 16,
                paddingTop: 12,
                borderTop: "1px solid var(--ledger-border-subtle)",
                fontSize: 12.5,
                lineHeight: "18px",
                color: "var(--ledger-ink-secondary)",
              }}
            >
              {footer}
            </div>
          ) : null}
        </main>
        {supplement ? <div>{supplement}</div> : null}
        </div>
        </div>
        <footer style={{ padding: "0 16px 16px", textAlign: "center", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
          <Link href="/privacy" style={{ color: "inherit", textDecoration: "none" }}>Privacy</Link> ·{" "}
          <Link href="/terms" style={{ color: "inherit", textDecoration: "none" }}>Terms</Link> ·{" "}
          <Link href="/security" style={{ color: "inherit", textDecoration: "none" }}>Security</Link> · AI transparency
        </footer>
      </ZeroBasePortalHost>
    </div>
  );
}
