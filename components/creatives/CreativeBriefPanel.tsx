"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, FileCheck2, Rocket, Save } from "lucide-react";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import type {
  MetaCreativeBrief,
  MetaCreativeBriefContent,
  MetaCreativeBriefStatus,
} from "@/lib/meta/creative-brief-contract";

const EMPTY_CONTENT: MetaCreativeBriefContent = {
  keep: "",
  change: "",
  next: "",
};

function responseError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message;
  }
  if (record.error && typeof record.error === "object") {
    const message = (record.error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function createIdempotencyKey(snapshotId: string) {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `creative-brief:${snapshotId}:${suffix}`;
}

export function CreativeBriefPanel({
  businessId,
  providerAccountId,
  creativeId,
  decisionCard,
  existingBrief,
  onBriefChanged,
}: {
  businessId: string;
  providerAccountId: string;
  creativeId: string;
  decisionCard: BriefingCreativeCard | null;
  existingBrief: MetaCreativeBrief | null;
  onBriefChanged: (brief: MetaCreativeBrief) => void;
}) {
  const snapshotId = decisionCard?.sourceDecisionSnapshotId ?? null;
  const sourceMatched =
    decisionCard?.sourceDecisionSnapshotMatch === "matched" && Boolean(snapshotId);
  const currentBrief = existingBrief;
  const sourceMatchesCurrentCard =
    Boolean(currentBrief) && currentBrief?.sourceDecision.snapshotId === snapshotId;
  const canPersist = Boolean(currentBrief) || sourceMatched;
  const [content, setContent] = useState<MetaCreativeBriefContent>(
    () => currentBrief?.content ?? EMPTY_CONTENT,
  );
  const [createKey, setCreateKey] = useState(() =>
    snapshotId ? createIdempotencyKey(snapshotId) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContent(currentBrief?.content ?? EMPTY_CONTENT);
    setCreateKey(snapshotId ? createIdempotencyKey(snapshotId) : "");
    setError(null);
  }, [creativeId, currentBrief?.id, currentBrief?.version, snapshotId]);

  const dirty = useMemo(
    () =>
      !currentBrief ||
      content.keep !== currentBrief.content.keep ||
      content.change !== currentBrief.content.change ||
      content.next !== currentBrief.content.next,
    [content, currentBrief],
  );
  const reviewReady = Object.values(content).every(
    (value) => value.trim().length > 0,
  );

  async function persist(status: MetaCreativeBriefStatus) {
    if ((!currentBrief && (!snapshotId || !sourceMatched)) || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = currentBrief
        ? await fetch(
            `/api/meta/creative-briefs/${encodeURIComponent(currentBrief.id)}?businessId=${encodeURIComponent(businessId)}&providerAccountId=${encodeURIComponent(providerAccountId)}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({
                expectedVersion: currentBrief.version,
                content,
                status,
              }),
            },
          )
        : await fetch("/api/meta/creative-briefs", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              businessId,
              providerAccountId,
              idempotencyKey: createKey,
              sourceDecision: {
                snapshotId,
                trigger: "creative_studio_detail",
              },
              content,
              status,
            }),
          });
      const payload = (await response.json().catch(() => null)) as
        | { brief?: MetaCreativeBrief }
        | null;
      if (!response.ok || !payload?.brief) {
        throw new Error(responseError(payload, `Creative Brief could not be saved (${response.status}).`));
      }
      onBriefChanged(payload.brief);
      setContent(payload.brief.content);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Creative Brief could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const launchHref = currentBrief
    ? `/platforms/meta/launchpad?fromBriefing=true&providerAccountId=${encodeURIComponent(providerAccountId)}&creativeBriefId=${encodeURIComponent(currentBrief.id)}&sourceDecisionId=${encodeURIComponent(currentBrief.sourceDecision.decisionId)}&sourceDecisionSnapshotId=${encodeURIComponent(currentBrief.sourceDecision.snapshotId)}&creativeIds=${encodeURIComponent(creativeId)}&mode=rebuild`
    : null;

  return (
    <section
      className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-3"
      data-testid="creative-brief-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ink)]">
            <FileCheck2 className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
            Creative Brief
          </h3>
          <p className="mt-1 text-[11px] leading-4 text-[var(--muted)]">
            A separate workflow object. It never changes the engine label or raw decision evidence.
          </p>
        </div>
        <span className={`chip ${currentBrief?.status === "reviewed" ? "chip--healthy" : "chip--ghost"}`}>
          {currentBrief?.status ?? "Not saved"}
        </span>
      </div>

      {!currentBrief && !sourceMatched ? (
        <div className="mt-3 flex gap-2 rounded-[var(--r-sm)] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-2.5 text-[11px] leading-4 text-[var(--warn)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          The live card does not reconcile to an account-scoped persisted decision snapshot. Brief creation is withheld.
        </div>
      ) : null}

      {currentBrief && !sourceMatchesCurrentCard ? (
        <div className="mt-3 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-[11px] leading-4 text-[var(--muted)]">
          This brief preserves decision snapshot {currentBrief.sourceDecision.snapshotAsOf}. Its immutable source remains historical even if the live card has moved to a newer decision.
        </div>
      ) : null}

      <div className="mt-3 grid gap-2.5">
        {(["keep", "change", "next"] as const).map((field) => (
          <label key={field} className="grid gap-1 text-[11px] font-semibold text-[var(--ink)]">
            {field === "keep" ? "Keep" : field === "change" ? "Change" : "Next test"}
            <textarea
              value={content[field]}
              disabled={!canPersist || saving}
              onChange={(event) =>
                setContent((current) => ({ ...current, [field]: event.currentTarget.value }))
              }
              rows={field === "next" ? 3 : 2}
              placeholder={
                field === "keep"
                  ? "What must remain unchanged?"
                  : field === "change"
                    ? "What should the creator change?"
                    : "What single next test should be produced?"
              }
              className="w-full resize-y rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-[12px] font-normal leading-4 text-[var(--ink)] outline-none focus:border-[var(--border-3)] disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
        ))}
      </div>

      {error ? (
        <p className="mt-2 rounded-[var(--r-sm)] border border-[var(--danger-bd)] bg-[var(--danger-bg)] px-2.5 py-2 text-[11px] text-[var(--danger)]" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn--sm"
          disabled={!canPersist || saving || (Boolean(currentBrief) && !dirty && currentBrief?.status === "draft")}
          onClick={() => persist("draft")}
        >
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
          {saving ? "Saving" : "Save draft"}
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={
            !canPersist ||
            saving ||
            !reviewReady ||
            (currentBrief?.status === "reviewed" && !dirty)
          }
          title={
            reviewReady
              ? "Mark this version reviewed"
              : "Keep, Change, and Next test are required before review"
          }
          onClick={() => persist("reviewed")}
        >
          <FileCheck2 className="h-3.5 w-3.5" aria-hidden="true" />
          {currentBrief?.status === "reviewed" && !dirty ? "Reviewed" : "Mark reviewed"}
        </button>
        {currentBrief?.status === "reviewed" && !dirty && launchHref ? (
          <Link className="btn btn--sm" href={launchHref}>
            <Rocket className="h-3.5 w-3.5" aria-hidden="true" />
            Open in Launchpad
          </Link>
        ) : null}
      </div>

      <p className="mt-2 font-mono text-[10px] leading-4 text-[var(--muted)]">
        {currentBrief
          ? `brief ${currentBrief.id} · v${currentBrief.version} · source ${currentBrief.sourceDecision.snapshotId}`
          : snapshotId
            ? `source snapshot ${snapshotId}`
            : "source snapshot unavailable"}
      </p>
    </section>
  );
}
