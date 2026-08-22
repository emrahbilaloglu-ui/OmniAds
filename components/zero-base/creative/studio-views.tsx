"use client";

/**
 * The five creative studio surfaces (Flow D) plus the share ledger (Flow L).
 *
 * Each renders what its backend served and discloses what it did not. The
 * briefs surface has no delete control anywhere in it — see the adapter for
 * why — and the share ledger separates revoked from expired for the owner while
 * the public surface deliberately cannot.
 */
import { useState } from "react";

import Link from "next/link";

import { DataTable } from "@/components/zero-base/collections/data-table";
import { Button } from "@/components/zero-base/primitives/button";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { BUYER_FINANCIAL_WARNING } from "@/lib/zero-base/creative/share-acknowledgement";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import {
  BACKEND_CAP_NOT_SUPPLIED,
  landingPageCap,
  sourceState,
  type BriefRow,
  type ShareRow,
} from "@/lib/zero-base/creative/studio-adapters";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";
import legacyStyles from "@/components/zero-base/legacy-workspace-interior.module.css";

function Surface({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={legacyStyles.workspace}>
      <p style={{ margin: 0, fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--ledger-ink-tertiary)" }}>Creative Intelligence</p>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{title}</h1>
      <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>Business-scoped creative workflow and source-backed records.</p>
      <div style={{ marginTop: 16 }}>{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- briefs */

export function BriefsView({
  rows,
  backHref = null,
  canCreate,
  createBlockedReason,
  onCreate,
  error,
  unavailableReason,
}: {
  rows: readonly BriefRow[];
  /** Where the brief was reached from. */
  backHref?: string | null;
  canCreate: boolean;
  createBlockedReason: string | null;
  onCreate?: () => void;
  error?: string | null;
  unavailableReason?: string | null;
}) {
  const copy = useCopy();
  if (unavailableReason) {
    return (
      <Surface title={copy.creativeBriefs}>
        <UnavailableState reason={unavailableReason} />
      </Surface>
    );
  }
  const activeBrief = rows[0] ?? null;
  return (
    <Surface title={copy.creativeBriefs}>
      <div data-briefs-surface="" style={{ display: "grid", gap: 12 }}>
        {error ? (
          <p role="status" data-brief-error="" style={{ margin: 0, fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
            {error}
          </p>
        ) : null}

        <p style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {/* Stated rather than discovered by trying: a brief is lineage. */}
          Briefs cannot be deleted. Something downstream may have been created from one, and
          removing it would break that trail silently.
        </p>

        {activeBrief ? (
          <section data-brief-detail={activeBrief.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(260px, 2fr)", gap: 12 }}>
            <article style={{ padding: 14, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start", flexWrap: "wrap" }}>
                <div>
                  <span style={{ display: "block", font: "12px/1.3 var(--font-mono, monospace)", color: "var(--ledger-ink-tertiary)" }}>BRIEF {activeBrief.id}</span>
                  <h2 style={{ margin: "4px 0 0", fontSize: 17, fontWeight: 700 }}>{activeBrief.title}</h2>
                </div>
                <span style={{ padding: "4px 8px", borderRadius: 999, background: "var(--ledger-accent-tint)", color: "var(--ledger-accent-action)", fontSize: 12, fontWeight: 700 }}>{activeBrief.status}</span>
              </div>
              <dl style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 10, margin: "16px 0 0" }}>
                <div><dt style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.created}</dt><dd style={{ margin: "3px 0 0", fontSize: 12 }}>{activeBrief.createdAt}</dd></div>
                <div><dt style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.deletion}</dt><dd style={{ margin: "3px 0 0", fontSize: 12 }}>{copy.lineageImmutable}</dd></div>
              </dl>
              <div aria-label={copy.briefLifecycle} style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 6, marginTop: 14 }}>
                {["Draft", "Briefed", "In production", "Delivered"].map((step, index) => (
                  <div key={step} style={{ padding: "7px 8px", borderTop: `3px solid ${index <= 1 ? "var(--ledger-semantic-ok)" : "var(--ledger-border-subtle)"}`, fontSize: 12, color: index <= 1 ? "var(--ledger-ink-primary)" : "var(--ledger-ink-tertiary)" }}>{step}</div>
                ))}
              </div>
              <section style={{ marginTop: 12, padding: 10, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-app)" }}>
                <h3 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", color: "var(--ledger-ink-tertiary)" }}>{copy.objective}</h3>
                <p style={{ margin: "5px 0 0", fontSize: 12, lineHeight: "18px" }}>{copy.briefObjectiveDetail}</p>
              </section>
            </article>
            <aside style={{ padding: 14, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>{copy.derivedContext}</h3>
              {activeBrief.lineage.known ? (
                <dl data-el="brief-lineage" data-brief-lineage={activeBrief.id} style={{ margin: "10px 0 0", display: "grid", gap: 8, fontSize: 12 }}>
                  <div><dt style={{ color: "var(--ledger-ink-tertiary)" }}>{copy.creative}</dt><dd style={{ margin: 0 }}>{activeBrief.lineage.creativeId}</dd></div>
                  <div><dt style={{ color: "var(--ledger-ink-tertiary)" }}>{copy.account}</dt><dd style={{ margin: 0 }}>{activeBrief.lineage.accountId}</dd></div>
                </dl>
              ) : <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>{activeBrief.lineage.reason}</p>}
              <Link href={backHref ?? "/"} data-ctl="live:CREATIVE-02 back" style={{ display: "inline-flex", marginTop: 12, color: "var(--ledger-accent-action)", fontSize: 12 }}>{copy.backToCreatives}</Link>
            </aside>
          </section>
        ) : null}

        {activeBrief && rows.length > 1 ? (
          <section aria-label={copy.otherBriefs} style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
            <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>{copy.otherBriefs}</h2>
            <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 7 }}>
              {rows.slice(1).map((row) => (
                <li key={row.id} style={{ display: "grid", gridTemplateColumns: "minmax(140px,1fr) minmax(0,2fr)", gap: 12, paddingTop: 7, borderTop: "1px solid var(--ledger-border-subtle)", fontSize: 12 }}>
                  <strong>{row.title}</strong>
                  {row.lineage.known ? (
                    <span data-brief-lineage={row.id}>{row.lineage.creativeId} · {row.lineage.accountId}</span>
                  ) : (
                    <span data-brief-lineage-missing={row.id} style={{ color: "var(--ledger-semantic-warn)" }}>{row.lineage.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {!activeBrief ? <DataTable
          caption={copy.creativeBriefs}
          rows={[...rows]}
          rowKey={(row) => row.id}
          columns={[
            { id: "title", header: "Brief", render: (row) => row.title },
            { id: "created", header: "Created", render: (row) => row.createdAt },
            { id: "status", header: "Status", render: (row) => row.status },
            {
              id: "lineage",
              header: "Derived from",
              render: (row) =>
                row.lineage.known ? (
                  <span data-brief-lineage={row.id}>
                    {row.lineage.creativeId} · {row.lineage.accountId}
                  </span>
                ) : (
                  <span data-brief-lineage-missing={row.id} style={{ color: "var(--ledger-semantic-warn)" }}>
                    {row.lineage.reason}
                  </span>
                ),
            },
          ]}
        /> : null}
        {!activeBrief ? <p style={{ margin: 0, fontSize: 12 }}><Link href={backHref ?? "/"} data-ctl="live:CREATIVE-02 back" style={{ color: "var(--ledger-accent-action)" }}>{copy.backToCreatives}</Link></p> : null}
        <div>
          {canCreate ? (
            <Button
              variant="secondary"
              data-brief-create=""
              data-ctl="live:CREATIVE-07 status"
              onClick={onCreate}
            >
              {copy.createBriefFromCreative}
            </Button>
          ) : (
            <p data-brief-create-blocked="" style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
              {createBlockedReason}
            </p>
          )}
        </div>
        <style>{`@media(max-width:760px){[data-brief-detail]{grid-template-columns:1fr!important}}`}</style>
      </div>
    </Surface>
  );
}

/* ------------------------------------------------------- inbox and copies */

export interface SourcedRow {
  id: string;
  label: string;
  detail: string | null;
  source: string | null;
}

export function SourcedListView({
  title,
  rows,
  emptyReason,
  unavailableReason,
}: {
  title: string;
  rows: readonly SourcedRow[];
  emptyReason: string;
  unavailableReason?: string | null;
}) {
  if (unavailableReason) {
    return (
      <Surface title={title}>
        <UnavailableState reason={unavailableReason} />
      </Surface>
    );
  }
  return (
    <Surface title={title}>
      {rows.length === 0 ? (
        <p data-sourced-empty="" style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {emptyReason}
        </p>
      ) : (
        <DataTable
          caption={title}
          rows={[...rows]}
          rowKey={(row) => row.id}
          columns={[
            { id: "label", header: "Item", render: (row) => row.label },
            { id: "detail", header: "Detail", render: (row) => row.detail ?? "—" },
            {
              id: "source",
              header: "Source",
              render: (row) => {
                const state = sourceState(row.source);
                return state.kind === "sourced" ? (
                  <span data-row-source={row.id}>{state.source}</span>
                ) : (
                  <span data-row-unsourced={row.id} style={{ color: "var(--ledger-ink-tertiary)" }}>
                    {state.reason}
                  </span>
                );
              },
            },
          ]}
        />
      )}
    </Surface>
  );
}

/* -------------------------------------------------------- landing pages */

export function LandingPagesView({
  rows,
  served,
  unavailableReason,
}: {
  rows: readonly { id: string; path: string; sessions: string; conversions: string }[];
  served: { rowCap?: number | null; pageSize?: number | null };
  unavailableReason?: string | null;
}) {
  const copy = useCopy();
  const cap = landingPageCap(served);
  if (unavailableReason) {
    return (
      <Surface title={copy.landingPages}>
        <UnavailableState reason={unavailableReason} />
      </Surface>
    );
  }
  return (
    <Surface title={copy.landingPages}>
      <p
        data-landing-cap={cap.rowCap === null && cap.pageSize === null ? "not-supplied" : "served"}
        style={{ margin: "0 0 12px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}
      >
        {cap.text}
        {cap.text === BACKEND_CAP_NOT_SUPPLIED
          ? " — this surface does not know how many rows the backend will return."
          : ""}
      </p>
      <DataTable
        caption={copy.landingPages}
        rows={[...rows]}
        rowKey={(row) => row.id}
        columns={[
          { id: "path", header: "Page", render: (row) => row.path },
          { id: "sessions", header: "Sessions", numeric: true, render: (row) => row.sessions },
          { id: "conversions", header: "Conversions", numeric: true, render: (row) => row.conversions },
        ]}
      />
    </Surface>
  );
}

/* --------------------------------------------------------------- shares */

export function SharesView({
  rows,
  onRevoke,
  onRotate,
  onCreate,
  busyToken,
  error,
  unavailableReason,
  initialTitle = "",
  initialAudience = "creator",
  initialExpiresAt = "",
  initialAcknowledged = false,
  initialOpen = false,
  showAlternateGateProof = false,
  createRefusalReason = null,
  onCancel,
}: {
  rows: readonly ShareRow[];
  onRevoke?: (token: string) => void;
  onRotate?: (token: string) => void;
  onCreate?: (input: { title: string; audience: "buyer" | "creator"; expiresAt: string }) => void;
  busyToken?: string | null;
  error?: string | null;
  unavailableReason?: string | null;
  /** Draft state to open in; a share form part-way through is a real state. */
  initialTitle?: string;
  initialAudience?: "buyer" | "creator";
  initialExpiresAt?: string;
  initialAcknowledged?: boolean;
  /**
   * Defaults CLOSED.
   *
   * It defaulted open, so arriving at the Shares ledger put a half-filled
   * mint form in front of the operator before they had read what already
   * exists — and the primary reason to open this screen is to check, rotate or
   * revoke an existing link. A caller that wants the form open (a reference
   * artboard, a resumed draft) says so explicitly. WP11 item 5.
   */
  initialOpen?: boolean;
  /** Reference artboard only: shows the alternate unacknowledged gate beside the live state. */
  showAlternateGateProof?: boolean;
  /**
   * Why minting is refused here, when it is. Shown on the control rather than
   * discovered as a 400 after the form is filled in.
   */
  createRefusalReason?: string | null;
  /**
   * Optional notification that the draft was discarded. The Cancel control
   * itself is always rendered — a form with no way out is a trap, and that is
   * not something a caller may opt out of.
   */
  onCancel?: () => void;
}) {
  const t = useCopy();
  const copy = useCopy();
  const [title, setTitle] = useState(initialTitle);
  const [audience, setAudience] = useState<"buyer" | "creator">(initialAudience);
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt);
  const [acknowledged, setAcknowledged] = useState(initialAcknowledged);
  const [createOpen, setCreateOpen] = useState(initialOpen);
  const canSubmit = Boolean(title.trim() && expiresAt.trim() && (audience === "creator" || acknowledged));
  if (unavailableReason) {
    return (
      <Surface title={copy.shares}>
        <UnavailableState reason={unavailableReason} />
      </Surface>
    );
  }
  return (
    <Surface title={copy.shares}>
      {error ? (
        <p role="status" data-share-error="" style={{ margin: "0 0 12px", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
          {error}
        </p>
      ) : null}
      <DataTable
        collection="links"
        caption={copy.shareLedger}
        rows={[...rows]}
        rowKey={(row) => row.token}
        columns={[
          { id: "title", header: "Share", render: (row) => row.title },
          { id: "audience", header: "Audience", render: (row) => row.audience },
          {
            id: "status",
            header: "Status",
            // The owner sees revoked and expired as different facts; the public
            // surface deliberately cannot tell them apart.
            render: (row) => <span data-share-status={row.token}>{row.statusText}</span>,
          },
          {
            id: "actions",
            header: "Actions",
            render: (row) =>
              row.status === "active" ? (
                <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Button
                    variant="secondary"
                    data-share-rotate={row.token}
                    data-ctl="live:CREATIVE-10 rotate"
                    state={busyToken === row.token ? { kind: "busy", label: "Working…" } : { kind: "enabled" }}
                    onClick={() => onRotate?.(row.token)}
                  >
                    {copy.rotateLink}
                  </Button>
                  <Button
                    variant="danger"
                    data-share-revoke={row.token}
                    data-ctl="live:CREATIVE-10 revoke"
                    state={busyToken === row.token ? { kind: "busy", label: "Working…" } : { kind: "enabled" }}
                    onClick={() => onRevoke?.(row.token)}
                  >
                    {t.revoke}
                  </Button>
                </span>
              ) : (
                <span data-share-actions-none={row.token} style={{ color: "var(--ledger-ink-tertiary)" }}>
                  No actions — this link is already {row.status}.
                </span>
              ),
          },
        ]}
      />

      <div style={{ marginTop: 12 }}>
        {/*
          Refused rather than removed when the caller supplies no `onCreate`.

          The mint form on this screen carries a title, an audience and an
          expiry, and no creative selection — while the server requires
          `creatives.length > 0`. So a create issued from here was a guaranteed
          400 (plan §5.1 finding 16): a control that looked live and could never
          succeed. Selection happens in the Creative Studio share flow, and this
          says so instead of silently failing or vanishing.
        */}
        <Button
          variant="secondary"
          data-ctl="live:CREATIVE-10 open-create"
          state={
            onCreate
              ? { kind: "enabled" }
              : {
                  kind: "disabled",
                  reason: createRefusalReason ?? copy.shareCreateElsewhere,
                }
          }
          onClick={onCreate ? () => setCreateOpen(true) : undefined}
        >
          {copy.createAShare}
        </Button>
      </div>
      {createOpen ? (
      <div data-share-dialog-backdrop="" style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "var(--ledger-scrim)" }}>
      <section role="dialog" aria-modal="true" aria-label={copy.createAShare} style={{ width: "calc(100% - 32px)", maxWidth: 500, padding: 18, display: "grid", gap: 8, border: "1px solid var(--ledger-border-control)", borderRadius: 14, background: "var(--ledger-bg-surface)", boxShadow: "var(--ledger-elevation-2)" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.createAShare}</h2>
        <TextInput label={copy.title} data-share-title="" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div data-el="share-tiers">
        <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
          <legend style={{ fontSize: 12, color: "var(--ledger-ink-secondary)" }}>{copy.audience}</legend>
          {(["creator", "buyer"] as const).map((option) => (
            <label key={option} style={{ fontSize: 12, display: "flex", gap: 6 }}>
              <input
                type="radio"
                name="share-audience"
                data-share-audience={option}
                data-ctl="live:CREATIVE-11 tier"
                checked={audience === option}
                onChange={() => setAudience(option)}
              />
              {option === "buyer" ? "Buyer (outside this workspace)" : "Creator (inside this workspace)"}
            </label>
          ))}
        </fieldset>
        </div>
        <TextInput
          label={copy.expiresAt}
          data-share-expires=""
          data-ctl="live:CREATIVE-10 expiry"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
        />
        {audience === "buyer" ? (
          <label data-share-ack-block="" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              data-share-acknowledge=""
              data-ctl="live:CREATIVE-11 ack"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>{BUYER_FINANCIAL_WARNING}</span>
          </label>
        ) : null}
        <div>
          <Button
            variant="secondary"
            data-share-create=""
            data-ctl={canSubmit ? "live:CREATIVE-10 mint" : "disabled:CREATIVE-10 mint"}
            state={
              canSubmit
                ? { kind: "enabled" }
                : {
                    kind: "disabled",
                    reason:
                      audience === "buyer" && !acknowledged
                        ? "A buyer share requires the financial acknowledgement."
                        : "A share needs a title and an expiry.",
                  }
            }
            onClick={() => onCreate?.({ title: title.trim(), audience, expiresAt: expiresAt.trim() })}
          >
            {copy.createShare}
          </Button>
          {showAlternateGateProof && canSubmit ? (
            <Button
              variant="secondary"
              data-ctl="disabled:CREATIVE-10 mint"
              state={{ kind: "disabled", reason: "A buyer share requires the financial acknowledgement." }}
              style={{ marginLeft: 6 }}
            >
              {copy.acknowledgementRequired}
            </Button>
          ) : null}
          {/*
            Unconditional, not gated on `onCancel`. This dialog opens with the
            surface (H27 draws the form open), so a cancel that only exists when
            a caller happens to pass a handler leaves the operator inside a modal
            with no way out — which is what the production share client did.
            Closing is the view's own business; `onCancel` is only the optional
            notification that the draft was discarded.
          */}
          <Button
            variant="quiet"
            data-share-cancel=""
            data-ctl="live:cancel"
            onClick={() => {
              setTitle("");
              setExpiresAt("");
              setAcknowledged(false);
              setCreateOpen(false);
              onCancel?.();
            }}
            style={{ marginLeft: 6 }}
          >
            {copy.cancel}
          </Button>
        </div>
      </section>
      </div>
      ) : null}

    </Surface>
  );
}
