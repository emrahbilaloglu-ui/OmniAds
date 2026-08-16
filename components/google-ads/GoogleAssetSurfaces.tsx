"use client";

import type {
  AssetGroupRow,
  AssetRow,
  AudienceRow,
} from "@/components/google-ads/google-ads-dashboard-support";

/**
 * The three surfaces the design's Assets & Audiences screen switches between:
 * the Performance Max asset group table, the text/image asset pair, and the
 * audience table. Each column reads a served field; a field Google does not
 * return on these reports renders an em dash rather than a derived stand-in.
 */

const HEAD =
  "bg-[var(--adv-fill)] px-3 py-[9px] font-[family-name:var(--adv-font-mono)] text-[10px] font-medium uppercase tracking-[0.1em] whitespace-nowrap text-[var(--adv-ink-3)]";

const CARD = "rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]";

const CARD_HEAD =
  "flex flex-wrap items-center gap-2 border-b border-[var(--adv-hairline)] px-4 py-[13px]";

const CARD_TITLE =
  "m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]";

const CARD_SUB = "font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]";

const FOOTNOTE = "m-0 font-[family-name:var(--adv-font-mono)] text-[11px] text-[var(--adv-ink-4)]";

/** These reports run long; the tables show the top slice and say how many. */
const VISIBLE_ROWS = 50;

function moreNote(total: number) {
  if (total <= VISIBLE_ROWS) return null;
  return (
    <p className="m-0 border-t border-[var(--adv-hairline)] px-4 py-2.5 font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
      Showing the top {VISIBLE_ROWS} of {total.toLocaleString()} rows by spend.
    </p>
  );
}

function roasTone(roas: number, average: number) {
  if (!Number.isFinite(roas) || roas <= 0) {
    return { bg: "var(--adv-fill-2)", fg: "var(--adv-ink-3)" };
  }
  if (average > 0 && roas >= average) return { bg: "var(--adc-pos-bg)", fg: "var(--adc-pos-fg)" };
  if (average > 0 && roas < average * 0.6) {
    return { bg: "var(--adc-danger-bg)", fg: "var(--adc-danger-fg)" };
  }
  return { bg: "var(--adc-caution-bg)", fg: "var(--adc-caution-fg)" };
}

/** Google's own ad strength wording carries the tone; nothing is recomputed. */
function strengthTone(strength: string) {
  const value = strength.toLowerCase();
  if (value === "best" || value === "good") {
    return { bg: "var(--adc-pos-bg)", fg: "var(--adc-pos-fg)" };
  }
  if (value === "low") return { bg: "var(--adc-danger-bg)", fg: "var(--adc-danger-fg)" };
  return { bg: "var(--adc-caution-bg)", fg: "var(--adc-caution-fg)" };
}

const PERFORMANCE_TONE: Record<string, { bg: string; fg: string; label: string }> = {
  top: { bg: "var(--adc-pos-bg)", fg: "var(--adc-pos-fg)", label: "Best" },
  average: { bg: "var(--adc-caution-bg)", fg: "var(--adc-caution-fg)", label: "Good" },
  underperforming: { bg: "var(--adc-danger-bg)", fg: "var(--adc-danger-fg)", label: "Low" },
};

export function GoogleAssetGroupsTable({
  rows,
  currencyFormatter,
  focusedNames = [],
  footnote,
}: {
  rows: AssetGroupRow[];
  currencyFormatter: (value: number) => string;
  focusedNames?: string[];
  footnote?: string | null;
}) {
  if (rows.length === 0) return null;

  const focused = new Set(focusedNames.map((name) => name.toLowerCase().trim()));
  const totalSpend = rows.reduce((sum, row) => sum + (Number(row.spend) || 0), 0);
  const totalRevenue = rows.reduce((sum, row) => sum + (Number(row.revenue) || 0), 0);
  const averageRoas = totalSpend > 0 ? totalRevenue / totalSpend : 0;

  return (
    <>
      <article className={`${CARD} overflow-x-auto`}>
        <div className={CARD_HEAD}>
          <h2 className={CARD_TITLE}>Asset groups</h2>
          <span className={CARD_SUB}>Performance Max · ad strength is Google-served</span>
        </div>
        <table className="w-full min-w-[640px] border-collapse text-[13px] tabular-nums">
          <thead>
            <tr>
              <th className={`${HEAD} px-4 text-left`}>Asset group</th>
              <th className={`${HEAD} text-left`}>Campaign</th>
              <th className={`${HEAD} text-right`}>Spend</th>
              <th className={`${HEAD} text-right`}>Conv value</th>
              <th className={`${HEAD} text-right`}>ROAS</th>
              <th className={`${HEAD} px-4 text-left`}>Ad strength</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, VISIBLE_ROWS).map((row) => {
              const roas = Number(row.roas) || 0;
              const tone = roasTone(roas, averageRoas);
              const strength = row.adStrength?.trim() || null;
              const strengthColors = strength ? strengthTone(strength) : null;
              return (
                <tr
                  key={row.id}
                  className="border-t border-[var(--adv-hairline)]"
                  style={
                    focused.has(row.name.toLowerCase().trim())
                      ? { background: "var(--adv-accent-bg)" }
                      : undefined
                  }
                >
                  <td className="px-4 py-[11px] font-semibold text-[var(--adv-ink)]">{row.name}</td>
                  <td className="px-3 py-[11px] text-[12.5px] text-[var(--adv-ink-3)]">
                    {row.campaign || "—"}
                  </td>
                  <td className="px-3 py-[11px] text-right text-[var(--adv-ink-2)]">
                    {currencyFormatter(Number(row.spend) || 0)}
                  </td>
                  <td className="px-3 py-[11px] text-right font-semibold text-[var(--adv-ink)]">
                    {currencyFormatter(Number(row.revenue) || 0)}
                  </td>
                  <td className="px-3 py-[11px] text-right">
                    <span
                      className="inline-flex rounded-md px-2 py-0.5 text-[11.5px] font-bold"
                      style={{ background: tone.bg, color: tone.fg }}
                    >
                      {roas > 0 ? roas.toFixed(2) : "—"}
                    </span>
                  </td>
                  <td className="px-4 py-[11px]">
                    {strength ? (
                      <span
                        className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
                        style={{ background: strengthColors!.bg, color: strengthColors!.fg }}
                      >
                        {strength}
                      </span>
                    ) : (
                      <span className="text-[var(--adv-ink-4)]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {moreNote(rows.length)}
      </article>
      {footnote ? <p className={FOOTNOTE}>{footnote}</p> : null}
    </>
  );
}

export function GoogleAssetPair({
  assets,
  focusedLabels = [],
  labelOf,
}: {
  assets: AssetRow[];
  focusedLabels?: string[];
  labelOf: (asset: AssetRow) => string;
}) {
  const focused = new Set(focusedLabels.map((label) => label.toLowerCase().trim()));
  const text = assets.filter(
    (asset) => asset.type === "Headline" || asset.type === "Description",
  );
  const images = assets.filter((asset) => asset.type === "Image");
  if (text.length === 0 && images.length === 0) return null;

  const imageImpressions = images.reduce((sum, asset) => sum + (Number(asset.impressions) || 0), 0);

  return (
    <div className="grid items-start gap-3 [grid-template-columns:minmax(0,1.55fr)_minmax(280px,1fr)] max-[1100px]:[grid-template-columns:minmax(0,1fr)]">
      <article className={CARD}>
        <div className={CARD_HEAD}>
          <h2 className={CARD_TITLE}>Text assets</h2>
          <span className={CARD_SUB}>ratings are Google-served · refreshed each sync</span>
        </div>
        {text.length === 0 ? (
          <p className="m-0 px-4 py-[11px] text-[12px] text-[var(--adv-ink-3)]">
            No headline or description asset served in this window.
          </p>
        ) : (
          text.slice(0, VISIBLE_ROWS).map((asset) => {
            const label = labelOf(asset);
            const performance = asset.performanceLabel
              ? PERFORMANCE_TONE[asset.performanceLabel]
              : null;
            return (
              <div
                key={asset.id}
                className="flex items-center gap-2.5 border-t border-[var(--adv-hairline)] px-4 py-[11px] first-of-type:border-t-0"
                style={
                  focused.has(label.toLowerCase().trim())
                    ? { background: "var(--adv-accent-bg)" }
                    : undefined
                }
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--adv-ink)]">
                  “{label}”
                </span>
                <span className="shrink-0 rounded-[5px] border border-[var(--adv-border)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.06em] text-[var(--adv-ink-3)]">
                  {asset.type}
                </span>
                <span className="shrink-0 font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
                  {(Number(asset.impressions) || 0).toLocaleString()} impr
                </span>
                {performance ? (
                  <span
                    className="inline-flex shrink-0 rounded-md px-[9px] py-0.5 text-[11px] font-bold"
                    style={{ background: performance.bg, color: performance.fg }}
                  >
                    {performance.label}
                  </span>
                ) : (
                  <span className="shrink-0 text-[11px] text-[var(--adv-ink-4)]">—</span>
                )}
              </div>
            );
          })
        )}
      </article>

      <article className={`${CARD} p-4`}>
        <div className="flex items-baseline gap-2">
          <h2 className={CARD_TITLE}>Image assets</h2>
          <span className={CARD_SUB}>impression share</span>
        </div>
        {images.length === 0 ? (
          <p className="m-0 mt-3 text-[11.5px] leading-[1.5] text-[var(--adv-ink-4)]">
            No image asset served in this window.
          </p>
        ) : (
          <>
            <div className="mt-2.5 grid grid-cols-2 gap-2.5">
              {images.slice(0, 6).map((asset) => {
                const impressions = Number(asset.impressions) || 0;
                const share =
                  imageImpressions > 0 ? (impressions / imageImpressions) * 100 : null;
                const preview = asset.preview?.startsWith("http") ? asset.preview : null;
                return (
                  <div
                    key={asset.id}
                    className="overflow-hidden rounded-[10px] border border-[var(--adv-border)]"
                  >
                    {preview ? (
                      <img
                        src={preview}
                        alt={labelOf(asset)}
                        className="h-16 w-full object-cover"
                      />
                    ) : (
                      <div className="h-16 w-full bg-[var(--adv-fill-2)]" />
                    )}
                    <p className="m-0 px-[9px] py-1.5 text-[10px] text-[var(--adv-ink-3)]">
                      {share === null ? "no impressions" : `${share.toFixed(1)}% of impressions`}
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="m-0 mt-3 text-[11.5px] leading-[1.5] text-[var(--adv-ink-4)]">
              Thumbnails render from synced assets; an asset Google returns
              without an image URL shows a plain tile.
            </p>
          </>
        )}
      </article>
    </div>
  );
}

export function GoogleAudiencesTable({
  rows,
  currencyFormatter,
  footnote,
}: {
  rows: AudienceRow[];
  currencyFormatter: (value: number) => string;
  footnote: string;
}) {
  if (rows.length === 0) return null;

  const totalSpend = rows.reduce((sum, row) => sum + (Number(row.spend) || 0), 0);
  const totalRevenue = rows.reduce((sum, row) => sum + (Number(row.revenue) || 0), 0);
  const averageRoas = totalSpend > 0 ? totalRevenue / totalSpend : 0;

  return (
    <>
      <article className={`${CARD} overflow-x-auto`}>
        <div className={CARD_HEAD}>
          <h2 className={CARD_TITLE}>Audiences</h2>
          <span className={CARD_SUB}>
            observation + targeting · lists sync from Shopify segments
          </span>
        </div>
        <table className="w-full min-w-[640px] border-collapse text-[13px] tabular-nums">
          <thead>
            <tr>
              <th className={`${HEAD} px-4 text-left`}>Audience</th>
              <th className={`${HEAD} text-left`}>Type</th>
              <th className={`${HEAD} text-right`}>Size</th>
              <th className={`${HEAD} text-right`}>Conv</th>
              <th className={`${HEAD} text-right`}>CPA</th>
              <th className={`${HEAD} px-4 text-right`}>ROAS</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, VISIBLE_ROWS).map((row, index) => {
              const roas = Number(row.roas) || 0;
              const tone = roasTone(roas, averageRoas);
              const conversions = Number(row.conversions) || 0;
              const spend = Number(row.spend) || 0;
              const cpa =
                typeof row.cpa === "number" && Number.isFinite(row.cpa) && row.cpa > 0
                  ? row.cpa
                  : conversions > 0
                    ? spend / conversions
                    : null;
              return (
                <tr
                  key={row.criterionId ?? `${row.type}-${row.campaign ?? ""}-${index}`}
                  className="border-t border-[var(--adv-hairline)]"
                >
                  <td className="px-4 py-[11px] font-semibold text-[var(--adv-ink)]">
                    {row.adGroup || row.name || row.criterionId || "Unnamed audience"}
                  </td>
                  <td className="px-3 py-[11px]">
                    <span className="inline-flex rounded-md bg-[var(--adv-fill-2)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--adv-ink-2)]">
                      {row.type}
                    </span>
                  </td>
                  {/* List size lives on the user list resource, which the
                      audience performance report does not return. */}
                  <td className="px-3 py-[11px] text-right text-[var(--adv-ink-2)]">—</td>
                  <td className="px-3 py-[11px] text-right font-semibold text-[var(--adv-ink)]">
                    {conversions.toLocaleString()}
                  </td>
                  <td className="px-3 py-[11px] text-right text-[var(--adv-ink-2)]">
                    {cpa === null ? "—" : currencyFormatter(cpa)}
                  </td>
                  <td className="px-4 py-[11px] text-right">
                    <span
                      className="inline-flex rounded-md px-2 py-0.5 text-[11.5px] font-bold"
                      style={{ background: tone.bg, color: tone.fg }}
                    >
                      {roas > 0 ? roas.toFixed(2) : "—"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {moreNote(rows.length)}
      </article>
      <p className={FOOTNOTE}>{footnote}</p>
    </>
  );
}
