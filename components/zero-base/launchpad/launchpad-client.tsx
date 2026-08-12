"use client";

/**
 * Launchpad data boundary.
 *
 * Reads templates and validation from the existing endpoints. It contains no
 * reference to the launch or add-to-existing endpoints — not a guarded one, not
 * a disabled one. A string that is never written cannot be reached by a flag
 * flip or a refactor.
 */
import { useCallback, useEffect, useState } from "react";

import { LaunchpadView, type LaunchpadTemplate } from "@/components/zero-base/launchpad/launchpad-view";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import { type ValidationFinding } from "@/lib/zero-base/launchpad/launchpad-contract";
import type { SurfaceState } from "@/lib/zero-base/state-types";

export function LaunchpadClient({
  businessId,
  providerAccountId,
}: {
  businessId: string;
  providerAccountId: string | null;
}) {
  const [templates, setTemplates] = useState<LaunchpadTemplate[]>([]);
  const [drafts, setDrafts] = useState<Array<{ id: string; name: string; createdAt?: string }>>([]);
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading Launchpad" });
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(() => {
    const params = new URLSearchParams({ businessId });
    if (providerAccountId) params.set("providerAccountId", providerAccountId);
    return params.toString();
  }, [businessId, providerAccountId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [templateResponse, draftResponse] = await Promise.all([
          fetch(`/api/launchpad/meta/templates?${query()}`, { cache: "no-store" }),
          fetch(`/api/launchpad/meta/drafts?${query()}`, { cache: "no-store" }),
        ]);
        if (!templateResponse.ok) {
          if (!cancelled) {
            setSurface({
              kind: "error",
              reason: "Launchpad templates could not be read for this business.",
              verbatim: `HTTP ${templateResponse.status}`,
              retry: true,
            });
          }
          return;
        }
        const templateJson = (await templateResponse.json()) as { templates?: LaunchpadTemplate[] };
        const draftJson = draftResponse.ok
          ? ((await draftResponse.json()) as { drafts?: Array<{ id: string; name: string; createdAt?: string }> })
          : { drafts: [] };
        if (cancelled) return;
        setTemplates(templateJson.templates ?? []);
        setDrafts(draftJson.drafts ?? []);
        setSurface({ kind: "ready" });
      } catch (caught) {
        if (cancelled) return;
        setSurface({
          kind: "error",
          reason: "Launchpad could not be reached.",
          verbatim: caught instanceof Error ? caught.message : undefined,
          retry: true,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, nonce]);

  /** Create a draft with the body the real route requires: name + payload. */
  const createDraft = useCallback(
    async (name: string, payload: Record<string, unknown>) => {
      setError(null);
      const response = await fetch(`/api/launchpad/meta/drafts?${query()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, providerAccountId, name, payload }),
      }).catch(() => null);
      if (!response?.ok) {
        const json = (await response?.json().catch(() => null)) as { message?: string } | null;
        setError(json?.message ?? "The draft could not be saved.");
        return;
      }
      setNonce((value) => value + 1);
    },
    [businessId, providerAccountId, query],
  );

  /**
   * Duplicate-to-change: read the immutable served template, then create a new
   * one from its payload. `duplicateOf` alone is not the route contract — the
   * handler requires name and payload.
   */
  const duplicateTemplate = useCallback(
    async (id: string, name: string) => {
      setError(null);
      const source = await fetch(
        `/api/launchpad/meta/templates/${encodeURIComponent(id)}?${query()}`,
        { cache: "no-store" },
      )
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
      const payload = (source as { template?: { payload?: unknown } } | null)?.template?.payload;
      if (payload === undefined) {
        setError("The template payload could not be read, so it cannot be duplicated.");
        return;
      }
      const response = await fetch(`/api/launchpad/meta/templates?${query()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, providerAccountId, name, payload }),
      }).catch(() => null);
      if (!response?.ok) {
        const json = (await response?.json().catch(() => null)) as { message?: string } | null;
        setError(json?.message ?? "The duplicate could not be created.");
        return;
      }
      setNonce((value) => value + 1);
    },
    [businessId, providerAccountId, query],
  );

  const deleteTemplate = useCallback(
    async (id: string) => {
      setError(null);
      await fetch(`/api/launchpad/meta/templates/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId }),
      }).catch(() => null);
      setNonce((value) => value + 1);
    },
    [businessId],
  );

  /** The real validator, with the payload the route expects. */
  const validate = useCallback(
    async (payload: Record<string, unknown>) => {
      setError(null);
      const response = await fetch(`/api/launchpad/meta/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, providerAccountId, payload }),
      }).catch(() => null);
      if (!response?.ok) {
        setError("Validation could not be run.");
        return;
      }
      const json = (await response.json().catch(() => null)) as {
        findings?: ValidationFinding[];
        errors?: Array<{ field?: string; message?: string }>;
      } | null;
      setFindings(
        json?.findings ??
          (json?.errors ?? []).map((item, index) => ({
            id: String(index),
            field: item.field ?? null,
            severity: "error" as const,
            message: item.message ?? "Validation reported an error.",
          })),
      );
    },
    [businessId, providerAccountId],
  );

  return (
    <SurfaceStateBoundary state={surface}>
      <LaunchpadView
        templates={templates}
        drafts={drafts}
        findings={findings}
        error={error}
        onCreateDraft={createDraft}
        onValidate={validate}
        onDeleteTemplate={(id) => void deleteTemplate(id)}
        onDuplicateTemplate={(id, name) => void duplicateTemplate(id, name)}
      />
    </SurfaceStateBoundary>
  );
}
