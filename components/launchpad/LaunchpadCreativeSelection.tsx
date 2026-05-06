"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Search } from "lucide-react";
import { CreativeDecisionLabelBadge } from "@/components/creatives/CreativeDecisionLabelBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import { cn } from "@/lib/utils";

export function hasBelowBreakeven(decision: DecisionOutput | null | undefined) {
  return Boolean(decision?.badges?.some((badge) => badge.type === "below_breakeven"));
}

export function getCreativeAdvisoryNotes(decision: DecisionOutput | null | undefined) {
  if (!decision) return [];
  const notes: Array<{ tone: "success" | "warning" | "danger" | "muted"; text: string }> = [];
  if (decision.label === "scale") {
    notes.push({
      tone: "success",
      text: "Engine: scale candidate (consider higher budget tier)",
    });
  }
  if (decision.label === "cut") {
    notes.push({ tone: "danger", text: "Engine: cut candidate - confirm intent" });
  }
  if (decision.label === "out_of_scope") {
    notes.push({ tone: "muted", text: "Engine: out of scope (no decision)" });
  }
  if (decision.label === "refresh") {
    notes.push({ tone: "warning", text: "Engine: refresh recommended - concept tired" });
  }
  if (decision.label === "diagnose") {
    notes.push({ tone: "danger", text: "Engine: data anomaly - verify before launch" });
  }
  if (hasBelowBreakeven(decision)) {
    notes.push({ tone: "warning", text: "Below breakeven - historical loss" });
  }
  return notes;
}

function noteClass(tone: "success" | "warning" | "danger" | "muted") {
  if (tone === "success") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (tone === "danger") return "border-rose-200 bg-rose-50 text-rose-800";
  if (tone === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-border bg-muted text-muted-foreground";
}

export function LaunchpadCreativeSelection({
  rows,
  selectedCreativeIds,
  decisionByCreativeId,
  loading = false,
  onToggleCreative,
}: {
  rows: MetaCreativeRow[];
  selectedCreativeIds: string[];
  decisionByCreativeId: Map<string, DecisionOutput>;
  loading?: boolean;
  onToggleCreative: (row: MetaCreativeRow) => void;
}) {
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const selectedSet = useMemo(
    () => new Set(selectedCreativeIds),
    [selectedCreativeIds],
  );
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (activeOnly) {
        const status = row.effectiveStatus?.toUpperCase() ?? "ACTIVE";
        if (status && status !== "ACTIVE") return false;
      }
      if (!query) return true;
      return [row.name, row.creativeId, row.campaignName, row.adSetName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [activeOnly, rows, search]);

  return (
    <section className="space-y-4" data-testid="launchpad-creative-selection">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Creative selection</h2>
          <p className="text-sm text-muted-foreground">
            {selectedCreativeIds.length} selected
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(event) => setActiveOnly(event.target.checked)}
            />
            Active only
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search creatives"
              className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none focus:border-primary sm:w-64"
            />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          Loading creatives...
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border">
        <div className="grid grid-cols-[44px_1fr_120px_120px] border-b bg-muted/50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span />
          <span>Creative</span>
          <span>Spend</span>
          <span>ROAS</span>
        </div>
        <div className="max-h-[520px] overflow-y-auto">
          {filteredRows.map((row) => {
            const decision = decisionByCreativeId.get(row.creativeId) ?? null;
            const selected = selectedSet.has(row.creativeId);
            const notes = selected ? getCreativeAdvisoryNotes(decision) : [];
            return (
              <div
                key={row.id}
                className={cn(
                  "grid grid-cols-[44px_1fr_120px_120px] gap-2 border-b px-3 py-3 last:border-b-0",
                  selected ? "bg-primary/5" : "bg-background",
                )}
              >
                <div className="pt-1">
                  <input
                    type="checkbox"
                    checked={selected}
                    aria-label={`Select ${row.name}`}
                    onChange={() => onToggleCreative(row)}
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{row.name}</p>
                    {decision ? <CreativeDecisionLabelBadge label={decision.label} /> : null}
                    {hasBelowBreakeven(decision) ? (
                      <Badge className="border-amber-200 bg-amber-50 text-amber-900" variant="outline">
                        Below breakeven
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {row.campaignName ?? row.campaignId ?? "No campaign"} / {row.adSetName ?? row.adSetId ?? "No ad set"}
                  </p>
                  {notes.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {notes.map((note) => (
                        <span
                          key={note.text}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
                            noteClass(note.tone),
                          )}
                        >
                          {note.tone === "danger" ? <AlertTriangle className="h-3 w-3" /> : null}
                          {note.text}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="pt-1 text-sm tabular-nums">${row.spend.toFixed(0)}</div>
                <div className="pt-1 text-sm tabular-nums">{row.roas.toFixed(2)}</div>
              </div>
            );
          })}
          {filteredRows.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No creatives found.</div>
          ) : null}
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={() => setActiveOnly(false)}>
          Show all statuses
        </Button>
      </div>
    </section>
  );
}
