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

function Surface({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{title}</h1>
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
  return (
    <Surface title={copy.creativeBriefs}>
      <div data-briefs-surface="" style={{ display: "grid", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12.5 }}>
          <Link href={backHref ?? "/"} data-ctl="live:CREATIVE-02 back" style={{ color: "var(--ledger-accent-action)" }}>
            {copy.backToCreatives}
          </Link>
        </p>
        {error ? (
          <p role="status" data-brief-error="" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
            {error}
          </p>
        ) : null}
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
            <p data-brief-create-blocked="" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
              {createBlockedReason}
            </p>
          )}
        </div>

        <p style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {/* Stated rather than discovered by trying: a brief is lineage. */}
          Briefs cannot be deleted. Something downstream may have been created from one, and
          removing it would break that trail silently.
        </p>

        <DataTable
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
                  <span data-brief-lineage={row.id} data-el="brief-lineage">
                    {row.lineage.creativeId} · {row.lineage.accountId}
                  </span>
                ) : (
                  <span data-brief-lineage-missing={row.id} style={{ color: "var(--ledger-semantic-warn)" }}>
                    {row.lineage.reason}
                  </span>
                ),
            },
          ]}
        />
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
        <p data-sourced-empty="" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-ink-tertiary)" }}>
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
  /** Discards the draft. A form with no way out is a trap. */
  onCancel?: () => void;
}) {
  const t = useCopy();
  const copy = useCopy();
  const [title, setTitle] = useState(initialTitle);
  const [audience, setAudience] = useState<"buyer" | "creator">(initialAudience);
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt);
  const [acknowledged, setAcknowledged] = useState(initialAcknowledged);
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
        <p role="status" data-share-error="" style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
          {error}
        </p>
      ) : null}
      <section aria-label={copy.createAShare} style={{ marginBottom: 16, display: "grid", gap: 8, maxWidth: 420 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.createAShare}</h2>
        <TextInput label={copy.title} data-share-title="" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextInput
          label={copy.expiresAt}
          data-share-expires=""
          data-ctl="live:CREATIVE-10 expiry"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
        />
        <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
          <legend style={{ fontSize: 12, color: "var(--ledger-ink-secondary)" }}>{copy.audience}</legend>
          {(["creator", "buyer"] as const).map((option) => (
            <label key={option} style={{ fontSize: 12.5, display: "flex", gap: 6 }}>
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
        {audience === "buyer" ? (
          <label data-share-ack-block="" data-el="share-tiers" style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "flex-start" }}>
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
          {onCancel ? (
            <Button
              variant="quiet"
              data-share-cancel=""
              data-ctl="live:cancel"
              onClick={() => {
                setTitle("");
                setExpiresAt("");
                setAcknowledged(false);
                onCancel();
              }}
              style={{ marginLeft: 6 }}
            >
              {copy.cancel}
            </Button>
          ) : null}
        </div>
      </section>

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
    </Surface>
  );
}
