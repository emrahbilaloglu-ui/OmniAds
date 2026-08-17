import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import styles from "./page.module.css";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Only persisted provider payload names are eligible for display. */
export function launchIntentDisplayName(intent: MetaLaunchIntent) {
  const payload = record(intent.requestPayload);
  if (!payload) return "—";

  if (intent.operation === "new_campaign") {
    const campaign = record(payload.campaign);
    const name = typeof campaign?.name === "string" ? campaign.name.trim() : "";
    return name || "—";
  }

  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  const firstTarget = record(targets[0]);
  const targetName =
    typeof firstTarget?.targetCampaignName === "string"
      ? firstTarget.targetCampaignName.trim()
      : "";
  return targetName || "—";
}

function adsManagerLink(intent: MetaLaunchIntent) {
  const receipt = intent.resultReceipt ?? intent.errorReceipt?.partialResult;
  const account = intent.providerAccountId?.replace(/^act_/, "").trim();
  if (!receipt?.campaignId || !account) return null;
  const params = new URLSearchParams({
    act: account,
    selected_campaign_ids: receipt.campaignId,
  });
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?${params.toString()}`;
}

function isLandedReceipt(intent: MetaLaunchIntent) {
  return (
    (intent.status === "succeeded" ||
      intent.status === "partially_succeeded" ||
      intent.status === "failed" ||
      intent.status === "silent_failure") &&
    adsManagerLink(intent) != null
  );
}

function formatTimestamp(value: string | null, actor: string | null) {
  if (!value) return "—";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "—";
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(time));
  return `${date} · by ${actor?.trim() || "—"}`;
}

function terminalTimestamp(intent: MetaLaunchIntent) {
  return (
    intent.resultReceipt?.completedAt ??
    intent.completedAt ??
    intent.errorReceipt?.recordedAt ??
    null
  );
}

/** Canonical Launchpad receipt row: id, name, PAUSED, time and provider link. */
export function LaunchIntentReceiptRows({
  intents,
}: {
  intents: MetaLaunchIntent[];
}) {
  const landedIntents = intents.filter(isLandedReceipt);
  return (
    <div data-testid="launch-intent-receipts">
      {landedIntents.length > 0 ? (
        landedIntents.map((intent) => {
          const adsManagerHref = adsManagerLink(intent);
          return (
            <div
              key={intent.id}
              className={styles.exactReceiptRow}
              data-testid="launchpad-receipt-row"
            >
              <span className={styles.exactReceiptId}>{intent.id || "—"}</span>
              <span className={styles.exactReceiptName}>
                {launchIntentDisplayName(intent)}
              </span>
              <span className={styles.exactReceiptStatus}>
                {intent.requestedStatus}
              </span>
              <span className={styles.exactReceiptTime}>
                {formatTimestamp(terminalTimestamp(intent), null)}
              </span>
              {adsManagerHref ? (
                <a
                  href={adsManagerHref}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.exactReceiptLink}
                >
                  Open in Ads Manager ↗
                </a>
              ) : (
                <span className={styles.exactReceiptUnavailable}>—</span>
              )}
            </div>
          );
        })
      ) : (
        <div
          className={styles.exactReceiptRow}
          data-testid="launchpad-receipt-empty"
        >
          <span className={styles.exactReceiptId}>—</span>
          <span className={styles.exactReceiptName}>—</span>
          <span className={styles.exactReceiptStatus} data-empty="true">
            —
          </span>
          <span className={styles.exactReceiptTime}>—</span>
          <span className={styles.exactReceiptUnavailable}>—</span>
        </div>
      )}
    </div>
  );
}
