"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, X } from "lucide-react";

export type ShareAudience = "buyer" | "creative_team" | "external";

export interface ShareViewState {
  audience: ShareAudience;
  hideDecisionLanguage: boolean;
  expiresInDays: number;
  freezeSnapshot: boolean;
}

interface ShareViewModalProps {
  open: boolean;
  presetLabel: string;
  itemCount: number;
  initialState?: Partial<ShareViewState>;
  buildShareUrl?: (state: ShareViewState) => string;
  onConfirm?: (state: ShareViewState, url: string) => void;
  onClose: () => void;
  testId?: string;
}

const AUDIENCES: ReadonlyArray<{
  key: ShareAudience;
  label: string;
  description: string;
}> = [
  {
    key: "buyer",
    label: "Buyer",
    description: "Revenue + efficiency metrics, decision language visible.",
  },
  {
    key: "creative_team",
    label: "Creative team",
    description: "Hook / CTA / Offer scoring framing, no Cut/Scale language.",
  },
  {
    key: "external",
    label: "External",
    description: "Public-safe summary, no internal benchmarks or labels.",
  },
];

const DEFAULT_STATE: ShareViewState = {
  audience: "creative_team",
  hideDecisionLanguage: true,
  expiresInDays: 7,
  freezeSnapshot: true,
};

export function ShareViewModal({
  open,
  presetLabel,
  itemCount,
  initialState,
  buildShareUrl,
  onConfirm,
  onClose,
  testId = "share-view-modal",
}: ShareViewModalProps) {
  const [state, setState] = useState<ShareViewState>({
    ...DEFAULT_STATE,
    ...initialState,
  });
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  useEffect(() => {
    if (open) {
      setState({ ...DEFAULT_STATE, ...initialState });
      setCopyState("idle");
    }
  }, [open, initialState]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const url = useMemo(() => {
    if (buildShareUrl) return buildShareUrl(state);
    const params = new URLSearchParams({
      audience: state.audience,
      expires: String(state.expiresInDays),
      snapshot: state.freezeSnapshot ? "1" : "0",
    });
    return `/share/creative/[token]?${params.toString()}`;
  }, [buildShareUrl, state]);

  if (!open) return null;

  function handleCopy() {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(url);
    }
    setCopyState("copied");
    window.setTimeout(() => setCopyState("idle"), 1600);
  }

  function handleConfirm() {
    onConfirm?.(state, url);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" data-testid={testId}>
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/40"
        aria-label="Close share view"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-[520px] overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <div>
            <h2 className="text-[14px] font-bold tracking-tight text-neutral-900">
              Share view
            </h2>
            <div className="text-[11.5px] text-neutral-500">
              preset · {presetLabel} · {itemCount} creatives
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 hover:bg-neutral-50"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-[12.5px] text-neutral-700">
          <section>
            <div className="text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
              Audience
            </div>
            <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              {AUDIENCES.map((aud) => {
                const active = state.audience === aud.key;
                return (
                  <button
                    key={aud.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setState((current) => ({
                        ...current,
                        audience: aud.key,
                        hideDecisionLanguage:
                          aud.key === "buyer" ? false : true,
                      }))
                    }
                    className={
                      "rounded-md border px-3 py-2 text-left " +
                      (active
                        ? "border-blue-300 bg-blue-50 text-blue-700"
                        : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50")
                    }
                  >
                    <div className="font-semibold">{aud.label}</div>
                    <div className="mt-0.5 text-[11px] text-neutral-500">
                      {aud.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="space-y-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={state.hideDecisionLanguage}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    hideDecisionLanguage: event.currentTarget.checked,
                  }))
                }
                className="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
              />
              <span>Hide all decision language (Cut / Scale / Promote)</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={state.freezeSnapshot}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    freezeSnapshot: event.currentTarget.checked,
                  }))
                }
                className="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
              />
              <span>Freeze data snapshot (view stays consistent for recipients)</span>
            </label>
            <label className="flex items-center gap-2">
              <span>Link expires in</span>
              <select
                value={state.expiresInDays}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    expiresInDays: Number(event.currentTarget.value),
                  }))
                }
                className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-[12px] text-neutral-700"
                aria-label="Expires in"
              >
                <option value={1}>1 day</option>
                <option value={3}>3 days</option>
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
              </select>
            </label>
          </section>

          <section>
            <div className="text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
              Share link
            </div>
            <div className="mt-1.5 flex items-stretch overflow-hidden rounded-md border border-neutral-200">
              <input
                type="text"
                value={url}
                readOnly
                className="flex-1 bg-neutral-50 px-3 py-1.5 font-mono text-[11.5px] text-neutral-700 focus:outline-none"
                aria-label="Share URL"
              />
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 border-l border-neutral-200 bg-white px-3 text-[12px] font-medium text-neutral-700 hover:bg-neutral-50"
              >
                <Copy size={12} aria-hidden="true" />
                {copyState === "copied" ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="mt-1.5 text-[12px] text-neutral-500">
              Public URL pattern · /share/creative/[token] — token is minted on
              Confirm. Backend signing is future work.
            </div>
          </section>
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700"
          >
            Create share link
          </button>
        </div>
      </div>
    </div>
  );
}
