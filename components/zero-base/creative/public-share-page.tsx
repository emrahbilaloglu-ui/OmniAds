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
      style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}
    >
      <header>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{share.title}</h1>
        {share.dateRange ? (
          <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ledger-ink-tertiary)" }}>{share.dateRange}</p>
        ) : null}
      </header>

      {share.financialWarning ? (
        <p
          data-share-financial-warning=""
          style={{
            margin: "16px 0 0",
            padding: "10px 14px",
            border: "1px solid #b8860b",
            borderRadius: 8,
            fontSize: 12.5,
            lineHeight: "18px",
          }}
        >
          {share.financialWarning}
        </p>
      ) : null}

      <section aria-label={copy.creatives} style={{ marginTop: 20, display: "grid", gap: 24 }}>
        {share.creatives.length === 0 ? (
          <p data-share-creatives="empty" style={{ margin: 0, fontSize: 13 }}>
            {copy.shareHasNoCreatives}
          </p>
        ) : (
          share.creatives.map((creative) => (
            <article key={creative.key} data-share-creative={creative.key} style={{ display: "grid", gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{creative.name}</h2>
              {creative.media ? (
                <ShareMedia source={creative.media} />
              ) : (
                <p
                  data-share-media="missing"
                  data-share-media-for={creative.key}
                  style={{ margin: 0, fontSize: 13, color: "var(--ledger-ink-tertiary)" }}
                >
                  {creative.mediaUnavailableReason}
                </p>
              )}
            </article>
          ))
        )}
      </section>
    </main>
  );
}
