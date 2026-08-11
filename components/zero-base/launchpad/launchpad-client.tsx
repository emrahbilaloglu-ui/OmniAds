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
import {
  reconcileBulkOutcomes,
  type BulkItemOutcome,
  type ValidationFinding,
} from "@/lib/zero-base/launchpad/launchpad-contract";
import type { SurfaceState } from "@/lib/zero-base/state-types";

export function LaunchpadClient({
  businessId,
  providerAccountId,
  mutationUiEnabled,
}: {
  businessId: string;
  providerAccountId: string | null;
  /** Server-read. Absent or false means no bulk control is constructed. */
  mutationUiEnabled?: boolean;
}) {
  const [templates, setTemplates] = useState<LaunchpadTemplate[]>([]);
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  const [candidates, setCandidates] = useState<{ adId: string; name: string }[]>([]);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading Launchpad" });
  const [nonce, setNonce] = useState(0);

  const query = useCallback(() => {
    const params = new URLSearchParams({ businessId });
    if (providerAccountId) params.set("providerAccountId", providerAccountId);
    return params.toString();
  }, [businessId, providerAccountId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/launchpad/meta/templates?${query()}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          if (!cancelled) {
            setSurface({
              kind: "error",
              reason: "Launchpad templates could not be read for this business.",
              verbatim: `HTTP ${response.status}`,
              retry: true,
            });
          }
          return;
        }
        const json = (await response.json()) as {
          templates?: LaunchpadTemplate[];
          findings?: ValidationFinding[];
          adCandidates?: { adId: string; name: string }[];
        };
        if (cancelled) return;
        setTemplates(json.templates ?? []);
        setFindings(json.findings ?? []);
        setCandidates(json.adCandidates ?? []);
        setSurface({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        setSurface({
          kind: "error",
          reason: "Launchpad could not be reached.",
          verbatim: error instanceof Error ? error.message : undefined,
          retry: true,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, nonce]);

  const deleteTemplate = useCallback(
    async (id: string) => {
      await fetch(`/api/launchpad/meta/templates/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId }),
      }).catch(() => null);
      setNonce((value) => value + 1);
    },
    [businessId],
  );

  const duplicateTemplate = useCallback(
    async (id: string) => {
      // Duplicate is a create, because the API has no update at all.
      await fetch(`/api/launchpad/meta/templates?${query()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, duplicateOf: id }),
      }).catch(() => null);
      setNonce((value) => value + 1);
    },
    [businessId, query],
  );

  const applyBulk = useCallback(
    async (adIds: string[]): Promise<BulkItemOutcome[]> => {
      try {
        const response = await fetch(`/api/launchpad/meta/bulk-ad-status?${query()}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ businessId, adIds }),
        });
        const json = (await response.json().catch(() => null)) as {
          items?: { adId: string; status?: string; detail?: string }[];
        } | null;
        return reconcileBulkOutcomes({ requested: adIds, served: json?.items ?? [] });
      } catch {
        // Every item is unknown: the request may or may not have been applied.
        return reconcileBulkOutcomes({ requested: adIds, served: [] });
      }
    },
    [businessId, query],
  );

  return (
    <SurfaceStateBoundary state={surface}>
      <LaunchpadView
        templates={templates}
        findings={findings}
        onDeleteTemplate={(id) => void deleteTemplate(id)}
        onDuplicateTemplate={(id) => void duplicateTemplate(id)}
        bulk={mutationUiEnabled ? { candidates, onApply: applyBulk } : undefined}
      />
    </SurfaceStateBoundary>
  );
}
