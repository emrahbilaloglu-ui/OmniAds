"use client";

import { useMemo } from "react";
import type { ChangeEvent } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { getCreativeDisplayPills } from "@/lib/meta/creative-taxonomy";
import { getCreativeStaticPreviewSources, getCreativeStaticPreviewState } from "@/lib/meta/creatives-preview";
import { generateAiAnalysis } from "@/lib/generateAiAnalysis";

interface CreativeInsightsDrawerProps {
  row: MetaCreativeRow | null;
  open: boolean;
  notes: string;
  onOpenChange: (open: boolean) => void;
  onNotesChange: (value: string) => void;
}

type DrawerRowLike = MetaCreativeRow & {
  cardPreviewUrl?: string | null;
  card_preview_url?: string | null;
  imageUrl?: string | null;
  image_url?: string | null;
  previewUrl?: string | null;
  preview_url?: string | null;
  cachedThumbnailUrl?: string | null;
  cached_thumbnail_url?: string | null;
  thumbnailUrl?: string | null;
  thumbnail_url?: string | null;
};

export function CreativeInsightsDrawer({
  row,
  open,
  notes,
  onOpenChange,
  onNotesChange,
}: CreativeInsightsDrawerProps) {
  const safeRow = row as DrawerRowLike | null;

  const analysis = useMemo(() => {
    return safeRow ? generateAiAnalysis(safeRow) : null;
  }, [safeRow]);
  const taxonomyPills = useMemo(
    () =>
      safeRow
        ? getCreativeDisplayPills({
            creative_delivery_type: safeRow.creativeDeliveryType,
            creative_visual_format: safeRow.creativeVisualFormat,
            creative_primary_type: safeRow.creativePrimaryType,
            creative_primary_label: safeRow.creativePrimaryLabel,
            creative_secondary_type: safeRow.creativeSecondaryType,
            creative_secondary_label: safeRow.creativeSecondaryLabel,
            taxonomy_source: safeRow.taxonomySource ?? null,
          })
        : { primaryLabel: null, secondaryLabel: null },
    [
      safeRow?.creativeDeliveryType,
      safeRow?.creativeVisualFormat,
      safeRow?.creativePrimaryType,
      safeRow?.creativePrimaryLabel,
      safeRow?.creativeSecondaryType,
      safeRow?.creativeSecondaryLabel,
    ]
  );

  const assetFallbacks = useMemo(
    () =>
      safeRow ? getCreativeStaticPreviewSources(safeRow, "card") : [],
    [safeRow]
  );
  const assetState = safeRow ? getCreativeStaticPreviewState(safeRow, "card") : "missing";

  const handleNotesChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onNotesChange(event.target.value);
  };

  if (!safeRow || !analysis) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="sr-only">
          <SheetTitle>Creative Insight</SheetTitle>
          <SheetDescription>Meta performance breakdown and action plan.</SheetDescription>
        </SheetHeader>

        <div className="shrink-0 border-b bg-muted/20 px-5 pb-4 pt-5">
          <div className="mx-auto max-w-md overflow-hidden rounded-xl border border-neutral-200 bg-white">
            <CreativeRenderSurface
              id={safeRow.id}
              name={safeRow.name}
              preview={safeRow.preview}
              size="large"
              mode="asset"
              assetState={assetState}
              assetFallbacks={assetFallbacks}
            />
          </div>

          <div className="mt-4 space-y-1.5">
            <p className="text-sm font-semibold leading-tight">{safeRow.name}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="text-[12px]">
                Meta
              </Badge>
              {taxonomyPills.primaryLabel ? (
                <Badge variant="outline" className="text-[12px]">
                  {taxonomyPills.primaryLabel}
                </Badge>
              ) : null}
              {taxonomyPills.secondaryLabel ? (
                <Badge variant="outline" className="text-[12px]">
                  {taxonomyPills.secondaryLabel}
                </Badge>
              ) : null}
              <span className="text-[11px] text-muted-foreground">Launched {safeRow.launchDate}</span>
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <AnalysisBlock title="Summary" items={analysis.summary} />
          <AnalysisBlock title="Performance Insights" items={analysis.performanceInsights} />
          <AnalysisBlock title="Recommendations" items={analysis.recommendations} />
          <AnalysisBlock title="Risks & Warnings" items={analysis.risks} />

          <section className="rounded-xl border p-3.5">
            <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Where it runs
            </h3>
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <MetaField label="Campaign" value={safeRow.tags[0] ? `Campaign - ${safeRow.tags[0]}` : "Campaign - Main"} />
              <MetaField label="Ad Set" value="Ad Set - Performance Cohort" />
              <MetaField label="Ad" value={safeRow.name} />
            </div>
          </section>

          <section className="rounded-xl border p-3.5">
            <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Notes
            </h3>
            <textarea
              value={notes}
              onChange={handleNotesChange}
              placeholder="Add analysis notes..."
              className="min-h-24 w-full rounded-lg border bg-background p-2.5 text-sm outline-none placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-ring"
            />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function AnalysisBlock({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;

  return (
    <section className="rounded-xl border p-3.5">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-1.5 text-[13px] leading-relaxed">
        {items.map((item, index) => (
          <li key={`${title}_${index}`} className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="truncate text-[12px] font-medium">{value}</p>
    </div>
  );
}
