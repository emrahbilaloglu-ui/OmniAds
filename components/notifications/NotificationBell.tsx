"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";

import { useAppStore } from "@/store/app-store";

/**
 * The bell.
 *
 * It stayed disabled for a long time for a good reason: nothing produced
 * notification events, so an enabled bell would have rendered a confident
 * `0 unread` meaning "nothing can generate these" rather than "nothing is
 * wrong". That reason is gone — the producer now runs on the maintenance cron
 * and the full attempted/delivered/opened/acknowledged lifecycle is shipped —
 * so leaving it disabled would itself be the dishonest state: alerts would be
 * produced and delivered to nobody.
 *
 * The same rule the rest of the console follows applies here, and the badge is
 * where it matters most:
 *
 * - while the first read is in flight, no count at all. A zero during load is
 *   indistinguishable from a real zero, and this particular zero means
 *   "nothing needs you".
 * - if the read fails, the badge says so rather than falling back to zero. An
 *   operator who sees no badge assumes there is nothing waiting.
 * - a genuine zero renders as no badge, which is the one case where silence is
 *   the correct answer.
 */
interface NotificationRow {
  id: string;
  deliveryId: string;
  businessId: string;
  eventType: string;
  severity: string;
  state: string;
  deepLink: string | null;
  occurredOn: string;
}

interface NotificationsPayload {
  notifications: NotificationRow[];
  unacknowledged: number;
}

async function fetchNotifications(
  businessId: string,
): Promise<NotificationsPayload> {
  const response = await fetch(
    `/api/notifications?businessId=${encodeURIComponent(businessId)}`,
    { headers: { Accept: "application/json" }, cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error("Notifications could not be read.");
  }
  return (await response.json()) as NotificationsPayload;
}

export function NotificationBell() {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const [open, setOpen] = useState(false);

  const query = useQuery({
    queryKey: ["notifications", selectedBusinessId],
    enabled: Boolean(selectedBusinessId),
    queryFn: () => fetchNotifications(selectedBusinessId as string),
    // The GET is what turns an attempt into a delivery, so polling it is not
    // free: each poll is a delivery claim. Once a minute is enough for an
    // alerting surface and keeps the delivery timestamp meaningful.
    refetchInterval: 60_000,
  });

  const rows = query.data?.notifications ?? [];
  const unacknowledged = query.data?.unacknowledged ?? null;

  async function act(deliveryId: string, action: "open" | "acknowledge") {
    if (!selectedBusinessId) return;
    await fetch(`/api/notifications/${encodeURIComponent(deliveryId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, action }),
    }).catch(() => null);
    void query.refetch();
  }

  const badge =
    query.isLoading || !selectedBusinessId
      ? null
      : query.error
        ? "?"
        : unacknowledged && unacknowledged > 0
          ? String(Math.min(unacknowledged, 99))
          : null;

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="notification-bell"
        data-notification-state={
          !selectedBusinessId
            ? "no_business"
            : query.isLoading
              ? "loading"
              : query.error
                ? "unreadable"
                : "ready"
        }
        // No client emit here. Opening the panel is not a section-9 event, and
        // inventing one would be dead vocabulary the database CHECK would
        // refuse. The lifecycle events that matter -- delivered, opened,
        // acknowledged -- are emitted server-side by the routes this component
        // calls, because only the server knows whether the transition landed.
        onClick={() => setOpen((current) => !current)}
        aria-label={
          query.error
            ? "Notifications — count unavailable"
            : query.isLoading
              ? "Notifications — loading"
              : unacknowledged
                ? `Notifications — ${unacknowledged} unacknowledged`
                : "Notifications"
        }
        className="relative grid h-7 w-7 place-items-center rounded-[6px] border border-[var(--adc-b1)] text-[var(--adc-ink3)]"
      >
        <Bell className="h-3.5 w-3.5" aria-hidden="true" />
        {badge ? (
          <span
            data-testid="notification-badge"
            className={`absolute -right-1 -top-1 min-w-[14px] rounded-full px-1 text-[10px] font-semibold leading-[14px] text-white ${
              query.error ? "bg-neutral-500" : "bg-rose-600"
            }`}
          >
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          data-testid="notification-panel"
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-1 w-[320px] rounded-lg border border-[var(--adc-b1)] bg-white p-2 shadow-lg"
        >
          {query.isLoading ? (
            // No count, no list, no zero.
            <p className="p-2 text-[12px] text-[var(--adc-ink3)]">
              Loading — nothing to show yet
            </p>
          ) : query.error ? (
            <div className="p-2 text-[12px] text-rose-700">
              <p>Could not read notifications</p>
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="mt-1 rounded border border-rose-300 px-1.5 py-0.5 text-[12px] font-medium"
              >
                Try again
              </button>
            </div>
          ) : rows.length === 0 ? (
            <p className="p-2 text-[12px] text-[var(--adc-ink3)]">
              Nothing needs you right now
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {rows.map((row) => (
                <li
                  key={row.deliveryId}
                  data-notification-severity={row.severity}
                  className="rounded border border-[var(--adc-b1)] p-2"
                >
                  <p className="text-[12px] font-medium text-[var(--adc-ink,#1a1c1f)]">
                    {row.eventType}
                  </p>
                  <p className="text-[12px] text-[var(--adc-ink3,#7d838c)]">
                    {row.occurredOn}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    {row.deepLink ? (
                      <a
                        href={row.deepLink}
                        onClick={() => void act(row.deliveryId, "open")}
                        className="text-[12px] underline"
                      >
                        Open
                      </a>
                    ) : null}
                    {/*
                      Acknowledging is separate from opening on purpose:
                      opening means someone looked, acknowledging means someone
                      took responsibility. Collapsing them would make every
                      glance count as ownership.
                    */}
                    {row.state !== "acknowledged" ? (
                      <button
                        type="button"
                        onClick={() => void act(row.deliveryId, "acknowledge")}
                        className="text-[12px] underline"
                      >
                        Acknowledge
                      </button>
                    ) : (
                      <span className="text-[12px] text-[var(--adc-ink3)]">
                        Acknowledged
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
