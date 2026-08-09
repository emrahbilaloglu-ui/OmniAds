"use client";

import { emitProductInstrumentation } from "@/lib/product-instrumentation-client";
import { useMemo, useState } from "react";
import { usePreferencesStore } from "@/store/preferences-store";
import {
  buildSavedView,
  describeSavedViewError,
  isSavedViewApplicable,
  savedViewScopeKey,
  selectSavedViews,
  validateSavedViewName,
  type SavedView,
  type SavedViewConfig,
} from "@/lib/saved-views";

/**
 * Save and restore the arrangement an operator actually works from.
 *
 * Views are read and written through the scope key, so a view belonging to
 * another client or surface cannot appear here, and one pinned to an account
 * that is no longer assigned is offered as unavailable rather than silently
 * restoring a scope the operator can no longer see.
 */
export function SavedViewsMenu({
  surface,
  businessId,
  currentConfig,
  availableAccountIds = [],
  onApply,
}: {
  surface: string;
  businessId: string;
  currentConfig: SavedViewConfig;
  availableAccountIds?: string[];
  onApply: (config: SavedViewConfig) => void;
}) {
  const savedViewsByScope = usePreferencesStore((state) => state.savedViewsByScope);
  const saveView = usePreferencesStore((state) => state.saveView);
  const deleteSavedView = usePreferencesStore((state) => state.deleteSavedView);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const views = useMemo(() => {
    const scoped = savedViewsByScope[savedViewScopeKey(surface, businessId)] ?? [];
    return selectSavedViews(scoped, surface, businessId);
  }, [savedViewsByScope, surface, businessId]);

  function handleSave() {
    const problem = validateSavedViewName(name, views);
    if (problem) {
      setError(describeSavedViewError(problem));
      return;
    }
    const view: SavedView = buildSavedView({
      id: `${surface}-${Date.now()}`,
      name,
      surface,
      businessId,
      config: currentConfig,
      createdAt: new Date().toISOString(),
    });
    saveView(view);
    emitProductInstrumentation({
      eventName: "saved_view_created",
      surface: "meta_decisions",
      outcome: "ok",
      scope: "business",
      businessId,
    });
    setName("");
    setError(null);
  }

  if (!businessId) return null;

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="rounded-md border border-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50"
        aria-expanded={open}
      >
        Views{views.length > 0 ? ` (${views.length})` : ""}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-1 w-72 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg">
          {views.length === 0 ? (
            <p className="px-1 py-1.5 text-[11px] text-neutral-500">
              No saved views for this client yet.
            </p>
          ) : (
            <ul className="mb-2 space-y-0.5">
              {views.map((view) => {
                const { applicable, reason } = isSavedViewApplicable(view, availableAccountIds);
                return (
                  <li key={view.id} className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={!applicable}
                      title={reason ?? undefined}
                      onClick={() => {
                        onApply(view.config);
                        emitProductInstrumentation({
                          eventName: "saved_view_applied",
                          surface: "meta_decisions",
                          outcome: "ok",
                          scope: "business",
                          businessId,
                        });
                        setOpen(false);
                      }}
                      className="flex-1 truncate rounded px-1.5 py-1 text-left text-[12px] text-neutral-800 hover:bg-neutral-50 disabled:text-neutral-400 disabled:hover:bg-transparent"
                    >
                      {view.name}
                      {!applicable ? " — unavailable" : ""}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSavedView(surface, businessId, view.id)}
                      className="rounded px-1 text-[11px] text-neutral-500 hover:text-rose-700"
                      aria-label={`Delete view ${view.name}`}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex items-center gap-1.5 border-t border-neutral-200 pt-2">
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              placeholder="Name this view"
              className="min-w-0 flex-1 rounded border border-neutral-200 px-1.5 py-1 text-[12px] outline-none"
            />
            <button
              type="button"
              onClick={handleSave}
              className="rounded bg-neutral-900 px-2 py-1 text-[11px] font-medium text-white"
            >
              Save
            </button>
          </div>
          {error ? <p className="mt-1 text-[11px] text-rose-700">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
