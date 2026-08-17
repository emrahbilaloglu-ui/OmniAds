import type { OverviewAttributionRow } from "@/src/types/models";

const CHANNEL_LOGOS: Array<{ match: RegExp; logo: string }> = [
  { match: /meta|facebook|instagram/i, logo: "/platform-logos/Meta.png" },
  { match: /google\s*ads|adwords/i, logo: "/platform-logos/googleAds.svg" },
  { match: /klaviyo/i, logo: "/platform-logos/Klaviyo.svg" },
  {
    match: /ga4|organic|analytics|direct|referral|search/i,
    logo: "/platform-logos/GA4.svg",
  },
];

function channelLogo(channel: string, source: string) {
  const hay = `${channel} ${source}`;
  return CHANNEL_LOGOS.find((entry) => entry.match.test(hay))?.logo ?? null;
}

/** Missing figures render as an em dash — never as zero. */
function dash(value: number | null | undefined, render: (value: number) => string) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return render(value);
}

function fixedNumber(value: number, minimumFractionDigits: number, maximumFractionDigits: number) {
  return Math.abs(value).toLocaleString("en-US", { minimumFractionDigits, maximumFractionDigits });
}

function fixedCurrency(value: number, currencySymbol: string, fractionDigits: number) {
  if (!currencySymbol) return "—";
  return `${value < 0 ? "−" : ""}${currencySymbol}${fixedNumber(value, fractionDigits, fractionDigits)}`;
}

function spendShare(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { label: "—", width: "0%" };
  }

  const bounded = Math.min(100, Math.max(0, value));
  const label = Number.isInteger(value) ? `${value}%` : `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return { label, width: `${bounded}%` };
}

export function AttributionCard({ rows, currencySymbol }: { rows: OverviewAttributionRow[]; currencySymbol: string }) {
  return (
    <article className="adv-card overflow-hidden">
      <div className="adv-card-head">
        <h2 className="adv-card-title">Attribution by channel</h2>
        <div className="flex gap-1.5">
          <input
            placeholder="Filter channels"
            aria-label="Filter channels"
            style={{
              height: 30,
              width: 160,
              borderRadius: 8,
              border: "1px solid #E4E8F0",
              background: "#F7F9FC",
              padding: "0 10px",
              fontSize: 12.5,
              outline: "none",
              fontFamily: "inherit",
              color: "#0E1526",
            }}
          />
          <button type="button" className="adv-btn adv-btn--sm">
            Columns
          </button>
        </div>
      </div>
      <div className="adv-scroll-x">
        <table className="adv-table" style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th scope="col" style={{ fontSize: 10, padding: "9px 16px" }}>
                Channel
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                Spend ↓
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                Revenue
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                ROAS
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                CPA
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                AOV
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                Conv.
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const logo = channelLogo(row.channel, row.source);
              const share = spendShare(row.spendShare);
              return (
                <tr key={`${row.channel}-${row.source}`} data-overview-channel={row.channel}>
                  <td style={{ padding: "11px 16px" }}>
                    <span className="inline-flex items-center" style={{ gap: 9 }}>
                      <span className="grid h-[26px] w-[26px] place-items-center rounded-[7px] border border-[var(--adv-border)] bg-[var(--adv-fill-2)]">
                        <span
                          role="img"
                          aria-label={row.channel}
                          className="inline-block h-[15px] w-[15px] bg-contain bg-center bg-no-repeat"
                          style={{
                            backgroundImage: logo ? `url(${logo})` : undefined,
                          }}
                        />
                      </span>
                      <span className="font-semibold text-[var(--adv-ink)]">{row.channel}</span>
                    </span>
                  </td>
                  <td className="!text-[var(--adv-ink)]">
                    {dash(row.spend, (value) => fixedCurrency(value, currencySymbol, Math.abs(value) < 100 ? 2 : 0))}
                  </td>
                  <td className="!font-semibold !text-[var(--adv-ink)]">
                    {dash(row.revenue, (value) => fixedCurrency(value, currencySymbol, Math.abs(value) < 100 ? 2 : 0))}
                  </td>
                  <td>
                    <span
                      className="inline-flex rounded-[6px] px-[7px] py-0.5 text-[12px] font-semibold"
                      style={
                        row.roas === null
                          ? {
                              background: "var(--adv-fill-2)",
                              color: "var(--adv-ink-3)",
                            }
                          : row.roas >= 1
                            ? {
                                background: "#E7F6F0",
                                color: "#0E9F6E",
                              }
                            : {
                                background: "#FDECF0",
                                color: "#E11D48",
                              }
                      }
                    >
                      {dash(row.roas, (value) => value.toFixed(2))}
                    </span>
                  </td>
                  <td>{dash(row.cpa, (value) => fixedCurrency(value, currencySymbol, 2))}</td>
                  <td>{dash(row.aov, (value) => fixedCurrency(value, currencySymbol, 2))}</td>
                  <td>{dash(row.conversions, (value) => Math.round(value).toLocaleString("en-US"))}</td>
                  <td>
                    <span className="inline-flex items-center justify-end gap-2">
                      <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-[var(--adv-hairline)]">
                        <span
                          className="block h-full rounded-full bg-[var(--adv-accent)]"
                          style={{ width: share.width }}
                        />
                      </span>
                      <span className="min-w-[34px] text-[12px] text-[var(--adv-ink-3)]">{share.label}</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </article>
  );
}
