"use client";

import { useEffect, useState } from "react";

import type {
  GoogleAdvisorResponse,
  GoogleRecommendation,
} from "@/lib/google-ads/growth-advisor-types";

import styles from "./GoogleAdvisorExact.module.css";
import {
  buildGoogleAdvisorExactViewModel,
  type GoogleAdvisorExactCardViewModel,
  type GoogleAdvisorExactIdentity,
  type GoogleAdvisorExactModeTone,
  type GoogleAdvisorExactTone,
} from "./google-advisor-exact-adapter";

export {
  buildGoogleAdvisorExactViewModel,
  type GoogleAdvisorExactCardViewModel,
  type GoogleAdvisorExactIdentity,
  type GoogleAdvisorExactViewModel,
} from "./google-advisor-exact-adapter";

const MOBILE_READ_ONLY_QUERY = "(max-width: 1023px)";

export type GoogleAdvisorDismissAuthority = "allowed" | "denied" | "unknown";
export type GoogleAdvisorSyncTone = "positive" | "warning" | "negative" | "neutral";
export type GoogleAdvisorDataState = "ready" | "loading" | "error" | "unavailable";

export interface GoogleAdvisorExactProps extends GoogleAdvisorExactIdentity {
  advisor: GoogleAdvisorResponse | null;
  advisorState?: GoogleAdvisorDataState;
  syncTone?: GoogleAdvisorSyncTone;
  planHref: string;
  productsHref: string;
  onNavigate: (href: string, recommendation: GoogleRecommendation) => void;
  onDismiss?: (recommendation: GoogleRecommendation) => void;
  dismissAuthority?: GoogleAdvisorDismissAuthority;
  readOnly?: boolean;
}

function useMobileReadOnly() {
  // Fail closed during SSR/hydration; the desktop dismissal becomes available
  // only after the browser proves that the viewport is outside the mobile lane.
  const [mobileReadOnly, setMobileReadOnly] = useState(true);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(MOBILE_READ_ONLY_QUERY);
    const update = (event: MediaQueryListEvent) => setMobileReadOnly(event.matches);
    setMobileReadOnly(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return mobileReadOnly;
}

function modeClass(tone: GoogleAdvisorExactModeTone) {
  const classByTone: Record<GoogleAdvisorExactModeTone, string> = {
    positive: styles.modePositive,
    primary: styles.modePrimary,
    automatic: styles.modeAutomatic,
    danger: styles.modeDanger,
    neutral: styles.modeNeutral,
  };
  return classByTone[tone];
}

function changeClass(tone: GoogleAdvisorExactTone) {
  const classByTone: Record<GoogleAdvisorExactTone, string> = {
    default: styles.changeDefault,
    primary: styles.changePrimary,
    danger: styles.changeDanger,
    muted: styles.changeMuted,
  };
  return classByTone[tone];
}

function bucketClass(tone: GoogleAdvisorExactCardViewModel["bucketTone"]) {
  const classByTone: Record<GoogleAdvisorExactCardViewModel["bucketTone"], string> = {
    now: styles.bucketNow,
    next: styles.bucketNext,
    blocked: styles.bucketBlocked,
    neutral: styles.bucketNeutral,
  };
  return classByTone[tone];
}

export function GoogleAdvisorExact({
  advisor,
  advisorState = advisor ? "ready" : "unavailable",
  accountId,
  currencyCode,
  windowLabel,
  syncLabel,
  syncTone,
  planHref,
  productsHref,
  onNavigate,
  onDismiss,
  dismissAuthority = "unknown",
  readOnly = false,
}: GoogleAdvisorExactProps) {
  const mobileReadOnly = useMobileReadOnly();
  const view = buildGoogleAdvisorExactViewModel(advisor, {
    accountId,
    currencyCode,
    windowLabel,
    syncLabel,
  });
  const dismissEnabled =
    !readOnly && !mobileReadOnly && dismissAuthority === "allowed" && Boolean(onDismiss);
  const resolvedSyncTone =
    syncTone ?? (!syncLabel || syncLabel.includes("—") ? "neutral" : "positive");

  return (
    <section
      aria-busy={advisorState === "loading"}
      className={styles.screen}
      data-advisor-state={advisorState}
      data-screen-label="Google Ads · Advisor"
    >
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{view.eyebrow}</p>
          <h1 className={styles.title}>Advisor</h1>
        </div>
        <div className={styles.headerStatus}>
          <span className={styles.guardCopy}>—</span>
          <span className={`${styles.syncPill} ${styles[`sync-${resolvedSyncTone}`]}`}>
            <span className={styles.syncDot} aria-hidden="true" />
            {view.syncLabel}
          </span>
        </div>
      </div>

      <div className={styles.tiles} data-advisor-tiles="true">
        {view.tiles.map((tile) => (
          <article className={styles.tile} data-advisor-tile={tile.key} key={tile.key}>
            <p className={styles.tileLabel}>{tile.label}</p>
            <p className={styles.tileValue}>{tile.value}</p>
            <p className={styles.tileSub}>{tile.sub}</p>
          </article>
        ))}
      </div>

      {view.cards.map((card) => {
        const recommendationDismissed =
          card.recommendation.currentStatus === "suppressed" ||
          card.recommendation.userAction === "dismissed";
        const cardDismissEnabled =
          dismissEnabled &&
          !recommendationDismissed &&
          Boolean(card.recommendation.recommendationFingerprint);
        const cta =
          card.navigationKind === "products"
            ? "Open Products"
            : card.navigationKind === "plan"
              ? "Apply (guarded)"
              : "—";
        const destination = card.navigationKind === "products" ? productsHref : planHref;
        const navigationEnabled = card.navigationKind !== "unsupported";
        return (
          <article
            className={styles.card}
            data-advisor-card={card.id}
            data-native-action-contract={card.nativeActionContract ? "true" : "false"}
            key={card.id}
          >
            <div className={styles.cardHead}>
              <span className={`${styles.bucket} ${bucketClass(card.bucketTone)}`}>
                {card.bucket}
              </span>
              <span className={styles.cardType}>{card.type}</span>
              <span className={`${styles.mode} ${modeClass(card.modeTone)}`}>
                {card.mode}
              </span>
              <span className={styles.money}>{card.money}</span>
            </div>

            <div className={styles.cardBody}>
              <div>
                <p className={styles.action}>{card.action}</p>
                <p className={styles.scope}>scope · {card.scope}</p>
              </div>

              <div className={styles.changes}>
                {card.changes.map((change, changeIndex) => (
                  <div className={styles.changeRow} key={`${card.id}-change-${changeIndex}`}>
                    <span className={styles.changeLabel}>{change.label}</span>
                    <div className={styles.changeItems}>
                      {change.items.map((item, itemIndex) => (
                        <span
                          className={`${styles.changeChip} ${changeClass(change.tone)}`}
                          key={`${card.id}-change-${changeIndex}-item-${itemIndex}`}
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className={styles.infoGrid}>
                <div>
                  <p className={styles.infoLabel}>Expected effect</p>
                  <p className={styles.infoText}>{card.effect}</p>
                </div>
                <div>
                  <p className={styles.infoLabel}>Why this now</p>
                  <p className={styles.infoText}>{card.why}</p>
                </div>
                <div>
                  <p className={styles.infoLabel}>Validation</p>
                  <p className={styles.infoText}>{card.validation}</p>
                </div>
                <div>
                  <p className={styles.infoLabel}>{card.lastLabel}</p>
                  <p className={styles.infoText}>{card.last}</p>
                </div>
              </div>

              <div className={styles.cardFooter}>
                <span className={styles.confidence}>{card.confidence}</span>
                <div className={styles.cardActions}>
                  <button
                    className={`${styles.cta} ${
                      card.navigationKind === "plan" ? styles.ctaApply : styles.ctaBlocked
                    }`}
                    data-advisor-navigation={card.navigationKind}
                    disabled={!navigationEnabled}
                    onClick={() => {
                      if (!navigationEnabled) return;
                      onNavigate(destination, card.recommendation);
                    }}
                    type="button"
                  >
                    {cta}
                  </button>
                  <button
                    className={styles.dismiss}
                    data-advisor-memory-action="dismiss"
                    disabled={!cardDismissEnabled}
                    onClick={() => {
                      if (!cardDismissEnabled) return;
                      onDismiss?.(card.recommendation);
                    }}
                    type="button"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          </article>
        );
      })}

      <p className={styles.closingCopy}>—</p>
    </section>
  );
}
