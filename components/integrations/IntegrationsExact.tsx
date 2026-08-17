"use client";

import styles from "@/components/integrations/IntegrationsExact.module.css";
import type {
  IntegrationsCardModel,
  IntegrationsExactModel,
  IntegrationsFirstSyncModel,
  IntegrationsSoonCardModel,
  IntegrationsStatusTone,
} from "@/components/integrations/integrations-exact-model";
import type { IntegrationProvider } from "@/store/integrations-store";

export type { IntegrationsExactModel } from "@/components/integrations/integrations-exact-model";

/** design 2817-2819 — the header's three fixed lines. */
const EYEBROW = "Workspace · Data sources";
const TITLE = "Integrations";
const HEADER_NOTE =
  "Connected sources refresh themselves — a full sync runs nightly at 03:00 ET, deltas land continuously. Sync progress appears once: while a new source runs its first import.";
const SOON_TITLE = "Coming soon";
const SOON_NOTE =
  "these stay out of the sidebar until the integration is live — never simulated";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const STATUS_CLASS: Record<IntegrationsStatusTone, string> = {
  connected: styles.statusConnected!,
  connecting: styles.statusConnecting!,
  attention: styles.statusAttention!,
  neutral: styles.statusNeutral!,
};

function FirstSyncBlock({ model }: { model: IntegrationsFirstSyncModel }) {
  return (
    <div className={styles.firstSync} data-testid="integration-first-sync">
      <div className={styles.firstSyncHead}>
        <span className={styles.firstSyncLabel}>First sync</span>
        <span className={styles.firstSyncPercent}>{model.percentLabel}</span>
      </div>
      <div className={styles.firstSyncTrack}>
        <div
          className={classNames(
            styles.firstSyncFill,
            model.complete && styles.firstSyncFillComplete,
          )}
          style={{ width: model.barWidth }}
        />
      </div>
      <div className={styles.firstSyncSteps}>
        {model.steps.map((step) => (
          <div key={step.key} className={styles.firstSyncStep}>
            <span
              className={classNames(
                styles.stepMark,
                step.state === "done" && styles.stepMarkDone,
                step.state === "current" && styles.stepMarkCurrent,
              )}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                strokeWidth={4}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={styles.stepTick}
                aria-hidden="true"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </span>
            <span
              className={classNames(
                styles.stepLabel,
                step.state === "done" && styles.stepLabelDone,
                step.state === "current" && styles.stepLabelCurrent,
              )}
            >
              {step.label}
            </span>
            <span className={styles.stepNote}>{step.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LiveCard({
  card,
  onAction,
}: {
  card: IntegrationsCardModel;
  onAction: (provider: IntegrationProvider, kind: "connect" | "manage") => void;
}) {
  return (
    <article
      className={classNames(styles.card, card.syncing && styles.cardSyncing)}
      data-provider={card.provider}
    >
      <div className={styles.cardHead}>
        <span className={styles.logoTile}>
          <span
            role="img"
            aria-label={card.name}
            className={styles.logoMark}
            style={
              card.logoSrc ? { backgroundImage: `url(${card.logoSrc})` } : undefined
            }
          />
        </span>
        <span className={styles.cardName}>{card.name}</span>
        <span
          className={classNames(styles.statusPill, STATUS_CLASS[card.statusTone])}
        >
          <span className={styles.statusDot} />
          {card.status}
        </span>
      </div>

      <p className={styles.cardDesc}>{card.description}</p>

      {card.firstSync ? <FirstSyncBlock model={card.firstSync} /> : null}

      <div className={styles.cardFoot}>
        <span className={styles.cardMeta} title={card.meta}>
          {card.meta}
        </span>
        <span className={styles.cardSpacer} />
        {card.button ? (
          <button
            type="button"
            className={classNames(
              styles.cardButton,
              card.button.kind === "manage"
                ? styles.cardButtonManage
                : styles.cardButtonConnect,
            )}
            onClick={() => onAction(card.provider, card.button!.kind)}
          >
            {card.button.caption}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function SoonCard({ card }: { card: IntegrationsSoonCardModel }) {
  return (
    <article className={styles.soonCard} data-provider={card.provider}>
      <span className={styles.soonLogoTile}>
        <span
          role="img"
          aria-label={card.name}
          className={styles.soonLogoMark}
          style={
            card.logoSrc ? { backgroundImage: `url(${card.logoSrc})` } : undefined
          }
        />
      </span>
      <span className={styles.soonBody}>
        <span className={styles.soonNameRow}>
          <span className={styles.soonName}>{card.name}</span>
          <span className={styles.soonBadge}>SOON</span>
        </span>
        <span className={styles.soonEta}>{card.eta}</span>
      </span>
      <button type="button" className={styles.soonButton} disabled>
        Notify me
      </button>
    </article>
  );
}

/**
 * The Integrations screen exactly as the design draws it.
 *
 * Presentational only: it takes a view model and two callbacks and reads no
 * store, fetches nothing and decides nothing. Every card has four children and
 * at most one button, which is what keeps the screen from re-growing the stack
 * of notice banners it used to carry.
 */
export function IntegrationsExact({
  model,
  onAction,
}: {
  model: IntegrationsExactModel;
  onAction: (provider: IntegrationProvider, kind: "connect" | "manage") => void;
}) {
  return (
    <div className={styles.root} data-screen-label="Integrations">
      <div>
        <p className={styles.eyebrow}>{EYEBROW}</p>
        <h1 className={styles.title}>{TITLE}</h1>
        <p className={styles.headerNote}>{HEADER_NOTE}</p>
      </div>

      <div className={styles.liveGrid}>
        {model.cards.map((card) => (
          <LiveCard key={card.provider} card={card} onAction={onAction} />
        ))}
      </div>

      <div className={styles.soonHead}>
        <h2 className={styles.soonTitle}>{SOON_TITLE}</h2>
        <span className={styles.soonNote}>{SOON_NOTE}</span>
      </div>

      <div className={styles.soonGrid}>
        {model.soonCards.map((card) => (
          <SoonCard key={card.provider} card={card} />
        ))}
      </div>
    </div>
  );
}

/**
 * The screen's own shape while the provider manifest is still loading: the real
 * header, then one auto-fit grid of empty card outlines. It replaced a skeleton
 * that painted three summary tiles and three titled sections — a layout this
 * screen does not have in either state.
 */
export function IntegrationsExactSkeleton({ cardCount = 6 }: { cardCount?: number }) {
  return (
    <div className={styles.root} data-testid="integrations-skeleton">
      <div>
        <p className={styles.eyebrow}>{EYEBROW}</p>
        <h1 className={styles.title}>{TITLE}</h1>
        <p className={styles.headerNote}>{HEADER_NOTE}</p>
      </div>
      <div className={styles.liveGrid}>
        {Array.from({ length: cardCount }).map((_, index) => (
          <div key={index} className={classNames(styles.card, styles.cardPlaceholder)} />
        ))}
      </div>
    </div>
  );
}
