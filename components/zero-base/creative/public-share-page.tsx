"use client";

/**
 * The public creative-share page (Flow L, public branch).
 *
 * This is what someone outside the workspace sees. It renders only the
 * sanitized `PublicShare` — the internal ids, workspace name and contact
 * address are not in that object at all, so there is nothing here to leak.
 *
 * The unavailable state is deliberately one message for every cause. Expired,
 * revoked, rotated-away and never-existed look identical, because telling a
 * stranger holding a dead link which one it was confirms the link was once
 * real and that this workspace issued it.
 */
import { useState } from "react";
import { ShareMedia } from "@/components/zero-base/creative/share-media";
import type { PublicShare, PublicShareCreative } from "@/lib/zero-base/creative/public-share";
import { PUBLIC_SHARE_GONE } from "@/lib/zero-base/creative/public-share";
import { toneStyle } from "@/lib/zero-base/creative/public-share-story";
import type { SharedMessage } from "@/components/creatives/shareCreativeTypes";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";
import { PublicShareScreenView } from "@/components/zero-base/creative/public-share-screen-view";
import styles from "./PublicSharePage.module.css";

const VERDICT_ICON_PATH: Record<"good" | "mixed" | "bad", string> = {
  good: "M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4 12 14.01l-3-3",
  mixed: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8v4 M12 16h.01",
  bad: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M15 9l-6 6 M9 9l6 6",
};

const MEDIA_MISSING_ICON =
  "M21 15V5a2 2 0 0 0-2-2H9 M3 7v12a2 2 0 0 0 2 2h12 M2 2l20 20 M21 15l-5-5L5 21";

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  // UTC, not the viewer's local zone — a date-only string like "2026-09-01"
  // parses as UTC midnight, and formatting it in a negative-offset zone would
  // otherwise roll it back a day.
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function BrandMark() {
  return (
    <span className={styles.brandMark} aria-hidden="true">
      <img
        src="/adsecute-mark.svg"
        alt=""
        width={14}
        height={14}
        style={{ filter: "brightness(0) invert(1)" }}
      />
    </span>
  );
}

export function PublicShareUnavailable() {
  const copy = useCopy();
  return (
    <main className={styles.unavailablePage} data-public-share="unavailable">
      <div className={styles.unavailableCard}>
        <span className={styles.unavailableIcon} aria-hidden="true">
          <svg fill="none" height="20" stroke="#555d6d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="20">
            <path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71M2 2l20 20" />
          </svg>
        </span>
        <h1>{copy.sharedSnapshotNoLongerAvailable}</h1>
        <p>{PUBLIC_SHARE_GONE}</p>
        <div className={styles.unavailableFooter}>
          <BrandMark />
          <span>share.adsecute.com</span>
        </div>
      </div>
    </main>
  );
}

function EmptySnapshotPage({ share }: { share: PublicShare }) {
  const copy = useCopy();
  return (
    <main className={styles.emptyPage} data-el="public-share" data-public-share="ready" data-share-audience={share.audience}>
      <div className={styles.emptyPageInner}>
        <header className={styles.header}>
          <div className={styles.headerRow}>
            <BrandMark />
            <span className={styles.brandName}>Adsecute</span>
            <span className={styles.snapshotTag}>{copy.snapshot}</span>
            <span className={styles.flexSpacer} />
            <span className={styles.frozenPill}>
              <svg fill="none" height="11" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="11">
                <path d="M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              {copy.frozenSnapshot}
            </span>
          </div>
        </header>
        <p className={styles.emptyCreatives} data-share-creatives="empty">
          {copy.shareHasNoCreatives}
        </p>
        <p className={styles.emptyFooterLine}>
          frozen, read-only · available until {share.expiresAt ? formatDate(share.expiresAt) : "—"}
        </p>
      </div>
    </main>
  );
}

function CsvButton({ href }: { href: string }) {
  const copy = useCopy();
  const [state, setState] = useState<"idle" | "busy" | "done" | "fail">("idle");

  const handleClick = async () => {
    if (state === "busy") return;
    setState("busy");
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error("csv_fetch_failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "snapshot-creatives.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setState("done");
    } catch {
      setState("fail");
    }
  };

  return (
    <div className={styles.csvRow}>
      <div className={styles.csvText}>
        <p>{copy.csvExport}</p>
        <span>{copy.csvContainsExactlyThisPage}</span>
      </div>
      {state === "fail" ? (
        <span className={styles.csvMessageFail}>
          The CSV couldn&rsquo;t be generated. Metrics on this page are unaffected.
        </span>
      ) : state === "done" ? (
        <span className={styles.csvMessageDone}>snapshot-creatives.csv saved</span>
      ) : null}
      <button
        className={styles.csvButton}
        data-public-share-csv=""
        data-public-share-csv-href={href}
        disabled={state === "busy"}
        onClick={handleClick}
        type="button"
      >
        {state === "busy" ? <span className={styles.csvSpinner} aria-hidden="true" /> : null}
        {state === "busy"
          ? "Preparing CSV…"
          : state === "done"
            ? "Downloaded"
            : state === "fail"
              ? "Try again"
              : "Download CSV"}
      </button>
    </div>
  );
}

function StoryCard({ story }: { story: NonNullable<PublicShareCreative["story"]> }) {
  const copy = useCopy();
  const tone = toneStyle(story.tone);
  const iconPath = story.tone === "unclear" ? null : VERDICT_ICON_PATH[story.tone];
  return (
    <>
      {story.verdict ? (
        <div
          className={styles.verdictBox}
          style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}
        >
          {iconPath ? (
            <svg fill="none" height="14" stroke={tone.fg} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="14">
              <path d={iconPath} />
            </svg>
          ) : null}
          <p>{story.verdict}</p>
        </div>
      ) : null}
      <div className={styles.stageList}>
        {story.stages.map((stage) => (
          <div key={stage.key}>
            <div className={styles.stageHead}>
              <span className={styles.stageLabel}>{stage.label}</span>
              {stage.band ? (
                <span className={styles.stageBand} data-band={stage.band}>
                  {stage.band}
                </span>
              ) : null}
            </div>
            <div className={styles.stageTrack}>
              <span
                className={styles.stageFill}
                data-band={stage.band ?? "none"}
                style={{ width: `${stage.widthPercent}%` }}
              />
              {stage.benchmarkPercent !== null ? (
                <span
                  className={styles.stageTick}
                  style={{ left: `${stage.benchmarkPercent}%` }}
                  title={copy.typicalCreativeInThisAccount}
                />
              ) : null}
            </div>
            <p className={styles.stagePlain}>
              {stage.plainText}
              {stage.benchmarkValueLabel !== null ? (
                <span className={styles.stageTypical}> · typical: {stage.benchmarkValueLabel}</span>
              ) : null}
            </p>
          </div>
        ))}
      </div>
      {story.dropOff && story.dropOffCaption ? (
        <div className={styles.dropOff}>
          <p className={styles.dropOffTitle}>{copy.whereViewersStopWatching}</p>
          <div className={styles.dropOffBars}>
            {story.dropOff.map((bar, index) => (
              <span className={styles.dropOffBarWrap} key={`${bar.label}-${index}`}>
                <span
                  className={styles.dropOffBar}
                  data-highlight={bar.highlighted ? "true" : "false"}
                  style={{ height: `${bar.heightPercent}%` }}
                />
              </span>
            ))}
          </div>
          <div className={styles.dropOffLabels}>
            {story.dropOff.map((bar, index) => (
              <span key={`${bar.label}-${index}-label`}>{bar.label}</span>
            ))}
          </div>
          <p className={styles.dropOffCaption}>{story.dropOffCaption}</p>
        </div>
      ) : null}
      {story.suggestion ? (
        <div className={styles.suggestion}>
          <svg fill="none" height="13" stroke="#2a5fe2" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="13">
            <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          <div>
            <p className={styles.suggestionEyebrow}>Suggested next step · from this data</p>
            <p>{story.suggestion}</p>
          </div>
        </div>
      ) : null}
      <p className={styles.rawLine}>{story.rawLine}</p>
    </>
  );
}

function CreativeCard({ creative }: { creative: PublicShareCreative }) {
  const copy = useCopy();
  const metrics = creative.metrics ?? [];
  const hasStory = Boolean(creative.story);
  const formatLabel =
    creative.format === "video" ? "Video" : creative.format === "catalog" ? "Catalog" : "Image";
  const missingMedia = (iconSize: number) => (
    <p className={styles.mediaMissing} data-share-media="missing" data-share-media-for={creative.key}>
      <svg fill="none" height={iconSize} stroke="#68707f" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width={iconSize}>
        <path d={MEDIA_MISSING_ICON} />
      </svg>
      {creative.mediaUnavailableReason ?? "No preview was captured for this creative."}
    </p>
  );
  const hasRealMedia = creative.media && (creative.media.kind === "image" || creative.media.kind === "video");

  return (
    <article className={styles.creativeCard} data-share-creative={creative.key}>
      {hasStory ? (
        <div className={styles.mediaFrame} data-variant="story">
          <span className={styles.formatBadge}>{formatLabel}</span>
          <div className={styles.phoneFrame}>
            {hasRealMedia ? <ShareMedia source={creative.media} /> : missingMedia(16)}
          </div>
        </div>
      ) : (
        <div className={styles.mediaFrame} data-variant="row">
          <span className={styles.formatBadge}>{formatLabel}</span>
          {hasRealMedia ? <ShareMedia source={creative.media} /> : missingMedia(18)}
        </div>
      )}
      <div className={styles.cardBody}>
        <p className={styles.creativeName}>{creative.name}</p>
        <p className={styles.creativeLaunch}>
          {creative.launchDate ? `Launched ${formatDate(creative.launchDate)}` : "Launch date unavailable"}
        </p>
        {creative.story ? (
          <StoryCard story={creative.story} />
        ) : metrics.length > 0 ? (
          <div className={styles.metricRows}>
            {metrics.map((metric) => (
              <div className={styles.metricRow} data-public-metric={metric.key} key={metric.key}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.metricsEmpty} data-public-metrics="empty">
            {copy.noMetricsInFrozenSnapshot}
          </p>
        )}
      </div>
    </article>
  );
}

function ComparisonTable({ share }: { share: PublicShare }) {
  const copy = useCopy();
  const metricOrder: Array<{ key: string; label: string }> = [];
  const seen = new Set<string>();
  for (const creative of share.creatives) {
    for (const metric of creative.metrics ?? []) {
      if (seen.has(metric.key)) continue;
      seen.add(metric.key);
      metricOrder.push({ key: metric.key, label: metric.label });
    }
  }
  if (metricOrder.length === 0) return null;

  let missingSeen = false;

  return (
    <>
      <article className={styles.comparisonTable}>
        <div className={styles.comparisonHead}>
          <h2>{copy.sideBySideComparison}</h2>
          <span>same order as the cards above · frozen values</span>
        </div>
        <div className={styles.tableScroll}>
          <table>
            <thead>
              <tr>
                <th>{copy.creative}</th>
                {metricOrder.map((metric) => (
                  <th key={metric.key}>{metric.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {share.creatives.map((creative) => {
                const values = new Map<string, string>(
                  (creative.metrics ?? []).map((metric) => [metric.key, metric.value]),
                );
                return (
                  <tr key={creative.key}>
                    <td>{creative.name}</td>
                    {metricOrder.map((metric) => {
                      const value = values.get(metric.key);
                      if (value === undefined) missingSeen = true;
                      return (
                        <td className={value === undefined ? styles.tableMissing : styles.tablePresent} key={metric.key}>
                          {value ?? "—"}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </article>
      {missingSeen ? (
        <p className={styles.tableNote}>
          — appears where a metric was not yet statistically mature when this snapshot was frozen.
        </p>
      ) : null}
    </>
  );
}

function NotesThread({
  share,
  messagesHref,
}: {
  share: PublicShare;
  messagesHref: string | null;
}) {
  const copy = useCopy();
  const [messages, setMessages] = useState<SharedMessage[]>(share.messages ?? []);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const text = draft.trim();
    if (!text || !messagesHref || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(messagesHref, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ text }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { messages?: SharedMessage[]; message?: string }
        | null;
      if (!response.ok || !payload?.messages) {
        throw new Error(payload?.message ?? "The note could not be sent.");
      }
      setMessages(payload.messages);
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The note could not be sent.");
    } finally {
      setSending(false);
    }
  };

  return (
    <section aria-label={copy.notesAndQuestions} data-public-notes-href={messagesHref ?? undefined}>
      <div className={styles.notesHead}>
        <h2>Notes &amp; questions</h2>
        <span>anyone with this link can reply · the thread stays with this snapshot</span>
      </div>
      <div className={styles.notesCard}>
        <div className={styles.notesList}>
          {messages.length === 0 ? (
            <p className={styles.notesEmpty}>{copy.noNotesYetStartThread}</p>
          ) : (
            messages.map((message) => (
              <div className={styles.noteRow} key={message.id}>
                <span className={styles.noteAvatar} data-role={message.who}>
                  {message.name.slice(0, 2).toUpperCase()}
                </span>
                <div className={styles.noteBody}>
                  <p className={styles.noteMeta}>
                    <span className={styles.noteName}>{message.name}</span>
                    {message.who === "sender" ? <span className={styles.senderTag}>{copy.sender}</span> : null}
                    <span className={styles.noteTime}>{formatDate(message.postedAt)}</span>
                  </p>
                  <p className={styles.noteText}>{message.text}</p>
                </div>
              </div>
            ))
          )}
        </div>
        {messagesHref ? (
          <div className={styles.noteComposer}>
            <div className={styles.noteInputRow}>
              <input
                aria-label={copy.writeANote}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void send();
                }}
                placeholder={copy.askAQuestionOrLeaveANote}
                value={draft}
              />
              <button disabled={sending || !draft.trim()} onClick={() => void send()} type="button">
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
            {error ? <p className={styles.noteError}>{error}</p> : null}
            <p className={styles.noteFooter}>
              replies are visible to everyone with this link · snapshot metrics stay read-only
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function PublicSharePage({
  share,
  csvHref = null,
  messagesHref = null,
}: {
  share: PublicShare;
  csvHref?: string | null;
  messagesHref?: string | null;
}) {
  const copy = useCopy();
  const creatives = share.creatives ?? [];

  if (creatives.length === 0) {
    return <EmptySnapshotPage share={share} />;
  }

  const disclosure =
    share.audience === "buyer"
      ? share.financialWarning
      : share.audience === "creative_team"
        ? "This view contains creative-quality metrics only. Spend, revenue and delivery data are not part of this snapshot."
        : "This read-only snapshot contains creative-quality metrics only. No financial, delivery or account information is included.";

  const gridClass =
    share.audience === "buyer"
      ? styles.gridBuyer
      : share.audience === "creative_team"
        ? styles.gridCreativeTeam
        : styles.gridExternal;

  const showCsv = Boolean(csvHref) && share.allowCsv;
  const showCsvOffNote = !showCsv && share.audience === "buyer";
  const actions = share.actions ?? [];

  return (
    <>
      {/* Anonymous, identifier-free, and only on the served page. */}
      <PublicShareScreenView />
      <main className={styles.page} data-el="public-share" data-public-share="ready" data-share-audience={share.audience}>
      <div className={styles.pageInner}>
        <header className={styles.header}>
          <div className={styles.headerRow}>
            <BrandMark />
            <span className={styles.brandName}>Adsecute</span>
            <span className={styles.snapshotTag}>{copy.snapshot}</span>
            <span className={styles.flexSpacer} />
            <span className={styles.frozenPill}>
              <svg fill="none" height="11" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="11">
                <path d="M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              {copy.frozenSnapshot}
            </span>
            <span className={styles.readOnlyPill}>{copy.readOnly}</span>
          </div>
          <h1 className={styles.title}>{share.title}</h1>
          <p className={styles.metaLine}>
            {creatives.length} creative{creatives.length === 1 ? "" : "s"}
            {share.dateRange ? ` · ${share.dateRange}` : ""}
            {share.frozenAt ? ` · Captured ${formatDate(share.frozenAt)}` : ""}
            {share.expiresAt ? ` · Available until ${formatDate(share.expiresAt)}` : ""}
          </p>
        </header>

        {disclosure ? (
          <div
            className={styles.disclosure}
            data-share-financial-warning={share.audience === "buyer" ? "" : undefined}
            data-tone={share.audience === "buyer" ? "warn" : "neutral"}
          >
            {disclosure}
          </div>
        ) : null}

        {share.note ? (
          <div className={styles.senderNote}>
            <p className={styles.senderNoteLabel}>{copy.noteFromTheSender}</p>
            <p>{share.note}</p>
          </div>
        ) : null}

        {showCsv && csvHref ? <CsvButton href={csvHref} /> : null}
        {showCsvOffNote ? <p className={styles.csvOffNote}>{copy.csvExportNotEnabledForLink}</p> : null}

        <div aria-label={copy.creatives} className={gridClass}>
          {creatives.map((creative) => (
            <CreativeCard creative={creative} key={creative.key} />
          ))}
        </div>

        {share.audience === "buyer" ? <ComparisonTable share={share} /> : null}

        {actions.length > 0 ? (
          <section aria-label={copy.whatChangedAndWhy} data-public-share-actions="">
            <div className={styles.actionsHead}>
              <h2>{copy.whatChangedAndWhy}</h2>
              <span>actions recorded during this window · frozen with the snapshot</span>
            </div>
            <div className={styles.actionsList}>
              {actions.map((action, index) => (
                <article data-public-share-action="" key={`${action.date}:${action.what}:${index}`}>
                  <div className={styles.actionHead}>
                    <p>{action.what}</p>
                    <span>{action.date}</span>
                  </div>
                  <p className={styles.actionWhy}>{action.why}</p>
                  {action.outcome ? (
                    <span className={styles.actionOutcome} data-tone={action.outcomeTone}>
                      {action.outcome}
                    </span>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <NotesThread messagesHref={messagesHref} share={share} />

        <footer className={styles.footer}>
          <p>
            This is a frozen, read-only snapshot · Available until{" "}
            {share.expiresAt ? formatDate(share.expiresAt) : "the issuer-defined time"}
          </p>
          <p className={styles.footerSub}>
            It contains only the creatives and metrics shown above. No ad-account
            credentials, workspace access or live data are attached, and the page
            never updates.
          </p>
          <p className={styles.footerBrand}>Adsecute · share.adsecute.com</p>
        </footer>
      </div>
    </main>
    </>
  );
}

export default PublicSharePage;
