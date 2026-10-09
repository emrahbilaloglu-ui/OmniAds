/** The ordinary user leaves immediately after durable logical offboarding.
 * Physical erasure is an operator concern; this does not prove stored absence. */
export function acceptBusinessDeletion(initial: { status?: string }) {
  if (initial.status === "ok") return "completed" as const;
  if (initial.status === "queued" || initial.status === "running") return "accepted" as const;
  throw new Error("Business removal could not be confirmed. Refresh the list before trying again.");
}

/** Operator-only receipt. A 202 only acknowledges durable work. Poll the authenticated, session-bound
 * read receipt; only the server's atomic absence proof is completion. */
export async function awaitBusinessDeletion(businessId: string, initial: { status?: string; monitorTicket?: string },
  onPending: (status: "queued" | "running") => void = () => {},
  options: { pollMs?: number; maxWaitMs?: number } = {}) {
  if (initial.status === "ok") return;
  if (!["queued", "running"].includes(initial.status ?? "") || !initial.monitorTicket)
    throw new Error("Deletion was accepted, but its background status could not be read. Refresh the list before retrying.");
  const deadline = Date.now() + (options.maxWaitMs ?? 35 * 60_000);
  onPending(initial.status as "queued" | "running");
  while (Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, options.pollMs ?? 3000));
    const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}/deletion-status`, {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ monitorTicket: initial.monitorTicket }), signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const data = response ? await response.json().catch(() => null) as { status?: string; message?: string } | null : null;
    if (!response?.ok || !data) throw new Error(data?.message ?? "The deletion status could not be confirmed. The background job may still be running; refresh the list before retrying.");
    if (data.status === "ok") return;
    if (data.status === "failed") throw new Error(data.message ?? "The deletion failed. Refresh the list before retrying.");
    if (data.status !== "queued" && data.status !== "running") throw new Error("The deletion status could not be confirmed.");
    onPending(data.status);
  }
  throw new Error("Deletion is taking longer than expected. Refresh the list to check its status; closing this window does not cancel the job.");
}
