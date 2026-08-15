"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Clock3,
  Download,
  FileCheck2,
  FilePlus2,
  GalleryHorizontalEnd,
  GitCompareArrows,
  Images,
  Search,
  Share2,
  Table2,
  Trophy,
} from "lucide-react";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { CreativesTableSection } from "@/components/creatives/CreativesTableSection";
import { formatMoney, resolveCreativeCurrency } from "@/components/creatives/money";
import type { BriefingCreativeCard, CreativesBriefingResponse } from "@/components/creatives/briefing/types";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { MetaCreativeBrief } from "@/lib/meta/creative-brief-contract";
import {
  buildCurrentWinnerEvidence,
  buildHistoricalWinnerEraState,
  findCreativeStudioCard,
  groupServerFatigueEvidence,
  indexCreativeStudioBriefingCards,
  qualifyCurrentWinner,
  resolveServerDecisionBadge,
  type CreativeStudioAssetView,
  type CreativeStudioFormatFilter,
  type CreativeStudioSort,
  type CreativeStudioWorkspaceView,
} from "@/app/(dashboard)/platforms/meta/creatives/studio-truth";
import styles from "./CreativeStudioWorkspace.module.css";

interface CreativeStudioWorkspaceProps {
  businessId: string;
  providerAccountId: string;
  rows: MetaCreativeRow[];
  allRowCount: number;
  briefingCards: BriefingCreativeCard[];
  briefingSource: CreativesBriefingResponse["source"] | null | undefined;
  decisionContextState: "loading" | "ready" | "error";
  decisionContextError?: string | null;
  defaultCurrency: string | null;
  workspaceView: CreativeStudioWorkspaceView;
  assetView: CreativeStudioAssetView;
  search: string;
  formatFilter: CreativeStudioFormatFilter;
  sort: CreativeStudioSort;
  selectedRowIds: string[];
  selectedMetricIds: string[];
  toolbarLead?: ReactNode;
  shareLoading?: boolean;
  csvLoading?: boolean;
  creativeBriefs: MetaCreativeBrief[];
  creativeBriefsState: "loading" | "ready" | "error";
  creativeBriefsError?: string | null;
  onWorkspaceViewChange: (view: CreativeStudioWorkspaceView) => void;
  onAssetViewChange: (view: CreativeStudioAssetView) => void;
  onSearchChange: (value: string) => void;
  onFormatFilterChange: (value: CreativeStudioFormatFilter) => void;
  onSortChange: (value: CreativeStudioSort) => void;
  onSelectedMetricIdsChange: (ids: string[]) => void;
  onToggleRow: (rowId: string) => void;
  onToggleAll: () => void;
  onOpenRow: (rowId: string) => void;
  onSortedRowsChange: (rows: MetaCreativeRow[]) => void;
  onShare: () => void;
  onCsv: () => void;
  onCompare: () => void;
  onCreateBrief: (card: BriefingCreativeCard) => void;
  onEditBrief: (brief: MetaCreativeBrief) => void;
}

const WORKSPACE_VIEWS: Array<{
  value: CreativeStudioWorkspaceView;
  label: string;
  icon: typeof Images;
}> = [
  { value: "assets", label: "Assets", icon: Images },
  { value: "winner_eras", label: "Winner eras", icon: Trophy },
  { value: "fatigue_brief", label: "Briefs", icon: Activity },
];

const FORMAT_OPTIONS: Array<{ value: CreativeStudioFormatFilter; label: string }> = [
  { value: "all", label: "All formats" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "catalog", label: "Catalog" },
];

const SORT_OPTIONS: Array<{ value: CreativeStudioSort; label: string }> = [
  { value: "spend", label: "Spend" },
  { value: "roas", label: "ROAS" },
  { value: "newest", label: "Newest" },
  { value: "name", label: "Name" },
];

export const CREATIVE_STUDIO_GALLERY_PAGE_SIZE = 48;

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatRoas(value: number | null | undefined): string {
  const numeric = finite(value);
  return numeric === null ? "--" : `${numeric.toFixed(2)}x`;
}

function formatCount(value: number | null | undefined): string {
  const numeric = finite(value);
  return numeric === null ? "--" : numeric.toLocaleString();
}

function cardName(card: BriefingCreativeCard): string {
  return card.creativeName?.trim() || card.name?.trim() || card.creativeId?.trim() || card.id;
}

function cardCreativeId(card: BriefingCreativeCard): string {
  return card.creativeId?.trim() || card.id;
}

function decisionHref(
  businessId: string,
  providerAccountId: string,
  card: BriefingCreativeCard,
): string {
  return `/platforms/meta?businessId=${encodeURIComponent(businessId)}&providerAccountId=${encodeURIComponent(providerAccountId)}&creativeId=${encodeURIComponent(cardCreativeId(card))}`;
}

function launchpadBriefHref(brief: MetaCreativeBrief): string {
  const query = new URLSearchParams({
    fromBriefing: "true",
    mode: "rebuild",
    providerAccountId: brief.providerAccountId,
    creativeBriefId: brief.id,
    sourceDecisionId: brief.sourceDecision.decisionId,
    sourceDecisionSnapshotId: brief.sourceDecision.snapshotId,
    creativeIds: brief.sourceDecision.creativeId,
  });
  return `/platforms/meta/launchpad?${query.toString()}`;
}

function sourceLabel(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "source unavailable";
  return normalized.replaceAll("_", " ");
}

export function CreativeStudioWorkspace({
  businessId,
  providerAccountId,
  rows,
  allRowCount,
  briefingCards,
  briefingSource,
  decisionContextState,
  decisionContextError = null,
  defaultCurrency,
  workspaceView,
  assetView,
  search,
  formatFilter,
  sort,
  selectedRowIds,
  selectedMetricIds,
  toolbarLead,
  shareLoading = false,
  csvLoading = false,
  creativeBriefs,
  creativeBriefsState,
  creativeBriefsError = null,
  onWorkspaceViewChange,
  onAssetViewChange,
  onSearchChange,
  onFormatFilterChange,
  onSortChange,
  onSelectedMetricIdsChange,
  onToggleRow,
  onToggleAll,
  onOpenRow,
  onSortedRowsChange,
  onShare,
  onCsv,
  onCompare,
  onCreateBrief,
  onEditBrief,
}: CreativeStudioWorkspaceProps) {
  const cardIndex = indexCreativeStudioBriefingCards(briefingCards);
  const winnerEvidence = buildCurrentWinnerEvidence(briefingCards);
  const historicalState = buildHistoricalWinnerEraState(briefingCards);
  const fatigueGroups = groupServerFatigueEvidence(briefingCards);
  const selectedCount = selectedRowIds.length;
  const selectedAll = rows.length > 0 && rows.every((row) => selectedRowIds.includes(row.id));
  const [galleryPage, setGalleryPage] = useState(1);
  const galleryPageCount = Math.max(
    1,
    Math.ceil(rows.length / CREATIVE_STUDIO_GALLERY_PAGE_SIZE),
  );
  const galleryRows = useMemo(() => {
    const start = (galleryPage - 1) * CREATIVE_STUDIO_GALLERY_PAGE_SIZE;
    return rows.slice(start, start + CREATIVE_STUDIO_GALLERY_PAGE_SIZE);
  }, [galleryPage, rows]);
  const galleryStart = rows.length === 0
    ? 0
    : (galleryPage - 1) * CREATIVE_STUDIO_GALLERY_PAGE_SIZE + 1;
  const galleryEnd = Math.min(
    galleryPage * CREATIVE_STUDIO_GALLERY_PAGE_SIZE,
    rows.length,
  );

  useEffect(() => {
    setGalleryPage(1);
  }, [formatFilter, providerAccountId, search, sort]);

  useEffect(() => {
    setGalleryPage((current) => Math.min(current, galleryPageCount));
  }, [galleryPageCount]);
  const engineVersions = Array.from(
    new Set(briefingCards.map((card) => card.engineVersion?.trim()).filter((value): value is string => Boolean(value))),
  );
  const sourceAsOf = briefingSource?.asOf ?? briefingCards.find((card) => card.sourceAsOf)?.sourceAsOf ?? null;
  const sourceDataSource = briefingSource?.dataSource ?? briefingCards.find((card) => card.sourceDataSource)?.sourceDataSource ?? null;
  const freshness = briefingSource?.dataHealth?.worstTier ?? null;

  return (
    <section className={styles.workspace} data-testid="creative-studio-workspace">
      <div className={styles.workspaceHeader}>
        <div className={styles.workspaceTabs} role="tablist" aria-label="Creative Studio views">
          {WORKSPACE_VIEWS.map((option) => {
            const Icon = option.icon;
            const active = workspaceView === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? styles.workspaceTabActive : styles.workspaceTab}
                onClick={() => onWorkspaceViewChange(option.value)}
              >
                <Icon size={15} aria-hidden="true" />
                {option.label}
              </button>
            );
          })}
        </div>
        <div className={styles.provenance} data-testid="studio-provenance">
          <span>{engineVersions.length === 1 ? engineVersions[0] : engineVersions.length > 1 ? "mixed engine eras" : "engine era unavailable"}</span>
          <span>{sourceAsOf ? `as of ${sourceAsOf}` : "as-of unavailable"}</span>
          <span>{sourceLabel(sourceDataSource)}</span>
          <span>{freshness ? `freshness ${freshness}` : "freshness unavailable"}</span>
        </div>
      </div>

      {decisionContextState === "error" ? (
        <div className={styles.contextWarning} role="status">
          Decision context unavailable. Asset metrics remain visible without inferred badges.
          {decisionContextError ? <span title={decisionContextError}> Source read failed.</span> : null}
        </div>
      ) : decisionContextState === "loading" ? (
        <div className={styles.contextNotice} role="status">Loading server decision context...</div>
      ) : null}

      {workspaceView === "assets" ? (
        <div role="tabpanel" className={styles.panel}>
          <div className={styles.toolbar}>
            <div className={styles.toolbarLead}>{toolbarLead}</div>
            <label className={styles.searchField}>
              <Search size={15} aria-hidden="true" />
              <input
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search asset, campaign, ad set, or copy"
                aria-label="Search creative assets"
              />
            </label>
            <select
              className={styles.select}
              value={formatFilter}
              onChange={(event) => onFormatFilterChange(event.target.value as CreativeStudioFormatFilter)}
              aria-label="Filter creative format"
            >
              {FORMAT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <select
              className={styles.select}
              value={sort}
              onChange={(event) => onSortChange(event.target.value as CreativeStudioSort)}
              aria-label="Sort creative assets"
            >
              {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <div className={styles.assetViewToggle} aria-label="Asset display mode">
              <button
                type="button"
                className={assetView === "gallery" ? styles.iconButtonActive : styles.iconButton}
                onClick={() => onAssetViewChange("gallery")}
                aria-label="Show gallery"
                title="Gallery"
              >
                <GalleryHorizontalEnd size={16} />
              </button>
              <button
                type="button"
                className={assetView === "table" ? styles.iconButtonActive : styles.iconButton}
                onClick={() => onAssetViewChange("table")}
                aria-label="Show table"
                title="Table"
              >
                <Table2 size={16} />
              </button>
            </div>
          </div>

          <div className={styles.selectionBar}>
            <label className={styles.selectAll}>
              <input type="checkbox" checked={selectedAll} onChange={onToggleAll} />
              Select all filtered
            </label>
            <span>{rows.length} of {allRowCount} assets</span>
            <span>{selectedCount} selected</span>
            <div className={styles.selectionActions}>
              <button
                type="button"
                className={styles.commandButton}
                onClick={onCompare}
                disabled={selectedCount < 2}
                title={selectedCount < 2 ? "Select at least two assets" : "Compare selected assets"}
              >
                <GitCompareArrows size={15} />
                Compare
              </button>
              <button
                type="button"
                className={styles.commandButton}
                onClick={onCsv}
                disabled={rows.length === 0 || csvLoading}
              >
                <Download size={15} />
                {csvLoading ? "Exporting" : "CSV"}
              </button>
              <button
                type="button"
                className={styles.commandButtonPrimary}
                onClick={onShare}
                disabled={selectedCount === 0 || shareLoading}
                title={selectedCount === 0 ? "Select assets to share" : "Share selected assets"}
              >
                <Share2 size={15} />
                {shareLoading ? "Sharing" : "Share"}
              </button>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className={styles.emptyState}>
              <Images size={24} aria-hidden="true" />
              <strong>No assets match this view</strong>
              <span>Clear search or format filters. Missing assets are not replaced with placeholders.</span>
            </div>
          ) : assetView === "gallery" ? (
            <>
              <div className={styles.gallery} data-testid="creative-assets-gallery">
                {galleryRows.map((row) => (
                  <AssetCard
                    key={row.id}
                    row={row}
                    decisionCard={findCreativeStudioCard(row, cardIndex)}
                    selected={selectedRowIds.includes(row.id)}
                    defaultCurrency={defaultCurrency}
                    onToggle={onToggleRow}
                    onOpen={onOpenRow}
                  />
                ))}
              </div>
              <nav
                className={styles.galleryPager}
                aria-label="Creative asset gallery pages"
                data-testid="creative-assets-gallery-pager"
              >
                <span>
                  Showing {galleryStart}-{galleryEnd} of {rows.length}
                </span>
                <div>
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label="Previous gallery page"
                    title="Previous page"
                    disabled={galleryPage <= 1}
                    onClick={() => setGalleryPage((current) => Math.max(1, current - 1))}
                  >
                    <ArrowLeft size={15} aria-hidden="true" />
                  </button>
                  <span className={styles.galleryPageCount}>
                    {galleryPage} / {galleryPageCount}
                  </span>
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label="Next gallery page"
                    title="Next page"
                    disabled={galleryPage >= galleryPageCount}
                    onClick={() =>
                      setGalleryPage((current) => Math.min(galleryPageCount, current + 1))
                    }
                  >
                    <ArrowRight size={15} aria-hidden="true" />
                  </button>
                </div>
              </nav>
            </>
          ) : (
            <div className={styles.tableWrap} data-testid="creative-assets-table">
              <CreativesTableSection
                rows={rows}
                initialPresetName="Creative Studio analysis"
                selectedMetricIds={selectedMetricIds}
                onSelectedMetricIdsChange={onSelectedMetricIdsChange}
                selectedRowIds={selectedRowIds}
                defaultCurrency={defaultCurrency}
                buyerDecisionLanguage={false}
                onToggleRow={onToggleRow}
                onToggleAll={onToggleAll}
                onOpenRow={onOpenRow}
                onSortedRowsChange={onSortedRowsChange}
              />
            </div>
          )}
        </div>
      ) : null}

      {workspaceView === "winner_eras" ? (
        <div role="tabpanel" className={styles.analysisPanel} data-testid="winner-eras-view">
          <section className={styles.analysisSection}>
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>Current engine era</span>
                <h2>Winner-qualified evidence</h2>
              </div>
              <span className={styles.countBadge}>{winnerEvidence.qualified.length} qualified</span>
            </div>
            {winnerEvidence.qualified.length > 0 ? (
              <div className={styles.evidenceList}>
                {winnerEvidence.qualified.map((card) => (
                  <WinnerEvidenceRow
                    key={cardKeyForRender(card)}
                    businessId={businessId}
                    providerAccountId={providerAccountId}
                    card={card}
                  />
                ))}
              </div>
            ) : (
              <div className={styles.emptyInline}>
                No current winner claims clear the server action, truth, threshold, confidence, and engine-era gates.
              </div>
            )}
          </section>

          <section className={styles.analysisSection}>
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>Claims withheld</span>
                <h2>Thin or incomplete truth</h2>
              </div>
              <span className={styles.countBadge}>{winnerEvidence.withheld.length} withheld</span>
            </div>
            {winnerEvidence.withheld.length > 0 ? (
              <div className={styles.evidenceList}>
                {winnerEvidence.withheld.map(({ card, qualification }) => (
                  <div key={cardKeyForRender(card)} className={styles.withheldRow}>
                    <div>
                      <strong>{cardName(card)}</strong>
                      <span>{qualification.explanation}</span>
                    </div>
                    <Link href={decisionHref(businessId, providerAccountId, card)} className={styles.deepLink}>
                      Server evidence <ArrowRight size={14} />
                    </Link>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.emptyInline}>No server winner candidates are currently being withheld.</div>
            )}
          </section>

          <section className={styles.analysisSection}>
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>Historical engine eras</span>
                <h2>Persisted winner history</h2>
              </div>
              <span className={historicalState.status === "available" ? styles.statusReady : styles.statusBlocked}>
                {historicalState.status === "available" ? "Available" : "Provenance required"}
              </span>
            </div>
            {historicalState.reason ? (
              <div className={styles.contractNotice}>
                <Clock3 size={16} aria-hidden="true" />
                <span>{historicalState.reason}</span>
              </div>
            ) : null}
            {historicalState.status === "available" && historicalState.eras.length > 0 ? (
              <div className={styles.eraList}>
                {historicalState.eras.map((era) => (
                  <div key={era.engineVersion} className={styles.eraBlock}>
                    <strong>{era.engineVersion}</strong>
                    <span>{era.entries.length} truth-qualified historical winner events</span>
                  </div>
                ))}
              </div>
            ) : null}
            {historicalState.transitions.length > 0 ? (
              <div className={styles.transitionTable}>
                <div className={styles.transitionHeader}>
                  <span>Date</span><span>Creative</span><span>Server transition</span><span>7d outcome</span>
                </div>
                {historicalState.transitions.slice(0, 12).map((transition, index) => (
                  <div key={`${transition.creativeId}:${transition.entry.date}:${index}`} className={styles.transitionRow}>
                    <span>{transition.entry.date}</span>
                    <strong>{transition.creativeName}</strong>
                    <span>{transition.entry.previousLabel ?? "--"} to {transition.entry.currentLabel}</span>
                    <span>{transition.entry.realizedOutcome7d ?? "--"}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {workspaceView === "fatigue_brief" ? (
        <div role="tabpanel" className={styles.analysisPanel} data-testid="fatigue-brief-view">
          <section className={styles.analysisSection}>
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>Server fatigue evidence</span>
                <h2>Campaign clusters</h2>
              </div>
              <span className={styles.countBadge}>{fatigueGroups.length} clusters</span>
            </div>
            {fatigueGroups.length > 0 ? (
              <div className={styles.fatigueGroups}>
                {fatigueGroups.map((group) => (
                  <section key={group.key} className={styles.fatigueGroup}>
                    <div className={styles.fatigueGroupHeader}>
                      <strong>{group.campaignLabel}</strong>
                      <span>{group.cards.length} server-flagged {group.cards.length === 1 ? "creative" : "creatives"}</span>
                    </div>
                    {group.cards.map((card) => (
                      <div key={cardKeyForRender(card)} className={styles.fatigueRow}>
                        <div>
                          <strong>{cardName(card)}</strong>
                          <span>{card.reason?.trim() || "No server rationale supplied."}</span>
                        </div>
                        {resolveServerDecisionBadge(card) ? (
                          <span className={styles.serverBadge}>{resolveServerDecisionBadge(card)?.label}</span>
                        ) : (
                          <span className={styles.missingBadge}>Decision badge unavailable</span>
                        )}
                        <div className={styles.rowActions}>
                          <button
                            type="button"
                            className={styles.commandButton}
                            disabled={
                              card.sourceDecisionSnapshotMatch !== "matched" ||
                              !card.sourceDecisionSnapshotId
                            }
                            title={
                              card.sourceDecisionSnapshotMatch === "matched"
                                ? "Create a persisted Creative Brief"
                                : "A matching persisted decision snapshot is required"
                            }
                            onClick={() => onCreateBrief(card)}
                          >
                            <FilePlus2 size={14} />
                            Create brief
                          </button>
                          <Link href={decisionHref(businessId, providerAccountId, card)} className={styles.deepLink}>
                          Decisions <ArrowRight size={14} />
                          </Link>
                        </div>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            ) : (
              <div className={styles.emptyInline}>No explicit server fatigue flags are present. Studio does not infer clusters from CTR alone.</div>
            )}
          </section>

          <section className={styles.analysisSection}>
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>Persisted workflow</span>
                <h2>Creative Briefs</h2>
              </div>
              <span className={styles.statusReady}>meta-creative-brief.v1</span>
            </div>
            {creativeBriefsState === "loading" ? (
              <div className={styles.emptyInline}>Loading account-scoped Creative Briefs...</div>
            ) : creativeBriefsState === "error" ? (
              <div className={styles.contractNotice} role="status">
                <span>
                  Creative Briefs could not load. Existing analysis remains read-only.
                  {creativeBriefsError ? ` ${creativeBriefsError}` : ""}
                </span>
              </div>
            ) : creativeBriefs.length === 0 ? (
              <div className={styles.emptyInline}>
                No persisted briefs for this Meta account. Create one only from a matched decision snapshot; Studio never stores row-level brief variation.
              </div>
            ) : (
              <div className={styles.briefList}>
                {creativeBriefs.map((brief) => (
                  <div key={brief.id} className={styles.briefRow}>
                    <div className={styles.briefIdentity}>
                      <strong>{brief.sourceDecision.creativeId}</strong>
                      <span>
                        {brief.sourceDecision.publishedLabel} · {brief.sourceDecision.engineVersion} · snapshot {brief.sourceDecision.snapshotAsOf}
                      </span>
                    </div>
                    <div className={styles.briefMeta}>
                      <span className={brief.status === "reviewed" ? styles.statusReady : styles.countBadge}>
                        {brief.status}
                      </span>
                      <span>v{brief.version}</span>
                      <span>{new Date(brief.updatedAt).toLocaleString()}</span>
                    </div>
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.commandButton}
                        onClick={() => onEditBrief(brief)}
                      >
                        <FileCheck2 size={14} />
                        Open
                      </button>
                      {brief.status === "reviewed" ? (
                        <Link href={launchpadBriefHref(brief)} className={styles.commandButtonPrimary}>
                          Launchpad <ArrowRight size={14} />
                        </Link>
                      ) : (
                        <span className={styles.draftHandoff}>Review before Launchpad</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}

function cardKeyForRender(card: BriefingCreativeCard): string {
  return `${card.providerAccountId ?? "account-missing"}:${cardCreativeId(card)}`;
}

function AssetCard({
  row,
  decisionCard,
  selected,
  defaultCurrency,
  onToggle,
  onOpen,
}: {
  row: MetaCreativeRow;
  decisionCard: BriefingCreativeCard | null;
  selected: boolean;
  defaultCurrency: string | null;
  onToggle: (rowId: string) => void;
  onOpen: (rowId: string) => void;
}) {
  const decisionBadge = resolveServerDecisionBadge(decisionCard);
  const qualification = qualifyCurrentWinner(decisionCard);
  const currency = resolveCreativeCurrency(row.currency, defaultCurrency);
  const assetFallbacks = [
    row.cardPreviewUrl,
    row.imageUrl,
    row.cachedThumbnailUrl,
    row.thumbnailUrl,
    row.previewUrl,
    row.tableThumbnailUrl,
  ];

  return (
    <article
      className={selected ? styles.assetCardSelected : styles.assetCard}
      data-testid="creative-asset-card"
    >
      <div className={styles.assetMedia}>
        <button type="button" className={styles.assetOpen} onClick={() => onOpen(row.id)} aria-label={`Open ${row.name}`}>
          <CreativeRenderSurface
            id={row.id}
            name={row.name}
            preview={row.preview}
            size="card"
            mode="asset"
            assetState={assetFallbacks.some(Boolean) ? "ready" : "missing"}
            assetFallbacks={assetFallbacks}
            className={styles.assetPreview}
          />
        </button>
        <label className={styles.assetCheckbox} title={selected ? "Remove from selection" : "Select asset"}>
          <input type="checkbox" checked={selected} onChange={() => onToggle(row.id)} aria-label={`Select ${row.name}`} />
        </label>
        {decisionBadge ? (
          <span className={styles.serverBadgeFloating} data-decision-source="server">
            {decisionBadge.label}
          </span>
        ) : null}
      </div>
      <div className={styles.assetBody}>
        <button type="button" className={styles.assetTitle} onClick={() => onOpen(row.id)} title={row.name}>
          {row.name}
        </button>
        <div className={styles.assetContext}>
          <span>{row.campaignName || "Campaign unavailable"}</span>
          <span>{row.format || row.creativeVisualFormat || "Format unavailable"}</span>
        </div>
        <div className={styles.assetMetrics}>
          <Metric label="Spend" value={formatMoney(row.spend, currency, defaultCurrency)} />
          <Metric label="ROAS" value={formatRoas(row.roas)} />
          <Metric label="Purchases" value={formatCount(row.purchases)} />
        </div>
        <div className={styles.assetFoot}>
          {decisionCard ? (
            <span title={`Engine ${decisionCard.engineVersion ?? "unavailable"}; truth ${decisionCard.truthSource ?? "unavailable"}`}>
              {sourceLabel(decisionCard.truthSource)}
            </span>
          ) : (
            <span>decision context unavailable</span>
          )}
          {qualification.qualified ? <span className={styles.winnerMarker}><BadgeCheck size={12} /> current winner evidence</span> : null}
        </div>
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function WinnerEvidenceRow({
  businessId,
  providerAccountId,
  card,
}: {
  businessId: string;
  providerAccountId: string;
  card: BriefingCreativeCard;
}) {
  const badge = resolveServerDecisionBadge(card);
  return (
    <article className={styles.winnerRow}>
      <div className={styles.winnerIdentity}>
        <BadgeCheck size={17} aria-hidden="true" />
        <div>
          <strong>{cardName(card)}</strong>
          <span>{card.campaignName || card.campaign || "Campaign unavailable"}</span>
        </div>
      </div>
      <div className={styles.winnerFacts}>
        {badge ? <span className={styles.serverBadge}>{badge.label}</span> : null}
        <span>{sourceLabel(card.truthSource)}</span>
        <span>{card.engineVersion || "engine unavailable"}</span>
        <span>{card.sourceAsOf || "as-of unavailable"}</span>
      </div>
      <Link href={decisionHref(businessId, providerAccountId, card)} className={styles.deepLink}>
        Open Decisions <ArrowRight size={14} />
      </Link>
    </article>
  );
}
