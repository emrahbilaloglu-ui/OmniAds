"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Save, Send, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import type { LaunchpadIssue, MetaLaunchPayload } from "@/lib/launchpad/meta";
import { hasBelowBreakeven } from "@/components/launchpad/LaunchpadCreativeSelection";

export interface LaunchpadValidationState {
  ok: boolean;
  blockers: LaunchpadIssue[];
  warnings: LaunchpadIssue[];
}

export function buildEngineAggregate(input: {
  selectedCreatives: MetaCreativeRow[];
  decisionByCreativeId: Map<string, DecisionOutput>;
}) {
  let scale = 0;
  let cut = 0;
  let diagnose = 0;
  let belowBreakeven = 0;
  let weightedRoasNumerator = 0;
  let weightedSpend = 0;

  input.selectedCreatives.forEach((creative) => {
    const decision = input.decisionByCreativeId.get(creative.creativeId);
    if (decision?.label === "scale") scale += 1;
    if (decision?.label === "cut") cut += 1;
    if (decision?.label === "diagnose") diagnose += 1;
    if (hasBelowBreakeven(decision)) belowBreakeven += 1;
    const spend = decision?.metrics.spend ?? creative.spend;
    const roas = decision?.metrics.roas ?? creative.roas;
    if (Number.isFinite(spend) && spend > 0 && Number.isFinite(roas)) {
      weightedSpend += spend;
      weightedRoasNumerator += spend * (roas ?? 0);
    }
  });

  return {
    total: input.selectedCreatives.length,
    scale,
    cut,
    diagnose,
    belowBreakeven,
    flagged: scale + cut + diagnose + belowBreakeven,
    averageRoas: weightedSpend > 0 ? weightedRoasNumerator / weightedSpend : null,
    severe: cut > 0 || diagnose > 0,
  };
}

export function LaunchpadReview({
  businessId,
  payload,
  selectedCreatives,
  decisionByCreativeId,
  onValidation,
  onSaveTemplate,
  onSaveDraft,
  onLaunch,
}: {
  businessId: string;
  payload: MetaLaunchPayload;
  selectedCreatives: MetaCreativeRow[];
  decisionByCreativeId: Map<string, DecisionOutput>;
  onValidation?: (state: LaunchpadValidationState) => void;
  onSaveTemplate: () => void;
  onSaveDraft: () => void;
  onLaunch: () => void;
}) {
  const [validation, setValidation] = useState<LaunchpadValidationState | null>(null);
  const [validating, setValidating] = useState(false);
  const aggregate = useMemo(
    () => buildEngineAggregate({ selectedCreatives, decisionByCreativeId }),
    [decisionByCreativeId, selectedCreatives],
  );

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    setValidating(true);
    fetch("/api/launchpad/meta/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, payload }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | LaunchpadValidationState
          | null;
        if (cancelled) return;
        const next = {
          ok: Boolean(body?.ok),
          blockers: Array.isArray(body?.blockers) ? body.blockers : [],
          warnings: Array.isArray(body?.warnings) ? body.warnings : [],
        };
        setValidation(next);
        onValidation?.(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const next = {
          ok: false,
          blockers: [
            {
              code: "validation_request_failed",
              message: error instanceof Error ? error.message : "Validation failed.",
            },
          ],
          warnings: [],
        };
        setValidation(next);
        onValidation?.(next);
      })
      .finally(() => {
        if (!cancelled) setValidating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, onValidation, payload]);

  const launchBlocked = validating || !validation?.ok;

  return (
    <section className="space-y-5" data-testid="launchpad-review">
      <div>
        <h2 className="text-lg font-semibold">Review</h2>
        <p className="text-sm text-muted-foreground">Campaign and ads will start paused</p>
      </div>

      <div
        className={`rounded-md border p-4 ${
          aggregate.severe ? "border-rose-200 bg-rose-50" : "bg-background"
        }`}
        data-testid="launchpad-engine-aggregate"
      >
        <div className="flex flex-wrap items-center gap-2">
          {aggregate.severe ? <AlertTriangle className="h-4 w-4 text-rose-700" /> : null}
          <p className="text-sm font-semibold">
            {aggregate.flagged} of {aggregate.total} selected creatives are engine-flagged
          </p>
          <Badge variant="outline">{aggregate.scale} scale</Badge>
          <Badge variant="outline">{aggregate.cut} cut</Badge>
          <Badge variant="outline">{aggregate.belowBreakeven} below breakeven</Badge>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Weighted ROAS {aggregate.averageRoas == null ? "n/a" : aggregate.averageRoas.toFixed(2)}
        </p>
      </div>

      <div className="rounded-md border p-4">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-semibold">Validation</p>
          {validating ? <Badge variant="outline">Checking</Badge> : null}
          {validation?.ok ? <Badge className="bg-emerald-600">OK</Badge> : null}
        </div>
        {validation?.blockers.length ? (
          <div className="space-y-2">
            {validation.blockers.map((blocker) => (
              <p key={`${blocker.code}-${blocker.message}`} className="text-sm text-rose-700">
                {blocker.message}
              </p>
            ))}
          </div>
        ) : null}
        {validation?.warnings.length ? (
          <div className="mt-3 space-y-2">
            {validation.warnings.map((warning) => (
              <p key={`${warning.code}-${warning.message}`} className="text-sm text-amber-800">
                {warning.message}
              </p>
            ))}
          </div>
        ) : null}
        {!validation && !validating ? (
          <p className="text-sm text-muted-foreground">Validation pending.</p>
        ) : null}
      </div>

      <div className="rounded-md border">
        <div className="border-b px-4 py-3 text-sm font-semibold">Payload preview</div>
        <pre className="max-h-[420px] overflow-auto p-4 text-xs">
          {JSON.stringify(payload, null, 2)}
        </pre>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSaveTemplate}>
          <Save className="h-4 w-4" />
          Save as template
        </Button>
        <Button type="button" variant="outline" onClick={onSaveDraft}>
          <Save className="h-4 w-4" />
          Save draft
        </Button>
        <Button type="button" disabled={launchBlocked} onClick={onLaunch}>
          <Send className="h-4 w-4" />
          Launch (paused)
        </Button>
      </div>
    </section>
  );
}
