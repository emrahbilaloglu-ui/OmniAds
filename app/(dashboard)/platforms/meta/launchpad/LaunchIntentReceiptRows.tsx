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
  if (!payload) return "Untitled launch";

  if (intent.operation === "new_campaign") {
    const campaign = record(payload.campaign);
    const name = typeof campaign?.name === "string" ? campaign.name.trim() : "";
    return name || "Untitled launch";
  }

  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  const firstTarget = record(targets[0]);
  const targetName =
    typeof firstTarget?.targetCampaignName === "string"
      ? firstTarget.targetCampaignName.trim()
      : "";
  return targetName || "Untitled launch";
}

/**
 * The campaign the intent's ads actually landed in.
 *
 * `add_to_existing` never creates a campaign, so `buildMetaLaunchIntentResultReceipt`
 * stores `campaignId: null` for it and every such receipt used to be dropped from
 * this card. Its campaign is the persisted request target instead. It is only
 * surfaced once at least one ad really landed, so the link can never open a
 * campaign this intent did not touch.
 */
export function landedCampaignId(intent: MetaLaunchIntent) {
  const receipt = intent.resultReceipt ?? intent.errorReceipt?.partialResult;
  if (!receipt) return null;
  const createdCampaignId = receipt.campaignId?.trim();
  if (createdCampaignId) return createdCampaignId;
  if (intent.operation !== "add_to_existing") return null;
  if (receipt.adIds.length === 0) return null;
  const payload = record(intent.requestPayload);
  const targets = Array.isArray(payload?.targets) ? payload.targets : [];
  const firstTarget = record(targets[0]);
  const targetCampaignId =
    typeof firstTarget?.targetCampaignId === "string"
      ? firstTarget.targetCampaignId.trim()
      : "";
  return targetCampaignId || null;
}

function adsManagerLink(intent: MetaLaunchIntent) {
  const campaignId = landedCampaignId(intent);
  const account = intent.providerAccountId?.replace(/^act_/, "").trim();
  if (!campaignId || !account) return null;
  const params = new URLSearchParams({
    act: account,
    selected_campaign_ids: campaignId,
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

/**
 * The provider state this receipt can actually prove.
 *
 * The row used to print `intent.requestedStatus`, which is always "PAUSED" —
 * what we *asked* for, not what happened. A `silent_failure` intent is one the
 * surface itself defines as unverified ("the provider call returned success,
 * but verification could not confirm the entity"), and a `failed` intent's
 * partial objects were never confirmed either. Both stay listed and linkable,
 * because a real provider object exists and needs reconciling in Meta — but
 * their status cell must not claim a state verification never established. An
 * unverified state is an unsupplied fact, so it renders as an em-dash.
 */
export function receiptStatusLabel(intent: MetaLaunchIntent) {
  if (intent.status === "succeeded") return "Paused";
  if (intent.status === "partially_succeeded") return "Partially created";
  return "Needs review";
}

function receiptStatusTone(intent: MetaLaunchIntent) {
  if (intent.status === "succeeded") return "verified";
  if (intent.status === "partially_succeeded") return "partial";
  return "review";
}

function formatTimestamp(value: string | null) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(time));
}

function terminalTimestamp(intent: MetaLaunchIntent) {
  return (
    intent.resultReceipt?.completedAt ??
    intent.completedAt ??
    intent.errorReceipt?.recordedAt ??
    null
  );
}

/**
 * Canonical Launchpad receipt row: id, name, provider state, time and link.
 * The state cell is `receiptStatusLabel`, not the requested status.
 */
export function LaunchIntentReceiptRows({
  intents,
  loading = false,
  unavailableReason = null,
}: {
  intents: MetaLaunchIntent[];
  loading?: boolean;
  unavailableReason?: string | null;
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
              <span className={styles.exactReceiptName}>
                {launchIntentDisplayName(intent)}
              </span>
              {/* Same single chip, same five-field row. `data-empty` is the
                  existing "this cell has no value" treatment — reused rather
                  than a new style, so the layout is untouched. */}
              <span
                className={styles.exactReceiptStatus}
                data-status={receiptStatusTone(intent)}
              >
                {receiptStatusLabel(intent)}
              </span>
              {formatTimestamp(terminalTimestamp(intent)) ? (
                <span className={styles.exactReceiptTime}>
                  {formatTimestamp(terminalTimestamp(intent))}
                </span>
              ) : null}
              {adsManagerHref ? (
                <a
                  href={adsManagerHref}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.exactReceiptLink}
                >
                  Open in Ads Manager ↗
                </a>
              ) : null}
            </div>
          );
        })
      ) : (
        <div
          className={styles.exactReceiptRow}
          data-testid="launchpad-receipt-empty"
        >
          <span className={styles.exactReceiptName}>
            {loading
              ? "Loading recent launches…"
              : unavailableReason
                ? unavailableReason
                : "No launches yet."}
          </span>
        </div>
      )}
    </div>
  );
}
