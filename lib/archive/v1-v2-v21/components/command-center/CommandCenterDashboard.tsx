"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckSquare2,
  Clock3,
  Lightbulb,
  Layers3,
  ListChecks,
  MessageSquareWarning,
  NotebookPen,
  RefreshCw,
  ShieldAlert,
  Square,
  Users,
} from "lucide-react";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { DecisionAuthorityPanel } from "@/components/decision-trust/DecisionAuthorityPanel";
import { DecisionPolicyExplanationPanel } from "@/components/decision-trust/DecisionPolicyExplanationPanel";
import { CommandCenterExecutionSupportMatrix } from "@/components/command-center/CommandCenterExecutionSupportMatrix";
import { CommandCenterHistoricalIntelligencePanel } from "@/components/command-center/CommandCenterHistoricalIntelligencePanel";
import {
  DEFAULT_DATE_RANGE,
  DateRangePicker,
  getPresetDates,
  type DateRangeValue,
} from "@/components/date-range/DateRangePicker";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { usePersistentCommandCenterDateRange } from "@/hooks/use-persistent-date-range";
import type {
  CommandCenterAction,
  CommandCenterActionStatus,
  CommandCenterFeedbackType,
  CommandCenterHandoff,
  CommandCenterOwnerWorkloadSummary,
  CommandCenterResponse,
  CommandCenterSavedViewDefinition,
} from "@/lib/command-center";
import { filterCommandCenterActionsByView } from "@/lib/command-center";
import type { CommandCenterExecutionPreview } from "@/lib/command-center-execution";
import { cn } from "@/lib/utils";
import {
  addCommandCenterNote,
  acknowledgeCommandCenterHandoff,
  applyCommandCenterExecution,
  batchMutateCommandCenterActions,
  createCommandCenterFeedback,
  createCommandCenterHandoff,
  createCommandCenterSavedView,
  deleteCommandCenterSavedView,
  getCommandCenter,
  getCommandCenterExecutionPreview,
  mutateCommandCenterAction,
  rollbackCommandCenterExecution,
} from "@/src/services";
import { useAppStore } from "@/store/app-store";

const STATUS_OPTIONS = [
  "all",
  "pending",
  "approved",
  "rejected",
  "snoozed",
  "completed_manual",
  "failed",
  "canceled",
] as const;

type StatusFilter = (typeof STATUS_OPTIONS)[number];
type SourceFilter = "all" | "meta" | "creative";

function resolveStatusTone(status: CommandCenterActionStatus) {
  if (status === "approved" || status === "completed_manual") {
    return "bg-emerald-50 text-emerald-700 border-emerald-200";
  }
  if (status === "rejected" || status === "failed" || status === "canceled") {
    return "bg-rose-50 text-rose-700 border-rose-200";
  }
  if (status === "snoozed") {
    return "bg-amber-50 text-amber-700 border-amber-200";
  }
  return "bg-slate-50 text-slate-700 border-slate-200";
}

function formatActionLabel(value: string) {
  return value.replaceAll("_", " ");
}

function formatSurfaceLane(value: CommandCenterAction["surfaceLane"]) {
  return value.replaceAll("_", " ");
}

function formatQueueSection(value: CommandCenterAction["queueSection"]) {
  return value.replaceAll("_", " ");
}

function formatWorkloadClass(value: CommandCenterAction["workloadClass"]) {
  return value.replaceAll("_", " ");
}

function resolveSurfaceLaneTone(lane: CommandCenterAction["surfaceLane"]) {
  if (lane === "action_core") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (lane === "watchlist") {
    return "border-blue-200 bg-blue-50 text-blue-700";
  }
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function resolveQueueSectionTone(section: CommandCenterAction["queueSection"]) {
  if (section === "default_queue") {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }
  if (section === "overflow_backlog") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (section === "watchlist") {
    return "border-blue-200 bg-blue-50 text-blue-700";
  }
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function resolveDispositionTone(
  disposition: CommandCenterAction["operatorDisposition"],
) {
  if (disposition === "protected_watchlist") {
    return "border-blue-200 bg-blue-50 text-blue-700";
  }
  if (disposition === "archive_only") {
    return "border-slate-200 bg-slate-100 text-slate-700";
  }
  if (disposition === "review_hold" || disposition === "review_reduce") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (disposition === "degraded_no_scale") {
    return "border-orange-200 bg-orange-50 text-orange-700";
  }
  if (disposition === "monitor_low_truth") {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function resolveExecutionSupportTone(
  mode: CommandCenterExecutionPreview["supportMode"],
) {
  if (mode === "supported") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (mode === "manual_only") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function resolveExecutionStatusTone(
  status: CommandCenterExecutionPreview["status"],
) {
  if (status === "executed" || status === "rolled_back") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (status === "failed") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  if (status === "ready_for_apply") {
    return "border-blue-200 bg-blue-50 text-blue-700";
  }
  if (status === "manual_only" || status === "unsupported") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function resolveSlaTone(status: CommandCenterAction["throughput"]["slaStatus"]) {
  if (status === "overdue") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  if (status === "due_soon") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (status === "on_track") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function resolveOwnerWorkloadTone(owner: CommandCenterOwnerWorkloadSummary) {
  if (owner.isUnassigned || owner.overdueCount > 0) {
    return "border-rose-200 bg-rose-50";
  }
  if (owner.highPriorityCount > 0) {
    return "border-amber-200 bg-amber-50";
  }
  return "border-slate-200 bg-white";
}

function resolveOpportunityTone(
  verdict: string,
  sourceSystem: "meta" | "creative",
) {
  if (verdict === "queue_ready") {
    return sourceSystem === "meta"
      ? "border-emerald-200 bg-emerald-50"
      : "border-sky-200 bg-sky-50";
  }
  if (verdict === "protected") {
    return "border-blue-200 bg-blue-50";
  }
  if (verdict === "blocked") {
    return "border-rose-200 bg-rose-50";
  }
  return "border-slate-200 bg-slate-50";
}

function createClientMutationId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildSavedViewDefinition(input: {
  currentViewDefinition: CommandCenterSavedViewDefinition | null;
  sourceFilter: SourceFilter;
  statusFilter: StatusFilter;
  watchlistOnly: boolean;
}): CommandCenterSavedViewDefinition {
  const next: CommandCenterSavedViewDefinition = {
    ...(input.currentViewDefinition ?? {}),
  };
  if (input.watchlistOnly) {
    next.surfaceLanes = ["watchlist"];
  } else if (!input.currentViewDefinition?.surfaceLanes?.length) {
    next.surfaceLanes = ["action_core"];
  }
  if (input.sourceFilter !== "all") {
    next.sourceTypes =
      input.sourceFilter === "meta"
        ? [
            "meta_adset_decision",
            "meta_budget_shift",
            "meta_geo_decision",
            "meta_placement_anomaly",
            "meta_no_touch_item",
          ]
        : ["creative_primary_decision"];
  }
  if (input.statusFilter !== "all") {
    next.statuses = [input.statusFilter];
  }
  if (input.watchlistOnly) {
    next.watchlistOnly = true;
  }
  return next;
}

function applyClientFilters(input: {
  actions: CommandCenterAction[];
  sourceFilter: SourceFilter;
  statusFilter: StatusFilter;
  watchlistOnly: boolean;
}) {
  return input.actions.filter((action) => {
    if (input.sourceFilter !== "all" && action.sourceSystem !== input.sourceFilter) {
      return false;
    }
    if (input.statusFilter !== "all" && action.status !== input.statusFilter) {
      return false;
    }
    if (input.watchlistOnly && !action.watchlistOnly) {
      return false;
    }
    return true;
  });
}

function SummaryCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            {label}
          </p>
          <p className="mt-1 text-2xl font-semibold text-slate-950">{value}</p>
        </div>
        <div className="rounded-xl bg-slate-50 p-2 text-slate-600">{icon}</div>
      </div>
    </div>
  );
}

function ActionCard({
  action,
  active,
  selectedForBatch,
  canBatchEdit,
  onToggleBatchSelection,
  onSelect,
}: {
  action: CommandCenterAction;
  active: boolean;
  selectedForBatch: boolean;
  canBatchEdit: boolean;
  onToggleBatchSelection: () => void;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-2xl border bg-white p-4 text-left shadow-sm transition-colors",
        active ? "border-slate-900 shadow-md" : "border-slate-200 hover:border-slate-300",
      )}
      data-testid={`command-center-action-${action.actionFingerprint}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {action.throughput.selectedInDefaultQueue ? (
              <Badge variant="outline" className="border-sky-200 bg-sky-50 text-sky-700">
                default queue
              </Badge>
            ) : null}
            <Badge
              variant="outline"
              className={cn("capitalize", resolveStatusTone(action.status))}
            >
              {formatActionLabel(action.status)}
            </Badge>
            <Badge variant="outline">{action.sourceContext.sourceLabel}</Badge>
            <Badge
              variant="outline"
              className={cn("capitalize", resolveSurfaceLaneTone(action.surfaceLane))}
            >
              {formatSurfaceLane(action.surfaceLane)}
            </Badge>
            <Badge
              variant="outline"
              className={cn("capitalize", resolveQueueSectionTone(action.queueSection))}
            >
              {formatQueueSection(action.queueSection)}
            </Badge>
            <Badge variant="outline" className="capitalize">
              {formatWorkloadClass(action.workloadClass)}
            </Badge>
            {action.operatorDisposition !== "standard" ? (
              <Badge
                variant="outline"
                className={cn(
                  "capitalize",
                  resolveDispositionTone(action.operatorDisposition),
                )}
              >
                {formatActionLabel(action.operatorDisposition)}
              </Badge>
            ) : null}
            {action.truthState === "degraded_missing_truth" ? (
              <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                degraded truth
              </Badge>
            ) : null}
            {action.batchReviewEligible ? (
              <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                batch ready
              </Badge>
            ) : null}
          </div>
          <p className="mt-2 text-sm font-semibold text-slate-950">{action.title}</p>
          <p className="mt-1 text-xs text-slate-600">
            {formatActionLabel(action.recommendedAction)} · {action.summary}
          </p>
        </div>
        <div className="flex items-start gap-3">
          {canBatchEdit ? (
            <span
              className="mt-0.5 text-slate-500"
              onClick={(event) => {
                event.stopPropagation();
                onToggleBatchSelection();
              }}
              role="checkbox"
              aria-checked={selectedForBatch}
              aria-label={
                selectedForBatch ? "Deselect action for batch review" : "Select action for batch review"
              }
              data-testid={`command-center-batch-toggle-${action.actionFingerprint}`}
            >
              {selectedForBatch ? (
                <CheckSquare2 className="h-4 w-4" />
              ) : (
                <Square className="h-4 w-4" />
              )}
            </span>
          ) : null}
          <div className="text-right text-xs text-slate-500">
            <p>{Math.round(action.confidence * 100)}% confidence</p>
            <p className="mt-1 capitalize">{action.priority} priority</p>
            <p className="mt-1">Score {action.throughput.priorityScore}</p>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
        {action.assigneeName ? <span>Assignee: {action.assigneeName}</span> : null}
        {action.snoozeUntil ? <span>Snooze until {action.snoozeUntil}</span> : null}
        {action.noteCount > 0 ? <span>{action.noteCount} notes</span> : null}
        <span>{action.throughput.ageLabel}</span>
        <Badge
          variant="outline"
          className={cn(resolveSlaTone(action.throughput.slaStatus))}
        >
          {action.throughput.slaStatus === "n_a"
            ? "sla n/a"
            : `sla ${formatActionLabel(action.throughput.slaStatus)}`}
        </Badge>
      </div>
    </button>
  );
}

function splitCommaList(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function CommandCenterDashboard() {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const [dateRange, setDateRange] = usePersistentCommandCenterDateRange();
  const searchParams = useSearchParams();
  const [activeViewKey, setActiveViewKey] = useState<string | null>(
    searchParams.get("viewKey"),
  );
  const [selectedActionFingerprint, setSelectedActionFingerprint] = useState<string | null>(
    searchParams.get("action"),
  );
  const [executionSheetOpen, setExecutionSheetOpen] = useState(
    Boolean(searchParams.get("action")),
  );
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  const [viewName, setViewName] = useState("");
  const [handoffShift, setHandoffShift] = useState<"morning" | "evening">("morning");
  const [handoffSummary, setHandoffSummary] = useState("");
  const [handoffBlockers, setHandoffBlockers] = useState("");
  const [handoffWatchouts, setHandoffWatchouts] = useState("");
  const [handoffToUserId, setHandoffToUserId] = useState<string>("");
  const [linkedHandoffActions, setLinkedHandoffActions] = useState<string[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [feedbackNoteDraft, setFeedbackNoteDraft] = useState("");
  const [queueGapNoteDraft, setQueueGapNoteDraft] = useState("");
  const [batchSelection, setBatchSelection] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const effectiveDateRange = useMemo<DateRangeValue>(
    () => dateRange ?? DEFAULT_DATE_RANGE,
    [dateRange],
  );

  const resolvedWindow = useMemo(
    () =>
      getPresetDates(
        effectiveDateRange.rangePreset,
        effectiveDateRange.customStart,
        effectiveDateRange.customEnd,
      ),
    [effectiveDateRange],
  );
  const startDate = resolvedWindow.start;
  const endDate = resolvedWindow.end;

  const query = useQuery({
    queryKey: ["command-center", selectedBusinessId, startDate, endDate],
    enabled: Boolean(selectedBusinessId && startDate && endDate),
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
    queryFn: () => getCommandCenter(selectedBusinessId!, startDate, endDate),
  });
  const payload = query.data as CommandCenterResponse | undefined;

  const selectedView = useMemo(() => {
    if (!query.data || !activeViewKey) return null;
    return query.data.savedViews.find((view) => view.viewKey === activeViewKey) ?? null;
  }, [activeViewKey, query.data]);

  const baseActions = useMemo(() => {
    if (!query.data) return [];
    if (!selectedView) {
      return query.data.actions.filter(
        (action) => action.queueSection === "default_queue",
      );
    }
    return filterCommandCenterActionsByView(query.data.actions, selectedView.definition);
  }, [query.data, selectedView]);

  const filteredActions = useMemo(
    () =>
      applyClientFilters({
        actions: baseActions,
        sourceFilter,
        statusFilter,
        watchlistOnly,
      }),
    [baseActions, sourceFilter, statusFilter, watchlistOnly],
  );

  const selectedAction =
    filteredActions.find(
      (action) => action.actionFingerprint === selectedActionFingerprint,
    ) ??
    query.data?.actions.find(
      (action) => action.actionFingerprint === selectedActionFingerprint,
    ) ??
    null;

  useEffect(() => {
    setBatchSelection((current) =>
      current.filter((fingerprint) =>
        filteredActions.some(
          (action) =>
            action.actionFingerprint === fingerprint && action.batchReviewEligible,
        ),
      ),
    );
  }, [filteredActions]);

  useEffect(() => {
    if (!selectedAction) {
      setExecutionSheetOpen(false);
    }
  }, [selectedAction]);

  const watchlistActions = useMemo(
    () =>
      query.data?.actions
        .filter((action) => action.surfaceLane === "watchlist")
        .slice(0, 6) ?? [],
    [query.data],
  );
  const archiveContextActions = useMemo(
    () =>
      query.data?.actions
        .filter((action) => action.surfaceLane === "archive_context")
        .slice(0, 6) ?? [],
    [query.data],
  );
  const overflowBacklogActions = useMemo(
    () =>
      query.data?.actions
        .filter((action) => action.queueSection === "overflow_backlog")
        .slice(0, 6) ?? [],
    [query.data],
  );
  const batchEligibleVisibleCount = useMemo(
    () => filteredActions.filter((action) => action.batchReviewEligible).length,
    [filteredActions],
  );

  const canEdit = query.data?.permissions.canEdit ?? false;
  const selectedFeedbackEntries = useMemo(
    () =>
      selectedAction
        ? (payload?.feedback ?? []).filter(
            (entry) => entry.actionFingerprint === selectedAction.actionFingerprint,
          )
        : [],
    [payload?.feedback, selectedAction],
  );
  const executionQuery = useQuery({
    queryKey: [
      "command-center-execution",
      selectedBusinessId,
      startDate,
      endDate,
      selectedAction?.actionFingerprint ?? null,
      selectedAction?.status ?? null,
      selectedAction?.lastMutatedAt ?? null,
    ],
    enabled: Boolean(selectedBusinessId && selectedAction),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () =>
      getCommandCenterExecutionPreview({
        businessId: selectedBusinessId!,
        startDate,
        endDate,
        actionFingerprint: selectedAction!.actionFingerprint,
      }),
  });

  async function refresh() {
    setPageError(null);
    await query.refetch();
    if (selectedAction) {
      await executionQuery.refetch();
    }
  }

  async function runMutation(input: {
    mutation:
      | "approve"
      | "reject"
      | "snooze"
      | "assign"
      | "reopen"
      | "complete_manual";
    assigneeUserId?: string | null;
    snoozeUntil?: string | null;
  }) {
    if (!selectedAction || !selectedBusinessId) return;
    setPending(true);
    setPageError(null);
    try {
      await mutateCommandCenterAction({
        businessId: selectedBusinessId,
        startDate,
        endDate,
        actionFingerprint: selectedAction.actionFingerprint,
        clientMutationId: createClientMutationId(),
        mutation: input.mutation,
        assigneeUserId: input.assigneeUserId,
        snoozeUntil: input.snoozeUntil,
      });
      await query.refetch();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Mutation failed.");
    } finally {
      setPending(false);
    }
  }

  async function submitNote() {
    if (!selectedAction || !selectedBusinessId || !noteDraft.trim()) return;
    setPending(true);
    setPageError(null);
    try {
      await addCommandCenterNote({
        businessId: selectedBusinessId,
        startDate,
        endDate,
        actionFingerprint: selectedAction.actionFingerprint,
        clientMutationId: createClientMutationId(),
        note: noteDraft.trim(),
      });
      setNoteDraft("");
      await query.refetch();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Note save failed.");
    } finally {
      setPending(false);
    }
  }

  function toggleBatchSelection(actionFingerprint: string) {
    if (
      !filteredActions.some(
        (action) =>
          action.actionFingerprint === actionFingerprint && action.batchReviewEligible,
      )
    ) {
      return;
    }
    setBatchSelection((current) =>
      current.includes(actionFingerprint)
        ? current.filter((item) => item !== actionFingerprint)
        : [...current, actionFingerprint],
    );
  }

  async function runBatchMutation(
    mutation: "approve" | "reject" | "reopen" | "complete_manual",
  ) {
    if (!selectedBusinessId || batchSelection.length === 0) return;
    setPending(true);
    setPageError(null);
    try {
      const result = await batchMutateCommandCenterActions({
        businessId: selectedBusinessId,
        startDate,
        endDate,
        actionFingerprints: batchSelection,
        clientMutationId: createClientMutationId(),
        mutation,
      });
      if (result.failureCount > 0) {
        setPageError(
          `${result.failureCount} batch item(s) could not be updated. The rest completed successfully.`,
        );
      }
      setBatchSelection([]);
      await query.refetch();
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : "Batch mutation failed.",
      );
    } finally {
      setPending(false);
    }
  }

  async function submitActionFeedback(feedbackType: Exclude<CommandCenterFeedbackType, "false_negative">) {
    if (!selectedBusinessId || !selectedAction || !feedbackNoteDraft.trim()) return;
    setPending(true);
    setPageError(null);
    try {
      await createCommandCenterFeedback({
        businessId: selectedBusinessId,
        startDate,
        endDate,
        actionFingerprint: selectedAction.actionFingerprint,
        clientMutationId: createClientMutationId(),
        feedbackType,
        scope: "action",
        note: feedbackNoteDraft.trim(),
      });
      setFeedbackNoteDraft("");
      await query.refetch();
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : "Feedback could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }

  async function submitQueueGapFeedback() {
    if (!selectedBusinessId || !queueGapNoteDraft.trim()) return;
    setPending(true);
    setPageError(null);
    try {
      await createCommandCenterFeedback({
        businessId: selectedBusinessId,
        clientMutationId: createClientMutationId(),
        feedbackType: "false_negative",
        scope: "queue_gap",
        note: queueGapNoteDraft.trim(),
        sourceSystem: sourceFilter === "all" ? null : sourceFilter,
        viewKey: activeViewKey,
      });
      setQueueGapNoteDraft("");
      await query.refetch();
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : "Queue-gap feedback failed.",
      );
    } finally {
      setPending(false);
    }
  }

  function prefillHandoffFromDigest() {
    if (!payload) return;
    setHandoffSummary(payload.shiftDigest.headline);
    setHandoffBlockers(payload.shiftDigest.blockers.join(", "));
    setHandoffWatchouts(payload.shiftDigest.watchouts.join(", "));
    setLinkedHandoffActions(payload.shiftDigest.linkedActionFingerprints);
  }

  async function saveCurrentView() {
    if (!selectedBusinessId || !viewName.trim()) return;
    setPending(true);
    setPageError(null);
    try {
      const definition = buildSavedViewDefinition({
        currentViewDefinition: selectedView?.definition ?? null,
        sourceFilter,
        statusFilter,
        watchlistOnly,
      });
      await createCommandCenterSavedView({
        businessId: selectedBusinessId,
        name: viewName.trim(),
        definition,
      });
      setViewName("");
      await query.refetch();
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : "Could not save current view.",
      );
    } finally {
      setPending(false);
    }
  }

  async function removeView(viewKey: string) {
    if (!selectedBusinessId) return;
    setPending(true);
    setPageError(null);
    try {
      await deleteCommandCenterSavedView({
        businessId: selectedBusinessId,
        viewKey,
      });
      if (activeViewKey === viewKey) {
        setActiveViewKey(null);
      }
      await query.refetch();
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : "Could not delete view.",
      );
    } finally {
      setPending(false);
    }
  }

  async function submitHandoff() {
    if (!selectedBusinessId || !handoffSummary.trim()) return;
    setPending(true);
    setPageError(null);
    try {
      await createCommandCenterHandoff({
        businessId: selectedBusinessId,
        shift: handoffShift,
        summary: handoffSummary.trim(),
        blockers: splitCommaList(handoffBlockers),
        watchouts: splitCommaList(handoffWatchouts),
        linkedActionFingerprints: linkedHandoffActions,
        toUserId: handoffToUserId || null,
      });
      setHandoffSummary("");
      setHandoffBlockers("");
      setHandoffWatchouts("");
      setLinkedHandoffActions([]);
      await query.refetch();
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : "Could not create handoff.",
      );
    } finally {
      setPending(false);
    }
  }

  async function acknowledgeHandoff(handoff: CommandCenterHandoff) {
    if (!selectedBusinessId) return;
    setPending(true);
    setPageError(null);
    try {
      await acknowledgeCommandCenterHandoff({
        businessId: selectedBusinessId,
        handoffId: handoff.id,
      });
      await query.refetch();
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : "Could not acknowledge handoff.",
      );
    } finally {
      setPending(false);
    }
  }

  async function runExecutionApply() {
    if (!selectedBusinessId || !selectedAction || !executionQuery.data) return;
    setPending(true);
    setPageError(null);
    try {
      await applyCommandCenterExecution({
        businessId: selectedBusinessId,
        startDate,
        endDate,
        actionFingerprint: selectedAction.actionFingerprint,
        previewHash: executionQuery.data.previewHash,
        clientMutationId: createClientMutationId(),
      });
      await Promise.all([query.refetch(), executionQuery.refetch()]);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Execution apply failed.");
    } finally {
      setPending(false);
    }
  }

  async function runExecutionRollback() {
    if (!selectedBusinessId || !selectedAction) return;
    setPending(true);
    setPageError(null);
    try {
      await rollbackCommandCenterExecution({
        businessId: selectedBusinessId,
        startDate,
        endDate,
        actionFingerprint: selectedAction.actionFingerprint,
        clientMutationId: createClientMutationId(),
      });
      await Promise.all([query.refetch(), executionQuery.refetch()]);
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : "Execution rollback failed.",
      );
    } finally {
      setPending(false);
    }
  }

  if (!selectedBusinessId) {
    return <BusinessEmptyState />;
  }

  return (
    <div className="space-y-5" data-testid="command-center-page">
      <div className="rounded-3xl border border-slate-200 bg-[linear-gradient(135deg,#ffffff_0%,#f7fafc_60%,#eef5ff_100%)] p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Command Center
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-950">
              Team workflow across Meta and Creative
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-600">
              Daily action queue, approval state, assignees, saved views, handoff notes,
              and decision history live in one operator surface.
            </p>
            {payload ? (
              <>
                <p className="mt-2 text-xs text-slate-500">
                  Decisions use live windows. Selected period affects analysis only.
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  Decision as of {payload.decisionAsOf} · primary window {payload.decisionWindows.primary30d.startDate} to {payload.decisionWindows.primary30d.endDate}
                </p>
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DateRangePicker
              value={effectiveDateRange}
              onChange={setDateRange}
              showComparisonTrigger={false}
              rangePresets={["today", "7d", "14d", "30d", "90d", "custom"]}
            />
            <Button variant="outline" size="sm" onClick={refresh} disabled={query.isFetching}>
              <RefreshCw className={cn("h-4 w-4", query.isFetching && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>

        {payload ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <SummaryCard
              label="Default Queue"
              value={payload.throughput.selectedCount}
              icon={<ArrowRight className="h-4 w-4" />}
            />
            <SummaryCard
              label="Overflow"
              value={payload.throughput.overflowCount}
              icon={<Clock3 className="h-4 w-4" />}
            />
            <SummaryCard
              label="Watchlist"
              value={payload.summary.watchlistCount}
              icon={<ShieldAlert className="h-4 w-4" />}
            />
            <SummaryCard
              label="Feedback"
              value={payload.feedbackSummary.totalCount}
              icon={<Users className="h-4 w-4" />}
            />
            <SummaryCard
              label="Opportunities"
              value={payload.opportunitySummary.totalCount}
              icon={<Lightbulb className="h-4 w-4" />}
            />
          </div>
        ) : null}

        {payload?.queueSections?.length ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {payload.queueSections.map((section) => (
              <Badge
                key={section.key}
                variant="outline"
                className={cn(
                  "capitalize",
                  section.key === "default_queue"
                    ? "border-sky-200 bg-sky-50 text-sky-700"
                    : section.key === "overflow_backlog"
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : section.key === "watchlist"
                        ? "border-blue-200 bg-blue-50 text-blue-700"
                        : "border-slate-200 bg-slate-50 text-slate-700",
                )}
              >
                {section.label}: {section.count}
                {section.actionableCount > 0 ? ` · ${section.actionableCount} actionable` : ""}
              </Badge>
            ))}
          </div>
        ) : null}

        {payload ? (
          <div className="mt-4 grid gap-3 xl:grid-cols-[1.2fr_0.8fr_0.8fr]">
            <div
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              data-testid="command-center-budget-summary"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Queue budget
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    {payload.throughput.selectedCount} of {payload.throughput.actionableCount} actionable
                    items fit the current operator budget.
                  </p>
                </div>
                <Badge variant="outline">{payload.throughput.totalBudget} max</Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                <Badge variant="outline">Critical {payload.throughput.quotas.critical}</Badge>
                <Badge variant="outline">High {payload.throughput.quotas.high}</Badge>
                <Badge variant="outline">Medium {payload.throughput.quotas.medium}</Badge>
                <Badge variant="outline">Low {payload.throughput.quotas.low}</Badge>
              </div>
              {payload.throughput.overflowCount > 0 ? (
                <p className="mt-3 text-xs text-amber-700">
                  {payload.throughput.overflowCount} item(s) overflow the current shift budget and stay outside the default queue.
                </p>
              ) : null}
            </div>

            <div
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              data-testid="command-center-shift-digest"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Shift digest
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-950">
                    {payload.shiftDigest.headline}
                  </p>
                </div>
                <Layers3 className="h-4 w-4 text-slate-500" />
              </div>
              <p className="mt-2 text-xs text-slate-600">{payload.shiftDigest.summary}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {payload.shiftDigest.blockers.map((item) => (
                  <Badge key={item} variant="outline" className="border-rose-200 bg-rose-50 text-rose-700">
                    blocker: {item}
                  </Badge>
                ))}
                {payload.shiftDigest.watchouts.map((item) => (
                  <Badge key={item} variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                    watch: {item}
                  </Badge>
                ))}
              </div>
            </div>

            <div
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              data-testid="command-center-feedback-summary"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Feedback
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    {payload.feedbackSummary.falsePositiveCount} false positive ·{" "}
                    {payload.feedbackSummary.badRecommendationCount} bad recommendation ·{" "}
                    {payload.feedbackSummary.falseNegativeCount} false negative
                  </p>
                </div>
                <MessageSquareWarning className="h-4 w-4 text-slate-500" />
              </div>
              <p className="mt-2 text-xs text-slate-600">
                {payload.feedbackSummary.queueGapCount} queue-gap report(s) ·{" "}
                {payload.feedbackSummary.calibrationCandidateCount} calibration candidate(s) ·{" "}
                {payload.feedbackSummary.workflowGapCount} workflow gap(s)
              </p>
            </div>
          </div>
        ) : null}

        {payload ? (
          <div
            className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
            data-testid="command-center-opportunity-board"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Opportunity board
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-950">
                  {payload.opportunitySummary.headline}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  {payload.opportunitySummary.queueEligibleCount} queue-ready ·{" "}
                  {payload.opportunitySummary.protectedCount} protected ·{" "}
                  {payload.opportunitySummary.metaCount} Meta ·{" "}
                  {payload.opportunitySummary.creativeCount} Creative
                </p>
              </div>
              <Lightbulb className="h-4 w-4 text-slate-500" />
            </div>

            {payload.opportunities.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                No opportunity-board item is available yet.
              </p>
            ) : (
              <div className="mt-3 grid gap-3 xl:grid-cols-2">
                {payload.opportunities.slice(0, 6).map((opportunity) => (
                  <div
                    key={opportunity.opportunityId}
                    className={cn(
                      "rounded-2xl border px-3 py-3",
                      resolveOpportunityTone(
                        opportunity.eligibilityTrace?.verdict ??
                          (opportunity.queueEligible ? "queue_ready" : "board_only"),
                        opportunity.sourceSystem,
                      ),
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">
                          {opportunity.title}
                        </p>
                        <p className="mt-1 text-xs text-slate-600">
                          {opportunity.summary}
                        </p>
                      </div>
                      <Badge variant="outline">
                        {formatActionLabel(opportunity.recommendedAction)}
                      </Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-600">
                      <span>{opportunity.sourceSystem}</span>
                      <span>{Math.round(opportunity.confidence * 100)}% confidence</span>
                      <span>
                        {(
                          opportunity.eligibilityTrace?.verdict ??
                          (opportunity.queueEligible ? "queue_ready" : "board_only")
                        ).replaceAll("_", "-")}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {opportunity.evidenceFloors.slice(0, 3).map((floor) => (
                        <Badge
                          key={`${opportunity.opportunityId}:${floor.key}`}
                          variant="outline"
                          className={cn(
                            floor.status === "met"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : floor.status === "watch"
                                ? "border-amber-200 bg-amber-50 text-amber-700"
                                : "border-slate-200 bg-slate-100 text-slate-700",
                          )}
                        >
                          {floor.label}: {floor.current}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {payload ? (
          <DecisionAuthorityPanel
            authority={payload.authority}
            commercialSummary={payload.commercialSummary}
            title="Command Center Authority"
            className="mt-4"
          />
        ) : null}

        {payload && !payload.permissions.canEdit ? (
          <div
            className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
            data-testid="command-center-read-only-banner"
          >
            {payload.permissions.reason ??
              "This workspace is read-only for your current role."}
          </div>
        ) : null}

        {pageError ? (
          <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {pageError}
          </div>
        ) : null}

        {payload ? (
          <div className="mt-4">
            <CommandCenterHistoricalIntelligencePanel
              intelligence={payload.historicalIntelligence}
            />
          </div>
        ) : null}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Saved views</Badge>
          <Button
            variant={activeViewKey === null ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveViewKey(null)}
          >
            Default queue
          </Button>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-3">
            {(payload?.viewStacks ?? []).map((stack) => (
              <div key={stack.stackKey}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {stack.label}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {stack.views.map((view) => (
                    <div key={view.viewKey} className="flex items-center gap-1">
                      <Button
                        variant={activeViewKey === view.viewKey ? "default" : "outline"}
                        size="sm"
                        onClick={() => setActiveViewKey(activeViewKey === view.viewKey ? null : view.viewKey)}
                        data-testid={`command-center-view-${view.viewKey}`}
                      >
                        {view.name}
                      </Button>
                      {!view.isBuiltIn ? (
                        <button
                          type="button"
                          className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50"
                          onClick={() => void removeView(view.viewKey)}
                          aria-label={`Delete ${view.name}`}
                        >
                          x
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div data-testid="command-center-owner-workload">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Owner workload
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Derived from the actionable queue without extra write paths.
                </p>
              </div>
              <ListChecks className="h-4 w-4 text-slate-500" />
            </div>
            <div className="mt-3 space-y-2">
              {(payload?.ownerWorkload ?? []).slice(0, 4).map((owner) => (
                <div
                  key={owner.ownerUserId ?? "unassigned"}
                  className={cn(
                    "rounded-2xl border px-3 py-3",
                    resolveOwnerWorkloadTone(owner),
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-950">{owner.ownerName}</p>
                    <Badge variant="outline">{owner.openCount} open</Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-600">
                    <span>{owner.overdueCount} overdue</span>
                    <span>{owner.highPriorityCount} high-priority</span>
                    <span>{owner.budgetedCount} budgeted</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 xl:grid-cols-[1fr_auto]">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Source</Badge>
            {(["all", "meta", "creative"] as SourceFilter[]).map((value) => (
              <Button
                key={value}
                variant={sourceFilter === value ? "default" : "outline"}
                size="sm"
                onClick={() => setSourceFilter(value)}
              >
                {value}
              </Button>
            ))}
            <Badge variant="outline">Status</Badge>
            {STATUS_OPTIONS.map((value) => (
              <Button
                key={value}
                variant={statusFilter === value ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter(value)}
              >
                {formatActionLabel(value)}
              </Button>
            ))}
            <Button
              variant={watchlistOnly ? "default" : "outline"}
              size="sm"
              onClick={() => setWatchlistOnly((current) => !current)}
            >
              Watchlist only
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
              placeholder="Save current view"
              className="h-9 rounded-md border border-slate-200 px-3 text-sm"
            />
            <Button size="sm" onClick={() => void saveCurrentView()} disabled={!canEdit || !viewName.trim()}>
              Save view
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.45fr_0.95fr]">
        <div className="space-y-5">
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-950">
                  {selectedView ? "Action queue" : "Default queue"}
                </h2>
                <p className="text-xs text-slate-500">
                  {filteredActions.length} visible actions
                </p>
              </div>
              <Badge variant="outline">
                {selectedView ? "saved-view filter" : "throughput-capped default"}
              </Badge>
            </div>

            <div className="mb-4 grid gap-3 lg:grid-cols-[1.1fr_0.9fr]">
              <div
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                data-testid="command-center-batch-toolbar"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                      Batch review
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      Only eligible workload classes stay inside the retry-safe batch subset.
                    </p>
                  </div>
                  <Badge variant="outline">{batchSelection.length} selected</Badge>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  {batchEligibleVisibleCount} visible action(s) are batch-ready in this queue.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => void runBatchMutation("approve")}
                    disabled={!canEdit || pending || batchSelection.length === 0}
                  >
                    Batch approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void runBatchMutation("reject")}
                    disabled={!canEdit || pending || batchSelection.length === 0}
                  >
                    Batch reject
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void runBatchMutation("reopen")}
                    disabled={!canEdit || pending || batchSelection.length === 0}
                  >
                    Batch reopen
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void runBatchMutation("complete_manual")}
                    disabled={!canEdit || pending || batchSelection.length === 0}
                  >
                    Batch complete
                  </Button>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                      Queue-gap feedback
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      Report missing work when the queue misses a real operator action.
                    </p>
                  </div>
                  <AlertTriangle className="h-4 w-4 text-slate-500" />
                </div>
                <textarea
                  value={queueGapNoteDraft}
                  onChange={(event) => setQueueGapNoteDraft(event.target.value)}
                  placeholder="What action is missing from this queue?"
                  className="mt-3 min-h-[80px] w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  disabled={!canEdit || pending}
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-[11px] text-slate-500">
                    Scope: {activeViewKey ?? "default_queue"} · {sourceFilter}
                  </p>
                  <Button
                    size="sm"
                    onClick={() => void submitQueueGapFeedback()}
                    disabled={!canEdit || pending || !queueGapNoteDraft.trim()}
                  >
                    Report missing action
                  </Button>
                </div>
              </div>
            </div>

            {query.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="h-28 animate-pulse rounded-2xl bg-slate-100" />
                ))}
              </div>
            ) : filteredActions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
                {selectedView
                  ? "No actions match this view."
                  : "No action-core items are ready in this window."}
              </div>
            ) : (
              <div className="space-y-3">
                {filteredActions.map((action) => (
                  <ActionCard
                    key={action.actionFingerprint}
                    action={action}
                    active={action.actionFingerprint === selectedActionFingerprint}
                    selectedForBatch={batchSelection.includes(action.actionFingerprint)}
                    canBatchEdit={canEdit && action.batchReviewEligible}
                    onToggleBatchSelection={() =>
                      toggleBatchSelection(action.actionFingerprint)
                    }
                    onSelect={() => {
                      setSelectedActionFingerprint(action.actionFingerprint);
                      setExecutionSheetOpen(true);
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" data-testid="command-center-handoffs">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-950">Shift handoff</h2>
                <p className="text-xs text-slate-500">
                  Morning/evening notes for the next operator.
                </p>
              </div>
              <Badge variant="outline">team-shared</Badge>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-sm text-slate-700">
                <span className="text-xs font-medium text-slate-500">Shift</span>
                <select
                  value={handoffShift}
                  onChange={(event) => setHandoffShift(event.target.value as "morning" | "evening")}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3"
                >
                  <option value="morning">Morning</option>
                  <option value="evening">Evening</option>
                </select>
              </label>
              <label className="space-y-1 text-sm text-slate-700">
                <span className="text-xs font-medium text-slate-500">To user</span>
                <select
                  value={handoffToUserId}
                  onChange={(event) => setHandoffToUserId(event.target.value)}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3"
                >
                  <option value="">Unassigned</option>
                  {(payload?.assignableUsers ?? []).map((user) => (
                    <option key={user.userId} value={user.userId}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-slate-500">
                  Prefill from current shift digest to keep handoff wording aligned.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={prefillHandoffFromDigest}
                  disabled={!payload}
                >
                  Prefill from digest
                </Button>
              </div>
              <textarea
                value={handoffSummary}
                onChange={(event) => setHandoffSummary(event.target.value)}
                placeholder="Summary for the next shift"
                className="min-h-[84px] w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                disabled={!canEdit || pending}
              />
              <div className="grid gap-3 md:grid-cols-2">
                <input
                  value={handoffBlockers}
                  onChange={(event) => setHandoffBlockers(event.target.value)}
                  placeholder="Blockers, comma-separated"
                  className="h-10 rounded-md border border-slate-200 px-3 text-sm"
                  disabled={!canEdit || pending}
                />
                <input
                  value={handoffWatchouts}
                  onChange={(event) => setHandoffWatchouts(event.target.value)}
                  placeholder="Watchouts, comma-separated"
                  className="h-10 rounded-md border border-slate-200 px-3 text-sm"
                  disabled={!canEdit || pending}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (
                      selectedAction &&
                      !linkedHandoffActions.includes(selectedAction.actionFingerprint)
                    ) {
                      setLinkedHandoffActions((current) => [
                        ...current,
                        selectedAction.actionFingerprint,
                      ]);
                    }
                  }}
                  disabled={!canEdit || pending || !selectedAction}
                >
                  Link selected action
                </Button>
                {linkedHandoffActions.length > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLinkedHandoffActions([])}
                    disabled={!canEdit || pending}
                  >
                    Clear linked actions
                  </Button>
                ) : null}
                {linkedHandoffActions.map((fingerprint) => (
                  <Badge key={fingerprint} variant="outline">
                    {fingerprint.slice(0, 12)}
                  </Badge>
                ))}
              </div>
              <Button onClick={() => void submitHandoff()} disabled={!canEdit || pending || !handoffSummary.trim()}>
                Save handoff
              </Button>
            </div>

            <div className="mt-5 space-y-3">
              {(payload?.handoffs ?? []).map((handoff) => (
                <div
                  key={handoff.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                  data-testid={`command-center-handoff-${handoff.id}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">
                        {handoff.shift} shift
                      </p>
                      <p className="mt-1 text-xs text-slate-600">{handoff.summary}</p>
                    </div>
                    <div className="text-right text-[11px] text-slate-500">
                      <p>From {handoff.fromUserName ?? "Unknown"}</p>
                      {handoff.toUserName ? <p>To {handoff.toUserName}</p> : null}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
                    {handoff.blockers.map((item) => (
                      <Badge key={item} variant="outline">
                        blocker: {item}
                      </Badge>
                    ))}
                    {handoff.watchouts.map((item) => (
                      <Badge key={item} variant="outline">
                        watch: {item}
                      </Badge>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="text-[11px] text-slate-500">
                      {handoff.acknowledgedAt
                        ? `Acknowledged by ${handoff.acknowledgedByUserName ?? "operator"}`
                        : "Awaiting acknowledgement"}
                    </div>
                    {!handoff.acknowledgedAt ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void acknowledgeHandoff(handoff)}
                        disabled={!canEdit || pending}
                      >
                        Acknowledge
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-5">
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" data-testid="command-center-journal">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-950">Decision journal</h2>
                <p className="text-xs text-slate-500">
                  Immutable operator history across approvals, notes, and handoffs.
                </p>
              </div>
              <NotebookPen className="h-4 w-4 text-slate-500" />
            </div>

            <div className="space-y-3">
              {(payload?.journal ?? []).map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                  data-testid={`command-center-journal-${entry.id}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{entry.message}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {entry.actionTitle} · {entry.actorName ?? entry.actorEmail ?? "Operator"}
                      </p>
                    </div>
                    <Badge variant="outline">{formatActionLabel(entry.eventType)}</Badge>
                  </div>
                  {entry.note ? (
                    <p className="mt-2 text-xs leading-5 text-slate-600">{entry.note}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-950">Overflow backlog</h2>
                <p className="text-xs text-slate-500">
                  Actionable items waiting behind today&apos;s default queue budget.
                </p>
              </div>
              <Badge variant="outline">{overflowBacklogActions.length}</Badge>
            </div>
            <div className="space-y-3">
              {overflowBacklogActions.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500">
                  No overflow items are waiting behind the current queue budget.
                </div>
              ) : (
                overflowBacklogActions.map((action) => (
                  <div key={action.actionFingerprint} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-slate-900">{action.title}</p>
                      <Badge
                        variant="outline"
                        className="border-amber-200 bg-amber-50 text-amber-700"
                      >
                        {formatWorkloadClass(action.workloadClass)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">{action.summary}</p>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-950">Watchlist</h2>
                <p className="text-xs text-slate-500">
                  Deterministic surfaces kept out of the default queue.
                </p>
              </div>
              <Badge variant="outline">{watchlistActions.length}</Badge>
            </div>
            <div className="space-y-3">
              {watchlistActions.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500">
                  No watchlist items are active.
                </div>
              ) : (
                watchlistActions.map((action) => (
                  <div key={action.actionFingerprint} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-slate-900">{action.title}</p>
                      <Badge
                        variant="outline"
                        className={cn(
                          "capitalize",
                          resolveDispositionTone(action.operatorDisposition),
                        )}
                      >
                        {formatActionLabel(action.operatorDisposition)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">{action.summary}</p>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-950">Archive context</h2>
                <p className="text-xs text-slate-500">
                  Inactive or immaterial rows retained for operator context.
                </p>
              </div>
              <Badge variant="outline">{archiveContextActions.length}</Badge>
            </div>
            <div className="space-y-3">
              {archiveContextActions.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500">
                  No archive-context rows are attached to this window.
                </div>
              ) : (
                archiveContextActions.map((action) => (
                  <div key={action.actionFingerprint} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-slate-900">{action.title}</p>
                      <Badge
                        variant="outline"
                        className={cn(
                          "capitalize",
                          resolveSurfaceLaneTone(action.surfaceLane),
                        )}
                      >
                        {formatSurfaceLane(action.surfaceLane)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">{action.summary}</p>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>

      <Sheet
        modal={false}
        open={Boolean(selectedAction) && executionSheetOpen}
        onOpenChange={setExecutionSheetOpen}
      >
        <SheetContent className="w-full sm:max-w-2xl" showOverlay={false}>
          {selectedAction ? (
            <>
              <SheetHeader className="border-b border-slate-200">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn("capitalize", resolveStatusTone(selectedAction.status))}
                  >
                    {formatActionLabel(selectedAction.status)}
                  </Badge>
                  <Badge variant="outline">{selectedAction.sourceContext.sourceLabel}</Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      "capitalize",
                      resolveSurfaceLaneTone(selectedAction.surfaceLane),
                    )}
                  >
                    {formatSurfaceLane(selectedAction.surfaceLane)}
                  </Badge>
                  {selectedAction.operatorDisposition !== "standard" ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        "capitalize",
                        resolveDispositionTone(selectedAction.operatorDisposition),
                      )}
                    >
                      {formatActionLabel(selectedAction.operatorDisposition)}
                    </Badge>
                  ) : null}
                  {selectedAction.sourceContext.operatingMode ? (
                    <Badge variant="outline">
                      Operating Mode: {selectedAction.sourceContext.operatingMode}
                    </Badge>
                  ) : null}
                  <Badge
                    variant="outline"
                    className={cn(
                      "capitalize",
                      resolveQueueSectionTone(selectedAction.queueSection),
                    )}
                  >
                    {formatQueueSection(selectedAction.queueSection)}
                  </Badge>
                  <Badge variant="outline" className="capitalize">
                    {formatWorkloadClass(selectedAction.workloadClass)}
                  </Badge>
                </div>
                <SheetTitle className="mt-2 text-xl">{selectedAction.title}</SheetTitle>
                <SheetDescription className="text-sm">
                  {selectedAction.operatorInstruction?.headline ??
                    `${formatActionLabel(selectedAction.recommendedAction)} · ${selectedAction.summary}`}
                </SheetDescription>
                {payload ? (
                  <p className="text-xs text-slate-500">
                    Decisions use live windows. Selected period affects analysis only.
                  </p>
                ) : null}
              </SheetHeader>

              <div className="space-y-5 overflow-y-auto p-4">
                <section className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Operator instruction
                      </p>
                      <p className="mt-1 text-sm font-semibold text-slate-950">
                        {selectedAction.operatorInstruction?.primaryMove ??
                          formatActionLabel(selectedAction.recommendedAction)}
                      </p>
                    </div>
                    <div className="text-right text-xs text-slate-500">
                      <p>{Math.round(selectedAction.confidence * 100)}% confidence</p>
                      <p className="capitalize">{selectedAction.priority} priority</p>
                    </div>
                  </div>
                  {selectedAction.truthState === "degraded_missing_truth" ? (
                    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Commercial truth is incomplete, so this recommendation is
                      limited to a review-safe disposition.
                    </div>
                  ) : null}
                  {selectedAction.operatorInstruction ? (
                    <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-2">
                      <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                          Why now
                        </p>
                        <p className="mt-1">{selectedAction.operatorInstruction.reasonSummary}</p>
                      </div>
                      <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                          Amount
                        </p>
                        <p className="mt-1">
                          {selectedAction.operatorInstruction.amountGuidance.label}
                        </p>
                      </div>
                      <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                          Target
                        </p>
                        <p className="mt-1">{selectedAction.operatorInstruction.targetContext.label}</p>
                      </div>
                      <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                          Urgency
                        </p>
                        <p className="mt-1 capitalize">{selectedAction.operatorInstruction.urgency}</p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {selectedAction.operatorInstruction.urgencyReason}
                        </p>
                      </div>
                      {selectedAction.operatorInstruction.nextObservation[0] ? (
                        <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 md:col-span-2">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Watch next
                          </p>
                          <p className="mt-1">{selectedAction.operatorInstruction.nextObservation[0]}</p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge variant="outline" className="capitalize">
                      queue: {formatQueueSection(selectedAction.queueSection)}
                    </Badge>
                    <Badge variant="outline" className="capitalize">
                      workload: {formatWorkloadClass(selectedAction.workloadClass)}
                    </Badge>
                    {selectedAction.batchReviewEligible ? (
                      <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                        batch-ready
                        {selectedAction.batchReviewClass
                          ? ` · ${formatActionLabel(selectedAction.batchReviewClass)}`
                          : ""}
                      </Badge>
                    ) : null}
                    {selectedAction.relatedEntities.map((entity) => (
                      <Badge key={`${entity.type}:${entity.id}`} variant="outline">
                        {entity.type}: {entity.label}
                      </Badge>
                    ))}
                  </div>
                  {selectedAction.calibrationHint ? (
                    <p className="mt-3 text-xs text-slate-600">
                      Calibration hint: {selectedAction.calibrationHint.channel}
                      {selectedAction.calibrationHint.objectiveFamily
                        ? ` · ${selectedAction.calibrationHint.objectiveFamily}`
                        : ""}
                      {selectedAction.calibrationHint.bidRegime
                        ? ` · ${selectedAction.calibrationHint.bidRegime}`
                        : ""}
                      {selectedAction.calibrationHint.archetype
                        ? ` · ${selectedAction.calibrationHint.archetype}`
                        : ""}
                      {selectedAction.calibrationHint.matchedProfileKey
                        ? ` · matched ${selectedAction.calibrationHint.matchedProfileKey}`
                        : ""}
                    </p>
                  ) : null}
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Decision Signals
                  </p>
                  <ul className="mt-3 space-y-2 text-sm text-slate-700">
                    {selectedAction.decisionSignals.map((signal) => (
                      <li key={signal} className="rounded-xl bg-slate-50 px-3 py-2">
                        {signal}
                      </li>
                    ))}
                  </ul>
                </section>

                {selectedAction.policyExplanation ? (
                  <DecisionPolicyExplanationPanel
                    explanation={selectedAction.policyExplanation}
                    title="Policy Review"
                  />
                ) : null}

                <section className="rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Evidence Snapshot
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selectedAction.evidence.map((item) => (
                      <div
                        key={`${item.label}:${item.value}`}
                        className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
                      >
                        <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                          {item.label}
                        </p>
                        <p className="text-sm font-semibold text-slate-900">{item.value}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Guardrails
                  </p>
                  <ul className="mt-3 space-y-2 text-sm text-slate-700">
                    {selectedAction.guardrails.length > 0 ? (
                      selectedAction.guardrails.map((guardrail) => (
                        <li key={guardrail} className="rounded-xl bg-slate-50 px-3 py-2">
                          {guardrail}
                        </li>
                      ))
                    ) : (
                      <li className="rounded-xl bg-slate-50 px-3 py-2 text-slate-500">
                        No additional guardrails attached to this action.
                      </li>
                    )}
                  </ul>
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                      Workflow
                    </p>
                    <Button asChild size="sm" variant="outline">
                      <Link href={selectedAction.sourceContext.sourceDeepLink}>
                        Open source surface
                      </Link>
                    </Button>
                  </div>

                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <label className="space-y-1 text-sm text-slate-700">
                      <span className="text-xs font-medium text-slate-500">Assign to</span>
                      <select
                        value={selectedAction.assigneeUserId ?? ""}
                        onChange={(event) =>
                          void runMutation({
                            mutation: "assign",
                            assigneeUserId: event.target.value || null,
                          })
                        }
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3"
                        disabled={!canEdit || pending}
                      >
                        <option value="">Unassigned</option>
                        {(payload?.assignableUsers ?? []).map((user) => (
                          <option key={user.userId} value={user.userId}>
                            {user.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-sm text-slate-700">
                      <span className="text-xs font-medium text-slate-500">Snooze until</span>
                      <div className="flex gap-2">
                        <input
                          type="datetime-local"
                          className="h-9 flex-1 rounded-md border border-slate-200 px-3 text-sm"
                          onChange={(event) => {
                            const nextValue = event.target.value
                              ? new Date(event.target.value).toISOString()
                              : null;
                            if (nextValue) {
                              void runMutation({
                                mutation: "snooze",
                                snoozeUntil: nextValue,
                              });
                            }
                          }}
                          disabled={!canEdit || pending}
                        />
                      </div>
                    </label>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void runMutation({ mutation: "approve" })} disabled={!canEdit || pending}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void runMutation({ mutation: "reject" })} disabled={!canEdit || pending}>
                      Reject
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void runMutation({ mutation: "reopen" })} disabled={!canEdit || pending}>
                      Reopen
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void runMutation({ mutation: "complete_manual" })} disabled={!canEdit || pending}>
                      Complete manual
                    </Button>
                  </div>
                </section>

                <section
                  className="rounded-2xl border border-slate-200 bg-white p-4"
                  data-testid="command-center-execution-panel"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Execution
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        Preview first, apply second. Unsupported or manual-only paths stay explicit.
                      </p>
                    </div>
                    {executionQuery.data ? (
                      <div className="flex flex-wrap gap-2">
                        <Badge
                          variant="outline"
                          className={resolveExecutionSupportTone(
                            executionQuery.data.supportMode,
                          )}
                          data-testid="command-center-execution-support-mode"
                        >
                          {formatActionLabel(executionQuery.data.supportMode)}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={resolveExecutionStatusTone(executionQuery.data.status)}
                        >
                          {formatActionLabel(executionQuery.data.status)}
                        </Badge>
                      </div>
                    ) : null}
                  </div>

                  {executionQuery.isLoading ? (
                    <div className="mt-4 h-28 animate-pulse rounded-2xl bg-slate-100" />
                  ) : executionQuery.error ? (
                    <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
                      {executionQuery.error instanceof Error
                        ? executionQuery.error.message
                        : "Execution preview failed."}
                    </div>
                  ) : executionQuery.data ? (
                    <div className="mt-4 space-y-4">
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                            Current state
                          </p>
                          <div className="mt-2 space-y-1 text-sm text-slate-700">
                            <p>Status: {executionQuery.data.currentState?.status ?? "Unavailable"}</p>
                            <p>
                              Daily budget:{" "}
                              {executionQuery.data.currentState?.dailyBudget != null
                                ? `$${Math.round(
                                    executionQuery.data.currentState.dailyBudget,
                                  )}`
                                : "Unavailable"}
                            </p>
                            <p>
                              Budget level:{" "}
                              {executionQuery.data.currentState?.budgetLevel ?? "Unavailable"}
                            </p>
                          </div>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                            Requested state
                          </p>
                          <div className="mt-2 space-y-1 text-sm text-slate-700">
                            <p>
                              Status: {executionQuery.data.requestedState?.status ?? "Unavailable"}
                            </p>
                            <p>
                              Daily budget:{" "}
                              {executionQuery.data.requestedState?.dailyBudget != null
                                ? `$${Math.round(
                                    executionQuery.data.requestedState.dailyBudget,
                                  )}`
                                : "Unavailable"}
                            </p>
                            <p>
                              Rollback: {formatActionLabel(executionQuery.data.rollback.kind)}
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Preview diff
                        </p>
                        <div className="mt-3 space-y-2" data-testid="command-center-execution-diff">
                          {executionQuery.data.diff.map((item) => (
                            <div
                              key={`${item.key}:${item.currentValue}:${item.requestedValue}`}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                            >
                              <p className="font-medium text-slate-900">{item.label}</p>
                              <p className="mt-1 text-xs text-slate-500">
                                {item.currentValue} → {item.requestedValue}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Approval and permissions
                        </p>
                        <div className="mt-2 space-y-1">
                          <p>
                            Workflow status:{" "}
                            {formatActionLabel(executionQuery.data.approval.workflowStatus)}
                          </p>
                          <p>
                            Approved by:{" "}
                            {executionQuery.data.approval.approvedByName ??
                              executionQuery.data.approval.approvedByEmail ??
                              "Pending approval"}
                          </p>
                          {executionQuery.data.permission.reason ? (
                            <p className="text-amber-700">
                              Apply gate: {executionQuery.data.permission.reason}
                            </p>
                          ) : (
                            <p className="text-emerald-700">Apply gate: ready</p>
                          )}
                          {executionQuery.data.permission.rollbackReason ? (
                            <p className="text-slate-600">
                              Rollback: {executionQuery.data.permission.rollbackReason}
                            </p>
                          ) : (
                            <p className="text-emerald-700">Rollback: available</p>
                          )}
                          <p className="text-slate-600">
                            Rollback truth:{" "}
                            {executionQuery.data.rollback.note ??
                              "No rollback note is available for this action."}
                          </p>
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                            Capability registry
                          </p>
                          <div className="mt-2 space-y-1">
                            <p>Capability: {executionQuery.data.capability.capabilityKey}</p>
                            <p>Provider: {executionQuery.data.capability.provider}</p>
                            <p>Target: {executionQuery.data.capability.targetType}</p>
                            <p>
                              Apply / rollback proof:{" "}
                              {formatActionLabel(
                                executionQuery.data.capability.applyProofLevel,
                              )}{" "}
                              /{" "}
                              {formatActionLabel(
                                executionQuery.data.capability.rollbackProofLevel,
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                            Latest validation
                          </p>
                          <div className="mt-2 space-y-1">
                            <p>
                              Status:{" "}
                              {executionQuery.data.latestValidation
                                ? formatActionLabel(executionQuery.data.latestValidation.status)
                                : "not run"}
                            </p>
                            <p>
                              Checked at:{" "}
                              {executionQuery.data.latestValidation?.checkedAt ?? "Not available"}
                            </p>
                            {executionQuery.data.latestValidation?.mismatchReasons?.length ? (
                              <p className="text-rose-700">
                                {executionQuery.data.latestValidation.mismatchReasons[0]}
                              </p>
                            ) : (
                              <p className="text-slate-600">
                                The latest validated apply or rollback artifact is shown here when available.
                              </p>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Preflight checks
                        </p>
                        <div className="mt-3 space-y-2">
                          {executionQuery.data.preflight.checks.map((check) => (
                            <div
                              key={check.key}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="font-medium text-slate-900">{check.label}</p>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    check.status === "pass"
                                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                      : check.status === "warn"
                                        ? "border-amber-200 bg-amber-50 text-amber-700"
                                        : "border-rose-200 bg-rose-50 text-rose-700",
                                  )}
                                >
                                  {check.status}
                                </Badge>
                              </div>
                              <p className="mt-1 text-xs text-slate-500">{check.detail}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Canary preflight
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {executionQuery.data.canaryPreflight.ready
                            ? "Live canary prerequisites are satisfied for the current supported action."
                            : "Live canary proof is still blocked by runtime or operator env requirements."}
                        </p>
                        <div className="mt-3 space-y-2">
                          {executionQuery.data.canaryPreflight.checks.map((check) => (
                            <div
                              key={check.key}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="font-medium text-slate-900">{check.label}</p>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    check.status === "pass"
                                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                      : "border-rose-200 bg-rose-50 text-rose-700",
                                  )}
                                >
                                  {check.status}
                                </Badge>
                              </div>
                              <p className="mt-1 text-xs text-slate-500">{check.detail}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      <CommandCenterExecutionSupportMatrix
                        preview={executionQuery.data}
                      />

                      {executionQuery.data.providerDiffEvidence ? (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                            Provider diff evidence
                          </p>
                          <div className="mt-2 space-y-1 text-sm text-slate-700">
                            <p>Observed at: {executionQuery.data.providerDiffEvidence.observedAt}</p>
                            <p>
                              Target: {executionQuery.data.providerDiffEvidence.targetId ?? "Unavailable"}
                            </p>
                            <p>
                              Requested state matched:{" "}
                              {executionQuery.data.providerDiffEvidence.matchedRequestedState
                                ? "yes"
                                : "no"}
                            </p>
                          </div>
                          <div className="mt-3 grid gap-3 md:grid-cols-2">
                            <div>
                              <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
                                Provider change
                              </p>
                              <div className="mt-2 space-y-2">
                                {executionQuery.data.providerDiffEvidence.providerChangeDiff.map((item) => (
                                  <div
                                    key={`provider-${item.key}-${item.currentValue}-${item.requestedValue}`}
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                                  >
                                    <p className="font-medium text-slate-900">{item.label}</p>
                                    <p className="mt-1 text-xs text-slate-500">
                                      {item.currentValue} → {item.requestedValue}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div>
                              <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
                                Remaining drift
                              </p>
                              <div className="mt-2 space-y-2">
                                {executionQuery.data.providerDiffEvidence.remainingDriftDiff.map((item) => (
                                  <div
                                    key={`drift-${item.key}-${item.currentValue}-${item.requestedValue}`}
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                                  >
                                    <p className="font-medium text-slate-900">{item.label}</p>
                                    <p className="mt-1 text-xs text-slate-500">
                                      {item.currentValue} → {item.requestedValue}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {executionQuery.data.prerequisites.length > 0 ? (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                            Prerequisites
                          </p>
                          <ul className="mt-2 space-y-1 text-sm text-slate-700">
                            {executionQuery.data.prerequisites.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {executionQuery.data.risks.length > 0 ? (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                            Risks
                          </p>
                          <ul className="mt-2 space-y-1 text-sm text-slate-700">
                            {executionQuery.data.risks.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {executionQuery.data.manualInstructions.length > 0 ? (
                        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-800">
                            Manual instructions
                          </p>
                          <ul className="mt-2 space-y-1 text-sm text-amber-900">
                            {executionQuery.data.manualInstructions.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => void runExecutionApply()}
                          disabled={
                            pending ||
                            !executionQuery.data.permission.canApply ||
                            executionQuery.data.supportMode !== "supported"
                          }
                          data-testid="command-center-execution-apply"
                        >
                          Apply
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void runExecutionRollback()}
                          disabled={pending || !executionQuery.data.permission.canRollback}
                          data-testid="command-center-execution-rollback"
                        >
                          Rollback
                        </Button>
                      </div>

                      <div
                        className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3"
                        data-testid="command-center-execution-audit"
                      >
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Execution audit trail
                        </p>
                        <div className="mt-3 space-y-2">
                          {executionQuery.data.auditTrail.length === 0 ? (
                            <p className="text-sm text-slate-500">
                              No execution audit entries yet.
                            </p>
                          ) : (
                            executionQuery.data.auditTrail.map((entry) => (
                              <div
                                key={entry.id}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="font-medium text-slate-900">
                                    {formatActionLabel(entry.operation)} ·{" "}
                                    {formatActionLabel(entry.executionStatus)}
                                  </p>
                                  <Badge variant="outline">
                                    {formatActionLabel(entry.approvalStatus)}
                                  </Badge>
                                </div>
                                {entry.blockedReason ? (
                                  <p className="mt-1 text-xs text-rose-700">
                                    {entry.blockedReason}
                                  </p>
                                ) : null}
                                {entry.validationStatus ? (
                                  <p className="mt-1 text-xs text-slate-600">
                                    Validation: {formatActionLabel(entry.validationStatus)}
                                  </p>
                                ) : null}
                                {entry.preflightBlockingChecks.length > 0 ? (
                                  <p className="mt-1 text-xs text-amber-700">
                                    Blocked: {entry.preflightBlockingChecks[0]}
                                  </p>
                                ) : null}
                                <p className="mt-1 text-xs text-slate-500">
                                  {entry.createdAt}
                                </p>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Notes
                  </p>
                  <textarea
                    value={noteDraft}
                    onChange={(event) => setNoteDraft(event.target.value)}
                    placeholder="Add operator context, blockers, or approval rationale"
                    className="mt-3 min-h-[110px] w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  />
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="text-xs text-slate-500">
                      {selectedAction.latestNoteExcerpt
                        ? `Latest note: ${selectedAction.latestNoteExcerpt}`
                        : "No notes yet."}
                    </div>
                    <Button size="sm" onClick={() => void submitNote()} disabled={!canEdit || pending || !noteDraft.trim()}>
                      Add note
                    </Button>
                  </div>
                </section>

                <section
                  className="rounded-2xl border border-slate-200 bg-white p-4"
                  data-testid="command-center-action-feedback"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Feedback
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        Capture operator disagreement without changing deterministic provenance.
                      </p>
                    </div>
                    <Badge variant="outline">
                      {selectedFeedbackEntries.length} recent
                    </Badge>
                  </div>
                  <textarea
                    value={feedbackNoteDraft}
                    onChange={(event) => setFeedbackNoteDraft(event.target.value)}
                    placeholder="Why was this a false positive or bad recommendation?"
                    className="mt-3 min-h-[96px] w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    disabled={!canEdit || pending}
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void submitActionFeedback("false_positive")}
                      disabled={!canEdit || pending || !feedbackNoteDraft.trim()}
                    >
                      Mark false positive
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void submitActionFeedback("bad_recommendation")}
                      disabled={!canEdit || pending || !feedbackNoteDraft.trim()}
                    >
                      Mark bad recommendation
                    </Button>
                  </div>
                  <div className="mt-4 space-y-2">
                    {selectedFeedbackEntries.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-200 px-3 py-3 text-xs text-slate-500">
                        No feedback captured for this action yet.
                      </div>
                    ) : (
                      selectedFeedbackEntries.slice(0, 5).map((entry) => (
                        <div
                          key={entry.id}
                          className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">
                                {formatActionLabel(entry.feedbackType)}
                              </Badge>
                              <Badge variant="outline">
                                {formatActionLabel(entry.outcome)}
                              </Badge>
                              {entry.workloadClass ? (
                                <Badge variant="outline" className="capitalize">
                                  {formatWorkloadClass(entry.workloadClass)}
                                </Badge>
                              ) : null}
                            </div>
                            <p className="text-[11px] text-slate-500">
                              {entry.actorName ?? entry.actorEmail ?? "Operator"} ·{" "}
                              {entry.createdAt}
                            </p>
                          </div>
                          <p className="mt-2 text-sm text-slate-700">{entry.note}</p>
                          {entry.calibrationHint ? (
                            <p className="mt-2 text-[11px] text-slate-500">
                              Calibration: {entry.calibrationHint.channel}
                              {entry.calibrationHint.matchedProfileKey
                                ? ` · ${entry.calibrationHint.matchedProfileKey}`
                                : ""}
                            </p>
                          ) : null}
                        </div>
                      ))
                    )}
                  </div>
                </section>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
