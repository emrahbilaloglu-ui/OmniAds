"use client";

/**
 * The public creative-share page (Flow L, public branch).
 *
 * This is what someone outside the workspace sees. It renders only the
 * sanitized `PublicShare` — the internal ids, workspace name and contact
 * address are not in that object at all, so there is nothing here to leak.
 *
 * The unavailable state is deliberately one message for every cause. Expired,
 * revoked, rotated-away and never-existed look identical, because telling a
 * stranger holding a dead link which one it was confirms the link was once real
 * and that this workspace issued it.
 */
import { ShareMedia } from "@/components/zero-base/creative/share-media";
import type { PublicShare } from "@/lib/zero-base/creative/public-share";
import { PUBLIC_SHARE_GONE } from "@/lib/zero-base/creative/public-share";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export function PublicShareUnavailable() {
  const copy = useCopy();
  return (
    <main
      data-public-share="unavailable"
      style={{ maxWidth: 640, margin: "0 auto", padding: 24, fontSize: 14, lineHeight: "22px" }}
    >
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{copy.linkNotAvailable}</h1>
      <p style={{ marginTop: 8 }}>{PUBLIC_SHARE_GONE}</p>
    </main>
  );
}

export function PublicSharePage({ share }: { share: PublicShare }) {
  const copy = useCopy();
  return (
    <main
      data-public-share="ready"
      data-el="public-share"
      data-share-audience={share.audience}
      style={{ minHeight: "100vh", background: "var(--ledger-bg-app)", display: "grid", gridTemplateRows: "52px 1fr auto" }}
    >
      <header style={{ padding: "0 clamp(20px, 3vw, 40px)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid var(--ledger-border-subtle)", background: "var(--ledger-bg-surface)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 9, fontSize: 13, color: "var(--ledger-ink-secondary)" }}>
          <span aria-hidden="true" style={{ width: 20, height: 20, display: "grid", placeItems: "center", borderRadius: 5, background: "var(--ledger-accent-action)", color: "var(--ledger-bg-surface)", fontSize: 12, fontWeight: 800 }}>A</span>
          {copy.sharedVia} <strong style={{ color: "var(--ledger-ink-primary)" }}>{copy.brandName}</strong>
        </span>
        <span style={{ font: "12px/1.3 var(--font-mono, monospace)", color: "var(--ledger-ink-secondary)" }}>no login · no workspace identity</span>
      </header>
      <section aria-label={copy.creatives} style={{ width: "100%", maxWidth: 1180, margin: "0 auto", padding: "18px clamp(20px, 3vw, 40px)", display: "grid", gap: 14, alignContent: "start" }}>
        {share.creatives.length > 0 && share.financialWarning ? (
          <p data-share-financial-warning="" style={{ margin: 0, padding: "8px 10px", border: "1px solid var(--ledger-semantic-warn)", borderRadius: "var(--ledger-radius-card)", fontSize: 12, lineHeight: "18px", color: "var(--ledger-ink-secondary)" }}>
            {share.financialWarning}
          </p>
        ) : null}
        {share.creatives.length === 0 ? (
          <p data-share-creatives="empty" style={{ margin: 0, fontSize: 13 }}>
            {copy.shareHasNoCreatives}
          </p>
        ) : (
          share.creatives.map((creative) => (
            <article key={creative.key} data-share-creative={creative.key} style={{ display: "grid", gridTemplateColumns: "minmax(280px, 420px) minmax(0, 1fr)", alignItems: "start", gap: 26 }}>
              <div data-public-media-frame="" style={{ aspectRatio: "1 / 1", border: "1px solid var(--ledger-border-subtle)", borderRadius: 14, overflow: "hidden", background: "var(--ledger-bg-inset)", display: "grid", placeItems: "center" }}>
              {creative.media && (creative.media.kind === "image" || creative.media.kind === "video") ? (
                <ShareMedia source={creative.media} />
              ) : (
                <p
                  data-share-media="missing"
                  data-share-media-for={creative.key}
                  style={{ margin: 0, padding: 24, fontSize: 13, color: "var(--ledger-ink-tertiary)" }}
                >
                  {creative.mediaUnavailableReason ?? (creative.media as { reason?: string } | null)?.reason ?? "No preview was captured for this creative."}
                </p>
              )}
              </div>
              <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
                <div>
                  <h1 style={{ margin: 0, fontSize: 22, fontWeight: 750, lineHeight: "28px" }}>{creative.name}</h1>
                  {share.dateRange ? <p style={{ margin: "4px 0 0", font: "12px/1.4 var(--font-mono, monospace)", color: "var(--ledger-ink-secondary)" }}>{share.dateRange}</p> : null}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
                  {(creative.metrics ?? []).map((metric) => (
                    <div key={metric.key} data-public-metric={metric.key} style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
                      <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>{metric.label}</span>
                      <strong style={{ display: "block", marginTop: 3, font: "700 18px/1.25 var(--font-mono, monospace)" }}>{metric.value}</strong>
                    </div>
                  ))}
                  <div style={{ padding: 12, border: "1px dashed var(--ledger-border-control)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)", fontSize: 12, lineHeight: "17px", color: "var(--ledger-ink-secondary)" }}>
                    {share.audience === "buyer" ? "Financials are not included in this share tier" : "Performance data is not included in this creator share"}
                  </div>
                </div>
                <p style={{ margin: 0, padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)", fontSize: 12, lineHeight: "18px" }}><strong>{copy.commentary}</strong><span style={{ display: "block", marginTop: 3, color: "var(--ledger-ink-secondary)" }}>{copy.publicShareCommentary}</span></p>
              </div>
            </article>
          ))
        )}
      </section>
      <footer style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", padding: "12px clamp(20px, 3vw, 40px)", borderTop: "1px solid var(--ledger-border-subtle)", background: "var(--ledger-bg-surface)", font: "12px/1.4 var(--font-mono, monospace)", color: "var(--ledger-ink-secondary)" }}>
        <span>Link expires {share.expiresAt || "at the issuer-defined time"}</span>
        <span>Audience tier: {share.audience} · workspace identity excluded</span>
      </footer>
      <style>{`[data-public-media-frame] [data-share-media="image"],[data-public-media-frame] [data-share-media="video"]{width:100%!important;height:100%!important;object-fit:cover!important;border-radius:0!important}@media(max-width:720px){[data-share-creative]{grid-template-columns:1fr!important}}`}</style>
    </main>
  );
}
