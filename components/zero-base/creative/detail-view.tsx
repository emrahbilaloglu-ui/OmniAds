"use client";

/**
 * Creative detail and history (H22/H23).
 *
 * A deep link that names a creative this account does not own gets a distinct
 * refusal, not an empty page: "belongs to another account" and "does not exist"
 * are different problems with different fixes, and collapsing them sends an
 * operator looking for the wrong one.
 */
import Link from "next/link";

import { DataTable } from "@/components/zero-base/collections/data-table";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import { CreativeMedia } from "@/components/zero-base/creative/creative-media";
import {
  CREATIVE_REPLAY_BANNER,
  type DecisionBand,
  type EvidenceItem,
  type HistoryEntryView,
} from "@/lib/zero-base/creative/detail-adapter";
import type { MediaState } from "@/lib/zero-base/creative/performance-adapter";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export function CreativeDetailView({
  creativeId,
  name,
  media,
  evidence,
  band,
  decisionsHref,
  history,
  anyReplayed,
  shareHref = null,
  unavailableReason,
}: {
  creativeId: string;
  name: string;
  media: MediaState;
  evidence: readonly EvidenceItem[];
  band: DecisionBand;
  decisionsHref: string | null;
  history: readonly HistoryEntryView[];
  anyReplayed: boolean;
  /** Null where the actor cannot mint a share for this creative. */
  shareHref?: string | null;
  unavailableReason?: string | null;
}) {
  const copy = useCopy();
  if (unavailableReason) {
    return (
      <div data-creative-detail="">
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{copy.creative}</h1>
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      </div>
    );
  }

  return (
    <div data-creative-detail={creativeId} style={{ display: "grid", gap: 20 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <CreativeMedia state={media} label={name} />
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{name}</h1>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            {creativeId}
          </p>
        </div>
      </div>

      <section aria-label={copy.decision}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.decision}</h2>
        {band.kind === "band" ? (
          <p
            data-decision-band={band.label}
            // The band is only meaningful with the hysteresis that produced it:
            // a creative flips between Scale and Keep on noise otherwise.
            data-el="hysteresis-note"
            style={{ margin: "4px 0 0", fontSize: 13 }}
          >
            {band.label}
            {band.detail ? (
              <span style={{ display: "block", color: "var(--ledger-ink-secondary)" }}>{band.detail}</span>
            ) : null}
          </p>
        ) : (
          // No band and no action: the reason is the posture's own words.
          <p
            data-decision-band-none=""
            data-el="shadow-review-band"
            style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}
          >
            {band.reason}
          </p>
        )}
        {shareHref ? (
          <p style={{ margin: "6px 0 0", fontSize: 12.5 }}>
            <Link href={shareHref} data-ctl="live:CREATIVE-10 share" style={{ color: "var(--ledger-accent-action)" }}>
              {copy.shareThisCreative}
            </Link>
          </p>
        ) : null}
        {decisionsHref ? (
          <p style={{ margin: "6px 0 0", fontSize: 12.5 }}>
            <Link
              href={decisionsHref}
              data-detail-decision-link=""
              data-ctl="live:CREATIVE-07 brief"
              style={{ color: "var(--ledger-accent-action)" }}
            >
              {copy.openInDecisions}
            </Link>
          </p>
        ) : null}
      </section>

      <section aria-label={copy.evidence}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.evidence}</h2>
        {evidence.length === 0 ? (
          <p data-evidence="none" style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ledger-ink-tertiary)" }}>
            {copy.noEvidenceServed}
          </p>
        ) : (
          <dl data-evidence="ready" data-el="enrichment-label" style={{ display: "grid", gap: 6, margin: "8px 0 0" }}>
            {evidence.map((item) => (
              <div key={item.label}>
                <dt style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{item.label}</dt>
                <dd data-evidence-item={item.label} style={{ margin: 0, fontSize: 13 }}>
                  {item.value}
                  <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                    {item.source}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section aria-label={copy.history}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.history}</h2>
        {anyReplayed ? (
          <p
            role="status"
            data-creative-replay-banner=""
            style={{
              margin: "8px 0 0",
              padding: "10px 14px",
              borderRadius: "var(--ledger-radius-card)",
              border: "1px solid var(--ledger-semantic-warn)",
              fontSize: 12.5,
              color: "var(--ledger-semantic-warn)",
            }}
          >
            {CREATIVE_REPLAY_BANNER}
          </p>
        ) : null}
        <div style={{ marginTop: 8 }}>
          {history.length === 0 ? (
            <p data-creative-history="empty" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-ink-tertiary)" }}>
              {copy.nothingRecordedCreative}
            </p>
          ) : (
            <DataTable
              caption={copy.creativeHistory}
              rows={[...history]}
              rowKey={(row) => row.id}
              columns={[
                { id: "when", header: "When", render: (row) => row.occurredAt },
                { id: "what", header: "Entry", render: (row) => row.label },
                {
                  id: "actor",
                  header: "Actor",
                  render: (row) => <span data-history-actor={row.id}>{row.actor}</span>,
                },
                {
                  id: "provenance",
                  header: "Provenance",
                  render: (row) =>
                    row.replayed ? (
                      <span data-history-replayed={row.id} style={{ color: "var(--ledger-semantic-warn)" }}>
                        {copy.replayed}
                      </span>
                    ) : (
                      <span data-history-recorded={row.id}>{copy.recordedAtTheTime}</span>
                    ),
                },
              ]}
            />
          )}
        </div>
      </section>
    </div>
  );
}
