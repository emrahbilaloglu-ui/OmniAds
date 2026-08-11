"use client";

/**
 * Meta Decisions — the daily operator surface (H09/H10, read side of H11/H12).
 *
 * The surface renders the served presentation and computes nothing. Verdict and
 * metric strings are printed exactly as the server produced them, because the
 * Decision Center's standing rule is that the UI must not compute buyerAction
 * and a surface that reformats a verdict will eventually disagree with it.
 *
 * Two things the design is emphatic about:
 *
 * - the evidence window and the snapshot time are drawn as separate facts. A
 *   snapshot written this morning can describe a window that ended days ago,
 *   and collapsing them is how a stale read looks current.
 * - a generic Ads Manager link is a link, never an executed action. It is
 *   labelled as opening Meta, and it never appears where an action would.
 */
import { useMemo, useRef, useState } from "react";

import Link from "next/link";

import { Button } from "@/components/zero-base/primitives/button";
import type { WorkflowConflict } from "@/lib/zero-base/meta/workflow-view-model";
import { Collection } from "@/components/zero-base/collections/collection";
import { DataTable } from "@/components/zero-base/collections/data-table";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { ZeroBaseTabs } from "@/components/zero-base/primitives/tabs";
import { ZeroBaseSheet } from "@/components/zero-base/primitives/overlays";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import {
  actionCountFor,
  orderedBanners,
  type DecisionRow,
  type DecisionsViewModel,
} from "@/lib/zero-base/meta/decisions-presentation";
import {
  DECISION_LEVELS,
  type DecisionLane,
  type DecisionLevel,
  type DecisionsUrlState,
} from "@/lib/zero-base/meta/decisions-url-state";
import {
  WorkflowChip,
  WorkflowPanel,
  type WorkflowSubmit,
  type WorkflowSubmitResult,
} from "@/components/zero-base/meta/decisions/workflow-overlay";
import type { WorkflowRecord } from "@/lib/decision-workflow";
import type { WorkflowEvent } from "@/lib/decision-workflow-store";
import {
  workflowPosture,
  type WorkflowLoadState,
} from "@/lib/zero-base/meta/workflow-view-model";
import {
  MutationCeremonyPanel,
  type MutationCeremonySeed,
} from "@/components/zero-base/meta/decisions/mutation-ceremony-panel";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

const LANE_LABEL: Record<DecisionLane, string> = {
  act: "Act now",
  test: "Needs resolution",
  watch: "Monitoring",
};

/**
 * The workflow overlay's wiring, supplied by the route.
 *
 * Optional as a whole: with no overlay the surface is exactly the read-only
 * Decisions page it was, rather than a page with broken controls.
 */
export interface DecisionsWorkflow {
  records: Map<string, WorkflowRecord>;
  events: readonly WorkflowEvent[];
  loadState: WorkflowLoadState;
  onSubmit: (decisionKey: string, submit: WorkflowSubmit) => Promise<WorkflowSubmitResult>;
  onRefresh?: () => void;
  newMutationId: () => string;
  /** A conflict already known to the caller. */
  initialConflict?: WorkflowConflict | null;
}

export function DecisionsView({
  model,
  state,
  demo,
  onStateChange,
  adsManagerHref,
  workflow,
  mutation,
  stickyBar,
  shareViewHref = null,
  inspectorEvidence = null,
  briefHref = null,
}: {
  model: DecisionsViewModel;
  state: DecisionsUrlState;
  demo: boolean;
  onStateChange: (next: DecisionsUrlState) => void;
  adsManagerHref?: string | null;
  workflow?: DecisionsWorkflow;
  /** Server-owned. Absent whenever the mutation UI is not enabled. */
  mutation?: MutationCeremonySeed;
  /**
   * The narrow terminus bar (INV-17).
   *
   * At 390 the decision detail is the end of Flow A, and the Meta-stop path has
   * to stay one tap away rather than several screens back up the rail. Passed
   * by the caller that knows the viewport; absent at desktop widths, where the
   * rail already carries it.
   */
  stickyBar?: { metaStopHref: string; onOpenManual?: () => void };
  /** URL that reproduces this lane, filter and search exactly. */
  shareViewHref?: string | null;
  inspectorEvidence?: { windowLabel: string; snapshotAt: string; gaps: readonly string[] } | null;
  briefHref?: string | null;
}) {
  const copy = useCopy();
  const [search, setSearch] = useState(state.search);
  // Focus returns to the row that opened the inspector, not to the top.
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const selectedRow = useMemo(
    () => model.rows.find((row) => row.id === state.selected) ?? null,
    [model.rows, state.selected],
  );

  // A URL naming a row this lane does not serve is a real situation — the row
  // aged out, or the link is from another filter. Say so instead of silently
  // showing nothing.
  const selectionMissing = state.selected !== null && selectedRow === null;

  const banners = orderedBanners(model.banners);

  return (
    <div data-decisions-surface="">
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>
          {copy.metaDecisions}
        </h1>
        {/* Two separate facts, drawn separately and labelled. */}
        <p style={{ margin: "4px 0 0", fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}>
          <span data-evidence-window="">
            Evidence window {model.evidenceWindow.startDate} to {model.evidenceWindow.endDate}
          </span>
          {" · "}
          <span data-snapshot-time="">
            Snapshot written {model.snapshotAt ?? "not recorded"}
            {model.snapshotDate ? ` for ${model.snapshotDate}` : ""}
          </span>
        </p>
      </header>

      {banners.length > 0 ? (
        <div data-banner-stack="" style={{ display: "grid", gap: 8, marginBottom: 16 }}>
          {banners.map((banner) => (
            <p
              key={banner.id}
              role="status"
              data-banner={banner.blocking ? "hard" : "partial"}
              data-banner-id={banner.id}
              style={{
                margin: 0,
                padding: "10px 14px",
                borderRadius: "var(--ledger-radius-card)",
                fontSize: 13,
                lineHeight: "19px",
                border: `1px solid ${
                  banner.blocking ? "var(--ledger-semantic-danger)" : "var(--ledger-semantic-warn)"
                }`,
                color: banner.blocking
                  ? "var(--ledger-semantic-danger)"
                  : "var(--ledger-semantic-warn)",
              }}
            >
              <strong>{banner.blocking ? "Blocking: " : "Advisory: "}</strong>
              {banner.title} — {banner.detail}
            </p>
          ))}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <div style={{ maxWidth: 280, flex: "1 1 220px" }}>
          <TextInput
            label={copy.findADecision}
            data-ctl="live:META-DEC-17 search"
            value={search}
            placeholder={copy.campaignAdsetOrTitle}
            onChange={(event) => {
              setSearch(event.target.value);
              onStateChange({ ...state, search: event.target.value, selected: null });
            }}
            hint={copy.filtersLaneDecisions}
          />
        </div>
        <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
          <legend style={{ fontSize: 12, fontWeight: 500, color: "var(--ledger-ink-secondary)", padding: 0 }}>
            {copy.level}
          </legend>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            {DECISION_LEVELS.map((level) => {
              const checked = state.levels.includes(level);
              return (
                <label
                  key={level}
                  style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 24, fontSize: 13 }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    data-level-filter={level}
                    data-ctl="live:META-DEC-02 level"
                    onChange={() =>
                      onStateChange({
                        ...state,
                        selected: null,
                        levels: checked
                          ? state.levels.filter((entry) => entry !== level)
                          : ([...state.levels, level] as DecisionLevel[]),
                      })
                    }
                  />
                  {level}
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div data-lane-region="" data-ctl="live:lane">
      <ZeroBaseTabs
        label={copy.decisionLanes}
        tabCtl="live:META-DEC-01 lane"
        value={state.lane}
        onValueChange={(lane) =>
          onStateChange({ ...state, lane: lane as DecisionLane, selected: null })
        }
        tabs={(["act", "test", "watch"] as DecisionLane[]).map((lane) => ({
          id: lane,
          label: `${LANE_LABEL[lane]} (${model.counts[lane]})`,
          content:
            lane === state.lane ? (
              <>
                {selectionMissing ? (
                  <div style={{ marginBottom: 12 }} data-row-gone="">
                    <UnavailableState reason={copy.decisionNoLongerServed} />
                  </div>
                ) : null}

                <Collection
                  envelope={{
                    items: model.rows,
                    servedCount: model.rows.length,
                    totalCount: model.counts[lane],
                    cap: null,
                    nextCursor: null,
                    truncated: model.truncated,
                    disclosure: model.disclosure,
                  }}
                  state={
                    model.rows.length === 0
                      ? {
                          kind: "empty",
                          reason: `No decisions in ${LANE_LABEL[lane]} for this window and filter.`,
                        }
                      : { kind: "ready" }
                  }
                >
                  <DataTable
                    collection="decisions"
                    caption={`${LANE_LABEL[lane]} decisions`}
                    rows={model.rows}
                    rowKey={(row) => row.id}
                    columns={[
                      {
                        id: "title",
                        header: "Decision",
                        render: (row) => (
                          <button
                            type="button"
                            ref={(node) => {
                              triggerRefs.current[row.id] = node;
                            }}
                            data-decision-row={row.id}
                            data-ctl="live:META-DEC-05 open-inspector"
                            onClick={() => onStateChange({ ...state, selected: row.id })}
                            style={{
                              minHeight: 24,
                              padding: 0,
                              background: "transparent",
                              border: 0,
                              textAlign: "left",
                              color: "var(--ledger-accent-action)",
                              cursor: "pointer",
                              fontSize: 13,
                              fontWeight: 600,
                            }}
                          >
                            {row.title}
                          </button>
                        ),
                      },
                      { id: "level", header: "Level", render: (row) => row.level },
                      {
                        id: "verdict",
                        header: "Verdict",
                        // Printed exactly as served. No formatting, no mapping.
                        render: (row) => (
                          <span
                            data-verdict={row.id}
                            data-el="verdict-chip"
                            data-stale={row.confidence === "low" ? "" : undefined}
                          >
                            {row.decision}
                          </span>
                        ),
                      },
                      {
                        id: "confidence",
                        header: "Confidence",
                        render: (row) => (
                          <span data-confidence={row.id}>
                            {row.confidence}
                            {/* A low-confidence row is demoted, not dropped:
                                it is still a served fact, just a weaker one. */}
                            {row.confidence === "low" ? (
                              <span
                                data-el="stale-demoted"
                                style={{ display: "block", fontSize: 12, color: "var(--ledger-semantic-warn)" }}
                              >
                                {copy.demotedLowConfidence}
                              </span>
                            ) : null}
                            {row.confidenceReason ? (
                              <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                                {row.confidenceReason}
                              </span>
                            ) : null}
                          </span>
                        ),
                      },
                      ...(workflow
                        ? [
                            {
                              id: "workflow",
                              header: "Workflow",
                              render: (row: DecisionRow) => (
                                <WorkflowChip
                                  record={workflow.records.get(row.id) ?? null}
                                  loadState={workflow.loadState}
                                />
                              ),
                            },
                          ]
                        : []),
                      {
                        id: "action",
                        header: "Action",
                        render: (row) => {
                          const count = actionCountFor({ row, viewer: model.viewer, demo });
                          if (count === 0) {
                            return (
                              <span data-action-count="0" style={{ color: "var(--ledger-ink-tertiary)" }}>
                                {row.held ? "Held" : "Read-only"}
                                {row.heldReason ? (
                                  <span style={{ display: "block", fontSize: 12 }}>{row.heldReason}</span>
                                ) : null}
                              </span>
                            );
                          }
                          return (
                            <span data-action-count="1">{row.recommendedAction}</span>
                          );
                        },
                      },
                    ]}
                  />
                </Collection>
              </>
            ) : null,
        }))}
      />
      </div>

      {adsManagerHref ? (
        <p style={{ margin: "8px 0 0", fontSize: 12 }}>
          <a
            href={adsManagerHref}
            target="_blank"
            rel="noopener noreferrer"
            data-ctl="live:META-DEC-13 open"
            style={{ color: "var(--ledger-accent-action)" }}
          >
            {copy.openMetaAdsManager}
          </a>
        </p>
      ) : null}

      {shareViewHref ? (
        <p style={{ margin: "8px 0 0", fontSize: 12.5 }}>
          {/* The exact view, not "Decisions": a shared link that lands on a
              different filter is a different set of decisions. */}
          <Link href={shareViewHref} data-ctl="live:INV-18 share-view" style={{ color: "var(--ledger-accent-action)" }}>
            {copy.shareThisView}
          </Link>
        </p>
      ) : null}


      <ZeroBaseSheet
        open={selectedRow !== null}
        onOpenChange={(open) => {
          if (!open) {
            const previous = state.selected;
            onStateChange({ ...state, selected: null });
            // Focus returns to the row that opened it.
            if (previous) triggerRefs.current[previous]?.focus();
          }
        }}
        title={selectedRow?.title ?? "Decision"}
        closeCtl="live:close"
      >
        {selectedRow ? (
          <DecisionInspector
            row={selectedRow}
            model={model}
            demo={demo}
            evidence={inspectorEvidence}
            briefHref={briefHref}
            stickyBar={stickyBar}
            adsManagerHref={adsManagerHref}
            workflow={workflow}
            mutation={mutation}
          />
        ) : null}
      </ZeroBaseSheet>
    </div>
  );
}

function DecisionInspector({
  row,
  model,
  demo,
  adsManagerHref,
  workflow,
  mutation,
  evidence,
  briefHref,
  stickyBar,
}: {
  row: DecisionRow;
  model: DecisionsViewModel;
  demo: boolean;
  adsManagerHref?: string | null;
  workflow?: DecisionsWorkflow;
  mutation?: MutationCeremonySeed;
  /** What the verdict was measured over, and what was missing from it. */
  evidence?: { windowLabel: string; snapshotAt: string; gaps: readonly string[] } | null;
  briefHref?: string | null;
  /** The narrow terminus bar; part of the detail, not the surface behind it. */
  stickyBar?: { metaStopHref: string; onOpenManual?: () => void };
}) {
  const copy = useCopy();
  const actions = actionCountFor({ row, viewer: model.viewer, demo });

  return (
    <div data-decision-inspector={row.id} style={{ display: "grid", gap: 12, marginTop: 12 }}>
      <dl style={{ display: "grid", gap: 8, margin: 0 }}>
        <div>
          <dt style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.verdict}</dt>
          <dd data-inspector-verdict="" data-el="verdict-chip" style={{ margin: 0, fontSize: 13 }}>
            {row.decision}
          </dd>
        </div>
        <div>
          <dt style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>Why</dt>
          <dd data-inspector-why="" style={{ margin: 0, fontSize: 13 }}>{row.why}</dd>
        </div>
        <div>
          <dt style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.scope}</dt>
          <dd style={{ margin: 0, fontSize: 13 }}>
            {row.campaignName ?? "—"}
            {row.adsetName ? ` · ${row.adsetName}` : ""}
          </dd>
        </div>
        {evidence ? (
          <>
            <div>
              <dt style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                {copy.evidenceWindow}
              </dt>
              {/* The window every figure below covers. A verdict without it is
                  unfalsifiable — the reader cannot tell what it was measured
                  over. */}
              <dd data-el="evidence-window" style={{ margin: 0, fontSize: 13 }}>
                {evidence.windowLabel}
              </dd>
            </div>
            <div>
              <dt style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.asOf}</dt>
              {/* Snapshot time, not "now": these numbers are as of a moment. */}
              <dd data-el="asof-row" style={{ margin: 0, fontSize: 13 }}>
                {evidence.snapshotAt}
              </dd>
            </div>
            {evidence.gaps.length > 0 ? (
              <div>
                <dt style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.gaps}</dt>
                <dd
                  data-el="provenance-gap"
                  style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}
                >
                  {/* Named, not smoothed over: a metric missing at this grain
                      is a different fact from a metric that is zero. */}
                  {evidence.gaps.map((gap) => (
                    <span key={gap} style={{ display: "block" }}>
                      {gap}
                    </span>
                  ))}
                </dd>
              </div>
            ) : null}
          </>
        ) : null}
      </dl>

      {stickyBar ? (
        <div
          data-decision-sticky-bar=""
          style={{
            position: "sticky",
            bottom: 0,
            display: "flex",
            gap: 8,
            padding: "8px 0",
            background: "var(--ledger-bg-surface)",
            borderTop: "1px solid var(--ledger-border-subtle)",
          }}
        >
          <Button
            variant="secondary"
            data-ctl="gated:META-WRITE-01"
            onClick={stickyBar.onOpenManual}
          >
            {copy.openManualAction}
          </Button>
          <Link
            href={stickyBar.metaStopHref}
            data-ctl="live:nav"
            style={{
              alignSelf: "center",
              color: "var(--ledger-accent-action)",
              fontSize: 13,
              textDecoration: "none",
            }}
          >
            {copy.metaStop}
          </Link>
        </div>
      ) : null}

      {briefHref ? (
        <p data-el="row-action" style={{ margin: 0, fontSize: 12.5 }}>
          <Link href={briefHref} data-ctl="live:CREATIVE-07 brief" style={{ color: "var(--ledger-accent-action)" }}>
            {copy.openTheBrief}
          </Link>
        </p>
      ) : null}

      {actions === 0 ? (
        <p data-inspector-action-count="0" style={{ margin: 0, fontSize: 13, color: "var(--ledger-ink-secondary)" }}>
          {row.held
            ? (row.heldReason ?? "No action is offered for this decision.")
            : "This view is read-only for your role."}
        </p>
      ) : (
        <p data-inspector-action-count="1" style={{ margin: 0, fontSize: 13 }}>
          {row.recommendedAction}
        </p>
      )}

      {workflow ? (
        <WorkflowPanel
          decisionKey={row.id}
          servedIds={model.servedIds}
          record={workflow.records.get(row.id) ?? null}
          events={workflow.events}
          loadState={workflow.loadState}
          posture={workflowPosture({ viewer: model.viewer, demo })}
          initialConflict={workflow.initialConflict ?? null}
          onSubmit={(submit) => workflow.onSubmit(row.id, submit)}
          onRefresh={workflow.onRefresh}
          newMutationId={workflow.newMutationId}
        />
      ) : null}

      {/* Absent entirely unless the server says the mutation UI is enabled. */}
      {mutation ? <MutationCeremonyPanel row={row} seed={mutation} /> : null}

      {adsManagerHref ? (
        <p style={{ margin: 0, fontSize: 12, lineHeight: "16px" }}>
          {/* Explicitly a link out, never dressed as something that happened. */}
          <a
            href={adsManagerHref}
            target="_blank"
            rel="noopener noreferrer"
            data-ads-manager-link=""
            data-ctl="live:META-DEC-13 open"
            style={{ color: "var(--ledger-accent-action)" }}
          >
            {copy.openMetaAdsManager}
          </a>
          <span style={{ display: "block", color: "var(--ledger-ink-tertiary)" }}>
            {copy.opensMetaNewTab}
          </span>
        </p>
      ) : null}
    </div>
  );
}
