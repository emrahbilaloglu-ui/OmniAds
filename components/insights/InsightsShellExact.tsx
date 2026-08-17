"use client";

import type { ReactNode } from "react";
import Link from "next/link";

import styles from "@/components/insights/InsightsShellExact.module.css";
import type { InsightsShellExactModel } from "@/components/insights/insights-shell-exact-model";

export type { InsightsShellExactModel } from "@/components/insights/insights-shell-exact-model";

/**
 * The Insights page head and outer pill row, exactly as the design draws them.
 *
 * Presentational only: it takes a view model plus the working date control and
 * the active section's body, and renders nothing else. The design carries one
 * head per screen — eyebrow, h1, three chips — and no description line.
 */
export function InsightsShellExact({
  model,
  dateControl,
  children,
}: {
  model: InsightsShellExactModel;
  /** The real range picker, mounted inside the design's first head chip. */
  dateControl?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.root} data-screen-label="Insights">
      <div className={styles.head}>
        <div className={styles.identity}>
          <p className={styles.eyebrow}>{model.eyebrow}</p>
          <h1 className={styles.title}>{model.title}</h1>
        </div>
        <div className={styles.chips}>
          {dateControl ? <div className={styles.dateChip}>{dateControl}</div> : null}
          {model.sources.map((source) => (
            <span key={source.id} className={styles.sourceChip}>
              {/* A 14×14 static mark: next/image would add a wrapper and a
                  loader the design's chip has no room for. */}
              <img
                src={source.iconSrc}
                alt=""
                aria-hidden="true"
                className={styles.sourceIcon}
                width={14}
                height={14}
              />
              {source.label}
              <span className={styles.sourceState} data-tone={source.tone}>
                {source.stateLabel}
              </span>
            </span>
          ))}
        </div>
      </div>

      <div className={styles.tabRow} role="tablist" aria-label="Insights">
        {model.tabs.map((tab) => (
          <Link
            key={tab.id}
            href={tab.href}
            role="tab"
            aria-selected={tab.active}
            data-active={tab.active ? "true" : "false"}
            className={styles.tab}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <div className={styles.body}>{children}</div>
    </div>
  );
}
