"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  History,
  Loader2,
  PauseCircle,
  PlayCircle,
} from "lucide-react";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";

type ManualAction = "pause" | "resume";
export type DuplicateProgress = "idle" | "submitting" | "verifying" | "success" | "error";

interface CreativeAdActionsSectionProps {
  businessId: string;
  row: MetaCreativeRow;
  open: boolean;
  initialDuplicateOpen?: boolean;
}

interface CampaignPickerRow {
  id: string;
  name: string;
  status: string;
}

interface AdsetPickerRow {
  id: string;
  name: string;
  campaignId: string;
  status: string;
}

interface ActionHistoryRow {
  id: string;
  action: "pause" | "resume" | "duplicate";
  status: "pending" | "success" | "failure" | "silent_failure";
  requestedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  resultingAdId: string | null;
}

interface ActionResponse {
  ok: boolean;
  status?: string;
  newAdId?: string;
  adsManagerUrl?: string;
  error?: {
    code?: string;
    message?: string;
    existingAdId?: string;
  };
}

export function CreativeAdActionsSection({
  businessId,
  row,
  open,
  initialDuplicateOpen = false,
}: CreativeAdActionsSectionProps) {
  const queryClient = useQueryClient();
  const [localStatus, setLocalStatus] = useState(
    normalizeStatus(row.effectiveStatus),
  );
  const [confirmAction, setConfirmAction] = useState<ManualAction | null>(null);
  const [pendingAction, setPendingAction] = useState<ManualAction | null>(null);
  const [duplicateOpen, setDuplicateOpen] = useState(initialDuplicateOpen);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [selectedAdsetId, setSelectedAdsetId] = useState("");
  const [nameOverride, setNameOverride] = useState(`${row.name} (copy)`);
  const [activateAfterCreate, setActivateAfterCreate] = useState(false);
  const [duplicateProgress, setDuplicateProgress] = useState<DuplicateProgress>("idle");
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null);
  const [duplicateResult, setDuplicateResult] = useState<{
    newAdId: string;
    adsManagerUrl: string | null;
  } | null>(null);
  const [toast, setToast] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const adId = resolveManualAdActionId(row);
  const actionsQueryKey = ["meta-ad-actions", businessId, adId] as const;

  useEffect(() => {
    setLocalStatus(normalizeStatus(row.effectiveStatus));
    setConfirmAction(null);
    setPendingAction(null);
    setDuplicateOpen(false);
    setDuplicateProgress("idle");
    setDuplicateMessage(null);
    setDuplicateResult(null);
    setSelectedCampaignId("");
    setSelectedAdsetId("");
    setNameOverride(`${row.name} (copy)`);
    setActivateAfterCreate(false);
  }, [row.effectiveStatus, adId, row.name]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const campaignsQuery = useQuery({
    queryKey: ["meta-action-campaigns", businessId],
    enabled: open && Boolean(businessId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () => fetchCampaigns(businessId),
  });

  const adsetsQuery = useQuery({
    queryKey: ["meta-action-adsets", businessId],
    enabled: open && Boolean(businessId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () => fetchAdsets(businessId),
  });

  const historyQuery = useQuery({
    queryKey: actionsQueryKey,
    enabled: open && Boolean(businessId) && Boolean(adId),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () => fetchActionHistory({ businessId, adId }),
  });

  const activeCampaigns = useMemo(
    () =>
      (campaignsQuery.data ?? []).filter(
        (campaign) => normalizeStatus(campaign.status) === "ACTIVE",
      ),
    [campaignsQuery.data],
  );
  const selectedCampaignAdsets = useMemo(
    () =>
      (adsetsQuery.data ?? []).filter(
        (adset) =>
          adset.campaignId === selectedCampaignId &&
          normalizeStatus(adset.status) === "ACTIVE",
      ),
    [adsetsQuery.data, selectedCampaignId],
  );

  const canPause = localStatus === "ACTIVE" && !pendingAction;
  const canResume = localStatus === "PAUSED" && !pendingAction;
  const duplicateConfirmDisabled = isDuplicateConfirmDisabled({
    selectedCampaignId,
    selectedAdsetId,
    progress: duplicateProgress,
  });

  async function runStatusAction(action: ManualAction) {
    const previousStatus = localStatus;
    const optimisticStatus = action === "pause" ? "PAUSED" : "ACTIVE";
    setConfirmAction(null);
    setPendingAction(action);
    setLocalStatus(optimisticStatus);

    const result = await postAction({
      adId,
      action,
      body: { businessId },
    });

    setPendingAction(null);
    void queryClient.invalidateQueries({ queryKey: actionsQueryKey });

    if (!result.ok) {
      setLocalStatus(previousStatus);
      setToast({
        type: "error",
        message: formatActionError(result, `Could not ${action} ad.`),
      });
      return;
    }

    setLocalStatus(normalizeStatus(result.status ?? optimisticStatus));
    setToast({
      type: "success",
      message: action === "pause" ? "Ad paused on Meta." : "Ad resumed on Meta.",
    });
  }

  async function runDuplicate() {
    if (duplicateConfirmDisabled) return;
    setDuplicateProgress("submitting");
    setDuplicateMessage("Submitting to Meta...");
    setDuplicateResult(null);
    const verifyingTimer = window.setTimeout(() => {
      setDuplicateProgress("verifying");
      setDuplicateMessage("Verifying ad creation...");
    }, 600);

    const result = await postAction({
      adId,
      action: "duplicate",
      body: buildDuplicateActionBody({
        businessId,
        targetAdsetId: selectedAdsetId,
        nameOverride,
        activateAfterCreate,
      }),
    });
    window.clearTimeout(verifyingTimer);
    void queryClient.invalidateQueries({ queryKey: actionsQueryKey });

    if (!result.ok || !result.newAdId) {
      setDuplicateProgress("error");
      setDuplicateMessage(formatActionError(result, "Could not duplicate ad."));
      setToast({
        type: "error",
        message: formatActionError(result, "Could not duplicate ad."),
      });
      return;
    }

    setDuplicateProgress("success");
    setDuplicateMessage("Ad created and verified.");
    setDuplicateResult({
      newAdId: result.newAdId,
      adsManagerUrl: result.adsManagerUrl ?? null,
    });
    setToast({ type: "success", message: "Ad duplicated on Meta." });
  }

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
      data-testid="creative-ad-actions"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-900">Actions</h4>
          <div className="mt-2 flex items-center gap-2">
            <span className={statusClassName(localStatus)}>{localStatus}</span>
            <span className="text-xs text-slate-500">Meta ad status</span>
          </div>
        </div>
        {pendingAction ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600">
            <Loader2 className="h-3 w-3 animate-spin" />
            Updating
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <button
          type="button"
          disabled={!canPause}
          onClick={() => setConfirmAction("pause")}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <PauseCircle className="h-4 w-4" />
          Pause ad
        </button>
        <button
          type="button"
          disabled={!canResume}
          onClick={() => setConfirmAction("resume")}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <PlayCircle className="h-4 w-4" />
          Resume ad
        </button>
        <button
          type="button"
          onClick={() => setDuplicateOpen(true)}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-900 bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800"
        >
          <Copy className="h-4 w-4" />
          Duplicate to campaign...
        </button>
      </div>

      <details className="mt-4 rounded-xl border border-slate-200 bg-white">
        <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
          <History className="h-3.5 w-3.5" />
          Recent actions on this ad
        </summary>
        <div className="border-t border-slate-100 px-3 py-3">
          {historyQuery.isLoading ? (
            <p className="text-sm text-slate-500">Loading actions...</p>
          ) : historyQuery.isError ? (
            <p className="text-sm text-rose-600">Action history unavailable.</p>
          ) : (historyQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">No actions yet.</p>
          ) : (
            <div className="space-y-2">
              {(historyQuery.data ?? []).map((item) => (
                <div
                  key={item.id}
                  className="grid grid-cols-[minmax(88px,1fr)_80px_90px] gap-2 text-xs text-slate-700"
                >
                  <span>{formatTimestamp(item.requestedAt)}</span>
                  <span className="font-medium capitalize">{item.action}</span>
                  <span className={historyStatusClassName(item.status)}>
                    {item.status}
                  </span>
                  {item.errorMessage ? (
                    <p className="col-span-3 text-rose-700">
                      {item.errorCode ? `${item.errorCode}: ` : ""}
                      {item.errorMessage}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </details>

      {confirmAction ? (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/50 px-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-600" />
              <div>
                <h5 className="text-sm font-semibold text-slate-900">
                  Confirm {confirmAction === "pause" ? "pause" : "resume"}
                </h5>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  This will {confirmAction} this ad on Meta. Confirm?
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="h-9 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void runStatusAction(confirmAction)}
                className="h-9 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {duplicateOpen ? (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/50 px-4">
          <div className="max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h5 className="text-sm font-semibold text-slate-900">
                  Duplicate to campaign
                </h5>
                <p className="mt-1 text-sm text-slate-500">{row.name}</p>
              </div>
              <button
                type="button"
                onClick={() => setDuplicateOpen(false)}
                className="h-8 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                  Target campaign
                </span>
                <select
                  value={selectedCampaignId}
                  onChange={(event) => {
                    setSelectedCampaignId(event.target.value);
                    setSelectedAdsetId("");
                  }}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-slate-400"
                >
                  <option value="">Select active campaign</option>
                  {activeCampaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                  Target ad set
                </span>
                <select
                  value={selectedAdsetId}
                  disabled={!selectedCampaignId}
                  onChange={(event) => setSelectedAdsetId(event.target.value)}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-slate-400 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                >
                  <option value="">
                    {selectedCampaignId ? "Select active ad set" : "Select campaign first"}
                  </option>
                  {selectedCampaignAdsets.map((adset) => (
                    <option key={adset.id} value={adset.id}>
                      {adset.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                  Name override
                </span>
                <input
                  type="text"
                  value={nameOverride}
                  onChange={(event) => setNameOverride(event.target.value)}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-slate-400"
                />
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={activateAfterCreate}
                  onChange={(event) => setActivateAfterCreate(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span className="text-sm font-medium text-slate-700">
                  Activate immediately
                </span>
              </label>

              {duplicateMessage ? (
                <div className={duplicateProgressClassName(duplicateProgress)}>
                  {duplicateProgress === "success" ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : duplicateProgress === "error" ? (
                    <AlertTriangle className="h-4 w-4" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  <div className="min-w-0">
                    <p>{duplicateMessage}</p>
                    {duplicateResult ? (
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">{duplicateResult.newAdId}</span>
                        {duplicateResult.adsManagerUrl ? (
                          <a
                            href={duplicateResult.adsManagerUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-semibold text-slate-900 underline"
                          >
                            Meta Ads Manager
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDuplicateOpen(false)}
                className="h-9 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={duplicateConfirmDisabled}
                onClick={() => void runDuplicate()}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {duplicateProgress === "submitting" || duplicateProgress === "verifying" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div
          className={`fixed bottom-5 right-5 z-[120] max-w-md rounded-xl border px-4 py-3 text-sm shadow-xl ${
            toast.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-rose-200 bg-rose-50 text-rose-900"
          }`}
        >
          {toast.message}
        </div>
      ) : null}
    </section>
  );
}

function normalizeStatus(value: string | null | undefined) {
  const status = value?.trim().toUpperCase();
  return status && status.length > 0 ? status : "UNKNOWN";
}

export function isDuplicateConfirmDisabled(input: {
  selectedCampaignId: string;
  selectedAdsetId: string;
  progress: DuplicateProgress;
}) {
  return (
    !input.selectedCampaignId ||
    !input.selectedAdsetId ||
    input.progress === "submitting" ||
    input.progress === "verifying"
  );
}

export function buildDuplicateActionBody(input: {
  businessId: string;
  targetAdsetId: string;
  nameOverride: string;
  activateAfterCreate: boolean;
}) {
  const name = input.nameOverride.trim();
  return {
    businessId: input.businessId,
    targetAdsetId: input.targetAdsetId,
    name: name || undefined,
    activateAfterCreate: input.activateAfterCreate,
  };
}

export function resolveManualAdActionId(row: MetaCreativeRow) {
  return row.realAdId?.trim() || row.id;
}

function statusClassName(status: string) {
  const base = "rounded border px-2 py-0.5 text-xs font-semibold";
  if (status === "ACTIVE") return `${base} border-emerald-200 bg-emerald-50 text-emerald-700`;
  if (status === "PAUSED") return `${base} border-amber-200 bg-amber-50 text-amber-700`;
  return `${base} border-slate-200 bg-slate-50 text-slate-600`;
}

function historyStatusClassName(status: ActionHistoryRow["status"]) {
  const base = "rounded border px-2 py-0.5 text-center text-[11px] font-semibold";
  if (status === "success") return `${base} border-emerald-200 bg-emerald-50 text-emerald-700`;
  if (status === "silent_failure") return `${base} border-amber-200 bg-amber-50 text-amber-700`;
  if (status === "failure") return `${base} border-rose-200 bg-rose-50 text-rose-700`;
  return `${base} border-slate-200 bg-slate-50 text-slate-600`;
}

function duplicateProgressClassName(progress: DuplicateProgress) {
  const base = "flex items-start gap-2 rounded-xl border px-3 py-2 text-sm";
  if (progress === "success") return `${base} border-emerald-200 bg-emerald-50 text-emerald-900`;
  if (progress === "error") return `${base} border-rose-200 bg-rose-50 text-rose-900`;
  return `${base} border-slate-200 bg-slate-50 text-slate-700`;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatActionError(result: ActionResponse, fallback: string) {
  const code = result.error?.code?.trim();
  const message = result.error?.message?.trim();
  if (code && message) return `${code}: ${message}`;
  if (message) return message;
  if (code) return code;
  return fallback;
}

async function fetchCampaigns(businessId: string): Promise<CampaignPickerRow[]> {
  const url = new URL("/api/meta/campaigns", window.location.origin);
  url.searchParams.set("businessId", businessId);
  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) throw new Error(`campaign fetch failed: ${response.status}`);
  const payload = (await response.json()) as { rows?: CampaignPickerRow[] };
  return Array.isArray(payload.rows) ? payload.rows : [];
}

async function fetchAdsets(businessId: string): Promise<AdsetPickerRow[]> {
  const url = new URL("/api/meta/adsets", window.location.origin);
  url.searchParams.set("businessId", businessId);
  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) throw new Error(`ad set fetch failed: ${response.status}`);
  const payload = (await response.json()) as { rows?: AdsetPickerRow[] };
  return Array.isArray(payload.rows) ? payload.rows : [];
}

async function fetchActionHistory(input: {
  businessId: string;
  adId: string;
}): Promise<ActionHistoryRow[]> {
  const url = new URL(
    `/api/meta/ads/${encodeURIComponent(input.adId)}/actions`,
    window.location.origin,
  );
  url.searchParams.set("businessId", input.businessId);
  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) throw new Error(`action history fetch failed: ${response.status}`);
  const payload = (await response.json()) as { rows?: ActionHistoryRow[] };
  return Array.isArray(payload.rows) ? payload.rows : [];
}

async function postAction(input: {
  adId: string;
  action: ManualAction | "duplicate";
  body: Record<string, unknown>;
}): Promise<ActionResponse> {
  const response = await fetch(
    `/api/meta/ads/${encodeURIComponent(input.adId)}/${input.action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.body),
    },
  );
  const payload = (await response.json().catch(() => null)) as ActionResponse | null;
  if (!payload) {
    return {
      ok: false,
      error: {
        code: String(response.status),
        message: "Meta action returned an empty response.",
      },
    };
  }
  return payload;
}
