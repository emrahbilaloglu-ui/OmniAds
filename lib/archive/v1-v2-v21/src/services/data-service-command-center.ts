import type {
  CommandCenterBatchMutationRequest,
  CommandCenterFeedbackEntry,
  CommandCenterFeedbackScope,
  CommandCenterFeedbackType,
  CommandCenterActionMutation,
  CommandCenterHandoff,
  CommandCenterResponse,
  CommandCenterSavedViewDefinition,
  CommandCenterSourceSystem,
} from "@/lib/command-center";
import type { CommandCenterExecutionPreview } from "@/lib/command-center-execution";
import {
  buildApiUrl,
  getApiErrorMessage,
  readJsonResponse,
} from "@/src/services/data-service-support";

export async function getCommandCenter(
  businessId: string,
  startDate: string,
  endDate: string,
  viewKey?: string | null,
): Promise<CommandCenterResponse> {
  const url = buildApiUrl("/api/command-center");
  url.searchParams.set("businessId", businessId);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  if (viewKey) url.searchParams.set("viewKey", viewKey);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Command Center request failed with status ${response.status}`,
      ),
    );
  }

  return payload as CommandCenterResponse;
}

export async function mutateCommandCenterAction(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  actionFingerprint: string;
  clientMutationId: string;
  mutation: CommandCenterActionMutation;
  assigneeUserId?: string | null;
  snoozeUntil?: string | null;
}) {
  const url = buildApiUrl("/api/command-center/actions");
  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Command Center action mutation failed with status ${response.status}`,
      ),
    );
  }

  return payload as { ok: true; state: unknown };
}

export async function addCommandCenterNote(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  actionFingerprint: string;
  clientMutationId: string;
  note: string;
}) {
  const url = buildApiUrl("/api/command-center/actions/note");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Command Center note request failed with status ${response.status}`,
      ),
    );
  }

  return payload as { ok: true; state: unknown };
}

export async function batchMutateCommandCenterActions(
  input: CommandCenterBatchMutationRequest,
) {
  const url = buildApiUrl("/api/command-center/actions/batch");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Command Center batch mutation failed with status ${response.status}`,
      ),
    );
  }

  return payload as {
    ok: boolean;
    mutation: CommandCenterBatchMutationRequest["mutation"];
    requestedCount: number;
    successCount: number;
    failureCount: number;
    results: Array<{
      actionFingerprint: string;
      ok: boolean;
      state?: unknown;
      error?: string;
    }>;
  };
}

export async function createCommandCenterFeedback(input: {
  businessId: string;
  clientMutationId: string;
  feedbackType: CommandCenterFeedbackType;
  scope: CommandCenterFeedbackScope;
  note: string;
  actionFingerprint?: string;
  startDate?: string;
  endDate?: string;
  viewKey?: string | null;
  sourceSystem?: CommandCenterSourceSystem | null;
}) {
  const url = buildApiUrl("/api/command-center/feedback");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Create feedback failed with status ${response.status}`,
      ),
    );
  }

  return payload as { ok: true; feedback: CommandCenterFeedbackEntry };
}

export async function createCommandCenterSavedView(input: {
  businessId: string;
  name: string;
  definition: CommandCenterSavedViewDefinition;
}) {
  const url = buildApiUrl("/api/command-center/views");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Create saved view failed with status ${response.status}`,
      ),
    );
  }

  return payload as { ok: true; view: unknown };
}

export async function deleteCommandCenterSavedView(input: {
  businessId: string;
  viewKey: string;
}) {
  const url = buildApiUrl("/api/command-center/views");
  const response = await fetch(url.toString(), {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Delete saved view failed with status ${response.status}`,
      ),
    );
  }

  return payload as { ok: true };
}

export async function createCommandCenterHandoff(input: {
  businessId: string;
  shift: "morning" | "evening";
  summary: string;
  blockers: string[];
  watchouts: string[];
  linkedActionFingerprints: string[];
  toUserId?: string | null;
}) {
  const url = buildApiUrl("/api/command-center/handoffs");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Create handoff failed with status ${response.status}`,
      ),
    );
  }

  return payload as { ok: true; handoff: CommandCenterHandoff | null };
}

export async function acknowledgeCommandCenterHandoff(input: {
  businessId: string;
  handoffId: string;
}) {
  const url = buildApiUrl("/api/command-center/handoffs");
  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      ...input,
      action: "acknowledge",
    }),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Acknowledge handoff failed with status ${response.status}`,
      ),
    );
  }

  return payload as { ok: true; handoff: CommandCenterHandoff | null };
}

export async function getCommandCenterExecutionPreview(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  actionFingerprint: string;
}) {
  const url = buildApiUrl("/api/command-center/execution");
  url.searchParams.set("businessId", input.businessId);
  url.searchParams.set("startDate", input.startDate);
  url.searchParams.set("endDate", input.endDate);
  url.searchParams.set("actionFingerprint", input.actionFingerprint);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Execution preview failed with status ${response.status}`,
      ),
    );
  }

  return payload as CommandCenterExecutionPreview;
}

export async function applyCommandCenterExecution(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  actionFingerprint: string;
  previewHash: string;
  clientMutationId: string;
}) {
  const url = buildApiUrl("/api/command-center/execution/apply");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Execution apply failed with status ${response.status}`,
      ),
    );
  }

  return payload as { ok: true; preview: CommandCenterExecutionPreview };
}

export async function rollbackCommandCenterExecution(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  actionFingerprint: string;
  clientMutationId: string;
}) {
  const url = buildApiUrl("/api/command-center/execution/rollback");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Execution rollback failed with status ${response.status}`,
      ),
    );
  }

  return payload as { ok: true; preview: CommandCenterExecutionPreview };
}
